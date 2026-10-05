/**
 * Trilha de segmentos (Zoom e Layout): CRIAR arrastando no espaço vazio, MOVER arrastando o corpo,
 * REDIMENSIONAR pelas bordas, selecionar com clique. Os arrastes viram UM passo de desfazer, partem do
 * documento do instante em que o gesto começou (sem acumular erro) e grudam (ímã) na cabeça de reprodução e
 * nas bordas dos outros itens. Nenhum segmento atravessa o vizinho.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Project } from '@shared/types'
import { useDoc, useEditor } from '../context'
import type { TimelineView } from './view'

const DRAG_PX = 4
const EDGE_PX = 7

export type LaneItem = {
  id: string
  start: number
  end: number
  label: ReactNode
  title: string
  /** Texto de acessibilidade completo. */
  aria: string
  variant?: string
}

export type LaneApi = {
  kind: 'zoom' | 'layout'
  items: LaneItem[]
  /** Documento depois de mover o segmento `id` por `delta` ms (a partir de `base`). */
  move(base: Project, id: string, delta: number): Project
  resize(base: Project, id: string, edge: 'start' | 'end', to: number): Project
  /** Cria arrastando de `a` até `b`; devolve o id criado (ou null). */
  create(a: number, b: number): string | null
  empty: string
}

type Gesture =
  | { mode: 'create'; a: number; x0: number; moved: boolean }
  | { mode: 'move'; id: string; x0: number; base: Project; start: number; end: number; moved: boolean }
  | { mode: 'resize'; id: string; edge: 'start' | 'end'; x0: number; base: Project; start: number; end: number; moved: boolean }

export function SegmentLane({
  lane,
  view,
  getSnap,
  onSnapGuide,
  onSeek
}: {
  lane: LaneApi
  view: TimelineView
  /** Candidatos do ímã (instantes de origem), lidos na hora do gesto; `skip` tira o próprio item. */
  getSnap: (skip?: { kind: 'zoom' | 'layout'; id: string }) => readonly number[]
  onSnapGuide: (ms: number | null) => void
  onSeek: (sourceMs: number) => void
}) {
  const { store } = useEditor()
  const selection = useDoc((s) => s.selection)
  const trackRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [ghost, setGhost] = useState<{ start: number; end: number } | null>(null)

  const xOf = (e: ReactPointerEvent): number => e.clientX - (trackRef.current?.getBoundingClientRect().left ?? 0)
  const capture = (e: ReactPointerEvent): void => trackRef.current?.setPointerCapture(e.pointerId)
  const selected = (id: string): boolean => selection?.kind === lane.kind && selection.id === id

  const select = (id: string): void => store.getState().setSelection({ kind: lane.kind, id })

  // --- começo do gesto -------------------------------------------------------------------------------
  const onLanePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const x = xOf(e)
    capture(e)
    gesture.current = { mode: 'create', a: view.toSource(x), x0: x, moved: false }
  }

  const onItemPointerDown = (e: ReactPointerEvent<HTMLDivElement>, item: LaneItem): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    const x = xOf(e)
    capture(e)
    select(item.id)
    store.getState().setRange(null)
    const x0 = view.toX(item.start)
    const x1 = view.toX(item.end)
    const edge: 'start' | 'end' | null = x - x0 <= EDGE_PX ? 'start' : x1 - x <= EDGE_PX ? 'end' : null
    store.getState().begin()
    const base = store.getState().project
    gesture.current = edge
      ? { mode: 'resize', id: item.id, edge, x0: x, base, start: item.start, end: item.end, moved: false }
      : { mode: 'move', id: item.id, x0: x, base, start: item.start, end: item.end, moved: false }
  }

  // --- movimento ----------------------------------------------------------------------------------
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current
    if (!g) return
    const x = xOf(e)
    if (!g.moved && Math.abs(x - g.x0) < DRAG_PX) return
    g.moved = true
    if (g.mode === 'create') {
      const candidates = getSnap()
      const a = view.snap(g.a, candidates)
      const b = view.snap(view.toSource(x), candidates)
      onSnapGuide(b.target)
      setGhost({ start: Math.min(a.ms, b.ms), end: Math.max(a.ms, b.ms) })
      return
    }
    if (g.mode === 'move') {
      // o deslocamento é medido no eixo de exibição e volta em ms de origem
      const shown = view.map.toDisplay(g.start) + (x - g.x0) / view.ppm
      let delta = view.map.fromDisplay(Math.max(0, shown)) - g.start
      const snapped = view.snapBlock(g.start + delta, g.end + delta, getSnap({ kind: lane.kind, id: g.id }))
      delta += snapped.delta
      onSnapGuide(snapped.target)
      store.getState().change(() => lane.move(g.base, g.id, delta))
      return
    }
    const edgeMs = g.edge === 'start' ? g.start : g.end
    const shown = view.map.toDisplay(edgeMs) + (x - g.x0) / view.ppm
    const to = view.snap(view.map.fromDisplay(Math.max(0, shown)), getSnap({ kind: lane.kind, id: g.id }))
    onSnapGuide(to.target)
    store.getState().change(() => lane.resize(g.base, g.id, g.edge, to.ms))
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current
    gesture.current = null
    onSnapGuide(null)
    if (trackRef.current?.hasPointerCapture(e.pointerId)) trackRef.current.releasePointerCapture(e.pointerId)
    if (!g) return
    if (g.mode === 'create') {
      const ghostNow = ghost
      setGhost(null)
      if (!g.moved || !ghostNow) {
        // um clique no espaço vazio: tira a seleção e leva a cabeça de reprodução até lá
        store.getState().setSelection(null)
        store.getState().setRange(null)
        onSeek(view.toSource(xOf(e)))
        return
      }
      lane.create(ghostNow.start, ghostNow.end)
      return
    }
    store.getState().end()
  }

  return (
    <div
      className="tl-lane tl-seglane"
      ref={trackRef}
      data-testid={`track-${lane.kind}`}
      data-kind={lane.kind}
      onPointerDown={onLanePointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {lane.items.length === 0 && !ghost ? <span className="tl-lane-empty">{lane.empty}</span> : null}
      {lane.items.map((item) => {
        const left = view.toX(item.start)
        const width = Math.max(3, view.toX(item.end) - left)
        const on = selected(item.id)
        return (
          <div
            key={item.id}
            role="button"
            tabIndex={0}
            className="tl-seg"
            data-kind={lane.kind}
            data-variant={item.variant}
            data-selected={on}
            data-testid={`seg-${lane.kind}-${item.id}`}
            data-start={Math.round(item.start)}
            data-end={Math.round(item.end)}
            aria-label={item.aria}
            aria-pressed={on}
            title={item.title}
            style={{ left, width }}
            onPointerDown={(e) => onItemPointerDown(e, item)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') select(item.id)
            }}
          >
            <i className="tl-handle" data-edge="start" aria-hidden="true" />
            <span className="tl-seg-label">{item.label}</span>
            <i className="tl-handle" data-edge="end" aria-hidden="true" />
          </div>
        )
      })}
      {ghost ? (
        <div className="tl-seg tl-ghost" data-kind={lane.kind} style={{ left: view.toX(ghost.start), width: Math.max(2, view.toX(ghost.end) - view.toX(ghost.start)) }} aria-hidden="true" />
      ) : null}
    </div>
  )
}
