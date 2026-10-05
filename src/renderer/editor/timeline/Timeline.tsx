/**
 * LINHA DO TEMPO do editor: régua, cabeça de reprodução arrastável, trilhas Vídeo / Zoom / Layout, zoom da
 * escala (Ctrl+roda, botões, controle), rolagem horizontal (roda), "esconder cortes" e ímã. Tudo em tempo de
 * ORIGEM; o eixo de exibição só difere dele quando os cortes estão escondidos (ver `timeline-view.ts`).
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { formatSpan, formatTimecode } from '@shared/format'
import { zoomCounts } from '@shared/edits'
import { moveLayoutSeg, moveZoom, resizeLayoutSeg, resizeZoom } from '@shared/edits'
import { keptRanges } from '@shared/timeline'
import { MAX_PX_PER_MS, clampPxPerMs, contentWidthPx, createTimeMap, fitPxPerMs, rulerTicks, scrollToReveal, visibleDisplayRange, zoomAround } from '@shared/timeline-view'
import type { LayoutKind } from '@shared/types'
import { CollapseIcon, FitIcon, MinusIcon, PlusIcon, ScissorsIcon, SplitIcon, ZoomInIcon } from '../../components/Icons'
import { t } from '../../i18n/pt-BR'
import { IconButton, Tip } from '../controls'
import { useDoc, useEditor, usePlayback } from '../context'
import { useEditorOps } from '../ops'
import { SegmentLane, type LaneApi, type LaneItem } from './SegmentLane'
import { VideoTrack } from './VideoTrack'
import { createTimelineView, type TimelineView } from './view'

const LAYOUT_NAMES = t.editor.layout.options as Record<LayoutKind, string>
const ZOOM_SLIDER_STEPS = 1000

/** Ao criar um trecho de layout arrastando: o primeiro layout diferente do padrão que o projeto comporta. */
function pickNewLayout(base: LayoutKind, hasScreen: boolean, hasCamera: boolean, vertical = false): LayoutKind {
  const order: LayoutKind[] = vertical ? ['stack', 'screen-wide', 'screen-focus', 'camera'] : ['screen', 'camera', 'side-by-side', 'bubble']
  const ok = (l: LayoutKind): boolean => (l === 'camera' ? hasCamera : l === 'screen' || l === 'screen-focus' || l === 'screen-wide' ? hasScreen : hasCamera && hasScreen)
  return order.find((l) => l !== base && ok(l)) ?? base
}

const Ruler = memo(function Ruler({ view, onScrub }: { view: TimelineView; onScrub: (clientX: number, phase: 'down' | 'move' | 'up') => void }) {
  const { from, to } = visibleDisplayRange(view.scrollLeft, view.viewportW, view.ppm)
  const ticks = rulerTicks(view.ppm, from, Math.min(to, view.map.totalMs + 1000))
  return (
    <div
      className="tl-ruler"
      data-testid="timeline-ruler"
      role="slider"
      aria-label={t.editor.timeline.ruler}
      aria-valuemin={0}
      aria-valuemax={Math.round(view.map.totalMs)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        onScrub(e.clientX, 'down')
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onScrub(e.clientX, 'move')
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        onScrub(e.clientX, 'up')
      }}
    >
      {ticks.map((tick) => (
        <span key={tick.ms} className="tl-tick" data-major={tick.major} style={{ left: tick.ms * view.ppm }}>
          {tick.label ? <em className="tnum">{tick.label}</em> : null}
        </span>
      ))}
    </div>
  )
})

/** A linha vertical da reprodução. Só ela assina o tempo: o resto da linha do tempo não redesenha a cada quadro. */
function Playhead({ view }: { view: TimelineView }) {
  const sourceMs = usePlayback((s) => s.sourceMs)
  const x = view.toX(sourceMs)
  return (
    <div className="tl-playhead" data-testid="playhead" data-source-ms={Math.round(sourceMs)} style={{ transform: `translateX(${x}px)` }}>
      <i aria-hidden="true" />
    </div>
  )
}

/** Mantém a cabeça de reprodução à vista enquanto toca (não mexe na rolagem se a pessoa está rolando). */
function PlayheadFollower({ view, scrollRef }: { view: TimelineView; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const playing = usePlayback((s) => s.playing)
  const sourceMs = usePlayback((s) => s.sourceMs)
  useEffect(() => {
    const el = scrollRef.current
    if (!playing || !el) return
    const next = scrollToReveal({
      ms: view.map.toDisplay(sourceMs),
      scrollLeft: el.scrollLeft,
      pxPerMs: view.ppm,
      viewportPx: el.clientWidth,
      totalMs: view.map.totalMs
    })
    if (Math.abs(next - el.scrollLeft) > 1) el.scrollLeft = next
  }, [playing, sourceMs, view, scrollRef])
  return null
}

export function Timeline() {
  const ctx = useEditor()
  const ops = useEditorOps()
  const { store, derived, durationMs, engineRef, playback, hasScreen, hasCamera } = ctx
  const zooms = useDoc((s) => s.project.zooms)
  const layouts = useDoc((s) => s.project.layouts)
  const cuts = useDoc((s) => s.project.cuts)
  const defaultLayout = useDoc((s) => s.project.style.defaultLayout)
  const isVertical = useDoc((s) => s.format === 'vertical')
  const range = useDoc((s) => s.range)
  const selection = useDoc((s) => s.selection)

  const [hideCuts, setHideCuts] = useState(false)
  const [userPpm, setUserPpm] = useState(0) // 0 = ajustar à largura
  const [viewportW, setViewportW] = useState(800)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [guide, setGuide] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pendingScroll = useRef<number | null>(null)

  const kept = useMemo(() => derived?.kept ?? keptRanges(durationMs, cuts), [derived, durationMs, cuts])
  const map = useMemo(() => createTimeMap({ durationMs, kept, hideCuts }), [durationMs, kept, hideCuts])
  const fit = fitPxPerMs(viewportW, map.totalMs)
  const ppm = userPpm > 0 ? clampPxPerMs(userPpm, viewportW, map.totalMs) : fit
  const contentW = Math.max(viewportW, contentWidthPx(map.totalMs, ppm))
  const view = useMemo(() => createTimelineView({ map, ppm, scrollLeft, viewportW, durationMs, kept }), [map, ppm, scrollLeft, viewportW, durationMs, kept])
  const ppmRef = useRef(ppm)
  ppmRef.current = ppm
  const mapRef = useRef(map)
  mapRef.current = map

  // --- largura visível e rolagem -------------------------------------------------------------------------
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setViewportW(Math.max(120, el.clientWidth))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (pendingScroll.current !== null) {
      el.scrollLeft = pendingScroll.current
      pendingScroll.current = null
    }
  }, [ppm])

  // Ctrl+roda aproxima/afasta ancorado no ponteiro; roda sozinha rola na horizontal (listener não passivo)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect()
        const z = zoomAround({
          pxPerMs: ppmRef.current,
          factor: Math.exp(-e.deltaY * 0.0018),
          anchorPx: e.clientX - rect.left,
          scrollLeft: el.scrollLeft,
          viewportPx: el.clientWidth,
          totalMs: mapRef.current.totalMs
        })
        pendingScroll.current = z.scrollLeft
        setUserPpm(z.pxPerMs)
        return
      }
      el.scrollLeft += e.deltaY + e.deltaX
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const zoomBy = useCallback(
    (factor: number) => {
      const el = scrollRef.current
      if (!el) return
      const z = zoomAround({ pxPerMs: ppmRef.current, factor, anchorPx: el.clientWidth / 2, scrollLeft: el.scrollLeft, viewportPx: el.clientWidth, totalMs: mapRef.current.totalMs })
      pendingScroll.current = z.scrollLeft
      setUserPpm(z.pxPerMs)
    },
    []
  )
  const fitAll = useCallback(() => {
    pendingScroll.current = 0
    setUserPpm(0)
    if (scrollRef.current) scrollRef.current.scrollLeft = 0
  }, [])

  // slider em escala logarítmica entre "cabe tudo" e o máximo
  const sliderValue = fit >= MAX_PX_PER_MS ? 0 : Math.round((Math.log(ppm / fit) / Math.log(MAX_PX_PER_MS / fit)) * ZOOM_SLIDER_STEPS)
  const onSlider = (v: number): void => {
    const el = scrollRef.current
    if (!el) return
    const target = fit * Math.pow(MAX_PX_PER_MS / fit, v / ZOOM_SLIDER_STEPS)
    zoomBy(target / ppmRef.current)
  }

  // --- cabeça de reprodução ------------------------------------------------------------------------------
  const seekSource = useCallback(
    (sourceMs: number) => {
      engineRef.current?.seekSource(sourceMs)
    },
    [engineRef]
  )
  const scrub = useCallback(
    (clientX: number, phase: 'down' | 'move' | 'up') => {
      const rect = contentRef.current?.getBoundingClientRect()
      if (!rect) return
      if (phase === 'down') engineRef.current?.pause()
      if (phase === 'up') return
      const x = clientX - rect.left
      engineRef.current?.seekSource(view.toSource(x))
    },
    [engineRef, view]
  )

  // --- ímã -----------------------------------------------------------------------------------------------
  const getSnap = useCallback(
    (skip?: { kind: 'zoom' | 'layout'; id: string }): number[] => {
      const p = store.getState().project
      const out: number[] = [0, durationMs, playback.getState().sourceMs]
      for (const c of p.cuts) if (c.enabled) out.push(c.start, c.end)
      for (const z of p.zooms) if (!(skip?.kind === 'zoom' && skip.id === z.id)) out.push(z.start, z.end)
      for (const l of p.layouts) if (!(skip?.kind === 'layout' && skip.id === l.id)) out.push(l.start, l.end)
      return out
    },
    [store, playback, durationMs]
  )

  // --- trilhas de segmentos --------------------------------------------------------------------------
  const zoomLane: LaneApi = useMemo(
    () => ({
      kind: 'zoom',
      empty: t.editor.timeline.noZoomsHint,
      items: zooms.map<LaneItem>((z) => {
        const scale = t.editor.zoom.scaleValue(z.scale)
        const manual = z.origin === 'manual'
        return {
          id: z.id,
          start: z.start,
          end: z.end,
          variant: manual ? 'manual' : 'auto',
          label: (
            <>
              <ZoomInIcon size={12} />
              <b className="tnum">{scale}</b>
              {z.focus !== 'auto' ? <em>{t.editor.zoom.focusManual}</em> : null}
            </>
          ),
          title: t.editor.timeline.zoomSeg(scale, manual),
          aria: t.editor.timeline.zoomSeg(scale, manual)
        }
      }),
      move: (base, id, delta) => moveZoom(base, id, delta, durationMs),
      resize: (base, id, edge, to) => resizeZoom(base, id, edge, to, durationMs),
      create: (a, b) => ops.createZoomDrag(a, b)
    }),
    [zooms, durationMs, ops]
  )

  const layoutLane: LaneApi = useMemo(
    () => ({
      kind: 'layout',
      empty: t.editor.timeline.layoutEmpty(LAYOUT_NAMES[defaultLayout]),
      items: layouts.map<LaneItem>((l) => ({
        id: l.id,
        start: l.start,
        end: l.end,
        label: <b>{LAYOUT_NAMES[l.layout]}</b>,
        title: t.editor.timeline.layoutSeg(LAYOUT_NAMES[l.layout]),
        aria: t.editor.timeline.layoutSeg(LAYOUT_NAMES[l.layout])
      })),
      move: (base, id, delta) => moveLayoutSeg(base, id, delta, durationMs),
      resize: (base, id, edge, to) => resizeLayoutSeg(base, id, edge, to, durationMs),
      create: (a, b) => ops.createLayout(a, b, pickNewLayout(defaultLayout, hasScreen, hasCamera, isVertical))
    }),
    [layouts, defaultLayout, durationMs, ops, hasScreen, hasCamera, isVertical]
  )

  const counts = zoomCounts({ zooms })
  const cutMs = useMemo(() => durationMs - kept.reduce((acc, r) => acc + (r.end - r.start), 0), [durationMs, kept])
  const hasRange = Boolean(range && range.end - range.start > 0)

  // clicar fora de qualquer trilha (na régua não) tira a seleção quando for um clique no fundo
  const onBackground = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget && selection) store.getState().setSelection(null)
  }

  return (
    <section className="tl" data-testid="timeline" aria-label={t.editor.timeline.label}>
      <div className="tl-toolbar" role="toolbar" aria-label={t.editor.timeline.label}>
        <div className="tl-tools">
          <IconButton icon={<ScissorsIcon size={16} />} text={t.editor.timeline.cut} label={t.editor.timeline.cutTip} keys="Delete" disabled={!hasRange} onClick={() => ops.cutRange()} testId="tl-cut" />
          <IconButton icon={<SplitIcon size={16} />} text={t.editor.timeline.split} label={t.editor.timeline.splitTip} keys="S" onClick={() => ops.splitAtPlayhead()} testId="tl-split" />
          <IconButton icon={<ZoomInIcon size={16} />} text={t.editor.timeline.zoomHere} label={t.editor.timeline.zoomHereTip} keys="Z" onClick={() => ops.zoomFromRange()} testId="tl-zoom-here" />
          <span className="tl-sep" aria-hidden="true" />
          <p className="tl-status tnum" data-testid="tl-status">
            {hasRange && range ? (
              <>
                <span className="tl-status-key">{t.editor.timeline.selection}</span> {t.editor.timeline.rangeLabel(formatTimecode(range.start), formatTimecode(range.end), formatSpan(range.end - range.start))}
              </>
            ) : cutMs > 0 ? (
              t.editor.timeline.cutTotal(formatSpan(cutMs))
            ) : (
              <span className="tl-status-muted">{t.editor.timeline.noSelection}</span>
            )}
          </p>
        </div>
        <div className="tl-view">
          <Tip label={t.editor.timeline.hideCutsTip} side="top">
            <button type="button" className="ibtn" data-with-text="true" aria-pressed={hideCuts} data-testid="tl-hide-cuts" onClick={() => setHideCuts((v) => !v)}>
              <CollapseIcon size={16} />
              <span>{hideCuts ? t.editor.timeline.showCuts : t.editor.timeline.hideCuts}</span>
            </button>
          </Tip>
          <span className="tl-sep" aria-hidden="true" />
          <IconButton icon={<MinusIcon size={16} />} label={t.editor.timeline.zoomOut} keys="Ctrl+Roda" size="sm" onClick={() => zoomBy(1 / 1.5)} testId="tl-zoom-out" />
          <input
            type="range"
            className="slider tl-zoom-slider"
            min={0}
            max={ZOOM_SLIDER_STEPS}
            step={1}
            value={Math.max(0, Math.min(ZOOM_SLIDER_STEPS, sliderValue))}
            style={{ ['--p' as string]: `${(Math.max(0, Math.min(ZOOM_SLIDER_STEPS, sliderValue)) / ZOOM_SLIDER_STEPS) * 100}%` }}
            aria-label={t.editor.timeline.zoomSlider}
            data-testid="tl-zoom-slider"
            onChange={(e) => onSlider(Number(e.target.value))}
          />
          <IconButton icon={<PlusIcon size={16} />} label={t.editor.timeline.zoomIn} keys="Ctrl+Roda" size="sm" onClick={() => zoomBy(1.5)} testId="tl-zoom-in" />
          <IconButton icon={<FitIcon size={16} />} label={t.editor.timeline.fitTip} size="sm" onClick={fitAll} testId="tl-fit" />
        </div>
      </div>

      <div className="tl-body">
        <div className="tl-labels" aria-hidden="true">
          <div className="tl-label tl-label-ruler" />
          <div className="tl-label" data-track="video">
            {t.editor.timeline.tracks.video}
          </div>
          <div className="tl-label" data-track="zoom">
            {t.editor.timeline.tracks.zoom}
            <small className="tnum">{counts.auto + counts.manual}</small>
          </div>
          <div className="tl-label" data-track="layout">
            {t.editor.timeline.tracks.layout}
          </div>
        </div>
        <div
          className="tl-scroll"
          ref={scrollRef}
          data-testid="timeline-scroll"
          data-px-per-ms={ppm}
          data-scroll-left={Math.round(scrollLeft)}
          data-hide-cuts={hideCuts}
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        >
          <div className="tl-content" ref={contentRef} style={{ width: contentW }} data-testid="timeline-content" onPointerDown={onBackground}>
            <Ruler view={view} onScrub={scrub} />
            <VideoTrack view={view} getSnap={getSnap} onSnapGuide={setGuide} onSeek={seekSource} />
            <SegmentLane lane={zoomLane} view={view} getSnap={getSnap} onSnapGuide={setGuide} onSeek={seekSource} />
            <SegmentLane lane={layoutLane} view={view} getSnap={getSnap} onSnapGuide={setGuide} onSeek={seekSource} />
            {guide !== null ? <div className="tl-guide" data-testid="snap-guide" style={{ transform: `translateX(${view.toX(guide)}px)` }} /> : null}
            <Playhead view={view} />
          </div>
        </div>
      </div>
      <PlayheadFollower view={view} scrollRef={scrollRef} />
    </section>
  )
}
