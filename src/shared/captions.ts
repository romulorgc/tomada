/**
 * LEGENDAS (M4a): das palavras da transcrição às PÁGINAS que o motor desenha, e às LEGENDAS de arquivo
 * (SRT e VTT). Tudo em TEMPO DE SAÍDA (ms): palavras cortadas somem, trechos silenciados somem, as emendas dos cortes
 * não deixam buraco nem pausa falsa, e o texto corrigido na aba Texto (`wordFixes`) vale. Código puro: sem DOM, sem Node.
 *
 * O que a legenda MOSTRA (páginas) e o que o arquivo SRT/VTT diz (legendas) são segmentações diferentes de propósito:
 * a página é desenho (2 linhas × 3 palavras, a palavra falada acesa); a legenda de arquivo segue a convenção de
 * legenda (até 2 linhas de 42 caracteres, 1 a 6 s).
 */
import { struckWords } from './text-edit'
import { keptRanges, sourceToOutput } from './timeline'
import type { CaptionStyle, CaptionStyleId, Cut, Mute, Project, Range, Word } from './types'

// ---------------------------------------------------------------------------
// Palavras no tempo de saída

export type CaptionWord = {
  /** Índice da palavra na transcrição (`Word.i`). */
  i: number
  /** Como foi dita, já com a correção de texto, com a pontuação. */
  text: string
  /** Início e fim no tempo de SAÍDA (ms). */
  start: number
  end: number
}

export type CaptionSource = {
  cuts: readonly Pick<Cut, 'start' | 'end' | 'enabled'>[]
  mutes?: readonly Pick<Mute, 'start' | 'end' | 'enabled'>[] | undefined
  wordFixes?: Readonly<Record<string, string>> | undefined
  /** Duração da gravação (ms de origem). */
  durationMs: number
}

/**
 * As palavras que a legenda mostra, no tempo de SAÍDA: só palavras de verdade (hesitações e "fala sem palavra" não
 * viram legenda), fora dos cortes e dos trechos de voz silenciada, com o texto corrigido.
 */
export function captionWords(words: readonly Word[] | null | undefined, src: CaptionSource): CaptionWord[] {
  if (!words || words.length === 0) return []
  const kept = keptRanges(src.durationMs, src.cuts)
  if (kept.length === 0) return []
  const struck = struckWords(words, src.cuts)
  const muted = src.mutes && src.mutes.length > 0 ? struckWords(words, src.mutes) : null
  const out: CaptionWord[] = []
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!
    if (w.kind !== 'word' || struck[k] || muted?.[k]) continue
    const fixed = src.wordFixes?.[String(w.i)]
    const text = (fixed !== undefined && fixed.trim() !== '' ? fixed : w.text).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const start = sourceToOutput(w.start, kept)
    const end = Math.max(start + 1, sourceToOutput(w.end, kept))
    out.push({ i: w.i, text, start, end })
  }
  return out
}

const SENTENCE_END = /[.!?…]["')\]]*$/u
const SOFT_BREAK = /[,;:]["')\]]*$/u

// ---------------------------------------------------------------------------
// Páginas (o que o motor desenha)

/** Quantas linhas uma página tem no máximo (todos os estilos). */
export const CAPTION_MAX_LINES = 2
/** Pausa (ms, no tempo de saída) que fecha uma página. */
export const PAGE_PAUSE_MS = 450
/** A página aparece um pouco antes da primeira palavra e fica um pouco depois da última. */
export const PAGE_LEAD_MS = 60
export const PAGE_HOLD_MS = 320

export type CaptionPage = {
  /** Número da página (0, 1, 2…). */
  id: number
  /** Janela em que a página está na tela (ms de saída). */
  start: number
  end: number
  /** Palavras como se mostram (sem a pontuação que o estilo dispensa). */
  words: (CaptionWord & { shown: string })[]
}

export type CaptionTrack = {
  /** Identifica ESTA montagem (as camadas de texto em cache usam). */
  id: string
  style: CaptionStyleId
  pages: CaptionPage[]
}

let trackCounter = 0

/** Estilos que pedem caixa-alta e texto sem pontuação de frase ("OLÁ PESSOAL"): o Destaque e o Karaokê. */
export function dropsPunctuation(style: CaptionStyleId): boolean {
  return style === 'highlight' || style === 'karaoke'
}

/** O texto de uma palavra como se mostra: o Destaque e o Karaokê tiram `. , ; :` e `…` das pontas (`?` e `!` ficam). */
export function shownText(text: string, style: CaptionStyleId): string {
  if (!dropsPunctuation(style)) return text
  const cleaned = text.replace(/^["'“‘(\[]+/u, '').replace(/["'”’)\]]+$/u, '').replace(/[.,;:…]+$/u, '')
  return cleaned === '' ? text : cleaned
}

export type CaptionPageOptions = { style: CaptionStyleId; wordsPerLine: number }

/** Quantas palavras cabem numa página: palavras por linha × linhas. */
export function wordsPerPage(wordsPerLine: number): number {
  return Math.max(1, Math.round(wordsPerLine)) * CAPTION_MAX_LINES
}

/**
 * Quebra as palavras em páginas: fim de frase, pausa maior que 450 ms (no tempo de SAÍDA: o corte já tirou o silêncio) e
 * o limite de palavras (palavras por linha × 2). Vírgula e dois-pontos quebram quando a página já passou da metade.
 */
export function buildCaptionPages(words: readonly CaptionWord[], opts: CaptionPageOptions): CaptionPage[] {
  const limit = wordsPerPage(opts.wordsPerLine)

  // 1. frases: fim de frase e pausa longa fecham uma frase
  const phrases: CaptionWord[][] = []
  let run: CaptionWord[] = []
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!
    const next = words[k + 1]
    run.push(w)
    const pause = next ? next.start - w.end : Infinity
    if (!next || pause > PAGE_PAUSE_MS || SENTENCE_END.test(w.text)) {
      phrases.push(run)
      run = []
    }
  }

  // 2. frase maior que o limite: partes IGUAIS (7 palavras = 4 + 3, nunca 6 + 1), com a emenda puxada para a vírgula mais perto
  const groups: CaptionWord[][] = []
  for (const phrase of phrases) {
    const n = Math.ceil(phrase.length / limit)
    if (n <= 1) {
      groups.push(phrase)
      continue
    }
    const size = Math.ceil(phrase.length / n)
    let from = 0
    for (let part = 0; part < n && from < phrase.length; part++) {
      let to = part === n - 1 ? phrase.length : Math.min(phrase.length, from + size)
      if (part < n - 1) {
        for (const d of [0, -1, 1]) {
          const cut = to + d
          if (cut > from && cut < phrase.length && cut - from <= limit && phrase.length - cut <= limit * (n - part - 1) && SOFT_BREAK.test(phrase[cut - 1]!.text)) {
            to = cut
            break
          }
        }
      }
      groups.push(phrase.slice(from, to))
      from = to
    }
  }

  const pages: CaptionPage[] = []
  let prevEnd = 0
  groups.forEach((g, id) => {
    const first = g[0]!
    const last = g[g.length - 1]!
    const nextFirst = groups[id + 1]?.[0]
    const start = Math.max(prevEnd, first.start - PAGE_LEAD_MS)
    let end = last.end + PAGE_HOLD_MS
    if (nextFirst) end = Math.min(end, Math.max(last.end, nextFirst.start - PAGE_LEAD_MS))
    if (end <= start) end = start + 1
    pages.push({ id, start, end, words: g.map((w) => ({ ...w, shown: shownText(w.text, opts.style) })) })
    prevEnd = end
  })
  return pages
}

/** A trilha de legendas de um projeto no formato (a visão do formato: `captions` já é a do 16:9 ou a do vertical). */
export function buildCaptionTrack(words: readonly Word[] | null | undefined, project: Pick<Project, 'cuts' | 'mutes' | 'wordFixes' | 'captions'>, durationMs: number): CaptionTrack | null {
  const cs = project.captions
  if (!cs.enabled) return null
  const cw = captionWords(words, { cuts: project.cuts, mutes: project.mutes, wordFixes: project.wordFixes, durationMs })
  if (cw.length === 0) return null
  return { id: `t${++trackCounter}`, style: cs.style, pages: buildCaptionPages(cw, { style: cs.style, wordsPerLine: cs.wordsPerLine }) }
}

/** A página na tela em `outMs` (tempo de SAÍDA) e a palavra acesa; `null` entre as páginas. */
export type CaptionMoment = {
  page: CaptionPage
  /** Índice (dentro da página) da última palavra que já começou, ou −1 antes da primeira. */
  active: number
  /** Há quanto tempo a palavra acesa começou (ms): é o relógio do "pop". */
  sinceActive: number
  /** Há quanto tempo a página apareceu e quanto falta para sair (ms). */
  sinceStart: number
  untilEnd: number
}

export function captionAt(track: CaptionTrack, outMs: number): CaptionMoment | null {
  const pages = track.pages
  let lo = 0
  let hi = pages.length - 1
  let at = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (pages[mid]!.start <= outMs) {
      at = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (at < 0) return null
  const page = pages[at]!
  if (outMs >= page.end) return null
  let active = -1
  for (let k = 0; k < page.words.length; k++) {
    if (page.words[k]!.start <= outMs) active = k
    else break
  }
  return {
    page,
    active,
    sinceActive: active >= 0 ? outMs - page.words[active]!.start : Infinity,
    sinceStart: outMs - page.start,
    untilEnd: page.end - outMs
  }
}

// ---------------------------------------------------------------------------
// "Pop" da palavra acesa

/** Quanto a palavra acesa cresce no máximo (1,0 → 1,08 → 1,0) e quando passa pelo pico (ms). */
export const POP_AMOUNT = 0.08
export const POP_PEAK_MS = 90

/**
 * Escala da palavra acesa `sinceMs` depois de acender: sobe a `1 + amount` em ~90 ms e volta a 1 sem balançar
 * (`x·e^(1−x)`: pico exato em `x = 1`, cauda curta). Antes de acender, e depois de ~0,5 s, vale 1.
 */
export function popScale(sinceMs: number, amount = POP_AMOUNT): number {
  if (!(sinceMs > 0) || sinceMs > POP_PEAK_MS * 6) return 1
  const x = sinceMs / POP_PEAK_MS
  return 1 + amount * x * Math.exp(1 - x)
}

/** Entrada e saída da página: 90 ms de fade (a entrada ainda sobe 8 px). */
export const PAGE_FADE_MS = 90

export function pageAlpha(m: Pick<CaptionMoment, 'sinceStart' | 'untilEnd'>): number {
  const inn = Math.min(1, Math.max(0, m.sinceStart / PAGE_FADE_MS))
  const out = Math.min(1, Math.max(0, m.untilEnd / PAGE_FADE_MS))
  return Math.min(inn, out)
}

// ---------------------------------------------------------------------------
// Legendas de arquivo (SRT e VTT)

export type Cue = { start: number; end: number; text: string }

export const CUE_MAX_LINE_CHARS = 42
export const CUE_MAX_MS = 6000
export const CUE_MIN_MS = 1000
export const CUE_PAUSE_MS = 700

/** Parte `words` em até 2 linhas de ≤ 42 caracteres, equilibradas. */
function cueLines(words: readonly string[]): string {
  const full = words.join(' ')
  if (full.length <= CUE_MAX_LINE_CHARS) return full
  let best = -1
  let bestScore = Infinity
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(' ').length
    const b = words.slice(k).join(' ').length
    if (a > CUE_MAX_LINE_CHARS || b > CUE_MAX_LINE_CHARS) continue
    const score = Math.abs(a - b)
    if (score < bestScore) {
      bestScore = score
      best = k
    }
  }
  if (best < 0) {
    // sem divisão que caiba: corta onde a primeira linha enche
    let acc = ''
    let k = 0
    while (k < words.length - 1 && (acc + ' ' + words[k]!).trim().length <= CUE_MAX_LINE_CHARS) acc = (acc + ' ' + words[k++]!).trim()
    best = Math.max(1, k)
  }
  return `${words.slice(0, best).join(' ')}\n${words.slice(best).join(' ')}`
}

/**
 * As legendas do arquivo, no tempo de SAÍDA: até 2 linhas de 42 caracteres, de 1 a 6 s, quebradas em fim de frase e em
 * pausa. Texto como foi dito (com pontuação e caixa), já com as correções; o que foi cortado não aparece e o tempo
 * conta a partir das emendas (depois de um corte de 3 s, a legenda seguinte começa 3 s mais cedo).
 */
export function buildCues(words: readonly Word[] | null | undefined, src: CaptionSource): Cue[] {
  const cw = captionWords(words, src)
  const groups: CaptionWord[][] = []
  let run: CaptionWord[] = []
  let chars = 0
  for (let k = 0; k < cw.length; k++) {
    const w = cw[k]!
    const next = cw[k + 1]
    run.push(w)
    chars += w.text.length + 1
    const pause = next ? next.start - w.end : Infinity
    const tooLong = next ? chars + next.text.length + 1 > CUE_MAX_LINE_CHARS * 2 || next.end - run[0]!.start > CUE_MAX_MS : false
    if (!next || pause > CUE_PAUSE_MS || SENTENCE_END.test(w.text) || tooLong) {
      groups.push(run)
      run = []
      chars = 0
    }
  }
  const cues: Cue[] = []
  groups.forEach((g, idx) => {
    const start = g[0]!.start
    let end = g[g.length - 1]!.end
    const nextStart = groups[idx + 1]?.[0]?.start
    if (end - start < CUE_MIN_MS) end = nextStart !== undefined ? Math.min(start + CUE_MIN_MS, Math.max(end, nextStart - 40)) : start + CUE_MIN_MS
    cues.push({ start: Math.round(start), end: Math.round(end), text: cueLines(g.map((w) => w.text)) })
  })
  return cues
}

const pad = (n: number, w: number): string => String(Math.max(0, Math.floor(n))).padStart(w, '0')

/** `HH:MM:SS,mmm` (SRT) ou `HH:MM:SS.mmm` (VTT). */
export function formatCueTime(ms: number, sep: ',' | '.'): string {
  const t = Math.max(0, Math.round(ms))
  return `${pad(t / 3_600_000, 2)}:${pad((t % 3_600_000) / 60_000, 2)}:${pad((t % 60_000) / 1000, 2)}${sep}${pad(t % 1000, 3)}`
}

export function toSrt(cues: readonly Cue[]): string {
  return cues.map((c, k) => `${k + 1}\n${formatCueTime(c.start, ',')} --> ${formatCueTime(c.end, ',')}\n${c.text}\n`).join('\n')
}

export function toVtt(cues: readonly Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${formatCueTime(c.start, '.')} --> ${formatCueTime(c.end, '.')}\n${c.text}\n`).join('\n')}`
}

/** Trechos mantidos do projeto (atalho para quem monta legendas de arquivo fora da cena). */
export function captionSourceOf(project: Pick<Project, 'cuts' | 'mutes' | 'wordFixes'>, durationMs: number): CaptionSource {
  return { cuts: project.cuts, mutes: project.mutes, wordFixes: project.wordFixes, durationMs }
}

export type { CaptionStyle, Range }
