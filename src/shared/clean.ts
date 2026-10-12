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
import { cutRangeAround } from './edges'
import { isHesitation, isSoftCrutch } from './fillers'
import { MIN_CUT_MS } from './cuts'
import { PACING, RETAKE_GAIN_BONUS_MS, countSeams, shapeCuts, type PacingId, type ShapeCut } from './pacing'
import { nextSegId } from './segments'
import type { Cut, Mute, Range, Word } from './types'
import type { RetakeSpan } from './transcription'
import { buildVoiceProfile, isLoudGapSpeech, type VoiceProfile } from './voice-profile'

// ---------------------------------------------------------------------------
// Parâmetros

export type SilenceMode = 'tutorial' | 'natural' | 'fast' | 'faster'

/**
 * Silêncio acima de `minMs` é cortado e DEIXA `keepMs` de pausa. Sem ritmo (`pacing: null`) metade de cada lado; com ritmo,
 * ~2/3 depois da palavra anterior e ~1/3 antes da seguinte (100 + 50 ms no vertical), como nos vídeos de referência.
 * `tutorial` (padrão) é o ritmo do YouTube/aula: só tira pausa ≥ 0,6 s e deixa 0,28 s (`PACING.horizontal`); `fast` é o do vertical.
 */
export const SILENCE_MODES: Record<SilenceMode, { minMs: number; keepMs: number }> = {
  tutorial: { minMs: PACING.horizontal.minSilenceMs, keepMs: PACING.horizontal.keepMs },
  natural: { minMs: 700, keepMs: 250 },
  fast: { minMs: PACING.vertical.minSilenceMs, keepMs: PACING.vertical.keepMs },
  faster: { minMs: 250, keepMs: 100 }
}

/** Que ritmo (teto de emendas por minuto) cada modo de silêncio pede quando `pacing` não é dito. */
const PACING_OF_MODE: Record<SilenceMode, PacingId> = { tutorial: 'horizontal', natural: 'horizontal', fast: 'vertical', faster: 'vertical' }

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
  /**
   * Ritmo (F1): bordas pelo vale de energia, lascas, trechos curtos e teto de emendas por minuto. Ausente = o que o modo de silêncio
   * pede; `null` = cortes crus, como antes (sem moldar). Ver `pacing.ts`.
   */
  pacing?: PacingId | null
}

/** O que a limpeza automática aplica por padrão: silêncio no ritmo de tutorial + hesitações puras, cortando. */
export const DEFAULT_CLEAN: CleanOptions = { silence: 'tutorial', hesitations: true, crutches: false, fillerMode: 'cut', retakes: false }

/** O ritmo que vale para estas opções (`null` = sem moldar). */
export function pacingOf(options: Pick<CleanOptions, 'silence' | 'pacing'>): PacingId | null {
  if (options.pacing === null) return null
  return options.pacing ?? PACING_OF_MODE[options.silence ?? 'tutorial']
}

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
export function quietThreshold(frames: readonly number[], minDb = -60): number {
  const s = sortedCopy(frames)
  const floor = percentile(s, 0.1)
  const speech = percentile(s, 0.95)
  const t = floor + Math.max(6, (speech - floor) / 3)
  return Math.min(-35, Math.max(minDb, t))
}

type QuietMask = { frameMs: number; startMs: number; quiet: Uint8Array }

/** Um quadro é quieto quando TODAS as faixas que existem estão abaixo do limiar. */
function buildQuietMask(levels: Levels, minDb = -60): QuietMask | null {
  const channels = [levels.mic, levels.system].filter((c): c is readonly number[] => c !== null && c.length > 0)
  if (channels.length === 0) return null
  const n = Math.max(...channels.map((c) => c.length))
  const quiet = new Uint8Array(n).fill(1)
  for (const ch of channels) {
    const thr = quietThreshold(ch, minDb)
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
  /** Tela ativa (clique, tecla, página mudando; ver `screen-activity.ts`): nenhum silêncio é cortado por cima dela. */
  screenActive?: readonly Range[]
  /** Cortes que já valem e a limpeza não decide (manuais, marcas de "errei"): contam nas emendas e nunca são desfeitos. */
  fixedCuts?: readonly Range[]
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
  /** O que o ritmo fez (F1); ausente quando a limpeza rodou sem moldar (`pacing: null`). */
  pacing?: PacingReport
}

export type PacingReport = {
  id: PacingId
  /** Cortes desfeitos por lasca, por fala curta entre cortes e por passar do teto de emendas por minuto. */
  dropped: { sliver: number; speech: number; budget: number }
  /** Lascas sem palavra que viraram parte do corte. */
  filled: number
  /** Cortes que não foram feitos porque a borda não cai numa pausa. */
  unsafeEdges: number
  /** "Fala sem palavra" alta mantida como fala (não é hesitação). */
  keptGapSpeech: number
  /** Silêncios (ms) que a tela ativa segurou: não foram tirados. */
  screenHeldMs: number
  /** Emendas por minuto do vídeo de saída que esta limpeza deixa (com os cortes fixos). */
  seamsPerMin: number
  seams: number
  /** O perfil da voz: se o nível separa voz de chiado (senão, só os tempos das palavras decidiram as bordas). */
  voice: { ok: boolean; gainDb: number; reason: string | null } | null
  /** Avisos para a Revisão (voz fraca demais, fala sem palavra mantida…), em português. */
  notices: string[]
}

const EMPTY_COUNTS = (): Record<CleanCategory, number> => ({ silence: 0, hesitation: 0, 'gap-speech': 0, crutch: 0, retake: 0 })

/** Palavra que o motor entregou como hesitação, ou que o léxico reconhece como hesitação pura. */
export function isHesitationWord(w: Pick<Word, 'text' | 'kind'>): boolean {
  return w.kind === 'filler' || (w.kind === 'word' && isHesitation(w.text))
}

function fmtSeconds(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toString().replace('.', ',')} s`
}

/** Quanto de um silêncio "segurado" pela tela ativa (ms) a última chamada de `silenceItems` deixou de cortar (para o relatório). */
export type SilenceOptions = {
  /** Repartição da pausa que sobra: `even` metade de cada lado (antes do ritmo); `lead` ~2/3 depois da palavra anterior e ~1/3 antes da seguinte. */
  split?: 'even' | 'lead'
  /** Piso do limiar de "quieto" (dBFS): vozes muito fracas pedem um piso mais baixo que −60. */
  quietFloorDb?: number
  /** Recebe quantos ms de silêncio a tela ativa segurou. */
  onHeld?(ms: number): void
}

/** Itens de silêncio: pausas entre as palavras onde o microfone, o som do computador e o VAD estão quietos (e a tela parada). */
export function silenceItems(input: CleanInput, mode: SilenceMode, opts: SilenceOptions = {}): CleanItem[] {
  const { words, durationMs } = input
  if (words.length === 0 || !(durationMs > 0)) return []
  const { minMs, keepMs } = SILENCE_MODES[mode]
  const lead = opts.split === 'lead'
  // pausa que fica depois da palavra anterior / antes da seguinte
  const keepAfter = clamp(lead ? (keepMs * 2) / 3 : keepMs / 2, GUARD_MIN_MS, GUARD_MAX_MS)
  const keepBefore = clamp(lead ? keepMs / 3 : keepMs / 2, GUARD_MIN_MS, GUARD_MAX_MS)
  const mask = input.levels ? buildQuietMask(input.levels, opts.quietFloorDb) : null
  const vad = [...(input.vad ?? [])].sort((p, q) => p.start - q.start)
  const active = [...(input.screenActive ?? [])].sort((p, q) => p.start - q.start)
  const sorted = [...words].sort((p, q) => p.start - q.start)

  const gaps: { start: number; end: number; open: 'start' | 'end' | null }[] = []
  gaps.push({ start: 0, end: sorted[0]!.start, open: 'start' })
  for (let k = 0; k + 1 < sorted.length; k++) gaps.push({ start: sorted[k]!.end, end: sorted[k + 1]!.start, open: null })
  gaps.push({ start: sorted[sorted.length - 1]!.end, end: durationMs, open: 'end' })

  const items: CleanItem[] = []
  let held = 0
  for (const gap of gaps) {
    if (gap.end - gap.start < minMs) continue
    const still = subtractRanges(quietParts(mask, gap.start, gap.end), vad)
    // a tela ativa segura o silêncio: só o miolo parado pode sair (o resto fica como está)
    const quiet = active.length > 0 ? subtractRanges(still, active) : still
    if (active.length > 0) held += still.reduce((acc, r) => acc + (r.end - r.start), 0) - quiet.reduce((acc, r) => acc + (r.end - r.start), 0)
    for (const q of quiet) {
      if (q.end - q.start < minMs) continue
      // no começo e no fim do vídeo não há palavra de um dos lados: o corte vai até a ponta
      const start = gap.open === 'start' && q.start <= gap.start ? 0 : q.start + keepAfter
      const end = gap.open === 'end' && q.end >= gap.end ? durationMs : q.end - keepBefore
      if (end - start < MIN_CUT_MS) continue
      items.push({ kind: 'cut', reason: 'silence', category: 'silence', start: Math.round(start), end: Math.round(end), label: `pausa de ${fmtSeconds(q.end - q.start)}` })
    }
  }
  opts.onHeld?.(held)
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

  // Ritmo (F1): com ele, as bordas seguem o vale de energia, a "fala sem palavra" alta é fala, e o conjunto é moldado no fim.
  const pacingId = pacingOf(options)
  const pacing = pacingId ? PACING[pacingId] : null
  const profile: VoiceProfile | null = pacing ? buildVoiceProfile(input.levels, words) : null
  const report: PacingReport | null = pacing
    ? { id: pacing.id, dropped: { sliver: 0, speech: 0, budget: 0 }, filled: 0, unsafeEdges: 0, keptGapSpeech: 0, screenHeldMs: 0, seamsPerMin: 0, seams: 0, voice: profile ? { ok: profile.ok, gainDb: profile.gainDb, reason: profile.reason } : null, notices: [] }
    : null
  if (report) {
    if (!profile) report.notices.push('Sem o nível do microfone: as bordas dos cortes seguiram só os tempos das palavras.')
    else if (!profile.ok) report.notices.push(`Voz baixa demais para o nível decidir os cortes (${profile.reason}): usei só os tempos das palavras. Regrave com o microfone mais perto.`)
  }

  if (options.silence) {
    const silenceOpts: SilenceOptions = report ? { split: 'lead', quietFloorDb: -85, onHeld: (ms) => { report.screenHeldMs += ms } } : {}
    for (const it of silenceItems({ ...input, words }, options.silence, silenceOpts)) {
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

  /** O trecho a cortar de `a..b`: com ritmo, bordas no vale (e `null` se a borda não cai numa pausa); sem ele, `cutAround`. */
  const cutRange = (a: number, b: number): Range | null => {
    if (!report) return cutAround(words, a, b, durationMs)
    const r = cutRangeAround(words, a, b, durationMs, { profile })
    if (!r.ok) {
      report.unsafeEdges++
      return null
    }
    return { start: r.start, end: r.end }
  }

  const wordItem = (k: number, category: CleanCategory, label: string): CleanItem | null => {
    const kind = fillerKind(category)
    const range = kind === 'cut' ? cutRange(k, k) : muteAround(words, k, durationMs)
    if (!range) return null
    return { kind, reason: 'filler', category, start: range.start, end: range.end, words: [words[k]!.i, words[k]!.i], label }
  }

  if (options.hesitations) {
    words.forEach((w, k) => {
      if (w.kind === 'gap-speech') {
        // fala que o motor não transcreveu, mas ALTA como a voz, é fala de verdade (G1: 16 trechos, +0,5 a −3,6 dB da voz): fica
        if (report && isLoudGapSpeech(profile, w)) {
          report.keptGapSpeech++
          return
        }
        const it = wordItem(k, 'gap-speech', 'fala sem palavra')
        if (it) {
          items.push(it)
          counts['gap-speech']++
        }
      } else if (isHesitationWord(w)) {
        const it = wordItem(k, 'hesitation', w.text.trim().replace(/[.,;:!?…]+$/u, ''))
        if (it) {
          items.push(it)
          counts.hesitation++
        }
      }
    })
  }

  const suggested = suggestedCrutchIndexes(words, durationMs)
  if (options.crutches) {
    for (const k of suggested) {
      const it = wordItem(k, 'crutch', words[k]!.text.trim().replace(/[.,;:!?…]+$/u, ''))
      if (it) {
        items.push(it)
        counts.crutch++
      }
    }
  }

  if (options.retakes) {
    const byIndex = new Map(words.map((w, k) => [w.i, k]))
    for (const r of input.retakes ?? []) {
      const a = byIndex.get(r.from)
      const b = byIndex.get(r.to)
      if (a === undefined || b === undefined || b < a) continue
      const range = cutRange(a, b)
      if (!range) continue
      items.push({ kind: 'cut', reason: 'retake', category: 'retake', start: range.start, end: range.end, words: [r.from, r.to], label: r.reason || 'recomeço' })
      counts.retake++
    }
  }

  let final = items
  if (pacing && report) final = shapeItems(items, words, input, pacing, report, counts)

  final.sort((a, b) => a.start - b.start || a.end - b.end)
  const total = (kind: 'cut' | 'mute'): number => unionLength(final.filter((i) => i.kind === kind))
  const result: CleanResult = { items: final, counts, suggestedCrutches: suggested.length, cutMs: total('cut'), muteMs: total('mute') }
  if (report) result.pacing = report
  return result
}

/** Ganho de um corte para o ritmo: o tempo que ele tira (ms), e mais que isso se é recomeço. */
const gainOf = (it: CleanItem): number => it.end - it.start + (it.reason === 'retake' ? RETAKE_GAIN_BONUS_MS : 0)

/**
 * Molda os cortes (lasca, fala curta, teto de emendas; ver `pacing.ts`) e devolve a lista final. Atualiza as contagens e o
 * relatório. Os silenciamentos (`mute`) passam direto: não criam emenda.
 */
function shapeItems(items: CleanItem[], words: readonly Word[], input: CleanInput, pacing: (typeof PACING)[PacingId], report: PacingReport, counts: Record<CleanCategory, number>): CleanItem[] {
  const { durationMs } = input
  const candidates: ShapeCut[] = []
  items.forEach((it, id) => {
    if (it.kind === 'cut') candidates.push({ id, start: it.start, end: it.end, gain: gainOf(it), fixed: false })
  })
  const fixedBase = items.length
  ;(input.fixedCuts ?? []).forEach((f, n) => candidates.push({ id: fixedBase + n, start: f.start, end: f.end, gain: Number.MAX_SAFE_INTEGER / 1e6, fixed: true }))
  // fala que fica: as palavras que nenhum corte candidato cobre
  const speech = words.filter((w) => !candidates.some((c) => c.start <= w.start + 1 && c.end >= w.end - 1)).map((w) => ({ start: w.start, end: w.end }))
  const shaped = shapeCuts({ durationMs, cuts: candidates, speech, pacing })
  report.dropped = shaped.dropped
  report.filled = shaped.fill.length

  const kept: CleanItem[] = items.filter((it, id) => it.kind !== 'cut' || shaped.keep.has(id))
  for (const f of shaped.fill) kept.push({ kind: 'cut', reason: 'silence', category: 'silence', start: Math.round(f.start), end: Math.round(f.end), label: 'resto entre dois cortes' })

  // contagens: refeitas a partir do que sobrou
  for (const key of Object.keys(counts) as CleanCategory[]) counts[key] = 0
  for (const it of kept) counts[it.category]++

  const spans = unionRanges([...kept.filter((it) => it.kind === 'cut'), ...(input.fixedCuts ?? [])])
  const removed = spans.reduce((acc, r) => acc + (r.end - r.start), 0)
  report.seams = countSeams(spans, durationMs)
  report.seamsPerMin = durationMs - removed > 0 ? (report.seams / (durationMs - removed)) * 60_000 : 0
  const d = shaped.dropped
  const undone = d.sliver + d.speech + d.budget
  if (undone > 0) report.notices.push(`Ritmo: ${undone} corte(s) pequeno(s) ficaram de fora para o vídeo não picotar (${d.budget} pelo teto de ${pacing.maxSeamsPerMin} emendas por minuto).`)
  if (report.keptGapSpeech > 0) report.notices.push(`${report.keptGapSpeech} trecho(s) de fala sem palavra transcrita foram mantidos (o volume é de fala, não de hesitação). Confira na Revisão.`)
  if (report.unsafeEdges > 0) report.notices.push(`${report.unsafeEdges} corte(s) não foram feitos porque a borda cairia no meio da fala.`)
  return kept
}

/** Une os intervalos que se tocam ou se sobrepõem. */
function unionRanges(spans: readonly Pick<Range, 'start' | 'end'>[]): Range[] {
  const sorted = spans.filter((r) => r.end > r.start).map((r) => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push(r)
  }
  return out
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

  const kept = doc.cuts.filter((c) => !replaced.has(c.reason) || c.origin === 'manual')
  const disabledBefore = doc.cuts.filter((c) => replaced.has(c.reason) && !c.enabled)
  const created: Cut[] = []
  const pool: Cut[] = [...kept]
  for (const it of items) {
    if (it.kind !== 'cut' || !replaced.has(it.reason)) continue
    if (kept.some((c) => c.origin === 'manual' && c.reason === it.reason && overlapMs(c,it) > 0)) continue
    const len = it.end - it.start
    const wasOff = disabledBefore.some((c) => c.reason === it.reason && overlapMs(c, it) >= len * 0.5)
    const cut: Cut = { id: nextSegId(pool, 'cut'), start: it.start, end: it.end, reason: it.reason, enabled: !wasOff, origin: 'auto' }
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
