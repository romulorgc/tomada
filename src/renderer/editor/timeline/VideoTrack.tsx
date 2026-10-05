/**
 * Trilha de VÍDEO: miniaturas da tela, forma de onda da voz, os cortes (hachurados; clicar restaura) e a
 * seleção de intervalo (arrastar; Delete corta). Em tempo de ORIGEM, com os cortes à mostra; com "esconder
 * cortes" o eixo colapsa para o tempo de saída e cada corte vira uma emenda.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { MIN_CUT_MS, reenableCut, restoreCut } from '@shared/cuts'
import { formatSpan, formatTimecode } from '@shared/format'
import { t } from '../../i18n/pt-BR'
import { AlertIcon } from '../../components/Icons'
import { useDoc, useEditor } from '../context'
import { Waveform } from './Waveform'
import type { TimelineView } from './view'

const DRAG_PX = 4

const fmt = formatTimecode

export function VideoTrack({ view, getSnap, onSnapGuide, onSeek }: { view: TimelineView; getSnap: () => readonly number[]; onSnapGuide: (ms: number | null) => void; onSeek: (sourceMs: number) => void }) {
  const { store, peaks, thumbs, retryAssets, hasScreen, hasCamera } = useEditor()
  const cuts = useDoc((s) => s.project.cuts)
  const range = useDoc((s) => s.range)
  const voiceOffset = useDoc((s) => s.project.sync.cameraOffsetMs)
  const hasVoice = useDoc((s) => Boolean(s.project.sources.voice))

  const trackRef = useRef<HTMLDivElement>(null)
  const thumbAreaRef = useRef<HTMLDivElement>(null)
  const [thumbH, setThumbH] = useState(48)
  const drag = useRef<{ x0: number; startMs: number; moved: boolean } | null>(null)

  useEffect(() => {
    const el = thumbAreaRef.current
    if (!el) return
    const measure = (): void => setThumbH(Math.max(24, el.clientHeight))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // --- gesto: arrastar marca um intervalo; um clique só leva a cabeça de reprodução até lá ------------------
  const xOf = (e: ReactPointerEvent): number => e.clientX - (trackRef.current?.getBoundingClientRect().left ?? 0)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const x = xOf(e)
    trackRef.current?.setPointerCapture(e.pointerId)
    drag.current = { x0: x, startMs: view.toSource(x), moved: false }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = drag.current
    if (!g) return
    const x = xOf(e)
    if (!g.moved && Math.abs(x - g.x0) < DRAG_PX) return
    g.moved = true
    const candidates = getSnap()
    const a = view.snap(g.startMs, candidates)
    const b = view.snap(view.toSource(x), candidates)
    onSnapGuide(b.target ?? a.target)
    const start = Math.min(a.ms, b.ms)
    const end = Math.max(a.ms, b.ms)
    store.getState().setSelection(null)
    store.getState().setRange({ start, end })
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = drag.current
    drag.current = null
    onSnapGuide(null)
    if (trackRef.current?.hasPointerCapture(e.pointerId)) trackRef.current.releasePointerCapture(e.pointerId)
    if (!g) return
    if (!g.moved) {
      store.getState().setSelection(null)
      store.getState().setRange(null)
      onSeek(view.toSource(xOf(e)))
      return
    }
    const r = store.getState().range
    if (r && r.end - r.start < MIN_CUT_MS) store.getState().setRange(null)
  }

  // --- peças --------------------------------------------------------------------------------------
  const thumbTiles = useMemo(() => {
    if (thumbs.status !== 'ready' || !thumbs.data) return []
    const tileW = Math.max(16, Math.round((thumbH * 16) / 9))
    const first = Math.max(0, Math.floor(view.scrollLeft / tileW))
    const last = Math.ceil((view.scrollLeft + view.viewportW) / tileW)
    const total = view.map.totalMs * view.ppm
    const out: { key: number; left: number; w: number; url: string }[] = []
    const data = thumbs.data
    for (let k = first; k <= last && k * tileW < total; k++) {
      const centerMs = view.toSource(Math.min(total, (k + 0.5) * tileW))
      const idx = Math.min(data.count - 1, Math.max(0, Math.round(centerMs / data.intervalMs)))
      const url = data.urls[idx]
      if (url) out.push({ key: k, left: k * tileW, w: Math.min(tileW, total - k * tileW), url })
    }
    return out
  }, [thumbs, thumbH, view])

  const hide = view.map.hideCuts
  const sortedCuts = useMemo(() => [...cuts].sort((a, b) => a.start - b.start), [cuts])

  return (
    <div className="tl-lane tl-video" ref={trackRef} data-testid="track-video" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <div className="tl-thumbs" ref={thumbAreaRef} aria-hidden="true">
        {thumbTiles.map((tile) => (
          <img key={tile.key} src={tile.url} alt="" draggable={false} style={{ left: tile.left, width: tile.w }} />
        ))}
      </div>
      {thumbs.status === 'error' ? (
        <p className="tl-note" role="alert" data-testid="thumbs-error">
          <AlertIcon size={14} /> {t.editor.timeline.thumbsFailed}
          <button type="button" className="link" onClick={retryAssets}>
            {t.editor.timeline.retry}
          </button>
        </p>
      ) : null}

      <div className="tl-waveform">
        {peaks.status === 'ready' && peaks.data ? <Waveform peaks={peaks.data} voiceOffsetMs={voiceOffset} view={view} /> : null}
        {peaks.status === 'loading' ? <span className="tl-note tl-note-inline">{t.editor.timeline.wavePending}</span> : null}
        {peaks.status === 'error' ? (
          <span className="tl-note tl-note-inline" role="alert" data-testid="peaks-error" title={peaks.error ?? ''}>
            <AlertIcon size={14} /> {t.editor.timeline.peaksFailed}
            <button type="button" className="link" onClick={retryAssets}>
              {t.editor.timeline.retry}
            </button>
          </span>
        ) : null}
        {peaks.status === 'none' || (!hasVoice && peaks.status !== 'loading') ? <span className="tl-note tl-note-inline">{t.editor.timeline.noAudio}</span> : null}
      </div>
      {!hasScreen && hasCamera ? <span className="tl-badge">{t.project.camera}</span> : null}

      {sortedCuts.map((c) => {
        const x0 = view.toX(c.start)
        const x1 = view.toX(c.end)
        if (!c.enabled) {
          if (c.reason === 'manual' || hide) return null
          return (
            <button
              key={c.id}
              type="button"
              className="tl-cut"
              data-off="true"
              data-testid={`cut-${c.id}`}
              aria-label={t.editor.timeline.reenable(fmt(c.start), fmt(c.end))}
              style={{ left: x0, width: Math.max(2, x1 - x0) }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => store.getState().change((p) => ({ ...p, cuts: reenableCut(p.cuts, c.id) }))}
            />
          )
        }
        const width = x1 - x0
        const label = t.editor.timeline.restore(fmt(c.start), fmt(c.end))
        const restore = (): void => {
          store.getState().change((p) => ({ ...p, cuts: restoreCut(p.cuts, c.id) }))
          store.getState().setSelection(null)
        }
        if (hide || width < 3) {
          // com os cortes escondidos o trecho não ocupa espaço: vira uma emenda clicável
          return (
            <button
              key={c.id}
              type="button"
              className="tl-seam"
              data-testid={`cut-${c.id}`}
              aria-label={label}
              title={t.editor.timeline.restoreTip}
              style={{ left: x0 }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={restore}
            />
          )
        }
        return (
          <button
            key={c.id}
            type="button"
            className="tl-cut"
            data-reason={c.reason}
            data-testid={`cut-${c.id}`}
            aria-label={label}
            title={t.editor.timeline.restoreTip}
            style={{ left: x0, width }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={restore}
          >
            {width > 84 ? <span>{formatSpan(c.end - c.start)}</span> : null}
          </button>
        )
      })}

      {range ? (
        <div
          className="tl-range"
          data-testid="tl-range"
          data-start={Math.round(range.start)}
          data-end={Math.round(range.end)}
          style={{ left: view.toX(range.start), width: Math.max(2, view.toX(range.end) - view.toX(range.start)) }}
        >
          <span>{formatSpan(range.end - range.start)}</span>
        </div>
      ) : null}
    </div>
  )
}
