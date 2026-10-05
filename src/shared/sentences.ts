/**
 * FRASES da transcrição (M4b): a unidade em que os cortes verticais, os capítulos e o "editar pedindo" pensam.
 * Uma frase começa na palavra seguinte a um fim de frase (`.`, `!`, `?`, `…`) ou a uma pausa longa e termina onde a
 * pontuação ou a pausa a fecham; frases muito longas (fala corrida sem ponto) são partidas numa pausa curta ou numa
 * vírgula. Só entram as palavras de verdade (`kind: 'word'`): hesitação e fala sem palavra ficam de fora do texto, mas
 * o tempo da frase vai da primeira à última palavra de verdade. Cada frase carrega um resumo da ATIVIDADE DE TELA (cliques
 * e teclas, nunca qual tecla) para a IA e a heurística saberem onde o apresentador está mostrando algo.
 *
 * Código puro: sem DOM, sem Node. Tempos em ms de ORIGEM.
 */
import type { Word } from './types'

const SENTENCE_END = /[.!?…]["')\]]*$/u
const SOFT_BREAK = /[,;:]["')\]]*$/u

/** Uma pausa deste tamanho (ms) fecha a frase mesmo sem pontuação (a fala corrida de quem não pontua). */
export const SENTENCE_PAUSE_MS = 900
/** Frase com 3 palavras ou menos não é partida só por pausa (um "então… pausa… clica aqui" é uma frase). */
export const SENTENCE_PAUSE_MIN_WORDS = 3
/** Frase que passa disto é partida numa vírgula ou pausa curta; ao chegar em `HARD` parte onde estiver. */
export const SENTENCE_SOFT_WORDS = 24
export const SENTENCE_HARD_WORDS = 40
const SOFT_PAUSE_MS = 350

/** Quanto antes do começo e depois do fim da frase um clique ou tecla ainda conta como "o que ela mostra". */
export const ACTIVITY_LEAD_MS = 400
export const ACTIVITY_TAIL_MS = 900

export type Sentence = {
  /** `Word.i` da primeira e da última palavra de verdade da frase. */
  first: number
  last: number
  /** Posições dessas duas palavras na lista recebida (podem diferir de `first`/`last` em listas parciais). */
  firstPos: number
  lastPos: number
  startMs: number
  endMs: number
  /** O texto, como foi dito (com a pontuação do motor). */
  text: string
  words: number
  /** Cliques e teclas (só "houve digitação") durante a frase. */
  clicks: number
  keys: number
}

export type ActivityTimes = { clicks?: readonly number[]; keys?: readonly number[] }

const clean = (text: string): string => text.trim().replace(/\s+/g, ' ')

/** Quantos tempos de `sorted` (ordenado) caem em [a, b]. */
export function countBetween(sorted: readonly number[], a: number, b: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid]! < a) lo = mid + 1
    else hi = mid
  }
  const from = lo
  hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid]! <= b) lo = mid + 1
    else hi = mid
  }
  return lo - from
}

/** Palavras de verdade → frases (com a atividade de tela de cada uma, se os tempos vierem). */
export function buildSentences(words: readonly Word[], activity: ActivityTimes = {}): Sentence[] {
  const spoken: { w: Word; pos: number }[] = []
  words.forEach((w, pos) => {
    if (w.kind === 'word' && clean(w.text) !== '') spoken.push({ w, pos })
  })
  const clicks = activity.clicks ? [...activity.clicks].sort((a, b) => a - b) : []
  const keys = activity.keys ? [...activity.keys].sort((a, b) => a - b) : []
  const out: Sentence[] = []
  let cur: { w: Word; pos: number }[] = []
  const flush = (): void => {
    if (cur.length === 0) return
    const a = cur[0]!
    const b = cur[cur.length - 1]!
    const startMs = a.w.start
    const endMs = Math.max(b.w.end, startMs + 1)
    out.push({
      first: a.w.i,
      last: b.w.i,
      firstPos: a.pos,
      lastPos: b.pos,
      startMs,
      endMs,
      text: cur.map((x) => clean(x.w.text)).join(' '),
      words: cur.length,
      clicks: countBetween(clicks, startMs - ACTIVITY_LEAD_MS, endMs + ACTIVITY_TAIL_MS),
      keys: countBetween(keys, startMs - ACTIVITY_LEAD_MS, endMs + ACTIVITY_TAIL_MS)
    })
    cur = []
  }
  for (let k = 0; k < spoken.length; k++) {
    const item = spoken[k]!
    cur.push(item)
    const next = spoken[k + 1]
    const text = clean(item.w.text)
    const pause = next ? next.w.start - item.w.end : Infinity
    const n = cur.length
    const end =
      !next ||
      SENTENCE_END.test(text) ||
      (pause >= SENTENCE_PAUSE_MS && n > SENTENCE_PAUSE_MIN_WORDS) ||
      (n >= SENTENCE_SOFT_WORDS && (SOFT_BREAK.test(text) || pause >= SOFT_PAUSE_MS)) ||
      n >= SENTENCE_HARD_WORDS
    if (end) flush()
  }
  return out
}

/** A frase que contém a posição `pos` da lista de palavras (ou `null` se a posição cai numa hesitação entre frases). */
export function sentenceAtPos(sentences: readonly Sentence[], pos: number): number | null {
  let lo = 0
  let hi = sentences.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = sentences[mid]!
    if (pos < s.firstPos) hi = mid - 1
    else if (pos > s.lastPos) lo = mid + 1
    else return mid
  }
  return null
}

/** Índice da primeira frase que começa em `pos` ou depois (`sentences.length` se não há). */
export function sentenceFromPos(sentences: readonly Sentence[], pos: number): number {
  let lo = 0
  let hi = sentences.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sentences[mid]!.firstPos < pos) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** A frase que contém o instante `t` (ms), ou a mais próxima que começa depois dele; `-1` se não há frases. */
export function sentenceAtTime(sentences: readonly Sentence[], t: number): number {
  if (sentences.length === 0) return -1
  let lo = 0
  let hi = sentences.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (sentences[mid]!.startMs <= t) lo = mid
    else hi = mid - 1
  }
  const s = sentences[lo]!
  if (t <= s.endMs) return lo
  return Math.min(sentences.length - 1, lo + 1)
}

/** Soma de [a, b) que cai dentro de `kept` (trechos mantidos, ordenados): quanto desse intervalo sobra no vídeo de saída. */
export function keptMsBetween(kept: readonly { start: number; end: number }[], a: number, b: number): number {
  let sum = 0
  for (const r of kept) {
    if (r.end <= a) continue
    if (r.start >= b) break
    sum += Math.min(r.end, b) - Math.max(r.start, a)
  }
  return sum
}
