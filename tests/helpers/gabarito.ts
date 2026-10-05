/**
 * O gabarito da voz sintética (`tests/fixtures/voz.json`, tempos EXATOS por construção) e a conferência de uma
 * transcrição contra ele: texto (WER) e erro de tempo de cada marca (começo e fim de cada frase e de cada muleta).
 *
 * As palavras da transcrição são alinhadas com as da referência por distância de edição; cada marca (frase ou
 * muleta) vale pelo primeiro e pelo último token alinhado.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Transcript } from '../../src/shared/types'
import { FIXTURES_DIR } from './fs'
import { tokens, wordErrors } from './wer'

export type Mark = { id: string; kind: 'speech' | 'filler'; text: string; startMs: number; endMs: number }
export type Gabarito = { durationMs: number; marks: Mark[]; text: string }

export function loadGabarito(): Gabarito {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, 'voz.json'), 'utf8')) as {
    durationMs: number
    segments: { id: string; kind: 'speech' | 'filler' | 'pause'; text?: string; startMs: number; endMs: number }[]
  }
  const marks: Mark[] = raw.segments.filter((s) => s.kind !== 'pause').map((s) => ({ id: s.id, kind: s.kind as 'speech' | 'filler', text: s.text ?? '', startMs: s.startMs, endMs: s.endMs }))
  return { durationMs: raw.durationMs, marks, text: marks.map((m) => m.text).join(' ') }
}

/** Alinha duas listas de tokens: devolve, para cada token da referência, o índice do token da hipótese (ou -1). */
export function alignTokens(ref: readonly string[], hyp: readonly string[]): number[] {
  const n = ref.length
  const m = hyp.length
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 0; i <= n; i++) d[i]![0] = i
  for (let j = 0; j <= m; j++) d[0]![j] = j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1))
    }
  }
  const map = new Array<number>(n).fill(-1)
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    const sub = d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
    if (d[i]![j] === sub) {
      map[i - 1] = j - 1
      i--
      j--
    } else if (d[i]![j] === d[i - 1]![j]! + 1) i--
    else j--
  }
  return map
}

export type MarkError = { id: string; kind: 'speech' | 'filler'; startErrMs: number | null; endErrMs: number | null; found: 'word' | 'gap-speech' | 'no' }

export type GabaritoReport = {
  wer: number
  refWords: number
  distance: number
  marks: MarkError[]
  /** Maior |erro| entre todos os começos e fins medidos (ms). */
  worstErrMs: number
  /** Quantas muletas do gabarito o motor deixou na transcrição (como palavra ou como fala sem palavra). */
  fillersFound: number
  fillersTotal: number
}

/** Confere a transcrição (SEM deslocamento: o áudio do gabarito é o arquivo `voz.wav` inteiro). */
export function checkAgainstGabarito(transcript: Transcript, gab: Gabarito = loadGabarito()): GabaritoReport {
  const real = transcript.words.filter((w) => w.kind !== 'gap-speech')
  const hypText = real.map((w) => w.text).join(' ')
  const { wer, refWords, distance } = wordErrors(gab.text, hypText)

  // tokens da referência por marca, e tokens da hipótese por palavra (cada palavra pode virar 0 ou mais tokens)
  const refTokens: string[] = []
  const refOwner: number[] = []
  gab.marks.forEach((m, mi) => {
    for (const t of tokens(m.text)) {
      refTokens.push(t)
      refOwner.push(mi)
    }
  })
  const hypTokens: string[] = []
  const hypOwner: number[] = []
  real.forEach((w, wi) => {
    for (const t of tokens(w.text)) {
      hypTokens.push(t)
      hypOwner.push(wi)
    }
  })
  const map = alignTokens(refTokens, hypTokens)

  const marks: MarkError[] = gab.marks.map((m, mi) => {
    const wordsOfMark: number[] = []
    refOwner.forEach((owner, ri) => {
      if (owner === mi && map[ri]! >= 0) wordsOfMark.push(hypOwner[map[ri]!]!)
    })
    if (wordsOfMark.length > 0) {
      const first = real[Math.min(...wordsOfMark)]!
      const last = real[Math.max(...wordsOfMark)]!
      return { id: m.id, kind: m.kind, startErrMs: first.start - m.startMs, endErrMs: last.end - m.endMs, found: 'word' as const }
    }
    // a muleta que o Whisper engoliu pode ter virado `gap-speech` (fala sem palavra) em cima dela
    const gap = transcript.words.find((w) => w.kind === 'gap-speech' && Math.min(w.end, m.endMs) - Math.max(w.start, m.startMs) >= (m.endMs - m.startMs) * 0.5)
    if (gap) return { id: m.id, kind: m.kind, startErrMs: gap.start - m.startMs, endErrMs: gap.end - m.endMs, found: 'gap-speech' as const }
    return { id: m.id, kind: m.kind, startErrMs: null, endErrMs: null, found: 'no' as const }
  })

  const errs = marks.flatMap((m) => [m.startErrMs, m.endErrMs]).filter((v): v is number => v !== null)
  const fillers = marks.filter((m) => m.kind === 'filler')
  return {
    wer,
    refWords,
    distance,
    marks,
    worstErrMs: errs.length > 0 ? Math.max(...errs.map(Math.abs)) : 0,
    fillersFound: fillers.filter((m) => m.found !== 'no').length,
    fillersTotal: fillers.length
  }
}
