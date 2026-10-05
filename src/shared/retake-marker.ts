import { z } from 'zod'
import { normalizeIntervals, toRecordingTime, type Interval } from './recording'
import type { Cut, Word } from './types'

export const retakeMarkSchema = z.object({ t: z.number().finite().min(0) })
export type RetakeMark = z.infer<typeof retakeMarkSchema>
export type RetakeDecision = RetakeMark & { start: number; end: number; confirmed: boolean; fallback: boolean }

/** A mídia pula a pausa: uma marca dentro dela não tem tempo de origem. */
export function markRecordingTime(now: number, t0: number, pauses: Interval[], openPause: number | null): RetakeMark | null {
  if (openPause !== null || !Number.isFinite(now) || !Number.isFinite(t0)) return null
  const t = toRecordingTime(now, t0, normalizeIntervals(pauses))
  return t === null ? null : { t: Math.round(t * 10) / 10 }
}

const normalized = (s: string): string => s.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '')

/** Marca explícita sempre corta; repetição dá confirmação, falta de fronteira pede revisão. */
export function deriveRetakeCuts({ words, marks, durationMs }: { words: readonly Word[]; marks: readonly RetakeMark[]; durationMs: number }): { cuts: Cut[]; decisions: RetakeDecision[] } {
  const ordered = words.filter((w) => w.kind !== 'gap-speech' && Number.isFinite(w.start) && Number.isFinite(w.end)).slice().sort((a, b) => a.start - b.start)
  const decisions: RetakeDecision[] = []
  const times = [...new Set(marks.map((m) => m.t).filter((t) => Number.isFinite(t) && t > 0 && t <= durationMs))].sort((a, b) => a - b)
  let previousMark = 0
  for (const t of times) {
    const before = ordered.filter((w) => w.start < t && w.end > previousMark)
    let frontier: number | null = null
    let first = 0
    for (let i = 1; i < before.length; i++) {
      const prev = before[i - 1]!, current = before[i]!
      if (/[.!?…]["'»”)]*$/.test(prev.text) || current.start - prev.end >= 700) {
        frontier = prev.end
        first = i
      }
    }
    // Início do vídeo é uma fronteira real se a primeira frase ainda cabe no fallback.
    if (frontier === null && before[0] && before[0].start <= 300 && t <= 6000) frontier = 0
    const fallback = frontier === null
    const start = Math.max(previousMark, frontier ?? Math.max(0, t - 6000))
    const next = ordered.find((w) => w.start >= t)
    // Só silêncio: nunca estende o corte por cima da primeira palavra retomada.
    const end = Math.min(durationMs, next && next.start - t <= 3000 ? next.start : t)
    const said = before.slice(first).map((w) => normalized(w.text)).filter(Boolean)
    const repeated = ordered.filter((w) => w.start >= t).slice(0, said.length).map((w) => normalized(w.text))
    const matches = said.filter((token, i) => token === repeated[i]).length
    const confirmed = said.length >= 2 && matches / said.length >= 0.72
    if (end > start) decisions.push({ t, start, end, confirmed, fallback })
    previousMark = t
  }
  return { decisions, cuts: decisions.map((d) => ({ id: `retake-mark-${d.t}`, start: d.start, end: d.end, reason: 'retake', enabled: true, origin: 'auto' })) }
}
