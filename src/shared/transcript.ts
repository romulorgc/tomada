/**
 * `transcript.json`: ler, validar e MONTAR a transcrição a partir do que os motores entregam.
 * Código puro: sem DOM, sem Node.
 *
 * ⏱ Tudo em milissegundos, no tempo de ORIGEM (o relógio da gravação). O motor entrega tempo do ARQUIVO de voz,
 * então quem monta soma `offsetMs` (o `sync.cameraOffsetMs` do projeto: a voz vem do arquivo da câmera).
 */
import { z } from 'zod'
import { isHesitation } from './fillers'
import type { Range, Transcript, TranscriptSegment, Word, WordKind } from './types'

export const TRANSCRIPT_FILE = 'transcript.json'

/** Fala que o VAD marcou e nenhuma palavra cobre: a partir daqui (ms) vira item `gap-speech`. */
export const GAP_SPEECH_MIN_MS = 250
/** Tolerância (ms) em volta de cada palavra ao procurar fala "sem palavra": os tempos do Whisper são imprecisos. */
export const GAP_SPEECH_TOLERANCE_MS = 80
/** Texto do item `gap-speech` (a interface mostra reticências). */
export const GAP_SPEECH_TEXT = '…'

export class TranscriptFormatError extends Error {
  override readonly name = 'TranscriptFormatError'
}

// ---------------------------------------------------------------------------
// Ler e validar

const finiteMs = z.number().refine((n) => Number.isFinite(n), 'tempo inválido')
const rangeSchema = z.looseObject({ start: finiteMs, end: finiteMs })

// Palavra vinda do disco: aceita o formato antigo (`confidence`, sem `i` nem `kind`) e completa o que falta.
const wordSchema = z.looseObject({
  i: z.number().int().optional(),
  text: z.string(),
  start: finiteMs,
  end: finiteMs,
  prob: z.number().optional(),
  confidence: z.number().optional(),
  kind: z.enum(['word', 'filler', 'gap-speech']).optional()
})

const segmentSchema = z.looseObject({
  start: finiteMs,
  end: finiteMs,
  text: z.string().default(''),
  first: z.number().int().optional(),
  last: z.number().int().optional()
})

const transcriptFileSchema = z.looseObject({
  engine: z.string().default('desconhecido'),
  model: z.string().default(''),
  language: z.string().default('pt'),
  durationMs: z.number().default(0),
  words: z.array(wordSchema),
  segments: z.array(segmentSchema).default([]),
  vad: z.array(rangeSchema).default([]),
  createdAt: z.string().default('')
})

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/** Valida um `transcript.json` já lido: ordena as palavras, numera (`i`) e completa os campos que faltam. */
export function parseTranscriptObject(raw: unknown): Transcript {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TranscriptFormatError('O transcript.json não é um objeto.')
  const parsed = transcriptFileSchema.safeParse(raw)
  if (!parsed.success) {
    const why = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('; ')
    throw new TranscriptFormatError(`transcript.json inválido: ${why}`)
  }
  const file = parsed.data
  const sorted = file.words
    .map((w) => ({ w, start: Math.round(w.start), end: Math.round(Math.max(w.start, w.end)) }))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const words: Word[] = sorted.map(({ w, start, end }, i) => ({
    i,
    text: w.text,
    start,
    end,
    prob: clamp01(w.prob ?? w.confidence ?? 1),
    kind: w.kind ?? (isHesitation(w.text) ? 'filler' : 'word')
  }))
  const lastEnd = words.length > 0 ? words[words.length - 1]!.end : 0
  const segments: TranscriptSegment[] = file.segments.map((s) => ({
    start: Math.round(s.start),
    end: Math.round(s.end),
    text: s.text,
    first: Math.max(0, Math.min(words.length - 1, s.first ?? 0)),
    last: Math.max(0, Math.min(words.length - 1, s.last ?? Math.max(0, words.length - 1)))
  }))
  return {
    engine: file.engine,
    model: file.model,
    language: file.language,
    durationMs: Math.max(Math.round(file.durationMs), lastEnd),
    words,
    segments,
    vad: file.vad.map((r) => ({ start: Math.round(r.start), end: Math.round(r.end) })).filter((r) => r.end > r.start),
    createdAt: file.createdAt
  }
}

/** Texto JSON → transcrição validada. */
export function parseTranscript(text: string): Transcript {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new TranscriptFormatError(`transcript.json não é um JSON válido: ${(err as Error).message}`)
  }
  return parseTranscriptObject(raw)
}

export function serializeTranscript(transcript: Transcript): string {
  return `${JSON.stringify(transcript)}\n`
}

// ---------------------------------------------------------------------------
// Montar a partir do que o motor entregou

/** Palavra como o motor a entrega (ms, tempo do ARQUIVO de voz). */
export type RawWord = { text: string; start: number; end: number; prob?: number }
export type RawSegment = { start: number; end: number; text: string }

export type BuildTranscriptInput = {
  engine: string
  model: string
  language: string
  durationMs: number
  words: readonly RawWord[]
  segments: readonly RawSegment[]
  /** Fala segundo o VAD (ms, tempo do arquivo). */
  vad: readonly Range[]
  /** Soma ao tempo do arquivo para chegar ao tempo de origem. */
  offsetMs: number
  createdAt: string
}

/** Pedaços de `[a, b)` que `covered` (ordenado, sem sobreposição) não cobre. */
function uncoveredParts(a: number, b: number, covered: readonly Range[]): Range[] {
  const out: Range[] = []
  let cursor = a
  for (const c of covered) {
    if (c.end <= cursor) continue
    if (c.start >= b) break
    if (c.start > cursor) out.push({ start: cursor, end: Math.min(c.start, b) })
    cursor = Math.max(cursor, c.end)
    if (cursor >= b) break
  }
  if (cursor < b) out.push({ start: cursor, end: b })
  return out
}

/**
 * Fala marcada pelo VAD onde nenhuma palavra foi transcrita (≥ `minMs`): a hesitação ("hã", "hum") que o Whisper
 * engoliu. Cada pedaço vira um item `gap-speech`. Função pura sobre tempos em ms.
 */
export function findGapSpeech(words: readonly Pick<Range, 'start' | 'end'>[], vad: readonly Range[], opts: { minMs?: number; toleranceMs?: number } = {}): Range[] {
  const minMs = opts.minMs ?? GAP_SPEECH_MIN_MS
  const tol = opts.toleranceMs ?? GAP_SPEECH_TOLERANCE_MS
  // palavras dilatadas, fundidas em intervalos sem sobreposição
  const dilated: Range[] = []
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    const s = w.start - tol
    const e = w.end + tol
    const last = dilated[dilated.length - 1]
    if (last && s <= last.end) last.end = Math.max(last.end, e)
    else dilated.push({ start: s, end: e })
  }
  const out: Range[] = []
  for (const speech of [...vad].sort((a, b) => a.start - b.start)) {
    for (const part of uncoveredParts(speech.start, speech.end, dilated)) {
      if (part.end - part.start >= minMs) out.push(part)
    }
  }
  return out
}

/** Pausa máxima (ms) entre o fim de uma palavra e o fim da fala do VAD para a palavra `esticar` até ele. */
export const VAD_STRETCH_MAX_MS = 450

/**
 * O Whisper marca o começo da primeira palavra depois de uma pausa MUITO antes da voz (mediu-se 300-440 ms de
 * antecedência) e o fim da última cedo demais. O VAD "justo" sabe onde a voz começa e termina de verdade: a primeira
 * palavra de cada trecho de fala começa onde a fala começa, e a última termina onde a fala termina (se faltar
 * pouco). Nunca invade a palavra vizinha. Função pura, em ms do arquivo.
 */
export function refineWordsWithVad(words: readonly RawWord[], vad: readonly Range[]): RawWord[] {
  const out = words.map((w) => ({ ...w }))
  if (out.length === 0 || vad.length === 0) return out
  const chunks = [...vad].sort((a, b) => a.start - b.start)

  // de qual trecho de fala é cada palavra: o que mais se sobrepõe a ela (o ponto médio não serve: é justamente o
  // tempo errado da palavra que puxa o ponto médio para fora do trecho)
  const firstOf = new Map<number, number>()
  const lastOf = new Map<number, number>()
  let ci = 0
  for (let k = 0; k < out.length; k++) {
    const w = out[k]!
    while (ci < chunks.length && chunks[ci]!.end <= w.start) ci++
    let best = -1
    let bestOverlap = 0
    for (let j = ci; j < chunks.length && chunks[j]!.start < w.end; j++) {
      const overlap = Math.min(chunks[j]!.end, w.end) - Math.max(chunks[j]!.start, w.start)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        best = j
      }
    }
    if (best < 0) continue
    if (!firstOf.has(best)) firstOf.set(best, k)
    lastOf.set(best, k)
  }

  for (const [j, first] of firstOf) {
    const c = chunks[j]!
    const a = out[first]!
    const prevEnd = first > 0 ? out[first - 1]!.end : 0
    if (a.start < c.start) a.start = Math.min(a.end, Math.max(c.start, prevEnd))
    const z = out[lastOf.get(j)!]!
    const next = out[lastOf.get(j)! + 1]
    const nextStart = next ? next.start : Infinity
    if (z.end < c.end && c.end - z.end <= VAD_STRETCH_MAX_MS) z.end = Math.min(c.end, nextStart)
    else if (z.end > c.end) z.end = Math.max(z.start, c.end)
  }
  return out
}

/** Toda palavra dura pelo menos isto (ms): o alinhamento por tokens do whisper.cpp às vezes devolve início = fim. */
export const MIN_WORD_MS = 10

/**
 * Garante o que o resto do app supõe: cada palavra termina depois de começar, e nenhuma começa antes de a anterior
 * terminar. Só EMPURRA para a frente (nunca antecipa nem apaga palavra): o desvio, quando há, é de poucos ms em torno
 * de uma palavra de duração zero. Opera sobre a lista já ordenada, em ms.
 */
export function enforceWordOrder<T extends { start: number; end: number }>(words: readonly T[]): T[] {
  const out = words.map((w) => ({ ...w }))
  let cursor = -Infinity
  for (const w of out) {
    if (w.start < cursor) w.start = cursor
    if (w.end < w.start + MIN_WORD_MS) w.end = w.start + MIN_WORD_MS
    cursor = w.end
  }
  return out
}

/**
 * Motor → `Transcript`: arredonda, corrige sobreposições, soma o deslocamento da voz, classifica as hesitações,
 * acrescenta os `gap-speech` e numera tudo. Os segmentos apontam para os índices finais.
 */
export function buildTranscript(input: BuildTranscriptInput): Transcript {
  const offset = Math.round(input.offsetMs)
  const cleaned = input.words
    .map((w) => ({ text: w.text.trim(), start: Math.round(w.start), end: Math.round(Math.max(w.start, w.end)), prob: clamp01(w.prob ?? 1) }))
    .filter((w) => w.text.length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  // o Whisper às vezes deixa uma palavra entrar na seguinte: a anterior termina onde a próxima começa
  for (let k = 0; k + 1 < cleaned.length; k++) {
    const a = cleaned[k]!
    const b = cleaned[k + 1]!
    if (b.start < a.end) a.end = Math.max(a.start, b.start)
  }
  const refined = enforceWordOrder(refineWordsWithVad(enforceWordOrder(cleaned), input.vad))
  const shifted = refined.map((w) => ({ ...w, prob: w.prob ?? 1, start: w.start + offset, end: w.end + offset }))
  const vad = input.vad
    .map((r) => ({ start: Math.round(r.start) + offset, end: Math.round(r.end) + offset }))
    .filter((r) => r.end > r.start)

  type Item = { text: string; start: number; end: number; prob: number; kind: WordKind }
  const items: Item[] = shifted.map((w) => ({ ...w, kind: isHesitation(w.text) ? ('filler' as const) : ('word' as const) }))
  for (const g of findGapSpeech(shifted, vad)) items.push({ text: GAP_SPEECH_TEXT, start: g.start, end: g.end, prob: 0, kind: 'gap-speech' })
  items.sort((a, b) => a.start - b.start || a.end - b.end)
  const words: Word[] = items.map((w, i) => ({ i, ...w }))

  const segments: TranscriptSegment[] = []
  for (const seg of input.segments) {
    const start = Math.round(seg.start) + offset
    const end = Math.round(seg.end) + offset
    let first = -1
    let last = -1
    for (const w of words) {
      const mid = (w.start + w.end) / 2
      if (mid >= start && mid <= end) {
        if (first < 0) first = w.i
        last = w.i
      }
    }
    if (first >= 0) segments.push({ start, end, text: seg.text.trim(), first, last })
  }

  return {
    engine: input.engine,
    model: input.model,
    language: input.language,
    durationMs: Math.max(Math.round(input.durationMs), words.length > 0 ? words[words.length - 1]!.end : 0),
    words,
    segments,
    vad,
    createdAt: input.createdAt
  }
}

/** Contagem por tipo (para o relatório e para a interface). */
export function transcriptCounts(transcript: Pick<Transcript, 'words'>): { words: number; fillers: number; gapSpeech: number } {
  let fillers = 0
  let gapSpeech = 0
  let words = 0
  for (const w of transcript.words) {
    if (w.kind === 'filler') fillers++
    else if (w.kind === 'gap-speech') gapSpeech++
    else words++
  }
  return { words, fillers, gapSpeech }
}
