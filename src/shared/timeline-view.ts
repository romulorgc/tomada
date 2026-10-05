/**
 * Matemática da LINHA DO TEMPO da interface: pixels ↔ tempo, zoom da régua, rolagem, ticks da régua e
 * ímã (grudar bordas). Tudo puro (sem DOM, sem Node) e em milissegundos.
 *
 * Dois "eixos": o tempo de ORIGEM (o do documento) e o tempo de EXIBIÇÃO. Com os cortes à mostra os dois
 * são o mesmo; com "esconder cortes" o eixo colapsa para o tempo de SAÍDA (os trechos cortados somem e
 * as bordas se encostam). O documento só conhece a origem: toda posição que vem da tela passa por
 * `fromDisplay`.
 */
import { outputToSource, rangesLength, sourceToOutput } from './timeline'
import type { Range } from './types'

export type TimeMap = {
  hideCuts: boolean
  /** Duração do eixo de exibição (ms): a da gravação, ou a de saída com os cortes escondidos. */
  totalMs: number
  /** Origem → exibição. */
  toDisplay(sourceMs: number): number
  /** Exibição → origem. */
  fromDisplay(displayMs: number): number
}

export function createTimeMap(opts: { durationMs: number; kept: readonly Range[]; hideCuts: boolean }): TimeMap {
  const { durationMs, kept, hideCuts } = opts
  if (!hideCuts) {
    return { hideCuts, totalMs: durationMs, toDisplay: (t) => t, fromDisplay: (d) => d }
  }
  return {
    hideCuts,
    totalMs: rangesLength(kept),
    toDisplay: (t) => sourceToOutput(t, kept),
    fromDisplay: (d) => outputToSource(d, kept)
  }
}

// ---------------------------------------------------------------------------
// Zoom da linha do tempo

/** Zoom máximo: 0,5 px por ms (500 px por segundo; um quadro de 30 qps tem ~16 px). */
export const MAX_PX_PER_MS = 0.5

/** px/ms em que o eixo inteiro cabe na largura visível (com um respiro à direita). */
export function fitPxPerMs(viewportPx: number, totalMs: number, padPx = 24): number {
  if (!(totalMs > 0) || !(viewportPx > 0)) return 0.05
  return Math.max(0.0005, (viewportPx - padPx) / totalMs)
}

/** Limita o zoom entre "cabe tudo" e o máximo. */
export function clampPxPerMs(value: number, viewportPx: number, totalMs: number): number {
  const lo = fitPxPerMs(viewportPx, totalMs)
  const hi = Math.max(lo, MAX_PX_PER_MS)
  return Math.min(hi, Math.max(lo, value))
}

/**
 * Zoom ancorado: o instante que está sob o ponteiro (`anchorPx`, em px a partir da borda esquerda da
 * área visível) continua sob o ponteiro depois de trocar a escala. Devolve a escala e a rolagem novas.
 */
export function zoomAround(opts: {
  pxPerMs: number
  factor: number
  anchorPx: number
  scrollLeft: number
  viewportPx: number
  totalMs: number
}): { pxPerMs: number; scrollLeft: number } {
  const next = clampPxPerMs(opts.pxPerMs * opts.factor, opts.viewportPx, opts.totalMs)
  const anchorMs = (opts.scrollLeft + opts.anchorPx) / opts.pxPerMs
  const wanted = anchorMs * next - opts.anchorPx
  return { pxPerMs: next, scrollLeft: clampScroll(wanted, next, opts.viewportPx, opts.totalMs) }
}

/** Largura do conteúdo rolável (px): o eixo todo mais um respiro. */
export function contentWidthPx(totalMs: number, pxPerMs: number, padPx = 24): number {
  return Math.ceil(totalMs * pxPerMs + padPx)
}

export function clampScroll(scrollLeft: number, pxPerMs: number, viewportPx: number, totalMs: number): number {
  const max = Math.max(0, contentWidthPx(totalMs, pxPerMs) - viewportPx)
  return Math.min(max, Math.max(0, scrollLeft))
}

/** Rolagem que deixa `ms` visível, com folga nas bordas (para seguir a cabeça de reprodução). */
export function scrollToReveal(opts: { ms: number; scrollLeft: number; pxPerMs: number; viewportPx: number; totalMs: number; marginPx?: number }): number {
  const margin = opts.marginPx ?? 48
  const x = opts.ms * opts.pxPerMs
  let left = opts.scrollLeft
  if (x < left + margin) left = x - margin
  else if (x > left + opts.viewportPx - margin) left = x - opts.viewportPx + margin
  return clampScroll(left, opts.pxPerMs, opts.viewportPx, opts.totalMs)
}

/** Faixa de tempo (exibição) que cabe na área visível. */
export function visibleDisplayRange(scrollLeft: number, viewportPx: number, pxPerMs: number): { from: number; to: number } {
  return { from: Math.max(0, scrollLeft / pxPerMs), to: (scrollLeft + viewportPx) / pxPerMs }
}

export const msToPx = (ms: number, pxPerMs: number): number => ms * pxPerMs
export const pxToMs = (px: number, pxPerMs: number): number => px / pxPerMs

// ---------------------------------------------------------------------------
// Régua

/** Passos "redondos" da régua (ms). */
const TICK_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000]

/** O menor passo que deixa os rótulos com pelo menos `minLabelPx` entre si. */
export function rulerStepMs(pxPerMs: number, minLabelPx = 80): number {
  for (const step of TICK_STEPS) if (step * pxPerMs >= minLabelPx) return step
  return TICK_STEPS[TICK_STEPS.length - 1]!
}

/** `m:ss` (com décimos/centésimos quando o passo é menor que 1 s). */
export function rulerLabel(ms: number, stepMs: number): string {
  const total = Math.max(0, ms)
  const s = Math.floor(total / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const base = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
  if (stepMs >= 1000) return base
  const frac = Math.round(total % 1000)
  if (stepMs >= 100) return `${base}.${String(Math.floor(frac / 100))}`
  if (stepMs >= 10) return `${base}.${String(Math.floor(frac / 10)).padStart(2, '0')}`
  return `${base}.${String(frac).padStart(3, '0')}`
}

export type RulerTick = { ms: number; major: boolean; label: string | null }

/**
 * Ticks da régua entre `fromMs` e `toMs` (exibição). Os principais (com rótulo) caem de `step` em
 * `step`; entre eles há quatro secundários (se couberem a ≥ 6 px).
 */
export function rulerTicks(pxPerMs: number, fromMs: number, toMs: number, minLabelPx = 80): RulerTick[] {
  const step = rulerStepMs(pxPerMs, minLabelPx)
  const minor = step / 5
  const showMinor = minor * pxPerMs >= 6 && Number.isInteger(minor)
  const unit = showMinor ? minor : step
  const first = Math.floor(Math.max(0, fromMs) / unit) * unit
  const out: RulerTick[] = []
  for (let ms = first; ms <= toMs + unit; ms += unit) {
    const major = Math.abs(ms / step - Math.round(ms / step)) < 1e-9
    out.push({ ms, major, label: major ? rulerLabel(ms, step) : null })
  }
  return out
}

// ---------------------------------------------------------------------------
// Ímã

export type SnapResult = { ms: number; target: number | null }

/**
 * Gruda `ms` no candidato mais próximo que esteja a no máximo `thresholdPx` (em px da tela, então o
 * "alcance" do ímã é o mesmo em qualquer zoom). `target` é o candidato escolhido (ou `null` se nada
 * ficou perto).
 */
export function snapTime(ms: number, candidates: readonly number[], thresholdPx: number, pxPerMs: number): SnapResult {
  const reach = thresholdPx / pxPerMs
  let best: number | null = null
  let bestDist = Infinity
  for (const c of candidates) {
    const d = Math.abs(c - ms)
    if (d <= reach && d < bestDist) {
      best = c
      bestDist = d
    }
  }
  return best === null ? { ms, target: null } : { ms: best, target: best }
}

/**
 * Gruda um segmento que tem duas bordas (`start` e `end`) movido como um bloco: vale a borda que
 * chegou mais perto de um candidato. Devolve o deslocamento ajustado.
 */
export function snapBlock(start: number, end: number, candidates: readonly number[], thresholdPx: number, pxPerMs: number): { delta: number; target: number | null } {
  const a = snapTime(start, candidates, thresholdPx, pxPerMs)
  const b = snapTime(end, candidates, thresholdPx, pxPerMs)
  const da = a.target === null ? Infinity : Math.abs(a.ms - start)
  const db = b.target === null ? Infinity : Math.abs(b.ms - end)
  if (da === Infinity && db === Infinity) return { delta: 0, target: null }
  return da <= db ? { delta: a.ms - start, target: a.target } : { delta: b.ms - end, target: b.target }
}
