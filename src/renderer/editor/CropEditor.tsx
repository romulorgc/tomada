/**
 * O EDITOR DO RECORTE (C1): a tela gravada INTEIRA (um quadro dela, parado) com o retângulo do recorte por cima. Arrastar o corpo
 * move; arrastar uma aresta ou um canto redimensiona (a proporção pode ser travada em 16:9, 16:10 ou 4:3). Cada gesto vira UM passo de
 * desfazer; Esc ou "Pronto" fecham. Nada aqui entra no vídeo: é só a mesa de trabalho.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { CROP_LOCKS, dragCrop, type CropHandle } from '@shared/crop-drag'
import type { Rect } from '@shared/types'
import { t } from '../i18n/pt-BR'
import { useDoc, useEditor } from './context'

const T = t.editor.crop

const HANDLES: { id: CropHandle; label: string }[] = [
  { id: 'nw', label: 'canto de cima, à esquerda' },
  { id: 'n', label: 'aresta de cima' },
  { id: 'ne', label: 'canto de cima, à direita' },
  { id: 'e', label: 'aresta da direita' },
  { id: 'se', label: 'canto de baixo, à direita' },
  { id: 's', label: 'aresta de baixo' },
  { id: 'sw', label: 'canto de baixo, à esquerda' },
  { id: 'w', label: 'aresta da esquerda' }
]

export function CropEditor({ onCommit, rect }: { /** O retângulo de agora (normalizado na tela gravada). */ rect: Rect; onCommit: (rect: Rect) => void }) {
  const { store, detail, playback } = useEditor()
  const source = useDoc((s) => s.doc.sources.screen)
  const offsetMs = useDoc((s) => s.doc.sync.screenOffsetMs)
  const lock = useDoc((s) => s.cropUi.lock)
  const stage = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [draft, setDraftState] = useState<Rect | null>(null)
  // o último retângulo do arraste também fica numa ref: o soltar do ponteiro não pode depender de a tela já ter redesenhado
  const draftRef = useRef<Rect | null>(null)
  const setDraft = (r: Rect | null): void => {
    draftRef.current = r
    setDraftState(r)
  }
  const drag = useRef<{ x: number; y: number; start: Rect; handle: CropHandle } | null>(null)
  const url = detail.media.screen?.url ?? null

  const shown = draft ?? rect
  const sourcePx = useMemo(() => ({ w: source?.w ?? 1920, h: source?.h ?? 1080 }), [source?.w, source?.h])
  const aspect = lock ? CROP_LOCKS[lock] : null

  // Um quadro da tela, no instante em que a cabeça de reprodução está
  useEffect(() => {
    const v = video.current
    if (!v) return
    const seek = (): void => {
      const at = Math.max(0, (playback.getState().sourceMs - offsetMs) / 1000)
      v.currentTime = Math.min(at, Math.max(0, (v.duration || at) - 0.05))
    }
    if (v.readyState >= 1) seek()
    else v.addEventListener('loadedmetadata', seek, { once: true })
    return () => v.removeEventListener('loadedmetadata', seek)
  }, [playback, offsetMs, url])

  // Esc e Enter fecham (a primeira vez que o editor se abre, o foco vai para ele)
  const close = (): void => store.getState().setCropUi({ editing: false })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        store.getState().setCropUi({ editing: false })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [store])

  const onDown = (handle: CropHandle) => (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, start: shown, handle }
  }
  const onMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current
    const el = stage.current
    if (!d || !el) return
    const box = el.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return
    setDraft(dragCrop(d.start, d.handle, (e.clientX - d.x) / box.width, (e.clientY - d.y) / box.height, sourcePx, aspect))
  }
  const onUp = (e: ReactPointerEvent<HTMLElement>): void => {
    if (!drag.current) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const finished = draftRef.current
    setDraft(null)
    if (finished) onCommit(finished)
  }

  const pct = (v: number): string => `${(v * 100).toFixed(3)}%`
  const sizePx = { w: Math.round(shown.w * sourcePx.w), h: Math.round(shown.h * sourcePx.h) }

  return (
    <div className="crop-editor" data-testid="crop-editor" role="dialog" aria-label={T.editorLabel} onPointerDown={(e) => e.stopPropagation()}>
      <div className="crop-bar">
        <span data-testid="crop-hint">{T.editorHint}</span>
        <button type="button" className="btn btn-primary" onClick={close} data-testid="crop-done">
          {T.done}
        </button>
      </div>
      <div className="crop-work">
        <div ref={stage} className="crop-stage" style={{ ['--ar' as string]: `${sourcePx.w} / ${sourcePx.h}` }} data-testid="crop-stage">
          {url ? <video ref={video} src={url} muted playsInline preload="auto" aria-hidden="true" tabIndex={-1} /> : null}
          <div
            className="crop-box"
            data-testid="crop-box"
            data-dragging={draft ? 'true' : undefined}
            style={{ left: pct(shown.x), top: pct(shown.y), width: pct(shown.w), height: pct(shown.h) }}
            onPointerDown={onDown('move')}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            <b className="crop-size tnum" data-testid="crop-size">
              {T.size(sizePx.w, sizePx.h)}
            </b>
            {HANDLES.map((h) => (
              <i
                key={h.id}
                className="crop-handle"
                data-handle={h.id}
                data-testid={`crop-handle-${h.id}`}
                role="presentation"
                title={h.label}
                onPointerDown={onDown(h.id)}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
