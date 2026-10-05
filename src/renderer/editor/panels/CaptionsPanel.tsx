/**
 * Aba LEGENDAS: liga e desliga, os 4 estilos (cada cartão desenha uma amostra pelo MESMO código do motor), tamanho, posição
 * vertical, palavras por linha, maiúsculas, caixa, cores e os arquivos SRT e VTT. As escolhas valem para o formato aberto (16:9
 * ou vertical): são campos da visão do formato. A prévia ao vivo é o próprio quadro do editor.
 */
import { useEffect, useRef, useState } from 'react'
import { drawCaptions } from '@shared/caption-render'
import { CAPTION_SIZE_MAX, CAPTION_SIZE_MIN, CAPTION_STYLE_IDS, defaultCaptionY, resolveCaptionStyle } from '@shared/caption-style'
import { buildCaptionTrack } from '@shared/captions'
import { createRenderCache, type CanvasFactory, type CanvasLike, type Ctx2D, type RenderCache } from '@shared/render'
import type { SceneCaptions } from '@shared/scene'
import type { CaptionStyle, CaptionStyleId } from '@shared/types'
import { CaptionsIcon } from '../../components/Icons'
import { t } from '../../i18n/pt-BR'
import { useApp } from '../../store'
import { ensureCaptionFonts } from '../../fonts'
import { ColorField, Hint, Section, Slider, Toggle } from '../controls'
import { useDoc, useEditor } from '../context'

const T = t.editor.captions
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** O que cada estilo traz de partida quando é escolhido (a caixa e quantas palavras por linha). */
const STYLE_DEFAULTS: Record<CaptionStyleId, { wordsPerLine: number; box: boolean }> = {
  highlight: { wordsPerLine: 3, box: false },
  natural: { wordsPerLine: 4, box: true },
  clean: { wordsPerLine: 4, box: true },
  karaoke: { wordsPerLine: 4, box: true }
}

const factory: CanvasFactory = (w, h) => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c as unknown as CanvasLike
}

/** Desenha a amostra de um estilo num cartão: o mesmo `drawCaptions` do vídeo, num quadro virtual levado ao cartão. */
function drawSample(canvas: HTMLCanvasElement, cache: RenderCache, cap: CaptionStyle, style: CaptionStyleId, vertical: boolean): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height)
  g.addColorStop(0, '#2a3552')
  g.addColorStop(1, '#10121a')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  // quadro virtual do formato (a legenda sai com o tamanho e as proporções reais), levado ao cartão
  const virtual = vertical ? { kind: 'vertical' as const, w: 1080, h: 1920 } : { kind: 'horizontal' as const, w: 1920, h: 1080 }
  const sample: CaptionStyle = { ...cap, style, ...STYLE_DEFAULTS[style], positionY: 0.5 }
  delete sample.size
  delete sample.uppercase
  const rs = resolveCaptionStyle(sample, virtual)
  const scene: SceneCaptions = { key: `sample-${style}`, style: { ...rs, safeY: null }, words: [...T.sample], active: 1, pop: 1, alpha: 1, dy: 0 }
  const k = (canvas.width * 0.9) / rs.maxWidth
  ctx.save()
  ctx.translate(canvas.width / 2 - (virtual.w / 2) * k, canvas.height / 2 - rs.centerY * k)
  ctx.scale(k, k)
  drawCaptions(ctx as unknown as Ctx2D, cache, scene)
  ctx.restore()
}

function StyleCard({ id, cap, vertical, ready, onPick }: { id: CaptionStyleId; cap: CaptionStyle; vertical: boolean; ready: boolean; onPick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const cache = useRef<RenderCache | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !ready) return
    cache.current ??= createRenderCache(factory)
    cache.current.captionLayouts.clear()
    drawSample(canvas, cache.current, cap, id, vertical)
  }, [id, cap.textColor, cap.highlightColor, vertical, ready, cap])
  return (
    <button type="button" className="cap-card" aria-pressed={cap.style === id} data-testid={`caption-style-${id}`} onClick={onPick}>
      <canvas ref={ref} width={320} height={180} aria-hidden="true" />
      <b>{T.styles[id].name}</b>
      <small>{T.styles[id].hint}</small>
    </button>
  )
}

export function CaptionsPanel() {
  const { store, transcript, detail, engineRef } = useEditor()
  const notify = useApp((s) => s.notify)
  const cap = useDoc((s) => s.project.captions)
  const format = useDoc((s) => s.format)
  const vertical = format === 'vertical'
  const words = transcript.data?.words ?? null
  const hasWords = (words?.length ?? 0) > 0
  const [fontsReady, setFontsReady] = useState(false)
  const [busy, setBusy] = useState<'srt' | 'vtt' | null>(null)
  const [saved, setSaved] = useState<{ path: string; name: string } | null>(null)

  useEffect(() => {
    let alive = true
    ensureCaptionFonts().then(
      () => alive && setFontsReady(true),
      (err: unknown) => notify({ kind: 'error', text: T.fontsFailed, detail: messageOf(err) })
    )
    return () => {
      alive = false
    }
  }, [notify])

  const edit = (patch: Partial<CaptionStyle>, coalesce?: string): void => {
    store.getState().change((p) => ({ ...p, captions: { ...p.captions, ...patch } }), coalesce ? { coalesce } : undefined)
  }
  const pickStyle = (style: CaptionStyleId): void => {
    store.getState().change((p) => ({ ...p, captions: { ...p.captions, style, ...STYLE_DEFAULTS[style] } }))
  }
  const resetStyle = (): void => {
    store.getState().change((p) => {
      const next = { ...p.captions }
      delete next.size
      delete next.positionY
      delete next.uppercase
      delete next.textColor
      return { ...p, captions: { ...next, highlightColor: '#FFD93D', ...STYLE_DEFAULTS[next.style] } }
    })
  }

  const rs = resolveCaptionStyle(cap, { kind: format, w: vertical ? 1080 : 1920, h: vertical ? 1920 : 1080 })
  const posY = cap.positionY ?? defaultCaptionY(cap.position, format)
  const boxable = cap.style === 'natural' || cap.style === 'karaoke'

  // ver a legenda: leva a reprodução ao começo da primeira página (a legenda só aparece onde há fala)
  const seekToCaption = (): void => {
    const doc = store.getState().project
    const track = buildCaptionTrack(words, { ...doc, captions: { ...doc.captions, enabled: true } }, doc.sources.voice?.durationMs ?? doc.sources.screen?.durationMs ?? 0)
    const first = track?.pages[0]
    if (!first) return
    engineRef.current?.seekOutput(first.start + 250)
  }

  const exportFile = async (kind: 'srt' | 'vtt'): Promise<void> => {
    setBusy(kind)
    try {
      await store.getState().flush()
      const r = await window.tomada.captions.export(detail.id, kind)
      const name = r.path.split(/[\\/]/).pop() ?? r.path
      setSaved({ path: r.path, name })
      notify({ kind: 'info', text: T.saved(name) })
    } catch (err) {
      notify({ kind: 'error', text: T.exportFailed, detail: messageOf(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="panel" data-testid="captions-panel">
      <Section title={T.title}>
        <Toggle label={T.show} hint={T.showHint} checked={cap.enabled} testId="captions-show" onChange={(v) => edit({ enabled: v })} />
        <p className="ctl-note" data-testid="captions-format-note">
          {T.forFormat[format]}
        </p>
        {!hasWords ? (
          <Hint tone="warn">
            <b>{T.noTranscript.title}.</b> {T.noTranscript.body}
          </Hint>
        ) : cap.enabled ? (
          <button type="button" className="link" data-testid="captions-seek" onClick={seekToCaption}>
            <CaptionsIcon size={13} /> {T.seek}
          </button>
        ) : null}
      </Section>

      <div className="panel-group" data-disabled={!cap.enabled} aria-disabled={!cap.enabled}>
        <Section title={T.style}>
          <div className="cap-styles" role="group" aria-label={T.style}>
            {CAPTION_STYLE_IDS.map((id) => (
              <StyleCard key={id} id={id} cap={cap} vertical={vertical} ready={fontsReady} onPick={() => pickStyle(id)} />
            ))}
          </div>
        </Section>

        <Section
          title={T.adjust}
          action={
            <button type="button" className="link" data-testid="captions-reset" onClick={resetStyle}>
              {T.reset}
            </button>
          }
        >
          <Slider
            label={T.size}
            value={cap.size ?? 1}
            min={CAPTION_SIZE_MIN}
            max={CAPTION_SIZE_MAX}
            step={0.05}
            testId="captions-size"
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => edit({ size: Math.round(v * 100) / 100 }, 'captions-size')}
          />
          <Slider
            label={T.position}
            value={posY}
            min={0.08}
            max={0.92}
            step={0.005}
            testId="captions-position"
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => edit({ positionY: Math.round(v * 1000) / 1000 }, 'captions-position')}
          />
          {vertical ? <p className="ctl-note">{T.safeNote}</p> : null}
          <Slider
            label={T.wordsPerLine}
            value={cap.wordsPerLine}
            min={1}
            max={5}
            step={1}
            testId="captions-words"
            format={(v) => String(Math.round(v))}
            onChange={(v) => edit({ wordsPerLine: Math.round(v) }, 'captions-words')}
          />
          <Toggle label={T.uppercase} checked={rs.uppercase} testId="captions-uppercase" onChange={(v) => edit({ uppercase: v })} />
          <Toggle label={T.box} checked={rs.box !== null} disabled={!boxable} testId="captions-box" onChange={(v) => edit({ box: v })} />
        </Section>

        <Section title={T.colors}>
          <div className="ctl-pair">
            <ColorField label={T.textColor} value={rs.color} testId="captions-text-color" onChange={(c) => edit({ textColor: c }, 'captions-text-color')} />
            <ColorField label={T.highlightColor} value={cap.highlightColor} testId="captions-highlight-color" onChange={(c) => edit({ highlightColor: c }, 'captions-highlight-color')} />
          </div>
        </Section>
      </div>

      <Section title={T.files}>
        <p className="ctl-note">{T.filesHelp}</p>
        <div className="cap-files">
          <button type="button" className="btn" disabled={!hasWords || busy !== null} data-testid="captions-export-srt" onClick={() => void exportFile('srt')}>
            {busy === 'srt' ? T.exporting : T.exportSrt}
          </button>
          <button type="button" className="btn" disabled={!hasWords || busy !== null} data-testid="captions-export-vtt" onClick={() => void exportFile('vtt')}>
            {busy === 'vtt' ? T.exporting : T.exportVtt}
          </button>
        </div>
        {saved ? (
          <p className="ctl-note" data-testid="captions-saved">
            {T.saved(saved.name)}{' '}
            <button type="button" className="link" onClick={() => void window.tomada.files.reveal(saved.path).catch((err: unknown) => notify({ kind: 'error', text: T.exportFailed, detail: messageOf(err) }))}>
              {T.reveal}
            </button>
          </p>
        ) : null}
      </Section>
    </div>
  )
}
