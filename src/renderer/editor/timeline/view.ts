/**
 * O "modelo de vista" da linha do tempo: escala (px por ms), rolagem, largura visível e o mapa
 * origem ↔ exibição, com as conversões que as trilhas usam. É recriado a cada mudança de escala,
 * rolagem ou cortes; as trilhas só leem dele.
 */
import { snapBlock, snapTime, type TimeMap } from '@shared/timeline-view'
import type { Range } from '@shared/types'

export type Span = {
  /** Onde o trecho começa no eixo de exibição (ms). */
  displayStart: number
  sourceStart: number
  sourceEnd: number
}

export type TimelineView = {
  map: TimeMap
  /** px por ms do eixo de exibição. */
  ppm: number
  scrollLeft: number
  viewportW: number
  durationMs: number
  /** Posição (px no conteúdo) de um instante de ORIGEM. */
  toX(sourceMs: number): number
  /** Instante de ORIGEM (limitado a [0, duração]) de uma posição em px no conteúdo. */
  toSource(x: number): number
  /** Os trechos desenhados: um só com os cortes à mostra; um por trecho mantido com eles escondidos. */
  spans(): Span[]
  /** Gruda um instante de ORIGEM nos candidatos (também de origem) dentro de `px` pixels. */
  snap(sourceMs: number, candidates: readonly number[], px?: number): { ms: number; target: number | null }
  /** Gruda um segmento (bordas `start`/`end` de origem) movido como bloco: devolve o deslocamento ajustado. */
  snapBlock(start: number, end: number, candidates: readonly number[], px?: number): { delta: number; target: number | null }
}

export const SNAP_PX = 8

export function createTimelineView(opts: { map: TimeMap; ppm: number; scrollLeft: number; viewportW: number; durationMs: number; kept: readonly Range[] }): TimelineView {
  const { map, ppm, scrollLeft, viewportW, durationMs, kept } = opts
  const clampSource = (ms: number): number => Math.min(durationMs, Math.max(0, ms))
  const toDisplayCandidates = (c: readonly number[]): number[] => c.map((v) => map.toDisplay(v))
  return {
    map,
    ppm,
    scrollLeft,
    viewportW,
    durationMs,
    toX: (ms) => map.toDisplay(ms) * ppm,
    toSource: (x) => clampSource(map.fromDisplay(Math.min(map.totalMs, Math.max(0, x / ppm)))),
    spans() {
      if (!map.hideCuts) return [{ displayStart: 0, sourceStart: 0, sourceEnd: durationMs }]
      const out: Span[] = []
      for (const r of kept) out.push({ displayStart: map.toDisplay(r.start), sourceStart: r.start, sourceEnd: r.end })
      return out
    },
    snap(sourceMs, candidates, px = SNAP_PX) {
      const r = snapTime(map.toDisplay(sourceMs), toDisplayCandidates(candidates), px, ppm)
      if (r.target === null) return { ms: sourceMs, target: null }
      const idx = toDisplayCandidates(candidates).indexOf(r.target)
      const original = candidates[idx]
      return original === undefined ? { ms: sourceMs, target: null } : { ms: original, target: original }
    },
    snapBlock(start, end, candidates, px = SNAP_PX) {
      // o ímã trabalha no eixo de exibição (o alcance é em pixels); o deslocamento volta em ms de origem
      const ds = map.toDisplay(start)
      const r = snapBlock(ds, map.toDisplay(end), toDisplayCandidates(candidates), px, ppm)
      if (r.target === null) return { delta: 0, target: null }
      const original = candidates[toDisplayCandidates(candidates).indexOf(r.target)]
      if (original === undefined) return { delta: 0, target: null }
      const viaStart = Math.abs(ds + r.delta - r.target) < 1e-6
      return { delta: original - (viaStart ? start : end), target: original }
    }
  }
}
