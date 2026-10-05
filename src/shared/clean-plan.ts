/**
 * O que a limpeza faria com o documento ANTES de aplicar (a "prévia do ganho" do painel Limpeza) e a mesma conta
 * usada para aplicar: assim o número que a pessoa vê é o número que acontece. Código puro.
 */
import { applyCleanup, scopeOf, type CleanOptions, type CleanResult } from './clean'
import { durationAfter } from './text-edit'
import type { Cut, Mute } from './types'

export type CleanPlan = {
  /** Cortes e silenciamentos que o documento terá depois de aplicar. */
  cuts: Cut[]
  mutes: Mute[]
  /** O documento muda de verdade? (falso = aplicar não faz nada) */
  changed: boolean
  /** Duração do vídeo com os cortes de agora e com os cortes depois de aplicar (ms). */
  fromMs: number
  toMs: number
  /** Quanto a duração cai (ms); negativo se a limpeza devolve tempo (ex.: trocar "Rápido" por "Natural"). */
  deltaMs: number
}

const sameCuts = (a: readonly Cut[], b: readonly Cut[]): boolean =>
  a.length === b.length && a.every((c, k) => c.start === b[k]!.start && c.end === b[k]!.end && c.enabled === b[k]!.enabled && c.reason === b[k]!.reason)

const sameMutes = (a: readonly Mute[], b: readonly Mute[]): boolean =>
  a.length === b.length && a.every((m, k) => m.start === b[k]!.start && m.end === b[k]!.end && m.enabled === b[k]!.enabled && m.reason === b[k]!.reason)

/** Aplica o resultado da limpeza a uma cópia do documento e mede. Não mexe no que recebe. */
export function planClean(doc: { cuts: readonly Cut[]; mutes?: readonly Mute[] }, result: CleanResult, options: CleanOptions, durationMs: number): CleanPlan {
  const applied = applyCleanup(doc, result.items, scopeOf(options))
  const fromMs = durationAfter(durationMs, doc.cuts)
  const toMs = durationAfter(durationMs, applied.cuts)
  const changed = !sameCuts(doc.cuts, applied.cuts) || !sameMutes(doc.mutes ?? [], applied.mutes)
  return { cuts: applied.cuts, mutes: applied.mutes, changed, fromMs, toMs, deltaMs: fromMs - toMs }
}
