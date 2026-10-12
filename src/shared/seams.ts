/**
 * Emendas: os pontos onde dois trechos mantidos se encontram depois dos cortes. Código puro (sem DOM, sem Node): a
 * exportação (`audio-graph.ts`), a prévia (`renderer/editor/engine.ts`), o enquadramento (`punch-in.ts`) e a prova
 * (`seam-proof.ts`) leem as emendas por aqui, então a regra é UMA só nos dois lados (prévia = exportação).
 *
 * Tempo de ORIGEM e de SAÍDA em milissegundos.
 *
 * O áudio da emenda é um cruzamento de potência igual (curva `qsin`) de `CROSSFADE_MS` com **alças reais**: o trecho
 * da esquerda avança `halfMs` para dentro do que foi cortado e o da direita recua `halfMs`, de modo que o meio do
 * cruzamento cai exatamente no corte do vídeo (o som não adianta nem atrasa) e nenhum lado passa por silêncio digital.
 */
import type { Range } from './types'

/** Duração do cruzamento de áudio de uma emenda (ms): 60-80 ms nas referências. */
export const CROSSFADE_MS = 70
/** Abaixo disto (ms de alça por lado) a emenda é um corte seco com microfade: não há material para cruzar. */
export const MIN_HALF_MS = 1

export type Seam = {
  /** A emenda está entre `kept[index]` e `kept[index + 1]`. */
  index: number
  /** Instante de SAÍDA (ms) da emenda: onde o trecho `index` termina na saída. */
  outMs: number
  /** Tempo de origem em que o trecho anterior termina e em que o seguinte começa. */
  leftEnd: number
  rightStart: number
  /** Quanto foi cortado entre os dois (ms de origem). */
  removedMs: number
  /** Metade do cruzamento (ms): a alça real de cada lado. 0 = sem material (corte seco). */
  halfMs: number
}

/**
 * As emendas de uma lista de trechos mantidos (`keptRanges`). A alça de cada lado é a menor entre metade do cruzamento, metade
 * do que foi cortado (as duas alças não se encavalam) e metade de cada trecho vizinho (o trecho do meio cabe os dois cruzamentos).
 */
export function planSeams(kept: readonly Range[], crossfadeMs: number = CROSSFADE_MS): Seam[] {
  const out: Seam[] = []
  let acc = 0
  for (let i = 0; i + 1 < kept.length; i++) {
    const a = kept[i]!
    const b = kept[i + 1]!
    acc += a.end - a.start
    const removed = Math.max(0, b.start - a.end)
    const half = Math.max(0, Math.min(crossfadeMs / 2, removed / 2, (a.end - a.start) / 2, (b.end - b.start) / 2))
    out.push({ index: i, outMs: acc, leftEnd: a.end, rightStart: b.start, removedMs: removed, halfMs: half >= MIN_HALF_MS ? half : 0 })
  }
  return out
}

/** Alça (ms) que o trecho `i` precisa de cada lado: no começo (emenda anterior) e no fim (emenda seguinte). */
export function handlesOf(seams: readonly Seam[], i: number): { head: number; tail: number } {
  return { head: i > 0 ? (seams[i - 1]?.halfMs ?? 0) : 0, tail: seams[i]?.halfMs ?? 0 }
}

/** Emendas por minuto do vídeo de saída. */
export function seamsPerMinute(seamCount: number, outputMs: number): number {
  return outputMs > 0 ? (seamCount / outputMs) * 60_000 : 0
}

// ---------------------------------------------------------------------------
// Qual trecho mantido contém um instante

/** Índice do trecho mantido que contém `t` (origem); `-1` se `t` caiu num corte. Busca binária. */
export function keptIndexOf(kept: readonly Range[], t: number): number {
  let lo = 0
  let hi = kept.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = kept[mid]!
    if (t < r.start) hi = mid - 1
    else if (t >= r.end) lo = mid + 1
    else return mid
  }
  return -1
}

// ---------------------------------------------------------------------------
// Curva do cruzamento

/**
 * Ganhos do cruzamento de potência igual no ponto `u` (0 = começo, 1 = fim): o `qsin` do ffmpeg (`acrossfade ... c1=qsin c2=qsin`).
 * Quem sai vale cos(u·π/2) e quem entra sin(u·π/2), então `out² + in² = 1` em todo o cruzamento (−3 dB para cada lado no meio).
 * A prévia usa esta mesma função nos volumes dos dois `<audio>`.
 */
export function equalPowerGains(u: number): { out: number; in: number } {
  const x = Math.min(1, Math.max(0, u))
  return { out: Math.cos((x * Math.PI) / 2), in: Math.sin((x * Math.PI) / 2) }
}
