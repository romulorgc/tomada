/**
 * CORTES VERTICAIS (M4b): como a IA é pedida (texto do sistema e da transcrição em frases), como a resposta dela é
 * validada contra a transcrição, a heurística SEM IA, e como um corte vira o documento que a prévia e a exportação
 * desenham (`clipDocument`). Código puro: sem DOM, sem Node. Tempos em ms de ORIGEM.
 *
 * Um corte é uma lista de até 3 trechos (ms de origem) que começam numa frase completa e terminam no fim de uma frase.
 * Para exportar, `clipDocument` devolve o MESMO projeto com tudo o que está fora dos trechos cortado: o resto do app
 * (áudio, vídeo, legenda, duração) não sabe que existe "corte" e segue as mesmas funções, então o corte herda sozinho a
 * limpeza do projeto (silêncios e muletas dentro dele) e a edição do vertical (layout, legenda, zoom).
 */
import { z } from 'zod'
import { captionStyleDefaults } from './caption-style'
import { formatDuration, formatSpan } from './format'
import { nextSegId } from './segments'
import {
  buildSentences,
  keptMsBetween,
  sentenceAtPos,
  sentenceAtTime,
  sentenceFromPos,
  type Sentence
} from './sentences'
import { keptRanges, rangesLength } from './timeline'
import type { Clip, ClipNotes, Cut, Project, Range, VerticalLayout, Word } from './types'
import { defaultVerticalEdit, projectForFormat } from './vertical'

// ---------------------------------------------------------------------------
// Constantes

/** Duração pedida à IA e à heurística (ms). */
export const CLIP_MIN_MS = 30_000
export const CLIP_MAX_MS = 60_000
/**
 * O que se aceita de verdade (ms): a limpeza tira silêncio de dentro do corte, então um corte de "35 s de fala" sai com
 * 31 s; a folga evita jogar fora um bom corte por poucos segundos.
 */
export const CLIP_ACCEPT_MIN_MS = 25_000
export const CLIP_ACCEPT_MAX_MS = 65_000
export const CLIP_MAX_RANGES = 3
export const HOOK_MAX_WORDS = 8
export const TITLE_MAX = 80
export const HOOK_TEXT_MAX = 80
/** Quantas palavras o começo ou o fim indicado pode estar da borda de uma frase para ser "corrigido" em vez de recusado. */
export const SNAP_WORDS = 4
/** Dois cortes que dividem mais que isto do mais curto são "o mesmo corte". */
export const CLIP_OVERLAP_MAX = 0.2
/** Folga antes da primeira e depois da última palavra de um corte (ms). */
export const CLIP_LEAD_MS = 150
export const CLIP_TAIL_MS = 350

/** Quantos cortes pedir à IA para um vídeo de `outputMs`: 3 a 8 por 10 min, proporcional. */
export function clipCountRange(outputMs: number): { min: number; max: number } {
  const minutes = Math.max(0, outputMs) / 60_000
  const min = Math.min(8, Math.max(1, Math.round(minutes * 0.3)))
  const max = Math.min(8, Math.max(2, Math.round(minutes * 0.8), min))
  return { min, max }
}

/** Quantos a heurística propõe (sem IA): metade de um corte por minuto, de 1 a 8. */
export function heuristicClipCount(outputMs: number): number {
  return Math.min(8, Math.max(1, Math.round((Math.max(0, outputMs) / 60_000) * 0.5)))
}

// ---------------------------------------------------------------------------
// Tipos

export type ClipDraft = {
  title: string
  hook: string
  ranges: Range[]
  score: number
  notes: ClipNotes
  reason: string
  source: 'ai' | 'heuristic'
}

export type ClipDrop = { title: string; why: string }

export type ClipValidation = { clips: ClipDraft[]; dropped: ClipDrop[] }

/** O resultado de "Sugerir cortes" (atravessa a ponte). */
export type ClipsResult = {
  clips: ClipDraft[]
  dropped: ClipDrop[]
  /** Quem escolheu: a IA ou a heurística (sem IA). */
  source: 'ai' | 'heuristic'
  /** Quando a heurística foi usada porque não há IA: por quê e como ligar (a interface mostra). */
  notice: string | null
}

// ---------------------------------------------------------------------------
// O pedido à IA

export const CLIPS_SYSTEM = `Você é um editor de vídeos curtos (TikTok, Reels e Shorts) especializado em DEMONSTRAÇÕES DE PROGRAMAS: a pessoa grava a tela e narra o que faz. Você recebe a transcrição dividida em frases e escolhe os melhores CORTES VERTICAIS, de 30 a 60 segundos.

Cada frase chega assim:
[a-b] início–fim · duração · atividade na tela · texto
"a" e "b" são os números da primeira e da última palavra da frase. A atividade na tela diz quantos cliques e teclas houve durante a frase: quando há, a pessoa está MOSTRANDO algo; sem atividade, só está falando.

O QUE É UM BOM CORTE
1. COMEÇO: começa na PRIMEIRA palavra de uma frase completa (o "a" da frase) e, nos 3 primeiros segundos, dá o GANCHO: afirma o resultado ou a promessa ("Em 10 segundos o cliente já está cadastrado"), não o contexto. Se a abertura natural é fraca (cumprimento, "hoje eu vou mostrar", "então", "bom, vamos lá", "antes de começar"), comece na frase seguinte.
2. MEIO: uma ideia só, com preparação e resultado: aparece o pedido ou o problema, a pessoa faz, o resultado aparece. Prefira trechos com ação na tela; fala sem nada na tela serve para abrir (o gancho) ou fechar (a conclusão).
3. FIM: termina na ÚLTIMA palavra de uma frase completa (o "b" da frase) que FECHA a ideia: o resultado dito ou mostrado, uma conclusão. Nunca termine anunciando o assunto seguinte ("agora vamos ver…"), no meio de uma explicação ou num "então".
4. DURAÇÃO: do início da primeira frase ao fim da última, de 30 a 60 segundos (use os tempos de início e fim das linhas). Menos de 30 s corta o resultado; mais de 60 s perde a atenção.
5. AUTÔNOMO: quem nunca viu o resto do vídeo precisa entender. Evite trechos que dependem de "como eu disse antes", "aquele botão", "isso aqui".
6. VALOR: a pessoa aprende ou ganha algo concreto (um recurso, um atalho, tempo economizado).

O QUE É UM CORTE RUIM (não devolva)
- começa em cumprimento ou apresentação ("Oi, pessoal", "Hoje eu vou mostrar…") ou em conectivo que depende da frase anterior ("e", "mas", "então", "aí", "porque");
- termina no meio da ideia, ou numa frase que anuncia outra coisa;
- mistura dois assuntos sem ligação;
- só fala, sem nada na tela, do começo ao fim (a menos que a ideia seja muito forte);
- tem menos de 30 s ou mais de 60 s;
- repete trecho de outro corte: os cortes NÃO podem se sobrepor;
- tem gancho genérico ou que o trecho não entrega ("Você não vai acreditar", "Veja isso").

COMO RESPONDER
Responda SOMENTE com um JSON, sem texto fora dele:
{"clips":[{"title":"...","hook":"...","ranges":[[a,b]],"score":0,"notes":{"hook":0,"flow":0,"value":0},"reason":"..."}]}
- "ranges": de 1 a 3 intervalos [a,b] em ordem cronológica; cada um vai do "a" de uma frase ao "b" da mesma frase ou de uma seguinte. Use mais de um intervalo só para PULAR um trecho no meio do assunto (um desvio, uma pausa), nunca para mudar a ordem.
- "title": até 60 caracteres; diz o que o corte mostra ou ensina; sem emoji, sem caixa-alta, sem sensacionalismo.
- "hook": no máximo 8 palavras; afirma o resultado ("Cadastre um cliente em 10 segundos"). É o texto que aparece sobre o vídeo nos 2 primeiros segundos e precisa ser verdade para o trecho.
- "notes": de 0 a 100 para "hook" (força dos 3 primeiros segundos), "flow" (começo, meio e fim) e "value" (utilidade). Seja exigente: 80 ou mais só para o que é realmente forte.
- "score": nota geral de 0 a 100 (cerca de 40% gancho, 30% fluxo, 30% valor).
- "reason": uma frase dizendo por que este trecho funciona.
- Ordene do melhor para o pior. Use só números de palavra que existem. Prefira poucos cortes bons a muitos fracos; se nada presta, responda {"clips":[]}.`

/** Palavras por pedido e quantas se repetem de uma janela para a seguinte (fala longa: a IA lê uma janela por vez). */
export const CLIPS_WINDOW_WORDS = 3600
export const CLIPS_WINDOW_OVERLAP_WORDS = 300

const seconds = (ms: number): string => `${(Math.round(ms / 100) / 10).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`
const clock = (ms: number): string => formatDuration(ms)

/** Uma frase como a IA a lê: `[41-58] 1:12-1:21 · 9,3 s · 2 cliques, 5 teclas · texto`. */
export function sentenceLine(s: Sentence): string {
  const act: string[] = []
  if (s.clicks > 0) act.push(`${s.clicks} ${s.clicks === 1 ? 'clique' : 'cliques'}`)
  if (s.keys > 0) act.push(`${s.keys} ${s.keys === 1 ? 'tecla' : 'teclas'}`)
  return `[${s.first}-${s.last}] ${clock(s.startMs)}–${clock(s.endMs)} · ${seconds(s.endMs - s.startMs)} · ${act.length > 0 ? act.join(', ') : 'sem ação na tela'} · ${s.text}`
}

export type ClipPrompt = { prompt: string; sentences: number }

/** Os pedidos (um por janela de frases). `outputMs` é a duração do vídeo depois dos cortes de agora. */
export function buildClipPrompts(sentences: readonly Sentence[], opts: { durationMs: number; outputMs: number }): ClipPrompt[] {
  const prompts: ClipPrompt[] = []
  if (sentences.length === 0) return prompts
  const total = clipCountRange(opts.outputMs)
  let from = 0
  while (from < sentences.length) {
    let to = from
    let words = 0
    while (to < sentences.length && words < CLIPS_WINDOW_WORDS) words += sentences[to++]!.words
    const slice = sentences.slice(from, to)
    const share = slice.length === sentences.length ? 1 : Math.max(0.25, (slice[slice.length - 1]!.endMs - slice[0]!.startMs) / Math.max(1, opts.durationMs))
    const min = slice.length === sentences.length ? total.min : Math.max(1, Math.round(total.min * share))
    const max = slice.length === sentences.length ? total.max : Math.max(min, Math.round(total.max * share))
    const head = `Vídeo com ${formatSpan(opts.durationMs)} de gravação${slice.length === sentences.length ? '' : ` (esta parte vai de ${clock(slice[0]!.startMs)} a ${clock(slice[slice.length - 1]!.endMs)})`}. Tempos em minutos:segundos da gravação. Sugira de ${min} a ${max} cortes.`
    prompts.push({ prompt: `${head}\n\nFrases:\n${slice.map(sentenceLine).join('\n')}`, sentences: slice.length })
    if (to >= sentences.length) break
    // a janela seguinte repete umas 300 palavras do fim desta (um bom corte na emenda não escapa)
    let back = to
    let overlap = 0
    while (back > from + 1 && overlap < CLIPS_WINDOW_OVERLAP_WORDS) overlap += sentences[--back]!.words
    from = Math.max(from + 1, back)
  }
  return prompts
}

/** Esquema da resposta: a lista é conferida item a item (um item ruim não derruba os outros). */
export const clipsSchema = z.object({ clips: z.array(z.unknown()) })
export type ClipsResponse = z.infer<typeof clipsSchema>

const intLike = z.number().refine((n) => Number.isFinite(n), { message: 'número inválido' })
const rangeItem = z.union([z.tuple([intLike, intLike]), z.object({ from: intLike, to: intLike })])
const noteValue = z.number().optional()
const clipItemSchema = z.object({
  title: z.string(),
  hook: z.string().optional(),
  ranges: z.array(rangeItem).min(1),
  score: z.number().optional(),
  notes: z.object({ hook: noteValue, flow: noteValue, value: noteValue }).optional(),
  reason: z.string().optional()
})

// ---------------------------------------------------------------------------
// Texto e notas

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const note = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(clamp(v, 0, 100)) : fallback)
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Conectivos que não podem terminar um gancho cortado no meio ("Cadastre o cliente em"). */
const DANGLING = new Set(['e', 'de', 'do', 'da', 'dos', 'das', 'a', 'o', 'as', 'os', 'em', 'no', 'na', 'que', 'para', 'com', 'um', 'uma', 'ou', 'por', 'se'])

/** O gancho com no máximo 8 palavras: o que passa é cortado sem deixar um conectivo pendurado no fim. */
export function limitHook(text: string): string {
  const unquoted = oneLine(text).replace(/^["'“‘]+|["'”’]+$/gu, '')
  const parts = unquoted.split(' ').filter(Boolean)
  if (parts.length <= HOOK_MAX_WORDS) return unquoted.slice(0, HOOK_TEXT_MAX).trim()
  const kept = parts.slice(0, HOOK_MAX_WORDS)
  while (kept.length > 1 && DANGLING.has(kept[kept.length - 1]!.toLowerCase().replace(/[.,;:!?…]+$/u, ''))) kept.pop()
  return kept.join(' ').replace(/[,;:-]+$/u, '').slice(0, HOOK_TEXT_MAX).trim()
}

/** O título com no máximo 80 caracteres, cortado numa palavra inteira. */
export function limitTitle(text: string): string {
  const t = oneLine(text).replace(/^["'“‘]+|["'”’]+$/gu, '')
  if (t.length <= TITLE_MAX) return t
  const cut = t.slice(0, TITLE_MAX)
  const at = cut.lastIndexOf(' ')
  return (at > TITLE_MAX * 0.5 ? cut.slice(0, at) : cut).replace(/[,;:\-–]+$/u, '').trim()
}

const wordCount = (text: string): number => oneLine(text).split(' ').filter(Boolean).length
export const hookWords = wordCount

// ---------------------------------------------------------------------------
// Trechos

/** O trecho (ms) que vai da frase `a` à frase `b` (índices em `sentences`): folga curta antes e depois, nunca dentro de outra palavra. */
export function rangeOfSentences(words: readonly Word[], sentences: readonly Sentence[], a: number, b: number, durationMs: number): Range {
  const sa = sentences[a]!
  const sb = sentences[b]!
  const first = words[sa.firstPos]!
  const last = words[sb.lastPos]!
  const prev = words[sa.firstPos - 1]
  const next = words[sb.lastPos + 1]
  let start = first.start - CLIP_LEAD_MS
  if (prev) start = Math.max(start, (prev.end + first.start) / 2)
  let end = last.end + CLIP_TAIL_MS
  if (next) end = Math.min(end, (last.end + next.start) / 2)
  return { start: Math.round(Math.max(0, start)), end: Math.round(Math.min(durationMs > 0 ? durationMs : Infinity, Math.max(end, start + 1))) }
}

/** Ordena, limita a [0, duração] e funde trechos que se tocam. */
export function normalizeRanges(ranges: readonly Range[], durationMs: number): Range[] {
  const sorted = ranges
    .map((r) => ({ start: Math.max(0, Math.min(r.start, r.end)), end: Math.min(durationMs > 0 ? durationMs : Infinity, Math.max(r.start, r.end)) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((x, y) => x.start - y.start || x.end - y.end)
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

/** Duração do corte NO VÍDEO DE SAÍDA: o que sobra dos trechos depois dos cortes ligados do projeto. */
export function clipOutputMs(ranges: readonly Range[], cuts: readonly Pick<Cut, 'start' | 'end' | 'enabled'>[], durationMs: number): number {
  const kept = keptRanges(durationMs, cuts)
  let sum = 0
  for (const r of normalizeRanges(ranges, durationMs)) sum += keptMsBetween(kept, r.start, r.end)
  return sum
}

/** Quanto dois cortes dividem (ms de origem). */
export function clipOverlapMs(a: readonly Range[], b: readonly Range[]): number {
  let sum = 0
  for (const x of a) for (const y of b) sum += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start))
  return sum
}

const sharesTooMuch = (a: readonly Range[], b: readonly Range[], limit: number): boolean => {
  const shortest = Math.min(rangesLength(a), rangesLength(b))
  return shortest > 0 && clipOverlapMs(a, b) > shortest * limit
}

// ---------------------------------------------------------------------------
// Validar o que a IA devolveu

export type ValidateContext = {
  words: readonly Word[]
  durationMs: number
  cuts: readonly Pick<Cut, 'start' | 'end' | 'enabled'>[]
  /** Cortes que o projeto já tem (um novo que repete um deles é descartado). */
  existing?: readonly Pick<Clip, 'ranges' | 'title'>[]
  /** Quantos cortes devolver, no máximo. */
  max?: number
  /** Quem escolheu (padrão: a IA). */
  source?: ClipDraft['source']
  /** Faixa de duração aceita (padrão: 25-65 s). */
  minMs?: number
  maxMs?: number
  sentences?: readonly Sentence[]
}

type Snap = { ok: true; sentence: number } | { ok: false; why: string }

function snapStart(sentences: readonly Sentence[], byIndex: ReadonlyMap<number, number>, i: number): Snap {
  const pos = byIndex.get(i)
  if (pos === undefined) return { ok: false, why: `a palavra ${i} não existe` }
  const s = sentenceAtPos(sentences, pos)
  if (s === null) {
    const next = sentenceFromPos(sentences, pos)
    if (next < sentences.length && sentences[next]!.firstPos - pos <= SNAP_WORDS) return { ok: true, sentence: next }
    return { ok: false, why: `começa fora de uma frase (palavra ${i})` }
  }
  const sen = sentences[s]!
  if (pos === sen.firstPos) return { ok: true, sentence: s }
  const back = pos - sen.firstPos
  const fwd = s + 1 < sentences.length ? sentences[s + 1]!.firstPos - pos : Infinity
  if (back <= fwd && back <= SNAP_WORDS) return { ok: true, sentence: s }
  if (fwd <= SNAP_WORDS) return { ok: true, sentence: s + 1 }
  return { ok: false, why: `não começa no início de uma frase (palavra ${i})` }
}

function snapEnd(sentences: readonly Sentence[], byIndex: ReadonlyMap<number, number>, i: number): Snap {
  const pos = byIndex.get(i)
  if (pos === undefined) return { ok: false, why: `a palavra ${i} não existe` }
  const s = sentenceAtPos(sentences, pos)
  if (s === null) {
    const prev = sentenceFromPos(sentences, pos) - 1
    if (prev >= 0 && pos - sentences[prev]!.lastPos <= SNAP_WORDS) return { ok: true, sentence: prev }
    return { ok: false, why: `termina fora de uma frase (palavra ${i})` }
  }
  const sen = sentences[s]!
  if (pos === sen.lastPos) return { ok: true, sentence: s }
  const fwd = sen.lastPos - pos
  const back = s > 0 ? pos - sentences[s - 1]!.lastPos : Infinity
  if (fwd <= back && fwd <= SNAP_WORDS) return { ok: true, sentence: s }
  if (back <= SNAP_WORDS) return { ok: true, sentence: s - 1 }
  return { ok: false, why: `não termina no fim de uma frase (palavra ${i})` }
}

/**
 * Confere os cortes que a IA propôs contra a transcrição. Por corte: formato (esquema), índices que existem, cada trecho
 * começando no início de uma frase e terminando no fim de uma frase (até 4 palavras de erro são CORRIGIDAS para a borda
 * da frase; mais que isso, recusa), duração de saída de 25 a 65 s, e nenhum corte repetindo outro. O que não passa é
 * descartado com o MOTIVO (a interface conta quantos e por quê); nunca é aplicado pela metade.
 */
export function validateClips(raw: readonly unknown[], ctx: ValidateContext): ClipValidation {
  const words = ctx.words
  const sentences = ctx.sentences ?? buildSentences(words)
  const byIndex = new Map(words.map((w, pos) => [w.i, pos]))
  const minMs = ctx.minMs ?? CLIP_ACCEPT_MIN_MS
  const maxMs = ctx.maxMs ?? CLIP_ACCEPT_MAX_MS
  const source = ctx.source ?? 'ai'
  const dropped: ClipDrop[] = []
  const drafts: ClipDraft[] = []

  raw.forEach((item, n) => {
    const parsed = clipItemSchema.safeParse(item)
    const label = parsed.success ? limitTitle(parsed.data.title) || `Corte ${n + 1}` : `Corte ${n + 1}`
    if (!parsed.success) {
      dropped.push({ title: label, why: `o formato não é o pedido (${parsed.error.issues[0]?.path.join('.') || 'raiz'}: ${parsed.error.issues[0]?.message ?? 'inválido'})` })
      return
    }
    const c = parsed.data
    const title = limitTitle(c.title)
    if (title === '') {
      dropped.push({ title: label, why: 'sem título' })
      return
    }
    if (c.ranges.length > CLIP_MAX_RANGES) {
      dropped.push({ title, why: `tem ${c.ranges.length} trechos (o máximo é ${CLIP_MAX_RANGES})` })
      return
    }
    const ranges: Range[] = []
    for (const r of c.ranges) {
      const from = Array.isArray(r) ? r[0] : r.from
      const to = Array.isArray(r) ? r[1] : r.to
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        dropped.push({ title, why: 'os números de palavra não são inteiros' })
        return
      }
      if (to < from) {
        dropped.push({ title, why: `o trecho ${from}–${to} termina antes de começar` })
        return
      }
      const a = snapStart(sentences, byIndex, from)
      if (!a.ok) {
        dropped.push({ title, why: a.why })
        return
      }
      const b = snapEnd(sentences, byIndex, to)
      if (!b.ok) {
        dropped.push({ title, why: b.why })
        return
      }
      if (b.sentence < a.sentence) {
        dropped.push({ title, why: `o trecho ${from}–${to} não cobre uma frase inteira` })
        return
      }
      ranges.push(rangeOfSentences(words, sentences, a.sentence, b.sentence, ctx.durationMs))
    }
    const merged = normalizeRanges(ranges, ctx.durationMs)
    const out = clipOutputMs(merged, ctx.cuts, ctx.durationMs)
    if (out < minMs || out > maxMs) {
      dropped.push({ title, why: `dura ${formatSpan(out)} (precisa ficar entre ${Math.round(minMs / 1000)} e ${Math.round(maxMs / 1000)} s)` })
      return
    }
    const hook = limitHook(c.hook ?? '') || limitHook(title)
    const hn = c.notes
    const base = typeof c.score === 'number' && Number.isFinite(c.score) ? Math.round(clamp(c.score, 0, 100)) : null
    const notes: ClipNotes = {
      hook: note(hn?.hook, base ?? 50),
      flow: note(hn?.flow, base ?? 50),
      value: note(hn?.value, base ?? 50)
    }
    const score = base ?? Math.round(0.4 * notes.hook + 0.3 * notes.flow + 0.3 * notes.value)
    drafts.push({ title, hook, ranges: merged, score, notes, reason: oneLine(c.reason ?? '').slice(0, 240), source })
  })

  // os melhores primeiro; quem repete um corte melhor (ou um que já existe) é descartado
  const ordered = [...drafts].sort((a, b) => b.score - a.score)
  const accepted: ClipDraft[] = []
  for (const d of ordered) {
    const same = ctx.existing?.find((e) => sharesTooMuch(d.ranges, e.ranges, 0.5)) ?? accepted.find((e) => sharesTooMuch(d.ranges, e.ranges, CLIP_OVERLAP_MAX))
    if (same) {
      dropped.push({ title: d.title, why: `repete o corte «${same.title}»` })
      continue
    }
    if (ctx.max !== undefined && accepted.length >= ctx.max) {
      dropped.push({ title: d.title, why: 'passa da quantidade pedida' })
      continue
    }
    accepted.push(d)
  }
  return { clips: accepted, dropped }
}

// ---------------------------------------------------------------------------
// Heurística (sem IA)

const WEAK_START = /^(oi|ola|opa|e ai|bom dia|boa tarde|boa noite|bom|bem|entao|ai|e|mas|ou|porque|pois|so que|tipo|ne|vamos la|bora|hoje eu vou|hoje vou|antes de comecar|como eu disse|como falei|como a gente viu)\b/

/** Sem acento, minúsculas, sem pontuação (para reconhecer o começo fraco de uma frase). */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export function isWeakStart(sentenceText: string): boolean {
  return WEAK_START.test(fold(sentenceText))
}

/** Pausa (ms) antes e depois de uma frase, entre palavras de verdade. */
const GAP_BIG_MS = 600
const INTERNAL_PAUSE_MS = 2500

export type HeuristicInput = {
  words: readonly Word[]
  durationMs: number
  cuts: readonly Pick<Cut, 'start' | 'end' | 'enabled'>[]
  /** Instantes (ms) de cliques e de teclas. */
  clicks?: readonly number[]
  keys?: readonly number[]
  /** Quantos cortes (padrão: meio por minuto). */
  count?: number
  existing?: readonly Pick<Clip, 'ranges' | 'title'>[]
}

const HEURISTIC_FALLBACK = 'Veja a demonstração.'
const TERMINAL_WORD = /[.!?]["'”’)\]]*$/u
const ELLIPSIS_WORD = /(?:\.{2,}|…)["'”’)\]]*$/u
const ABBREVIATION_WORD = /^(?:sr|sra|dr|dra|prof|profa|ex|etc|vs|fig|pág|pag|av|nº)\.$/iu

/** Só a pontuação original fecha o texto: pausa, limite de palavras ou reticências não inventam uma conclusão. */
function completeHeuristicSentences(text: string): string[] {
  const sentences: string[] = []
  let parts: string[] = []
  for (const part of oneLine(text).split(' ').filter(Boolean)) {
    parts.push(part)
    if (!TERMINAL_WORD.test(part) || ELLIPSIS_WORD.test(part) || ABBREVIATION_WORD.test(part)) continue
    sentences.push(parts.join(' '))
    parts = []
  }
  return sentences
}

/** A vírgula identifica a muleta; "é importante", "bom atendimento" e "tipo de cadastro" conservam o sentido. */
function cleanHeuristicSentence(text: string): string {
  let clean = text.replace(/^(?:(?:é|hã|hum|ahn|então|entao|aí|ai|bom|bem|olha|tipo|né|ne)\s*[,;:]\s*)+/iu, '')
  clean = clean.replace(/,\s*(?:tipo|né|ne|hã|hum|ahn)(?:\s*,\s*(?:tipo|né|ne|hã|hum|ahn))*\s*,\s*/giu, ' ')
  clean = clean.replace(/,\s*(?:né|ne|tipo|hã|hum|ahn)\s*([.!?]["'”’)\]]*)$/iu, '$1')
  clean = oneLine(clean)
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

function heuristicCopy(text: string, maxCharacters: number, maxWords = Infinity): string {
  for (const raw of completeHeuristicSentences(text)) {
    const candidate = cleanHeuristicSentence(raw)
    const words = wordCount(candidate)
    const folded = fold(candidate)
    if (words === 0 || words > maxWords || candidate.length > maxCharacters || (words === 1 && folded === 'e')) continue
    if (/^(?:oi|ola|opa|entao|ai|tipo|ne|hum|ahn|mas|porque|pois)\b/u.test(folded) || /^(?:e|hã)\b/iu.test(candidate)) continue
    const lastWord = folded.split(' ').at(-1) ?? ''
    if (DANGLING.has(lastWord)) continue
    return candidate
  }
  return HEURISTIC_FALLBACK
}

/** Uma frase inteira do corte como título, até 80 caracteres; nunca trunca a fala nem adiciona ponto. */
export function titleFromText(text: string): string {
  return heuristicCopy(text, TITLE_MAX)
}

/** Título e gancho sem IA, inclusive para a versão completa de uma gravação curta. */
export function heuristicClipLabels(text: string): { title: string; hook: string } {
  return { title: titleFromText(text), hook: heuristicCopy(text, HOOK_TEXT_MAX, HOOK_MAX_WORDS) }
}

type Candidate = { a: number; b: number; draft: ClipDraft; range: Range }

/**
 * Cortes SEM IA: blocos de frases entre pausas, de 30 a 60 s, começando numa frase que não seja cumprimento nem conectivo
 * e terminando numa frase que fecha (ponto final e pausa depois). A nota vem da densidade de fala (2 a 3 palavras por
 * segundo), da atividade de tela (cliques e teclas por segundo) e de como o começo e o fim se apoiam em pausas. Não
 * entende o assunto: título e gancho vêm de frases inteiras do próprio trecho, e a nota é honesta (`reason` diz "sem IA").
 */
export function heuristicClips(input: HeuristicInput): ClipValidation {
  const words = input.words
  const sentences = buildSentences(words, { ...(input.clicks ? { clicks: input.clicks } : {}), ...(input.keys ? { keys: input.keys } : {}) })
  const kept = keptRanges(input.durationMs, input.cuts)
  const outputMs = rangesLength(kept)
  const count = input.count ?? heuristicClipCount(outputMs)
  const cands: Candidate[] = []
  const gapBefore = (i: number): number => (i === 0 ? Infinity : sentences[i]!.startMs - sentences[i - 1]!.endMs)
  const gapAfter = (i: number): number => (i + 1 >= sentences.length ? Infinity : sentences[i + 1]!.startMs - sentences[i]!.endMs)

  for (let a = 0; a < sentences.length; a++) {
    if (isWeakStart(sentences[a]!.text)) continue
    const closes: { b: number; closing: number }[] = []
    for (let b = a; b < sentences.length; b++) {
      const r = rangeOfSentences(words, sentences, a, b, input.durationMs)
      const dur = keptMsBetween(kept, r.start, r.end)
      if (dur > CLIP_MAX_MS) break
      if (dur < CLIP_MIN_MS) continue
      const s = sentences[b]!
      const terminal = /[.!…]["')\]]*$/u.test(s.text.trim())
      const closing = (terminal ? 50 : 20) + (gapAfter(b) >= GAP_BIG_MS ? 50 : 0)
      closes.push({ b, closing })
    }
    // fica com os dois finais que mais fecham a ideia
    closes.sort((x, y) => y.closing - x.closing || y.b - x.b)
    for (const { b, closing } of closes.slice(0, 2)) {
      const range = rangeOfSentences(words, sentences, a, b, input.durationMs)
      const dur = keptMsBetween(kept, range.start, range.end) / 1000
      const slice = sentences.slice(a, b + 1)
      const nWords = slice.reduce((acc, s) => acc + s.words, 0)
      const speech = slice.reduce((acc, s) => acc + (s.endMs - s.startMs), 0) / 1000
      const wps = nWords / Math.max(1, speech)
      const density = 100 * clamp(1 - Math.abs(wps - 2.6) / 2, 0, 1)
      const events = slice.reduce((acc, s) => acc + s.clicks + s.keys / 6, 0)
      const activity = 100 * clamp(events / dur / 0.2, 0, 1)
      const early = slice.filter((s) => s.startMs - slice[0]!.startMs <= 5000).reduce((acc, s) => acc + s.clicks + s.keys, 0) > 0
      const start = (gapBefore(a) >= GAP_BIG_MS ? 100 : 55) - (slice[0]!.words > 26 ? 25 : 0)
      let longPauses = 0
      for (let k = a; k < b; k++) if (sentences[k + 1]!.startMs - sentences[k]!.endMs > INTERNAL_PAUSE_MS) longPauses++
      const hook = Math.round(clamp(0.6 * start + 0.4 * (early ? 100 : 30), 0, 100))
      const flow = Math.round(clamp(0.6 * Math.min(100, closing) + 0.4 * (100 - Math.min(2, longPauses) * 25), 0, 100))
      const value = Math.round(clamp(0.5 * density + 0.5 * activity, 0, 100))
      const score = Math.round(0.4 * hook + 0.3 * flow + 0.3 * value)
      const text = slice.map(sentence => sentence.text).join(' ')
      cands.push({
        a,
        b,
        range,
        draft: {
          ...heuristicClipLabels(text),
          ranges: [range],
          score,
          notes: { hook, flow, value },
          reason: `Sem IA: fala contínua (${wps.toFixed(1).replace('.', ',')} palavras por segundo)${events > 0 ? ` e ${Math.round(slice.reduce((acc, s) => acc + s.clicks + s.keys, 0))} ações na tela` : ''}.`,
          source: 'heuristic'
        }
      })
    }
  }

  cands.sort((x, y) => y.draft.score - x.draft.score || x.a - y.a)
  const accepted: ClipDraft[] = []
  const dropped: ClipDrop[] = []
  for (const c of cands) {
    if (accepted.length >= count) break
    if (accepted.some((x) => clipOverlapMs(x.ranges, c.draft.ranges) > 0)) continue
    if (input.existing?.some((e) => sharesTooMuch(c.draft.ranges, e.ranges, 0.5))) continue
    accepted.push(c.draft)
  }
  return { clips: accepted, dropped }
}

// ---------------------------------------------------------------------------
// Do corte ao documento

/** O que sobra FORA dos trechos de um corte (para virar cortes do documento). */
export function complementRanges(ranges: readonly Range[], durationMs: number): Range[] {
  const keep = normalizeRanges(ranges, durationMs)
  const out: Range[] = []
  let cursor = 0
  for (const r of keep) {
    if (r.start > cursor) out.push({ start: cursor, end: r.start })
    cursor = Math.max(cursor, r.end)
  }
  if (cursor < durationMs) out.push({ start: cursor, end: durationMs })
  return out
}

/**
 * O projeto como um CORTE o enxerga: tudo o que está fora dos trechos vira corte (`manual`, ligado), o título de gancho
 * é o do corte (o do projeto não vale: o corte tem o dele) e o estilo de legenda do corte, se tiver, vale. O resto (cortes de
 * silêncio e de muleta, voz silenciada, texto corrigido, zooms e layouts do vertical) é o do projeto. A prévia e a
 * exportação do corte desenham ESTE documento pelo mesmo caminho do vídeo inteiro.
 */
export function clipDocument(doc: Project, clip: Pick<Clip, 'ranges' | 'hook' | 'captionStyle' | 'captionsEnabled'>): Project {
  const durationMs = Math.max(doc.sources.screen?.durationMs ?? 0, doc.sources.camera?.durationMs ?? 0, doc.sources.voice?.durationMs ?? 0, doc.sources.system?.durationMs ?? 0)
  const outside = complementRanges(clip.ranges, durationMs)
  const cuts: Cut[] = [...doc.cuts]
  for (const r of outside) cuts.push({ id: nextSegId(cuts, 'clip-out'), start: r.start, end: r.end, reason: 'manual', enabled: true })
  const base = doc.vertical ?? defaultVerticalEdit()
  const vertical = { ...base }
  const hook = clip.hook.trim()
  if (hook !== '') vertical.hook = hook
  else delete vertical.hook
  if (clip.captionStyle) {
    vertical.captions = { ...base.captions, style: clip.captionStyle, ...captionStyleDefaults(clip.captionStyle, 'vertical') }
  }
  if (clip.captionsEnabled !== undefined) vertical.captions = { ...vertical.captions, enabled: clip.captionsEnabled }
  return { ...doc, cuts, vertical }
}

/** Fixa o layout do corte (V-A, V-B, V-C ou só câmera) no corte todo; `auto` deixa a escolha por atividade do projeto. */
export function withClipLayout(doc: Project, layoutV: VerticalLayout): Project {
  if (layoutV === 'auto') return doc
  const base = doc.vertical ?? defaultVerticalEdit()
  return { ...doc, vertical: { ...base, layout: layoutV, layouts: [] } }
}

/**
 * O corte como a prévia o desenha: o documento do corte (`clipDocument`), o layout fixo dele (`withClipLayout`) e a visão do
 * vertical. É a MESMA cadeia que a exportação percorre (a exportação só gera, no meio dela, os zooms e layouts de um vertical
 * nunca aberto), então prévia = exportação.
 */
export function clipScene(doc: Project, clip: Pick<Clip, 'ranges' | 'hook' | 'captionStyle' | 'layoutV'>): Project {
  return projectForFormat(withClipLayout(clipDocument(doc, clip), clip.layoutV), 'vertical')
}

// ---------------------------------------------------------------------------
// Lista de cortes do documento

export type ClipSummary = { id: string; number: number; title: string; durationMs: number }

/** Os cortes novos entram no fim da lista, com id próprio; o que repete um corte que já existe fica de fora. */
export function mergeSuggestedClips(existing: readonly Clip[], drafts: readonly ClipDraft[]): { clips: Clip[]; added: Clip[]; skipped: number } {
  const clips = [...existing]
  const added: Clip[] = []
  let skipped = 0
  for (const d of drafts) {
    if (clips.some((e) => sharesTooMuch(d.ranges, e.ranges, 0.5))) {
      skipped++
      continue
    }
    const clip: Clip = {
      id: nextSegId(clips, 'clip'),
      title: d.title,
      hook: d.hook,
      ranges: d.ranges.map((r) => ({ ...r })),
      score: d.score,
      notes: { ...d.notes },
      reason: d.reason,
      format: 'vertical',
      layoutV: 'auto',
      source: d.source
    }
    clips.push(clip)
    added.push(clip)
  }
  return { clips, added, skipped }
}

/** O texto do corte (as palavras de verdade dentro dos trechos), para mostrar e para conferir. */
export function clipText(ranges: readonly Range[], words: readonly Word[]): string {
  const parts: string[] = []
  for (const r of ranges) {
    for (const w of words) {
      if (w.kind !== 'word') continue
      const mid = (w.start + w.end) / 2
      if (mid >= r.start && mid < r.end) parts.push(oneLine(w.text))
    }
  }
  return parts.join(' ')
}

/**
 * Anda o começo ou o fim do corte uma FRASE para o lado (ajuste pela transcrição). Nunca deixa o corte vazio.
 * `dir` −1 = para antes, +1 = para depois. `null` quando não dá (não há frase para o lado, ou o corte ficaria sem frase).
 */
export function shiftClipEdge(clip: Clip, words: readonly Word[], edge: 'start' | 'end', dir: -1 | 1, durationMs: number): Clip | null {
  const sentences = buildSentences(words)
  if (sentences.length === 0 || clip.ranges.length === 0) return null
  const ranges = normalizeRanges(clip.ranges, durationMs)
  const firstSentence = sentenceAtTime(sentences, ranges[0]!.start)
  const lastSentence = sentenceAtTime(sentences, ranges[ranges.length - 1]!.end - 1)
  if (firstSentence < 0 || lastSentence < 0) return null
  // a frase do começo é a primeira que termina depois do começo do corte; a do fim, a última que começa antes do fim
  let a = firstSentence
  while (a < sentences.length - 1 && sentences[a]!.endMs <= ranges[0]!.start) a++
  let b = lastSentence
  while (b > 0 && sentences[b]!.startMs >= ranges[ranges.length - 1]!.end) b--
  const next = edge === 'start' ? a + dir : b + dir
  if (next < 0 || next >= sentences.length) return null
  if (edge === 'start' && next > b) return null
  if (edge === 'end' && next < a) return null
  const out = ranges.map((r) => ({ ...r }))
  if (edge === 'start') {
    out[0] = { ...out[0]!, start: rangeOfSentences(words, sentences, next, next, durationMs).start }
    if (out[0]!.start >= out[0]!.end) return null
  } else {
    const last = out.length - 1
    out[last] = { ...out[last]!, end: rangeOfSentences(words, sentences, next, next, durationMs).end }
    if (out[last]!.end <= out[last]!.start) return null
  }
  const merged = normalizeRanges(out, durationMs)
  const total = rangesLength(merged)
  if (total <= 0) return null
  return { ...clip, ranges: merged, source: 'manual' }
}
