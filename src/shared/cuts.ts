/**
 * Operações sobre os cortes do documento (`project.cuts`): cortar um intervalo, restaurar, reativar.
 * Tudo em milissegundos de ORIGEM. Código puro: sem DOM, sem Node.
 *
 * Restaurar um corte MANUAL o apaga; restaurar um corte automático (silêncio, muleta, recomeço, IA) só o
 * desliga (`enabled: false`), para a pessoa poder reativá-lo depois com um clique.
 */
import { nextSegId } from './segments'
import type { Cut } from './types'

/** Cortes menores que isto (ms) são ignorados: um clique sem querer não vira corte. */
export const MIN_CUT_MS = 40

/**
 * Corta [start, end): vira um corte `manual` ligado. Cortes manuais ligados que se tocam ou se
 * sobrepõem se fundem num só (o do primeiro id), então cortar "por cima" não empilha cortes.
 */
export function addManualCut(cuts: readonly Cut[], start: number, end: number, durationMs: number): Cut[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(durationMs > 0)) return [...cuts]
  let a = Math.round(Math.max(0, Math.min(start, end)))
  let b = Math.round(Math.min(durationMs, Math.max(start, end)))
  if (b - a < MIN_CUT_MS) return [...cuts]

  const touching = cuts.filter((c) => c.reason === 'manual' && c.enabled && c.start <= b && c.end >= a)
  for (const c of touching) {
    a = Math.min(a, c.start)
    b = Math.max(b, c.end)
  }
  const keep = cuts.filter((c) => !touching.includes(c))
  const id = touching[0]?.id ?? nextSegId(cuts, 'cut')
  const created: Cut = { id, start: a, end: b, reason: 'manual', enabled: true }
  return [...keep, created].sort((x, y) => x.start - y.start || x.end - y.end)
}

/** Cortes LIGADOS que cobrem o instante `t`. */
export function enabledCutsAt(cuts: readonly Cut[], t: number): Cut[] {
  return cuts.filter((c) => c.enabled && t >= c.start && t < c.end)
}

/** Restaura o que está cortado em `t`: manual some, automático é desligado. */
export function restoreAt(cuts: readonly Cut[], t: number): Cut[] {
  const hit = new Set(enabledCutsAt(cuts, t).map((c) => c.id))
  if (hit.size === 0) return [...cuts]
  const out: Cut[] = []
  for (const c of cuts) {
    if (!hit.has(c.id)) out.push(c)
    else if (c.reason !== 'manual') out.push({ ...c, enabled: false })
  }
  return out
}

/** Restaura um corte pelo id (mesma regra de `restoreAt`). */
export function restoreCut(cuts: readonly Cut[], id: string): Cut[] {
  const out: Cut[] = []
  for (const c of cuts) {
    if (c.id !== id) out.push(c)
    else if (c.reason !== 'manual') out.push({ ...c, enabled: false })
  }
  return out
}

/** Liga de novo um corte automático que tinha sido restaurado. */
export function reenableCut(cuts: readonly Cut[], id: string): Cut[] {
  return cuts.map((c) => (c.id === id ? { ...c, enabled: true } : c))
}

/** Quanto do vídeo a seleção [start, end) cortaria de verdade (ms): o que ainda não está cortado. */
export function newlyCutMs(cuts: readonly Cut[], start: number, end: number): number {
  const spans = cuts
    .filter((c) => c.enabled && c.end > start && c.start < end)
    .map((c) => ({ start: Math.max(start, c.start), end: Math.min(end, c.end) }))
    .sort((p, q) => p.start - q.start)
  let covered = 0
  let cursor = start
  for (const s of spans) {
    const from = Math.max(cursor, s.start)
    if (s.end > from) covered += s.end - from
    cursor = Math.max(cursor, s.end)
  }
  return Math.max(0, end - start - covered)
}
