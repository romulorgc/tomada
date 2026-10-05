/**
 * O que cada motor entrega, convertido para o formato comum (`RawWord`, `RawSegment`, em MILISSEGUNDOS, tempo do
 * arquivo de voz). Código puro: validado com zod, testado em unidade com saídas reais gravadas.
 */
import { z } from 'zod'
import type { Range } from './types'
import type { RawSegment, RawWord } from './transcript'

export class EngineOutputError extends Error {
  override readonly name = 'EngineOutputError'
}

export type EngineRaw = {
  engine: string
  model: string
  language: string
  durationMs: number
  words: RawWord[]
  segments: RawSegment[]
  vad: Range[]
  /** Tempos de bastidor que o motor mediu (segundos), se informou. */
  stats: Record<string, number>
}

const seconds = z.number().refine((n) => Number.isFinite(n), 'tempo inválido')
const ms = (s: number): number => Math.round(s * 1000)

function why(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
    .join('; ')
}

// ---------------------------------------------------------------------------
// faster-whisper (resources/transcribe.py): tempos em SEGUNDOS

const fasterWhisperSchema = z.object({
  engine: z.string().default('faster-whisper'),
  model: z.string().default(''),
  language: z.string().default('pt'),
  duration: seconds.default(0),
  words: z.array(z.object({ text: z.string(), start: seconds, end: seconds, prob: z.number().nullish() })),
  segments: z.array(z.object({ start: seconds, end: seconds, text: z.string() })),
  vad: z.array(z.object({ start: seconds, end: seconds })).default([]),
  stats: z.record(z.string(), z.number()).default({})
})

/** Saída do `transcribe.py` (JSON em segundos) → formato comum em ms. */
export function fromFasterWhisper(raw: unknown): EngineRaw {
  const parsed = fasterWhisperSchema.safeParse(raw)
  if (!parsed.success) throw new EngineOutputError(`O motor de transcrição devolveu algo que não entendi (${why(parsed.error)}).`)
  const o = parsed.data
  return {
    engine: o.engine,
    model: o.model,
    language: o.language,
    durationMs: ms(o.duration),
    words: o.words.map((w) => ({ text: w.text, start: ms(w.start), end: ms(w.end), prob: w.prob ?? 1 })),
    segments: o.segments.map((s) => ({ start: ms(s.start), end: ms(s.end), text: s.text })),
    vad: o.vad.map((v) => ({ start: ms(v.start), end: ms(v.end) })),
    stats: o.stats
  }
}

// ---------------------------------------------------------------------------
// whisper.cpp (`whisper-cli -ojf`): tempos em MILISSEGUNDOS, uma entrada por token

const wcppToken = z.object({
  text: z.string(),
  offsets: z.object({ from: z.number(), to: z.number() }),
  p: z.number().optional(),
  t_dtw: z.number().optional()
})

const whisperCppSchema = z.object({
  result: z.object({ language: z.string().optional() }).optional(),
  transcription: z.array(
    z.object({
      offsets: z.object({ from: z.number(), to: z.number() }),
      text: z.string(),
      tokens: z.array(wcppToken).default([])
    })
  )
})

/** Opções da leitura da saída do whisper.cpp. */
export type WhisperCppParseOptions = {
  /**
   * Usa o tempo DTW do token (`t_dtw`, em centésimos de segundo; é o FIM do token) quando o motor o informou. Só vem
   * com `-nfa` (sem flash attention). Padrão: sim. Sem ele, valem os tempos de token (`offsets`), mais grosseiros.
   */
  useDtw?: boolean
}

/**
 * Saída do `whisper-cli -ojf` → palavras. Cada token que começa com espaço abre uma palavra; pontuação e pedaços sem
 * espaço colam na palavra anterior. Tokens especiais (`[_BEG_]`, `[_TT_…]`) são ignorados. Com DTW, o fim da palavra é
 * o fim do último token dela e o começo é o fim da palavra anterior (a primeira palavra de cada trecho começa no
 * tempo do primeiro token); o VAD corrige depois o começo das palavras que vêm depois de uma pausa.
 */
export function fromWhisperCpp(raw: unknown, opts: WhisperCppParseOptions = {}): EngineRaw {
  const parsed = whisperCppSchema.safeParse(raw)
  if (!parsed.success) throw new EngineOutputError(`O whisper.cpp devolveu algo que não entendi (${why(parsed.error)}).`)
  const useDtw = opts.useDtw ?? true
  const out = parsed.data
  const words: RawWord[] = []
  const segments: RawSegment[] = []
  for (const seg of out.transcription) {
    segments.push({ start: seg.offsets.from, end: seg.offsets.to, text: seg.text })
    type Open = { text: string; start: number; end: number; probs: number[] }
    let open: Open | null = null
    let prevEnd = -1
    const flush = (): void => {
      if (open && open.text.trim()) {
        const prob = open.probs.length > 0 ? open.probs.reduce((a, b) => a + b, 0) / open.probs.length : 1
        words.push({ text: open.text.trim(), start: open.start, end: Math.max(open.start, open.end), prob })
        prevEnd = Math.max(prevEnd, open.end)
      }
      open = null
    }
    for (const t of seg.tokens) {
      if (t.text.startsWith('[_')) continue
      const dtwEnd = useDtw && t.t_dtw !== undefined && t.t_dtw >= 0 ? t.t_dtw * 10 : null
      const to = Math.max(dtwEnd ?? t.offsets.to, prevEnd)
      // pontuação ("," "." "?") cola na palavra anterior, mas o tempo dela NÃO conta: o token do ponto absorve a pausa seguinte
      if (open !== null && !/[\p{L}\p{N}]/u.test(t.text)) {
        open.text += t.text
        continue
      }
      if (/^\s/.test(t.text) || open === null) {
        flush()
        // sem DTW (ou na primeira palavra do trecho) o começo é o do próprio token
        const start = dtwEnd !== null && prevEnd >= 0 ? prevEnd : t.offsets.from
        open = { text: t.text, start, end: to, probs: t.p !== undefined ? [t.p] : [] }
      } else {
        open.text += t.text
        open.end = Math.max(open.end, to)
        if (t.p !== undefined) open.probs.push(t.p)
      }
    }
    flush()
  }
  const lastEnd = out.transcription.reduce((m, s) => Math.max(m, s.offsets.to), 0)
  return { engine: 'whisper.cpp', model: '', language: out.result?.language ?? 'pt', durationMs: lastEnd, words, segments, vad: [], stats: {} }
}

/**
 * Saída do `whisper-vad-speech-segments` ("Speech segment 0: start = 39.00, end = 185.00"; tempos em CENTÉSIMOS de
 * segundo) → trechos de fala em ms.
 */
export function parseWhisperCppVad(stdout: string): Range[] {
  const out: Range[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = /Speech segment \d+:\s*start\s*=\s*([\d.]+),\s*end\s*=\s*([\d.]+)/.exec(line)
    if (m) {
      const start = Math.round(Number(m[1]) * 10)
      const end = Math.round(Number(m[2]) * 10)
      if (end > start) out.push({ start, end })
    }
  }
  return out
}
