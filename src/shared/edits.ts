/**
 * Edições do DOCUMENTO que a interface faz (zooms e trechos de layout): criar, mover, redimensionar, dividir,
 * apagar, trocar escala/foco/layout, regenerar os zooms automáticos. Funções PURAS sobre `Project`: recebem o
 * documento e devolvem um documento NOVO (ou o mesmo objeto, se nada mudou). Sem DOM, sem Node.
 *
 * Regras:
 *  - zoom e trecho de layout nunca se sobrepõem aos vizinhos (`segments.ts`);
 *  - qualquer edição à mão de um zoom o marca como `manual`: "gerar de novo a partir dos cliques" só
 *    substitui os automáticos e MANTÉM os que a pessoa mexeu.
 */
import { MIN_SEG_MS, moveSeg, newSegRange, nextSegId, resizeSeg, segAt, sortedSegs, splitSeg, type SegBounds } from './segments'
import { mergeAutoZooms, MAX_ZOOM_SCALE } from './zoom'
import type { LayoutKind, LayoutSeg, Project, Zoom, ZoomFocus, ZoomPresetId } from './types'

/** Zoom criado à mão: no mínimo isto (ms) e com esta escala (a do preset Moderado). */
export const MANUAL_ZOOM_MIN_MS = 400
export const MANUAL_ZOOM_SCALE = 1.7
/** Escala que o painel aceita para um zoom. */
export const ZOOM_SCALE_MIN = 1.1
export const ZOOM_SCALE_MAX = 4
/** Trecho de layout criado à mão: no mínimo isto (ms). */
export const LAYOUT_MIN_MS = 500

const zoomBounds = (durationMs: number): SegBounds => ({ min: 0, max: durationMs, minLen: MANUAL_ZOOM_MIN_MS })
const layoutBounds = (durationMs: number): SegBounds => ({ min: 0, max: durationMs, minLen: LAYOUT_MIN_MS })

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

const touch = (z: Zoom): Zoom => (z.origin === 'manual' ? z : { ...z, origin: 'manual' })

// ---------------------------------------------------------------------------
// Zooms

/** Cria um zoom manual arrastando de `a` até `b`. `null` se o gesto não cabe (em cima de outro zoom, curto demais). */
export function createZoom(p: Project, a: number, b: number, durationMs: number, scale = MANUAL_ZOOM_SCALE): { project: Project; id: string } | null {
  const range = newSegRange(p.zooms, a, b, zoomBounds(durationMs))
  if (!range) return null
  const id = nextSegId(p.zooms, 'zoom')
  const zoom: Zoom = { id, start: range.start, end: range.end, scale: clamp(scale, ZOOM_SCALE_MIN, MAX_ZOOM_SCALE), focus: 'auto', origin: 'manual' }
  return { project: { ...p, zooms: sortedSegs([...p.zooms, zoom]) }, id }
}

/** Um zoom de `ms` de duração a partir de `at` (tecla Z sem seleção). O trecho se ajusta ao espaço livre. */
export function createZoomAt(p: Project, at: number, ms: number, durationMs: number): { project: Project; id: string } | null {
  return createZoom(p, at, at + ms, durationMs)
}

function mapZoom(p: Project, id: string, fn: (z: Zoom) => Zoom): Project {
  if (!p.zooms.some((z) => z.id === id)) return p
  return { ...p, zooms: p.zooms.map((z) => (z.id === id ? fn(z) : z)) }
}

export function moveZoom(p: Project, id: string, delta: number, durationMs: number): Project {
  const moved = moveSeg(p.zooms, id, delta, zoomBounds(durationMs))
  return changed(p.zooms, moved) ? { ...p, zooms: moved.map((z) => (z.id === id ? touch(z) : z)) } : p
}

export function resizeZoom(p: Project, id: string, edge: 'start' | 'end', to: number, durationMs: number): Project {
  const resized = resizeSeg(p.zooms, id, edge, to, zoomBounds(durationMs))
  return changed(p.zooms, resized) ? { ...p, zooms: resized.map((z) => (z.id === id ? touch(z) : z)) } : p
}

export function setZoomScale(p: Project, id: string, scale: number): Project {
  const s = Math.round(clamp(scale, ZOOM_SCALE_MIN, ZOOM_SCALE_MAX) * 100) / 100
  return mapZoom(p, id, (z) => (z.scale === s && z.origin === 'manual' ? z : { ...z, scale: s, origin: 'manual' }))
}

export function setZoomFocus(p: Project, id: string, focus: ZoomFocus): Project {
  const f: ZoomFocus = focus === 'auto' ? 'auto' : { x: clamp(focus.x, 0, 1), y: clamp(focus.y, 0, 1) }
  return mapZoom(p, id, (z) => ({ ...z, focus: f, origin: 'manual' }))
}

export function deleteZoom(p: Project, id: string): Project {
  return p.zooms.some((z) => z.id === id) ? { ...p, zooms: p.zooms.filter((z) => z.id !== id) } : p
}

/**
 * "Gerar de novo a partir dos cliques": troca os zooms automáticos pelos de `auto` (do preset) e mantém os
 * manuais. Um zoom automático que caísse em cima de um manual é descartado (o manual manda).
 */
export function regenerateZooms(p: Project, preset: ZoomPresetId | 'off', auto: readonly Zoom[]): Project {
  const manual = p.zooms.filter((z) => z.origin === 'manual')
  const free = auto.filter((a) => !manual.some((m) => a.start < m.end && a.end > m.start))
  return { ...p, zoomPreset: preset, zooms: mergeAutoZooms(manual, free) }
}

/** Quantos zooms automáticos e manuais o documento tem. */
export function zoomCounts(p: Pick<Project, 'zooms'>): { auto: number; manual: number } {
  let auto = 0
  let manual = 0
  for (const z of p.zooms) (z.origin === 'manual' ? manual++ : auto++)
  return { auto, manual }
}

// ---------------------------------------------------------------------------
// Trechos de layout

export function createLayoutSeg(p: Project, a: number, b: number, durationMs: number, layout: LayoutKind): { project: Project; id: string } | null {
  const range = newSegRange(p.layouts, a, b, layoutBounds(durationMs))
  if (!range) return null
  const id = nextSegId(p.layouts, 'layout')
  const seg: LayoutSeg = { id, start: range.start, end: range.end, layout }
  return { project: { ...p, layouts: sortedSegs([...p.layouts, seg]) }, id }
}

export function moveLayoutSeg(p: Project, id: string, delta: number, durationMs: number): Project {
  const moved = moveSeg(p.layouts, id, delta, layoutBounds(durationMs))
  return changed(p.layouts, moved) ? { ...p, layouts: moved } : p
}

export function resizeLayoutSeg(p: Project, id: string, edge: 'start' | 'end', to: number, durationMs: number): Project {
  const resized = resizeSeg(p.layouts, id, edge, to, layoutBounds(durationMs))
  return changed(p.layouts, resized) ? { ...p, layouts: resized } : p
}

export function setLayoutOfSeg(p: Project, id: string, layout: LayoutKind): Project {
  if (!p.layouts.some((l) => l.id === id && l.layout !== layout)) return p
  return { ...p, layouts: p.layouts.map((l) => (l.id === id ? { ...l, layout } : l)) }
}

export function deleteLayoutSeg(p: Project, id: string): Project {
  return p.layouts.some((l) => l.id === id) ? { ...p, layouts: p.layouts.filter((l) => l.id !== id) } : p
}

/**
 * Divide o layout no instante `t` (tecla S). Dentro de um trecho, parte o trecho em dois. Fora de qualquer
 * trecho (no layout padrão), cria dois trechos com o layout padrão, do vizinho anterior ao posterior, para
 * a pessoa poder trocar o layout de um dos lados. `null` se `t` está perto demais das bordas.
 */
export function splitLayoutAt(p: Project, t: number, durationMs: number): { project: Project; id: string } | null {
  const sorted = sortedSegs(p.layouts)
  const seg = segAt(sorted, t)
  if (seg) {
    const id = nextSegId(p.layouts, 'layout')
    const parts = splitSeg(p.layouts, seg.id, t, id, LAYOUT_MIN_MS)
    return parts ? { project: { ...p, layouts: sortedSegs(parts) }, id } : null
  }
  let from = 0
  let to = durationMs
  for (const s of sorted) {
    if (s.end <= t) from = Math.max(from, s.end)
    else if (s.start > t) to = Math.min(to, s.start)
  }
  if (t - from < LAYOUT_MIN_MS || to - t < LAYOUT_MIN_MS) return null
  const first = nextSegId(p.layouts, 'layout')
  const second = nextSegId([...p.layouts, { id: first }], 'layout')
  const base = p.style.defaultLayout
  const cut = Math.round(t)
  const created: LayoutSeg[] = [
    { id: first, start: from, end: cut, layout: base },
    { id: second, start: cut, end: to, layout: base }
  ]
  return { project: { ...p, layouts: sortedSegs([...p.layouts, ...created]) }, id: second }
}

// ---------------------------------------------------------------------------

function changed(before: readonly { id: string; start: number; end: number }[], after: readonly { id: string; start: number; end: number }[]): boolean {
  return before.some((b, i) => b.start !== after[i]?.start || b.end !== after[i]?.end)
}

/** Piso para o `MIN_SEG_MS` padrão (reexportado para a interface). */
export { MIN_SEG_MS }
