/**
 * PUBLICAR (M4b): capítulos do YouTube, títulos, descrição, tags, e legenda e hashtags de cada corte. Aqui moram as
 * regras (capítulos válidos), o pedido à IA, a conferência do que ela devolve, os capítulos SEM IA (pelas pausas) e os
 * textos que a exportação grava. Nada é publicado: o app só deixa o texto pronto para copiar. Código puro: sem DOM, sem Node.
 *
 * Capítulos do YouTube: o primeiro em 00:00, pelo menos 3, cada um com pelo menos 10 s. Eles são guardados em tempo de
 * ORIGEM (`meta.youtube.chapters[].start`) e o tempo que o YouTube vê é calculado com os cortes de AGORA: cortar o vídeo
 * depois de gerar os capítulos não desalinha a lista.
 */
import { z } from 'zod'
import { clipText, limitTitle } from './clips'
import { formatSpan } from './format'
import { buildSentences, keptMsBetween, sentenceAtPos, sentenceFromPos } from './sentences'
import { keptRanges, sourceToOutput } from './timeline'
import type { Clip, ClipMeta, Cut, Project, Range, Word, YoutubeChapter } from './types'

// ---------------------------------------------------------------------------
// Regras do YouTube

export const CHAPTER_MIN_COUNT = 3
export const CHAPTER_MIN_MS = 10_000
export const CHAPTER_TITLE_MAX = 60
export const YOUTUBE_TITLE_MAX = 100
export const YOUTUBE_DESCRIPTION_MAX = 5000
export const YOUTUBE_TAGS_MAX_CHARS = 500
/** Quantas palavras de erro se aceita para "corrigir" o começo de um capítulo para o início de uma frase. */
const CHAPTER_SNAP_WORDS = 4

export type Chapter = YoutubeChapter

/** Um capítulo no tempo que o YouTube vê (tempo de SAÍDA). */
export type ChapterLine = { start: number; outMs: number; time: string; title: string }

/** `mm:ss` (o YouTube aceita `0:00` e `00:00`); a partir de 1 hora, `h:mm:ss` para a lista toda. */
export function formatChapterTime(ms: number, withHours: boolean): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return withHours ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Título de capítulo limpo: sem horário na frente, sem aspas, no máximo 60 caracteres. */
export function cleanChapterTitle(text: string): string {
  const t = oneLine(text)
    .replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*[-–—:.)]*\s*/u, '')
    .replace(/[.:;,\s]+$/u, '')
    .replace(/^["'“‘]+|["'”’]+$/gu, '')
    .replace(/[.:;,\s]+$/u, '')
  if (t.length <= CHAPTER_TITLE_MAX) return t
  const cut = t.slice(0, CHAPTER_TITLE_MAX)
  const at = cut.lastIndexOf(' ')
  return (at > CHAPTER_TITLE_MAX * 0.5 ? cut.slice(0, at) : cut).trim()
}

/**
 * Os capítulos no tempo de SAÍDA, ordenados, com o primeiro em 00:00. Capítulo que cai dentro de um corte vai para o
 * ponto do corte; dois no mesmo instante ficam com o primeiro.
 */
export function chapterLines(chapters: readonly Chapter[], kept: readonly Range[]): ChapterLine[] {
  const total = kept.reduce((a, r) => a + (r.end - r.start), 0)
  const withHours = total >= 3_600_000
  const sorted = chapters
    .filter((c) => Number.isFinite(c.start) && oneLine(c.title) !== '')
    .map((c) => ({ start: c.start, outMs: sourceToOutput(c.start, kept), title: oneLine(c.title) }))
    .sort((a, b) => a.outMs - b.outMs || a.start - b.start)
  const out: ChapterLine[] = []
  for (const c of sorted) {
    if (out.length > 0 && c.outMs <= out[out.length - 1]!.outMs) continue
    out.push({ start: c.start, outMs: c.outMs, time: '', title: c.title })
  }
  // o primeiro capítulo é sempre em 00:00, seja qual for o ponto de origem dele
  if (out.length > 0) out[0]!.outMs = 0
  return out.map((c) => ({ ...c, time: formatChapterTime(c.outMs, withHours) }))
}

export type ChapterCheck = { ok: boolean; problems: string[] }

/** As três regras do YouTube sobre a lista (no tempo de saída). */
export function checkChapters(lines: readonly ChapterLine[], outputMs: number): ChapterCheck {
  const problems: string[] = []
  if (lines.length < CHAPTER_MIN_COUNT) problems.push(`o YouTube pede pelo menos ${CHAPTER_MIN_COUNT} capítulos (há ${lines.length})`)
  if (lines.length > 0 && lines[0]!.outMs !== 0) problems.push('o primeiro capítulo precisa começar em 00:00')
  for (let i = 0; i < lines.length; i++) {
    const end = i + 1 < lines.length ? lines[i + 1]!.outMs : outputMs
    if (end - lines[i]!.outMs < CHAPTER_MIN_MS) problems.push(`o capítulo "${lines[i]!.title}" tem menos de 10 s (${formatSpan(Math.max(0, end - lines[i]!.outMs))})`)
  }
  return { ok: problems.length === 0, problems }
}

/** Tira os capítulos que ficariam com menos de 10 s (o anterior os cobre), sem nunca tirar o primeiro. */
export function fitChapters(lines: readonly ChapterLine[], outputMs: number): ChapterLine[] {
  const out = [...lines]
  for (let i = 1; i < out.length; ) {
    if (out[i]!.outMs - out[i - 1]!.outMs < CHAPTER_MIN_MS) out.splice(i, 1)
    else i++
  }
  while (out.length > 1 && outputMs - out[out.length - 1]!.outMs < CHAPTER_MIN_MS) out.pop()
  return out
}

/** A lista como o YouTube a quer, uma por linha: `00:00 Introdução`. */
export function chaptersText(lines: readonly ChapterLine[]): string {
  return lines.map((l) => `${l.time} ${l.title}`).join('\n')
}

// ---------------------------------------------------------------------------
// Capítulos SEM IA: pelas pausas

const TOPIC_CUE = /^(agora|outra coisa|outro|vamos|mais uma|por fim|para finalizar|para terminar|a seguir|o proximo|a proxima|passando|falando em|por ultimo|e por ultimo|bom, era isso|entao vamos|chegamos)\b/

const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s,]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const DANGLING = new Set(['e', 'de', 'do', 'da', 'dos', 'das', 'a', 'o', 'as', 'os', 'em', 'no', 'na', 'que', 'para', 'com', 'um', 'uma', 'ou', 'por', 'se', 'eu', 'ele', 'ela'])

/** O título de um capítulo sem IA: as primeiras palavras da frase em que ele começa (até 6, sem terminar em conectivo). */
export function chapterTitleFromText(text: string): string {
  const parts = oneLine(text).split(' ').filter(Boolean).slice(0, 6)
  while (parts.length > 2 && DANGLING.has(parts[parts.length - 1]!.toLowerCase().replace(/[.,;:!?…]+$/u, ''))) parts.pop()
  const t = parts.join(' ').replace(/[.,;:!?…\s]+$/u, '')
  return cleanChapterTitle(t.charAt(0).toUpperCase() + t.slice(1))
}

export type ChaptersResult = { chapters: Chapter[]; why: string | null }

/**
 * Capítulos pelas pausas e pelos começos de assunto ("agora vamos…", "outra coisa…"): os pontos de maior pausa, sempre numa
 * frase nova, com pelo menos 10 s entre eles. O título é o começo da frase. Sem IA o título é simples de propósito.
 */
export function heuristicChapters(words: readonly Word[], durationMs: number, cuts: readonly Pick<Cut, 'start' | 'end' | 'enabled'>[]): ChaptersResult {
  const kept = keptRanges(durationMs, cuts)
  const outputMs = kept.reduce((a, r) => a + (r.end - r.start), 0)
  if (outputMs < CHAPTER_MIN_COUNT * CHAPTER_MIN_MS) return { chapters: [], why: `O vídeo tem ${formatSpan(outputMs)}: não cabem ${CHAPTER_MIN_COUNT} capítulos de pelo menos 10 s.` }
  const sentences = buildSentences(words)
  if (sentences.length < 2) return { chapters: [], why: 'Não há frases suficientes na transcrição para separar capítulos.' }
  const want = Math.min(10, Math.max(CHAPTER_MIN_COUNT, Math.round((outputMs / 60_000) * 1.2) + 1))

  type Cand = { k: number; weight: number; outMs: number }
  const cands: Cand[] = []
  for (let k = 1; k < sentences.length; k++) {
    const s = sentences[k]!
    const outMs = sourceToOutput(s.startMs, kept)
    const pause = s.startMs - sentences[k - 1]!.endMs
    const cue = TOPIC_CUE.test(fold(s.text)) ? 1500 : 0
    cands.push({ k, weight: pause + cue, outMs })
  }
  cands.sort((a, b) => b.weight - a.weight || a.k - b.k)

  const spacing = (minGap: number): Cand[] => {
    const picked: Cand[] = []
    for (const c of cands) {
      if (picked.length >= want - 1) break
      if (c.outMs < minGap || outputMs - c.outMs < minGap) continue
      if (picked.some((p) => Math.abs(p.outMs - c.outMs) < minGap)) continue
      picked.push(c)
    }
    return picked
  }
  let picked = spacing(Math.max(CHAPTER_MIN_MS * 2, outputMs / (want * 2)))
  if (picked.length < CHAPTER_MIN_COUNT - 1) picked = spacing(CHAPTER_MIN_MS)
  if (picked.length < CHAPTER_MIN_COUNT - 1) return { chapters: [], why: 'Não achei pausas nem trocas de assunto suficientes para 3 capítulos de pelo menos 10 s.' }
  picked.sort((a, b) => a.k - b.k)
  const chapters: Chapter[] = [{ start: 0, title: 'Introdução' }]
  for (const c of picked) chapters.push({ start: Math.max(0, sentences[c.k]!.startMs - 250), title: chapterTitleFromText(sentences[c.k]!.text) })
  return { chapters, why: null }
}

// ---------------------------------------------------------------------------
// Hashtags e tags

/** `#AgendaOnline`: sem espaço, só letras, números e `_`, de 2 a 30 caracteres. `null` se não sobra nada. */
export function normalizeHashtag(text: string): string | null {
  const body = oneLine(text)
    .replace(/^#+/u, '')
    .replace(/\s+/gu, '')
    .replace(/[^\p{L}\p{N}_]/gu, '')
  if (body.length < 2 || body.length > 30) return null
  return `#${body}`
}

export function normalizeHashtags(list: readonly unknown[], max: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const tag = normalizeHashtag(raw)
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    out.push(tag)
    if (out.length >= max) break
  }
  return out
}

/** Tags do YouTube: minúsculas, sem `#`, de 2 a 30 caracteres, no máximo 500 no total. */
export function normalizeTags(list: readonly unknown[], max = 15): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let chars = 0
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const tag = oneLine(raw).replace(/^#+/u, '').toLowerCase()
    if (tag.length < 2 || tag.length > 30 || seen.has(tag)) continue
    if (chars + tag.length + 1 > YOUTUBE_TAGS_MAX_CHARS) break
    seen.add(tag)
    chars += tag.length + 1
    out.push(tag)
    if (out.length >= max) break
  }
  return out
}

const STOP = new Set(
  (
    'agora ainda algum alguma aquela aquele aqui assim antes apenas bastante cada como coisa coisas depois desse desta deste disso dessa ' +
    'dessas desses eles ontem entao então essa essas esse esses esta estas este estes fazer feito fica ficar foram havia isso mais mesmo ' +
    'muito muita nada nele nela nesse nesta neste nossa nosso numa onde outra outro para pelo pela pelos pelas perto pode podem poder ' +
    'porque pois quando quem quer quero sabe sendo serve sobre sempre sobre sozinho tambem também tanto tinha todos todas toda todo ' +
    'tudo ultima última ultimo último vamos veja vejo vez vou você voce voces vocês'
  ).split(' ')
)

/** Palavras que mais aparecem no texto (de 5 letras para cima, fora as comuns): base das hashtags sem IA. */
export function keywordsOf(text: string, max: number): string[] {
  const counts = new Map<string, { n: number; first: number }>()
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  tokens.forEach((t, k) => {
    if (t.length < 5 || STOP.has(t)) return
    const c = counts.get(t)
    if (c) c.n++
    else counts.set(t, { n: 1, first: k })
  })
  return [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)
    .slice(0, max)
    .map(([w]) => w)
}

/** Legenda e hashtags de um corte SEM IA: o gancho (ou o título) e as palavras que mais aparecem no corte. */
export function fallbackClipMeta(clip: Pick<Clip, 'title' | 'hook' | 'ranges'>, words: readonly Word[] | null): ClipMeta {
  const text = words ? clipText(clip.ranges, words) : ''
  const kw = normalizeHashtags(keywordsOf(`${clip.title} ${text}`, 6), 6)
  return {
    caption: (clip.hook.trim() || clip.title).slice(0, 220),
    tiktok: kw.slice(0, 4),
    reels: kw.slice(0, 4),
    shorts: [...kw.slice(0, 2), '#Shorts']
  }
}

// ---------------------------------------------------------------------------
// O pedido à IA

export const PUBLISH_SYSTEM = `Você escreve os textos de publicação de um vídeo de DEMONSTRAÇÃO DE UM PROGRAMA (a pessoa gravou a tela e narrou o que faz). Você recebe o resumo do vídeo, a transcrição em frases e, se houver, os cortes verticais já escolhidos.

Cada frase da transcrição chega assim:
[a-b] início–fim · texto
"a" e "b" são os números da primeira e da última palavra da frase; início e fim são o tempo no VÍDEO FINAL (já sem os trechos cortados).

COMO RESPONDER
Responda SOMENTE com um JSON, sem texto fora dele:
{"titles":["...","...","..."],"description":"...","tags":["..."],"chapters":[{"from":0,"title":"..."}],"clips":[{"id":"clip-1","caption":"...","tiktok":["#..."],"reels":["#..."],"shorts":["#..."]}]}

- "titles": 3 opções de título para o YouTube, de até 70 caracteres, com a palavra mais importante no começo, dizendo o que a pessoa vê ou aprende. Três ângulos diferentes (o resultado, o passo a passo, para quem é). Sem sensacionalismo, sem caixa-alta, sem emoji.
- "description": 2 ou 3 parágrafos curtos: o que o vídeo mostra, para quem serve, o que a pessoa leva. NÃO coloque lista de capítulos nem horários (o programa acrescenta), nem links ou preços que não estejam na transcrição.
- "tags": de 8 a 15 palavras ou expressões curtas em minúsculas, em português, sem "#".
- "chapters": de 4 a 10 capítulos, um por assunto. "from" é o "a" da frase em que o assunto COMEÇA; o primeiro capítulo começa no começo do vídeo; cada capítulo precisa durar pelo menos 15 segundos. "title": até 50 caracteres, diz o assunto ("Cadastro de clientes"), sem horário.
- "clips": só se houver cortes listados, um item para cada, com o mesmo "id". "caption": legenda do post, até 150 caracteres, abre com o gancho do corte, sem emoji. "tiktok": 3 a 5 hashtags; "reels": 3 a 5; "shorts": 2 a 3. Hashtags relevantes ao que o corte mostra, sem espaço, cada uma começando com #.
- Não invente recursos: use só o que a pessoa mostra ou diz. Não cite nomes de assistentes ou ferramentas de IA nos textos.`

const clock = (ms: number): string => formatChapterTime(ms, false)

export type PublishPromptInput = {
  project: Project
  words: readonly Word[]
  durationMs: number
  /** Os cortes verticais do projeto (a IA escreve a legenda de cada um). */
  clips: readonly Clip[]
}

/** O pedido: o resumo, os cortes e a transcrição em frases, com os tempos do vídeo FINAL. */
export function buildPublishPrompt(input: PublishPromptInput): string {
  const { project, words, durationMs } = input
  const kept = keptRanges(durationMs, project.cuts)
  const outputMs = kept.reduce((a, r) => a + (r.end - r.start), 0)
  const lines: string[] = [`Vídeo "${oneLine(project.title).slice(0, 120)}" com ${formatSpan(outputMs)} (depois dos cortes).`]
  if (project.script) lines.push(`Roteiro de referência: ${JSON.stringify(project.script)}`)
  if (input.clips.length > 0) {
    lines.push('', 'Cortes verticais (escreva a legenda e as hashtags de cada um):')
    for (const c of input.clips) {
      lines.push(`- ${c.id}: "${oneLine(c.title)}" · gancho "${oneLine(c.hook)}" · texto: "${clipText(c.ranges, words).slice(0, 300)}"`)
    }
  }
  lines.push('', 'Frases:')
  for (const s of buildSentences(words)) {
    if (keptMsBetween(kept, s.startMs, s.endMs) < (s.endMs - s.startMs) * 0.5) continue // a frase foi cortada
    lines.push(`[${s.first}-${s.last}] ${clock(sourceToOutput(s.startMs, kept))}–${clock(sourceToOutput(s.endMs, kept))} · ${s.text}`)
  }
  return lines.join('\n')
}

const chapterItem = z.object({ from: z.number(), title: z.string() })

/** A resposta: os campos de lista são conferidos item a item; um item ruim não derruba o resto. */
export const publishSchema = z.object({
  titles: z.array(z.unknown()).default([]),
  description: z.string().default(''),
  tags: z.array(z.unknown()).default([]),
  chapters: z.array(z.unknown()).default([]),
  clips: z.array(z.unknown()).default([])
})
export type PublishResponse = z.infer<typeof publishSchema>

const clipItem = z.object({
  id: z.string(),
  caption: z.string().optional(),
  tiktok: z.array(z.unknown()).optional(),
  reels: z.array(z.unknown()).optional(),
  shorts: z.array(z.unknown()).optional()
})

/** Os textos de publicação já conferidos (o que a interface guarda em `project.meta`). */
export type PublishResult = {
  titles: string[]
  description: string
  tags: string[]
  chapters: Chapter[]
  /** Legenda e hashtags por corte (id do corte → texto). */
  clips: Record<string, ClipMeta>
  /** O que foi descartado ou corrigido, em português (a interface mostra). */
  notes: string[]
}

/** Remove da descrição as linhas que parecem capítulo (o programa acrescenta a lista certa) e limita o tamanho. */
export function cleanDescription(text: string): string {
  const kept = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*\d{1,2}:\d{2}(?::\d{2})?\b/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return kept.slice(0, YOUTUBE_DESCRIPTION_MAX)
}

/** Capítulos da IA → capítulos válidos: começo no início de uma frase (corrige até 4 palavras), ordenados, sem os que ficariam com menos de 10 s. */
export function validateChapters(raw: readonly unknown[], words: readonly Word[], durationMs: number, cuts: readonly Pick<Cut, 'start' | 'end' | 'enabled'>[]): { chapters: Chapter[]; notes: string[] } {
  const notes: string[] = []
  const sentences = buildSentences(words)
  const byIndex = new Map(words.map((w, pos) => [w.i, pos]))
  const found: Chapter[] = []
  for (const item of raw) {
    const p = chapterItem.safeParse(item)
    if (!p.success) {
      notes.push('um capítulo veio em formato inválido e foi descartado')
      continue
    }
    const title = cleanChapterTitle(p.data.title)
    const pos = Number.isInteger(p.data.from) ? byIndex.get(p.data.from) : undefined
    if (title === '' || pos === undefined) {
      notes.push(`o capítulo "${title || '?'}" aponta uma palavra que não existe e foi descartado`)
      continue
    }
    let s = sentenceAtPos(sentences, pos)
    if (s === null) s = sentenceFromPos(sentences, pos)
    const sen = sentences[s]
    if (!sen) {
      notes.push(`o capítulo "${title}" não cai numa frase e foi descartado`)
      continue
    }
    let k = s
    if (pos !== sen.firstPos) {
      const back = pos - sen.firstPos
      const next = sentences[s + 1]
      const fwd = next ? next.firstPos - pos : Infinity
      if (back <= fwd && back <= CHAPTER_SNAP_WORDS) k = s
      else if (fwd <= CHAPTER_SNAP_WORDS) k = s + 1
      else {
        notes.push(`o capítulo "${title}" não começa no início de uma frase e foi descartado`)
        continue
      }
    }
    found.push({ start: Math.max(0, sentences[k]!.startMs - 250), title })
  }
  const kept = keptRanges(durationMs, cuts)
  const outputMs = kept.reduce((a, r) => a + (r.end - r.start), 0)
  found.sort((a, b) => a.start - b.start)
  let list = found.filter((c, i) => i === 0 || c.start > found[i - 1]!.start)
  // o primeiro capítulo é em 00:00: se a IA começou o primeiro assunto logo no começo ele passa a ser o primeiro; senão entra uma "Introdução"
  if (list.length === 0 || sourceToOutput(list[0]!.start, kept) >= CHAPTER_MIN_MS) list = [{ start: 0, title: 'Introdução' }, ...list]
  else list = [{ ...list[0]!, start: 0 }, ...list.slice(1)]
  const lines = chapterLines(list, kept)
  const fitted = fitChapters(lines, outputMs)
  if (fitted.length < lines.length) notes.push(`${lines.length - fitted.length} capítulo(s) com menos de 10 s foram juntados ao anterior`)
  const chapters = fitted.map((l) => ({ start: l.start, title: l.title }))
  return { chapters, notes }
}

/** A resposta da IA → textos conferidos. Lança se não veio nem um título (a interface mostra e deixa tentar de novo). */
export function validatePublish(raw: PublishResponse, ctx: { words: readonly Word[]; durationMs: number; cuts: readonly Pick<Cut, 'start' | 'end' | 'enabled'>[]; clips: readonly Pick<Clip, 'id'>[] }): PublishResult {
  const notes: string[] = []
  const titles: string[] = []
  for (const t of raw.titles) {
    if (typeof t !== 'string') continue
    const v = limitTitle(t).slice(0, YOUTUBE_TITLE_MAX)
    if (v !== '' && !titles.includes(v)) titles.push(v)
    if (titles.length >= 3) break
  }
  if (titles.length === 0) throw new Error('A IA não devolveu nenhum título.')
  if (raw.titles.length > 3) notes.push('a IA devolveu mais de 3 títulos; ficaram os 3 primeiros')
  const description = cleanDescription(raw.description)
  if (description === '') notes.push('a IA não devolveu descrição')
  const tags = normalizeTags(raw.tags)
  const ch = validateChapters(raw.chapters, ctx.words, ctx.durationMs, ctx.cuts)
  notes.push(...ch.notes)

  const known = new Set(ctx.clips.map((c) => c.id))
  const clips: Record<string, ClipMeta> = {}
  for (const item of raw.clips) {
    const p = clipItem.safeParse(item)
    if (!p.success || !known.has(p.data.id)) {
      notes.push(`um texto de corte ${p.success ? `com o id "${p.data.id.slice(0, 30)}" (que não existe)` : 'em formato inválido'} foi descartado`)
      continue
    }
    const shorts = normalizeHashtags(p.data.shorts ?? [], 3).filter((h) => h.toLowerCase() !== '#shorts')
    clips[p.data.id] = {
      caption: oneLine(p.data.caption ?? '').slice(0, 220),
      tiktok: normalizeHashtags(p.data.tiktok ?? [], 5),
      reels: normalizeHashtags(p.data.reels ?? [], 5),
      shorts: [...shorts.slice(0, 2), '#Shorts']
    }
  }
  return { titles, description, tags, chapters: ch.chapters, clips, notes }
}

// ---------------------------------------------------------------------------
// Os textos que a exportação grava e os botões de copiar

/** A descrição do YouTube pronta para colar: o texto e a lista de capítulos (se ela é válida). */
export function descriptionWithChapters(description: string, lines: readonly ChapterLine[], outputMs: number): { text: string; chapters: ChapterCheck } {
  const check = checkChapters(lines, outputMs)
  const body = description.trim()
  if (!check.ok || lines.length === 0) return { text: body, chapters: check }
  return { text: `${body}${body ? '\n\n' : ''}${chaptersText(lines)}`, chapters: check }
}

export type YoutubeTextInput = {
  title: string
  titles: readonly string[]
  description: string
  tags: readonly string[]
  chapters: readonly Chapter[]
  kept: readonly Range[]
  /** Uma observação no fim do texto (ex.: "capítulos gerados pelas pausas, sem IA"). */
  chaptersNote?: string
  /** Por que não há capítulos (ex.: vídeo curto demais), quando a lista vazia não é por falta de geração. */
  chaptersWhy?: string
}

/** `exports/<título> - YouTube.txt`: títulos, descrição com capítulos e tags. */
export function buildYoutubeText(input: YoutubeTextInput): string {
  const outputMs = input.kept.reduce((a, r) => a + (r.end - r.start), 0)
  const lines = chapterLines(input.chapters, input.kept)
  const titles = input.titles.length > 0 ? input.titles : [input.title]
  const { text, chapters } = descriptionWithChapters(input.description, lines, outputMs)
  const out: string[] = ['TÍTULOS (escolha um)']
  titles.forEach((t, k) => out.push(`${k + 1}. ${t}`))
  out.push('', 'DESCRIÇÃO', text === '' ? '(sem descrição)' : text)
  if (!chapters.ok) {
    const why = input.chapters.length === 0 ? (input.chaptersWhy ?? 'nenhum foi gerado (aba Publicar)') : chapters.problems.join('; ')
    out.push('', `Capítulos não incluídos: ${why.replace(/[.\s]+$/u, '')}.`)
  }
  if (input.tags.length > 0) out.push('', 'TAGS', input.tags.join(', '))
  if (input.chaptersNote && chapters.ok) out.push('', input.chaptersNote)
  return `${out.join('\n')}\n`
}

/** O `.txt` que acompanha um corte exportado: título, gancho, legenda e hashtags de cada plataforma. */
export function buildClipText(clip: Pick<Clip, 'title' | 'hook'>, meta: ClipMeta): string {
  const out: string[] = [clip.title, ...(clip.hook.trim() ? [`Gancho: ${clip.hook.trim()}`] : []), '', 'Legenda:', meta.caption?.trim() || '(sem legenda)']
  const tags = (list: readonly string[] | undefined): string => (list && list.length > 0 ? list.join(' ') : '(nenhuma)')
  out.push('', `TikTok: ${tags(meta.tiktok)}`, `Reels: ${tags(meta.reels)}`, `Shorts: ${tags(meta.shorts)}`)
  return `${out.join('\n')}\n`
}

/** O texto de um corte: o que a pessoa guardou na aba Publicar; o que faltar vem do texto sem IA. */
export function resolveClipMeta(meta: ClipMeta | undefined, fallback: ClipMeta): ClipMeta {
  const pick = (v: readonly string[] | undefined, f: readonly string[] | undefined): string[] => (v && v.length > 0 ? [...v] : [...(f ?? [])])
  return {
    caption: meta?.caption?.trim() ? meta.caption : (fallback.caption ?? ''),
    tiktok: pick(meta?.tiktok ?? meta?.hashtags, fallback.tiktok),
    reels: pick(meta?.reels ?? meta?.hashtags, fallback.reels),
    shorts: pick(meta?.shorts ?? meta?.hashtags, fallback.shorts)
  }
}
