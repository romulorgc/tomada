/**
 * Edição pelo texto (aba Texto): parágrafos, palavras cortadas, apagar/restaurar um trecho de palavras, busca e a
 * palavra que está tocando. Tudo sobre a transcrição e `project.cuts`, em ms de ORIGEM. Código puro.
 */
import { MIN_CUT_MS, addManualCut } from './cuts'
import { cutAround, WORD_GUARD_MS } from './clean'
import { nextSegId } from './segments'
import { keptRanges } from './timeline'
import type { Cut, Range, Word } from './types'

// ---------------------------------------------------------------------------
// Parágrafos

/** Pausa (ms) que quebra o parágrafo. */
export const PARAGRAPH_PAUSE_MS = 1200
/** Fim de frase só quebra o parágrafo quando ele já tem pelo menos isto de palavras (evita parágrafos de uma linha). */
export const PARAGRAPH_MIN_WORDS = 12
/** Um parágrafo nunca passa disto. */
export const PARAGRAPH_MAX_WORDS = 90
/** Pausas a partir daqui (ms) ganham a ficha "⏸ 1,2 s". */
export const PAUSE_CHIP_MIN_MS = 500

export type Paragraph = { first: number; last: number; startMs: number; endMs: number }

const SENTENCE_END = /[.!?…]["')\]]*$/u

/** Quebra a transcrição em parágrafos: pausa maior que 1,2 s ou fim de frase (com o parágrafo já com algum corpo). */
export function buildParagraphs(words: readonly Word[]): Paragraph[] {
  const out: Paragraph[] = []
  if (words.length === 0) return out
  let first = 0
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!
    const next = words[k + 1]
    const count = k - first + 1
    const pause = next ? next.start - w.end : Infinity
    const sentenceEnd = w.kind !== 'gap-speech' && SENTENCE_END.test(w.text.trim())
    const breakHere = !next || pause > PARAGRAPH_PAUSE_MS || (sentenceEnd && count >= PARAGRAPH_MIN_WORDS) || count >= PARAGRAPH_MAX_WORDS
    if (breakHere) {
      out.push({ first, last: k, startMs: words[first]!.start, endMs: w.end })
      first = k + 1
    }
  }
  return out
}

/** Pausas entre palavras que merecem ficha: `[k]` é a pausa entre a palavra k e a k+1. */
export function pauseAfter(words: readonly Word[], k: number): number {
  const a = words[k]
  const b = words[k + 1]
  return a && b ? Math.max(0, b.start - a.end) : 0
}

// ---------------------------------------------------------------------------
// Palavras cortadas

/**
 * Quais palavras estão cortadas: o ponto médio da palavra cai dentro de um corte LIGADO. Uma passada só
 * (palavras e cortes ordenados): serve para 9.000 palavras.
 */
export function struckWords(words: readonly Pick<Word, 'start' | 'end'>[], cuts: readonly Pick<Cut, 'start' | 'end' | 'enabled'>[]): boolean[] {
  const spans = cuts.filter((c) => c.enabled && c.end > c.start).sort((a, b) => a.start - b.start)
  const out = new Array<boolean>(words.length).fill(false)
  let s = 0
  for (let k = 0; k < words.length; k++) {
    const mid = (words[k]!.start + words[k]!.end) / 2
    while (s < spans.length && spans[s]!.end <= mid) s++
    // cortes sobrepostos: olha os que começam antes de `mid` a partir de `s`
    for (let j = s; j < spans.length && spans[j]!.start <= mid; j++) {
      if (mid < spans[j]!.end) {
        out[k] = true
        break
      }
    }
  }
  return out
}

/** Índice da palavra que está tocando em `t` (a última que começou), ou -1 antes da primeira. */
export function wordIndexAt(words: readonly Pick<Word, 'start'>[], t: number): number {
  let lo = 0
  let hi = words.length - 1
  let at = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (words[mid]!.start <= t) {
      at = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return at
}

// ---------------------------------------------------------------------------
// Apagar e restaurar palavras

/** O trecho que apagar as palavras `a..b` corta (com a folga de 60 ms em cada emenda). */
export function wordCutRange(words: readonly Word[], a: number, b: number, durationMs: number): Range {
  return cutAround(words, Math.min(a, b), Math.max(a, b), durationMs, WORD_GUARD_MS)
}

/** Dois cortes manuais separados por menos que isto (ms) são fundidos: o que sobra entre eles é só uma lasca de pausa. */
export const SLIVER_MS = 2 * WORD_GUARD_MS

/** Apaga as palavras `a..b`: vira um corte manual (funde com os manuais que tocam ou que deixariam só uma lasca). */
export function cutWords(cuts: readonly Cut[], words: readonly Word[], a: number, b: number, durationMs: number): Cut[] {
  let { start, end } = wordCutRange(words, a, b, durationMs)
  for (const c of cuts) {
    if (c.reason === 'manual' && c.enabled && c.start <= end + SLIVER_MS && c.end >= start - SLIVER_MS) {
      start = Math.min(start, c.start)
      end = Math.max(end, c.end)
    }
  }
  return addManualCut(cuts, start, end, durationMs)
}

/**
 * Restaura as palavras `a..b`: tira do documento o que cobre esse trecho. Corte MANUAL é recortado (o pedaço de
 * fora fica, o de dentro some); corte automático (silêncio, muleta, recomeço) também é recortado, mas o pedaço de
 * dentro fica DESLIGADO, para a pessoa poder religá-lo.
 */
export function restoreWords(cuts: readonly Cut[], words: readonly Word[], a: number, b: number, durationMs: number): Cut[] {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  const first = words[lo]
  const last = words[hi]
  if (!first || !last) return [...cuts]
  // restaurar uma palavra devolve a palavra inteira (e a pausa colada nela que a emenda comeu)
  const range = wordCutRange(words, lo, hi, durationMs)
  const from = Math.min(range.start, first.start)
  const to = Math.max(range.end, last.end)
  return carveOut(cuts, from, to)
}

/** Tira [from, to) dos cortes ligados (ver `restoreWords`). */
export function carveOut(cuts: readonly Cut[], from: number, to: number): Cut[] {
  const out: Cut[] = []
  const pool: Cut[] = [...cuts]
  for (const c of cuts) {
    if (!c.enabled || c.end <= from || c.start >= to) {
      out.push(c)
      continue
    }
    const left = c.start < from ? { start: c.start, end: from } : null
    const right = c.end > to ? { start: to, end: c.end } : null
    const inside = { start: Math.max(c.start, from), end: Math.min(c.end, to) }
    if (left && left.end - left.start >= MIN_CUT_MS) out.push({ ...c, ...left })
    if (c.reason !== 'manual' && inside.end - inside.start >= 1) {
      const id = left || right ? nextSegId([...pool, ...out], 'cut') : c.id
      out.push({ ...c, id, ...inside, enabled: false })
      pool.push({ ...c, id })
    }
    if (right && right.end - right.start >= MIN_CUT_MS) {
      const id = nextSegId([...pool, ...out], 'cut')
      out.push({ ...c, id, ...right })
      pool.push({ ...c, id })
    }
  }
  return out.sort((x, y) => x.start - y.start || x.end - y.end)
}

/** Pausa entre as palavras `k` e `k+1`: corta (com a folga de cada lado) ou, se já está cortada, restaura. */
export function togglePause(cuts: readonly Cut[], words: readonly Word[], k: number, durationMs: number): Cut[] {
  const a = words[k]
  const b = words[k + 1]
  if (!a || !b) return [...cuts]
  const start = Math.round(a.end + WORD_GUARD_MS)
  const end = Math.round(b.start - WORD_GUARD_MS)
  if (end - start < MIN_CUT_MS) return [...cuts]
  const mid = (start + end) / 2
  const struck = cuts.some((c) => c.enabled && c.start <= mid && mid < c.end)
  return struck ? carveOut(cuts, start, end) : addManualCut(cuts, start, end, durationMs)
}

// ---------------------------------------------------------------------------
// Quanto sai

/** Duração do vídeo antes e depois dos cortes (ms), para "−2:14 · de 12:30 para 10:16". */
export function durationAfter(durationMs: number, cuts: readonly Pick<Cut, 'start' | 'end' | 'enabled'>[]): number {
  return keptRanges(durationMs, cuts).reduce((acc, r) => acc + (r.end - r.start), 0)
}

// ---------------------------------------------------------------------------
// Busca

/** Sem acento, sem pontuação, minúsculas: "Olá, Pessoal!" → "ola pessoal". */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export type TextMatch = { first: number; last: number }

/**
 * Onde a busca acha: casa uma palavra ou uma frase (palavras seguidas), sem ligar para acento, caixa ou
 * pontuação. Devolve os intervalos de palavras, em ordem.
 */
export function findMatches(words: readonly Pick<Word, 'text' | 'kind'>[], query: string): TextMatch[] {
  const q = foldText(query)
  if (q.length === 0) return []
  const folded = words.map((w) => (w.kind === 'gap-speech' ? '' : foldText(w.text)))
  // texto contínuo com a posição de cada palavra, para achar frases de várias palavras
  const starts: number[] = []
  let text = ''
  folded.forEach((f, k) => {
    starts[k] = text.length
    text += `${f} `
  })
  const out: TextMatch[] = []
  let at = text.indexOf(q)
  while (at >= 0) {
    const endAt = at + q.length
    let first = -1
    let last = -1
    for (let k = 0; k < words.length; k++) {
      const s = starts[k]!
      const e = s + folded[k]!.length
      if (folded[k]!.length === 0) continue
      if (e > at && s < endAt) {
        if (first < 0) first = k
        last = k
      }
    }
    if (first >= 0 && (out.length === 0 || out[out.length - 1]!.first !== first)) out.push({ first, last })
    at = text.indexOf(q, at + Math.max(1, q.length))
  }
  return out
}
