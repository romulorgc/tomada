/**
 * Limpeza automática do vídeo a partir da transcrição (M3). Código puro: sem DOM, sem Node, 100% testável.
 *
 * Entra: palavras (com `kind`), VAD (onde há fala), nível do áudio (microfone e som do computador), recomeços
 * apontados pela IA. Sai: uma lista de ITENS (cortes e silenciamentos) com o motivo de cada um; `applyCleanup` os
 * aplica ao documento como uma mudança só (o editor a desfaz com um Ctrl+Z).
 *
 * Regras que valem para tudo aqui:
 *  - **Borda nunca dentro de palavra**: todo corte começa e termina numa folga entre palavras, e deixa 30-200 ms de
 *    folga das palavras que ficam ("toda borda cai entre palavras").
 *  - **Silêncio só quando tudo está quieto**: o microfone E o som do computador abaixo do limiar, e o VAD sem fala.
 *    Fala que o VAD marcou e nenhuma palavra cobre (`gap-speech`) NÃO é silêncio.
 *  - **Hesitação pura corta por padrão; muleta com sentido só vira sugestão** ("né", "tipo", "então", "é").
 */
import { isHesitation, isSoftCrutch } from './fillers'
import { MIN_CUT_MS } from './cuts'
import { nextSegId } from './segments'
import type { Cut, Mute, Range, Word } from './types'
import type { RetakeSpan } from './transcription'

// ---------------------------------------------------------------------------
// Parâmetros

export type SilenceMode = 'natural' | 'fast' | 'faster'

/** Silêncio acima de `minMs` é cortado e DEIXA `keepMs` de pausa (metade de cada lado). */
export const SILENCE_MODES: Record<SilenceMode, { minMs: number; keepMs: number }> = {
  natural: { minMs: 700, keepMs: 250 },
  fast: { minMs: 400, keepMs: 150 },
  faster: { minMs: 250, keepMs: 100 }
}

export type FillerMode = 'cut' | 'mute' | 'mixed'

export type CleanOptions = {
  /** `null` = não mexer nos silêncios. */
  silence: SilenceMode | null
  /** Hesitações puras e fala sem palavra (`gap-speech`). */
  hesitations: boolean
  /** Inclui as muletas que podem ter sentido, quando o contexto as marca como sugestão. */
  crutches: boolean
  /** O que fazer com as muletas: cortar, silenciar, ou misto (corta as hesitações, só silencia as muletas). */
  fillerMode: FillerMode
  /** Inclui os recomeços que a IA apontou (`CleanInput.retakes`). */
  retakes: boolean
}

/** O que a limpeza automática aplica por padrão: silêncio Rápido + hesitações puras, cortando. */
export const DEFAULT_CLEAN: CleanOptions = { silence: 'fast', hesitations: true, crutches: false, fillerMode: 'cut', retakes: false }

/** Folga mínima e máxima (ms) entre a borda de um corte e a palavra que fica. */
export const GUARD_MIN_MS = 30
export const GUARD_MAX_MS = 200
/** Folga padrão que os cortes de palavras deixam de cada lado. */
export const WORD_GUARD_MS = 60
/** Uma pausa de pelo menos isto (ms) isola uma muleta. */
export const ISOLATING_PAUSE_MS = 350
/** Mais que esta fração do vídeo cortada por recomeços pede confirmação. */
export const RETAKE_CONFIRM_FRACTION = 0.3

// ---------------------------------------------------------------------------
// Nível do áudio

/**
 * Nível por quadro, em dBFS (inteiros, -120 = silêncio digital). `startMs` é o instante de ORIGEM do primeiro quadro
 * (o deslocamento da voz); cada quadro dura `frameMs`. `null` = a faixa não existe.
 */
export type Levels = {
  frameMs: number
  startMs: number
  mic: readonly number[] | null
  system: readonly number[] | null
}

const sortedCopy = (a: readonly number[]): number[] => [...a].sort((x, y) => x - y)
const percentile = (sorted: readonly number[], q: number): number => (sorted.length === 0 ? -120 : sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]!)

/**
 * Limiar de "quieto" de uma faixa: o chão de ruído (percentil 10) mais um terço do caminho até a fala (percentil
 * 95), entre -60 e -35 dBFS. Ruído de fundo alto empurra o limiar para cima; silêncio digital o deixa em -60.
 */
export function quietThreshold(frames: readonly number[]): number {
  const s = sortedCopy(frames)
  const floor = percentile(s, 0.1)
  const speech = percentile(s, 0.95)
  const t = floor + Math.max(6, (speech - floor) / 3)
  return Math.min(-35, Math.max(-60, t))
}

type QuietMask = { frameMs: number; startMs: number; quiet: Uint8Array }

/** Um quadro é quieto quando TODAS as faixas que existem estão abaixo do limiar. */
function buildQuietMask(levels: Levels): QuietMask | null {
  const channels = [levels.mic, levels.system].filter((c): c is readonly number[] => c !== null && c.length > 0)
  if (channels.length === 0) return null
  const n = Math.max(...channels.map((c) => c.length))
  const quiet = new Uint8Array(n).fill(1)
  for (const ch of channels) {
    const thr = quietThreshold(ch)
    for (let k = 0; k < n; k++) {
      const v = ch[k]
      if (v !== undefined && v > thr) quiet[k] = 0
    }
  }
  return { frameMs: levels.frameMs, startMs: levels.startMs, quiet }
}

/** Pedaços de [a, b) onde a máscara é quieta. Sem máscara, tudo é quieto. Fora do alcance dela, é quieto. */
function quietParts(mask: QuietMask | null, a: number, b: number): Range[] {
  if (!mask) return b > a ? [{ start: a, end: b }] : []
  const out: Range[] = []
  let cursor = a
  let runStart: number | null = null
  const kFrom = Math.max(0, Math.floor((a - mask.startMs) / mask.frameMs))
  const kTo = Math.ceil((b - mask.startMs) / mask.frameMs)
  for (let k = kFrom; k < kTo; k++) {
    const frameStart = Math.max(a, mask.startMs + k * mask.frameMs)
    const frameEnd = Math.min(b, mask.startMs + (k + 1) * mask.frameMs)
    if (frameEnd <= frameStart) continue
    const isQuiet = k >= mask.quiet.length || mask.quiet[k] === 1
    if (isQuiet) {
      if (runStart === null) runStart = frameStart
      cursor = frameEnd
    } else if (runStart !== null) {
      out.push({ start: runStart, end: cursor })
      runStart = null
    }
  }
  if (runStart !== null) out.push({ start: runStart, end: Math.min(b, cursor) })
  // quadros antes do início do arquivo de áudio (deslocamento da voz): sem sinal, valem como quietos
  return out.filter((r) => r.end > r.start)
}

/** Subtrai `holes` (ordenados) de `parts`. */
function subtractRanges(parts: readonly Range[], holes: readonly Range[]): Range[] {
  let current = parts.map((p) => ({ ...p }))
  for (const h of holes) {
    const next: Range[] = []
    for (const p of current) {
      if (h.end <= p.start || h.start >= p.end) next.push(p)
      else {
        if (h.start > p.start) next.push({ start: p.start, end: h.start })
        if (h.end < p.end) next.push({ start: h.end, end: p.end })
      }
    }
    current = next
  }
  return current
}

// ---------------------------------------------------------------------------
// Corte em volta de palavras

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * O trecho a cortar para tirar as palavras `a..b` (índices na lista, inclusive): as palavras mais a pausa que as
 * cerca, MENOS uma folga de `guardMs` (30-200) de cada lado, para a emenda ficar com uma pausa natural e nenhuma
 * borda cair em cima da palavra vizinha. Se a pausa de um lado é menor que a folga, o corte para na palavra.
 * No começo e no fim do vídeo o corte vai até a ponta.
 */
export function cutAround(words: readonly Pick<Word, 'start' | 'end'>[], a: number, b: number, durationMs: number, guardMs: number = WORD_GUARD_MS): Range {
  const first = words[a]
  const last = words[b]
  if (!first || !last || b < a) throw new RangeError(`cutAround: palavras ${a}..${b} fora da lista (${words.length}).`)
  const g = clamp(guardMs, GUARD_MIN_MS, GUARD_MAX_MS)
  const prevEnd = a > 0 ? words[a - 1]!.end : 0
  const nextStart = b + 1 < words.length ? words[b + 1]!.start : durationMs
  const gapL = Math.max(0, first.start - prevEnd)
  const gapR = Math.max(0, nextStart - last.end)
  const start = a === 0 ? 0 : Math.min(first.start, prevEnd + Math.min(g, gapL))
  const end = b === words.length - 1 ? Math.max(last.end, durationMs) : Math.max(last.end, nextStart - Math.min(g, gapR))
  return { start: Math.round(start), end: Math.round(end) }
}

// ---------------------------------------------------------------------------
// Itens da limpeza

export type CleanCategory = 'silence' | 'hesitation' | 'gap-speech' | 'crutch' | 'retake'

export type CleanItem = {
  kind: 'cut' | 'mute'
  reason: 'silence' | 'filler' | 'retake'
  category: CleanCategory
  start: number
  end: number
  /** Palavras que o item cobre (índices `Word.i`), quando é de palavras. */
  words?: [number, number]
  /** Texto curto para a lista de revisão ("hã", "tipo", "pausa de 1,5 s"). */
  label: string
}

export type CleanInput = {
  words: readonly Word[]
  durationMs: number
  /** Fala segundo o VAD (ms de origem); vazio/ausente = só palavras e nível. */
  vad?: readonly Range[]
  levels?: Levels | null
  /** Recomeços já validados (`validateRetakes`). */
  retakes?: readonly RetakeSpan[]
}

export type CleanResult = {
  items: CleanItem[]
  /** Quantos itens de cada categoria entraram. */
  counts: Record<CleanCategory, number>
  /** Quantas muletas com cara de sugestão existem (entram só com `crutches: true`). */
  suggestedCrutches: number
  /** Total que sai do vídeo (ms), já sem contar sobreposição entre os próprios itens. */
  cutMs: number
  /** Total de voz silenciada (ms). */
  muteMs: number
}

const EMPTY_COUNTS = (): Record<CleanCategory, number> => ({ silence: 0, hesitation: 0, 'gap-speech': 0, crutch: 0, retake: 0 })

/** Palavra que o motor entregou como hesitação, ou que o léxico reconhece como hesitação pura. */
export function isHesitationWord(w: Pick<Word, 'text' | 'kind'>): boolean {
  return w.kind === 'filler' || (w.kind === 'word' && isHesitation(w.text))
}

function fmtSeconds(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toString().replace('.', ',')} s`
}

/** Itens de silêncio: pausas entre as palavras onde o microfone, o som do computador e o VAD estão quietos. */
export function silenceItems(input: CleanInput, mode: SilenceMode): CleanItem[] {
  const { words, durationMs } = input
  if (words.length === 0 || !(durationMs > 0)) return []
  const { minMs, keepMs } = SILENCE_MODES[mode]
  const half = clamp(keepMs / 2, GUARD_MIN_MS, GUARD_MAX_MS)
  const mask = input.levels ? buildQuietMask(input.levels) : null
  const vad = [...(input.vad ?? [])].sort((p, q) => p.start - q.start)
  const sorted = [...words].sort((p, q) => p.start - q.start)

  const gaps: { start: number; end: number; open: 'start' | 'end' | null }[] = []
  gaps.push({ start: 0, end: sorted[0]!.start, open: 'start' })
  for (let k = 0; k + 1 < sorted.length; k++) gaps.push({ start: sorted[k]!.end, end: sorted[k + 1]!.start, open: null })
  gaps.push({ start: sorted[sorted.length - 1]!.end, end: durationMs, open: 'end' })

  const items: CleanItem[] = []
  for (const gap of gaps) {
    if (gap.end - gap.start < minMs) continue
    const quiet = subtractRanges(quietParts(mask, gap.start, gap.end), vad)
    for (const q of quiet) {
      if (q.end - q.start < minMs) continue
      // no começo e no fim do vídeo não há palavra de um dos lados: o corte vai até a ponta
      const start = gap.open === 'start' && q.start <= gap.start ? 0 : q.start + half
      const end = gap.open === 'end' && q.end >= gap.end ? durationMs : q.end - half
      if (end - start < MIN_CUT_MS) continue
      items.push({ kind: 'cut', reason: 'silence', category: 'silence', start: Math.round(start), end: Math.round(end), label: `pausa de ${fmtSeconds(q.end - q.start)}` })
    }
  }
  return items
}

/** Pausa (ms) antes e depois da palavra `k` da lista ordenada. */
function pausesAround(words: readonly Word[], k: number, durationMs: number): { before: number; after: number } {
  const w = words[k]!
  const before = k > 0 ? w.start - words[k - 1]!.end : w.start
  const after = k + 1 < words.length ? words[k + 1]!.start - w.end : durationMs - w.end
  return { before, after }
}

/**
 * Muletas "que podem ter sentido" que o contexto marca como vício:
 *  - "né" e "é": isoladas por pausa de um lado, repetidas ou coladas numa hesitação;
 *  - "tipo" e "então": mais cautela (têm mais sentido): pausa dos DOIS lados, repetidas ou coladas numa hesitação.
 * Devolve os índices na lista ordenada.
 */
export function suggestedCrutchIndexes(words: readonly Word[], durationMs: number): number[] {
  const out: number[] = []
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!
    if (w.kind !== 'word' || !isSoftCrutch(w.text)) continue
    const { before, after } = pausesAround(words, k, durationMs)
    const norm = w.text.toLowerCase().replace(/[^\p{L}]/gu, '')
    const strict = norm === 'tipo' || norm === 'então'
    const isolated = strict ? before >= ISOLATING_PAUSE_MS && after >= ISOLATING_PAUSE_MS : before >= ISOLATING_PAUSE_MS || after >= ISOLATING_PAUSE_MS
    const near = (j: number, gap: number): boolean => {
      const o = words[j]
      if (!o || gap >= ISOLATING_PAUSE_MS) return false
      return isHesitationWord(o) || o.kind === 'gap-speech' || (o.kind === 'word' && isSoftCrutch(o.text) && o.text.toLowerCase().replace(/[^\p{L}]/gu, '') === norm)
    }
    const clustered = near(k - 1, before) || near(k + 1, after)
    if (isolated || clustered) out.push(k)
  }
  return out
}

/** Todos os itens que a limpeza propõe, ordenados por tempo. */
export function computeClean(input: CleanInput, options: CleanOptions): CleanResult {
  const words = [...input.words].sort((a, b) => a.start - b.start || a.end - b.end)
  const { durationMs } = input
  const items: CleanItem[] = []
  const counts = EMPTY_COUNTS()

  if (options.silence) {
    for (const it of silenceItems({ ...input, words }, options.silence)) {
      items.push(it)
      counts.silence++
    }
  }

  const fillerKind = (category: CleanCategory): 'cut' | 'mute' => {
    if (options.fillerMode === 'cut') return 'cut'
    if (options.fillerMode === 'mute') return 'mute'
    // misto: as hesitações (não dizem nada) saem; as muletas (podem ter sentido) só ficam mudas
    return category === 'crutch' ? 'mute' : 'cut'
  }

  const wordItem = (k: number, category: CleanCategory, label: string): CleanItem => {
    const kind = fillerKind(category)
    const range = kind === 'cut' ? cutAround(words, k, k, durationMs) : muteAround(words, k, durationMs)
    return { kind, reason: 'filler', category, start: range.start, end: range.end, words: [words[k]!.i, words[k]!.i], label }
  }

  if (options.hesitations) {
    words.forEach((w, k) => {
      if (w.kind === 'gap-speech') {
        items.push(wordItem(k, 'gap-speech', 'fala sem palavra'))
        counts['gap-speech']++
      } else if (isHesitationWord(w)) {
        items.push(wordItem(k, 'hesitation', w.text.trim().replace(/[.,;:!?…]+$/u, '')))
        counts.hesitation++
      }
    })
  }

  const suggested = suggestedCrutchIndexes(words, durationMs)
  if (options.crutches) {
    for (const k of suggested) {
      items.push(wordItem(k, 'crutch', words[k]!.text.trim().replace(/[.,;:!?…]+$/u, '')))
      counts.crutch++
    }
  }

  if (options.retakes) {
    const byIndex = new Map(words.map((w, k) => [w.i, k]))
    for (const r of input.retakes ?? []) {
      const a = byIndex.get(r.from)
      const b = byIndex.get(r.to)
      if (a === undefined || b === undefined || b < a) continue
      const range = cutAround(words, a, b, durationMs)
      items.push({ kind: 'cut', reason: 'retake', category: 'retake', start: range.start, end: range.end, words: [r.from, r.to], label: r.reason || 'recomeço' })
      counts.retake++
    }
  }

  items.sort((a, b) => a.start - b.start || a.end - b.end)
  const total = (kind: 'cut' | 'mute'): number => unionLength(items.filter((i) => i.kind === kind))
  return { items, counts, suggestedCrutches: suggested.length, cutMs: total('cut'), muteMs: total('mute') }
}

/** Trecho a silenciar de uma palavra: ela inteira com folga de `GUARD_MIN_MS` e sem passar das palavras vizinhas. */
export function muteAround(words: readonly Pick<Word, 'start' | 'end'>[], k: number, durationMs: number): Range {
  const w = words[k]!
  const prevEnd = k > 0 ? words[k - 1]!.end : 0
  const nextStart = k + 1 < words.length ? words[k + 1]!.start : durationMs
  const pad = GUARD_MIN_MS
  return { start: Math.round(Math.min(w.start, Math.max(prevEnd, w.start - pad))), end: Math.round(Math.max(w.end, Math.min(nextStart, w.end + pad))) }
}

/** Soma dos itens sem contar duas vezes o que se sobrepõe. */
export function unionLength(spans: readonly Pick<Range, 'start' | 'end'>[]): number {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  let total = 0
  let cursorEnd = -Infinity
  for (const s of sorted) {
    const from = Math.max(s.start, cursorEnd)
    if (s.end > from) total += s.end - from
    cursorEnd = Math.max(cursorEnd, s.end)
  }
  return total
}

// ---------------------------------------------------------------------------
// Aplicar ao documento

/** Quais categorias esta aplicação SUBSTITUI no documento (as outras ficam como estão). */
export type CleanScope = { silence: boolean; filler: boolean; retake: boolean }

export function scopeOf(options: CleanOptions): CleanScope {
  return { silence: options.silence !== null, filler: options.hesitations || options.crutches, retake: options.retakes }
}

const overlapMs = (a: Range, b: Range): number => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

/**
 * Aplica os itens ao documento: substitui os cortes automáticos (e os silenciamentos) das categorias do escopo e
 * mantém tudo o mais (cortes manuais, categorias fora do escopo). Um corte que a pessoa tinha restaurado (desligado)
 * e que a limpeza propõe de novo continua DESLIGADO: ela já disse que não quer.
 */
export function applyCleanup(doc: { cuts: readonly Cut[]; mutes?: readonly Mute[] }, items: readonly CleanItem[], scope: CleanScope): { cuts: Cut[]; mutes: Mute[] } {
  const replaced = new Set<Cut['reason']>()
  if (scope.silence) replaced.add('silence')
  if (scope.filler) replaced.add('filler')
  if (scope.retake) replaced.add('retake')

  const kept = doc.cuts.filter((c) => !replaced.has(c.reason))
  const disabledBefore = doc.cuts.filter((c) => replaced.has(c.reason) && !c.enabled)
  const created: Cut[] = []
  const pool: Cut[] = [...kept]
  for (const it of items) {
    if (it.kind !== 'cut' || !replaced.has(it.reason)) continue
    const len = it.end - it.start
    const wasOff = disabledBefore.some((c) => c.reason === it.reason && overlapMs(c, it) >= len * 0.5)
    const cut: Cut = { id: nextSegId(pool, 'cut'), start: it.start, end: it.end, reason: it.reason, enabled: !wasOff }
    pool.push(cut)
    created.push(cut)
  }
  const cuts = [...kept, ...created].sort((a, b) => a.start - b.start || a.end - b.end)

  const keptMutes = (doc.mutes ?? []).filter((m) => !(scope.filler && m.reason === 'filler'))
  const mutePool: Mute[] = [...keptMutes]
  const newMutes: Mute[] = []
  if (scope.filler) {
    for (const it of items) {
      if (it.kind !== 'mute') continue
      const m: Mute = { id: nextSegId(mutePool, 'mute'), start: it.start, end: it.end, reason: 'filler', enabled: true }
      mutePool.push(m)
      newMutes.push(m)
    }
  }
  const mutes = [...keptMutes, ...newMutes].sort((a, b) => a.start - b.start || a.end - b.end)
  return { cuts, mutes }
}

// ---------------------------------------------------------------------------
// Recomeços (IA)

export type RetakeValidation = { retakes: RetakeSpan[]; dropped: number }

/**
 * Valida o que a IA devolveu para os recomeços: índice inteiro, dentro da transcrição, `from ≤ to`. O que não presta
 * é DESCARTADO (e contado em `dropped`); trechos que se tocam são fundidos.
 */
export function validateRetakes(raw: readonly { from: unknown; to: unknown; reason?: unknown }[], wordCount: number): RetakeValidation {
  let dropped = 0
  const ok: RetakeSpan[] = []
  for (const r of raw) {
    const { from, to } = r
    if (typeof from !== 'number' || typeof to !== 'number' || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= wordCount) {
      dropped++
      continue
    }
    ok.push({ from, to, reason: typeof r.reason === 'string' ? r.reason.trim().slice(0, 200) : '' })
  }
  ok.sort((a, b) => a.from - b.from || a.to - b.to)
  const merged: RetakeSpan[] = []
  for (const r of ok) {
    const last = merged[merged.length - 1]
    if (last && r.from <= last.to + 1) {
      last.to = Math.max(last.to, r.to)
      if (r.reason && !last.reason.includes(r.reason)) last.reason = last.reason ? `${last.reason}; ${r.reason}` : r.reason
    } else merged.push({ ...r })
  }
  return { retakes: merged, dropped }
}

/** Quanto do vídeo (ms) os recomeços cortariam. */
export function retakeCutMs(words: readonly Word[], retakes: readonly RetakeSpan[], durationMs: number): number {
  const byIndex = new Map(words.map((w, k) => [w.i, k]))
  const ranges: Range[] = []
  for (const r of retakes) {
    const a = byIndex.get(r.from)
    const b = byIndex.get(r.to)
    if (a !== undefined && b !== undefined && b >= a) ranges.push(cutAround(words, a, b, durationMs))
  }
  return unionLength(ranges)
}

/** Os recomeços passam de 30% do vídeo? Então a interface pede confirmação antes de aplicar. */
export function retakesNeedConfirmation(words: readonly Word[], retakes: readonly RetakeSpan[], durationMs: number): boolean {
  return durationMs > 0 && retakeCutMs(words, retakes, durationMs) > durationMs * RETAKE_CONFIRM_FRACTION
}
