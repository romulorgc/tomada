/**
 * Regras PURAS do motor de reprodução da prévia: avanço do relógio único pulando os cortes, correção de
 * deriva das mídias, pré-busca do próximo trecho e as teclas J/K/L. O motor (`renderer/editor/engine.ts`)
 * só liga isto aos `<video>`/`<audio>`. Tudo em milissegundos de ORIGEM. Sem DOM, sem Node.
 */
import type { Range } from './types'

// ---------------------------------------------------------------------------
// Relógio

export type ClockStep = {
  /** Novo instante de origem. */
  t: number
  /** Se o relógio caiu num corte: de onde saiu e para onde pulou. */
  jump: { from: number; to: number } | null
  /** Chegou ao fim (ou ao começo, andando para trás): quem chama para. */
  ended: boolean
}

/**
 * Avança o relógio `dtMs` à velocidade `rate` (negativa = para trás). Se o instante novo cai num trecho
 * cortado, pula para o início do próximo trecho mantido (ou para o fim do anterior, andando para trás).
 * Sem trecho para onde ir, termina.
 */
export function advanceClock(t: number, dtMs: number, rate: number, kept: readonly Range[]): ClockStep {
  if (kept.length === 0) return { t, jump: null, ended: true }
  const first = kept[0]!
  const last = kept[kept.length - 1]!
  const n = t + dtMs * rate
  if (rate >= 0) {
    for (const r of kept) if (n >= r.start && n < r.end) return { t: n, jump: null, ended: false }
    if (n >= last.end) return { t: last.end, jump: null, ended: true }
    const next = kept.find((r) => r.start > n)!
    return { t: next.start, jump: { from: n, to: next.start }, ended: false }
  }
  for (const r of kept) if (n >= r.start && n < r.end) return { t: n, jump: null, ended: false }
  if (n < first.start) return { t: first.start, jump: null, ended: true }
  let prev = first
  for (const r of kept) if (r.end <= n) prev = r
  const to = Math.max(prev.start, prev.end - 1)
  return { t: to, jump: { from: n, to }, ended: false }
}

/** Índice do trecho mantido que contém `t` (ou -1 se `t` está num corte). */
export function keptIndexAt(kept: readonly Range[], t: number): number {
  for (let i = 0; i < kept.length; i++) if (t >= kept[i]!.start && t < kept[i]!.end) return i
  return -1
}

/**
 * Pré-busca: quando falta pouco (`leadMs`) para o fim do trecho atual e existe um próximo, devolve o
 * início dele. O motor deixa a segunda cópia do vídeo parada nesse ponto, pronta para assumir na emenda.
 */
export function prefetchTarget(kept: readonly Range[], t: number, leadMs: number): { index: number; start: number } | null {
  const i = keptIndexAt(kept, t)
  if (i < 0 || i >= kept.length - 1) return null
  const cur = kept[i]!
  if (cur.end - t > leadMs) return null
  const next = kept[i + 1]!
  return { index: i + 1, start: next.start }
}

// ---------------------------------------------------------------------------
// Deriva das mídias

/** Deriva tolerada (em quadros) antes de corrigir: mais que isso é visível como lábio fora do som. */
export const DRIFT_FRAMES = 1.5
/** Uma mídia que já está alcançando o relógio só para de acelerar/frear abaixo disto (histerese: não oscila). */
export const DRIFT_SETTLE_FRAMES = 0.5
/** Quanto a velocidade é ajustada para alcançar o relógio sem pular (fração da velocidade). */
export const DRIFT_NUDGE = 0.06
/** Acima disto (ms) não adianta alcançar: busca direto. */
export const DRIFT_SEEK_MS = 400

export type DriftFix =
  /** Dentro da tolerância: velocidade nominal. */
  | { kind: 'ok'; rate: number }
  /** Pequena: acelera ou freia um pouco até alcançar o relógio. */
  | { kind: 'nudge'; rate: number }
  /** Grande: busca o instante certo. */
  | { kind: 'seek'; rate: number }

/**
 * O que fazer com uma mídia cujo instante difere do relógio em `driftMs` (mídia − relógio: positivo =
 * adiantada). `rate` é a velocidade nominal do relógio; `frameMs` a duração de um quadro da mídia.
 */
export function driftFix(
  driftMs: number,
  frameMs: number,
  rate: number,
  opts: { nudge?: number; seekMs?: number; toleranceFrames?: number } = {}
): DriftFix {
  const tolerance = frameMs * (opts.toleranceFrames ?? DRIFT_FRAMES)
  const abs = Math.abs(driftMs)
  if (!Number.isFinite(driftMs) || abs <= tolerance) return { kind: 'ok', rate }
  if (abs > (opts.seekMs ?? DRIFT_SEEK_MS)) return { kind: 'seek', rate }
  const nudge = opts.nudge ?? DRIFT_NUDGE
  const sign = driftMs > 0 ? -1 : 1 // adiantada freia, atrasada acelera
  return { kind: 'nudge', rate: Math.min(16, Math.max(0.0625, rate * (1 + sign * nudge))) }
}

// ---------------------------------------------------------------------------
// Quadros e teclas

export const DEFAULT_FPS = 30

/** Duração de um quadro (ms) para uma taxa; sem taxa válida, 30 qps. */
export function frameDurationMs(fps: number | undefined): number {
  return 1000 / (fps && fps > 0 ? fps : DEFAULT_FPS)
}

/** Anda `frames` quadros (negativo = volta) no tempo de SAÍDA, sem sair de [0, totalMs]. */
export function stepOutputMs(outMs: number, frames: number, fps: number | undefined, totalMs: number): number {
  const next = outMs + frames * frameDurationMs(fps)
  return Math.min(Math.max(0, totalMs), Math.max(0, next))
}

/** Velocidades do "shuttle" (J/L repetidos). */
export const SHUTTLE_RATES = [1, 2, 4] as const

/**
 * J/K/L estilo ilha de edição: L toca para a frente (de novo = mais rápido), J toca para trás,
 * K para. Devolve a velocidade nova (0 = parado; negativa = para trás).
 */
export function shuttleRate(current: number, key: 'J' | 'K' | 'L'): number {
  if (key === 'K') return 0
  const dir = key === 'L' ? 1 : -1
  if (current === 0 || Math.sign(current) !== dir) return dir
  const abs = Math.abs(current)
  const i = SHUTTLE_RATES.findIndex((r) => r === abs)
  const next = SHUTTLE_RATES[Math.min(SHUTTLE_RATES.length - 1, i < 0 ? 0 : i + 1)]!
  return dir * next
}
