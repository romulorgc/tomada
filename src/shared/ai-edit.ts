/**
 * EDITAR PEDINDO (M4b): a pessoa escreve o que quer ("tira a parte do preço", "faz 3 cortes para TikTok"), a IA devolve
 * OPERAÇÕES sobre a transcrição e este módulo as valida e aplica como UMA mudança do documento (um passo de desfazer),
 * com um resumo humano do que mudou. Código puro: sem DOM, sem Node. Tempos em ms de ORIGEM; as operações apontam
 * palavras da transcrição (`Word.i`), nunca tempos.
 *
 * Regra de ouro: cada operação é aplicada INTEIRA ou recusada com o motivo; nada é aplicado pela metade e nada é
 * "arrumado" em silêncio (um índice que não existe não vira o mais próximo). Se a mudança tiraria mais de 20% do vídeo, o
 * plano pede confirmação antes de aplicar.
 */
import { z } from 'zod'
import { CAPTION_STYLE_DEFAULTS, CAPTION_STYLE_IDS } from './caption-style'
import { limitHook, limitTitle, mergeSuggestedClips, validateClips } from './clips'
import { createLayoutSeg, createZoom, ZOOM_SCALE_MAX, ZOOM_SCALE_MIN } from './edits'
import { formatDuration, formatSpan } from './format'
import { nextSegId } from './segments'
import { buildSentences } from './sentences'
import { restoreWords, wordCutRange } from './text-edit'
import { keptRanges, outputDuration } from './timeline'
import type { CaptionStyleId, Cut, LayoutKind, Project, Word } from './types'
import { VERTICAL_ZOOM_SCALE } from './zoom'

/** Passou disto do vídeo (depois dos cortes de agora), a interface pede confirmação. */
export const EDIT_CONFIRM_FRACTION = 0.2
/** Mais operações que isto numa resposta só: recusa tudo (a IA se perdeu). */
export const EDIT_MAX_OPS = 40
/** Pedido de edição com mais que isto de caracteres é cortado antes de ir. */
export const EDIT_INSTRUCTION_MAX = 1000

export type EditFormat = 'horizontal' | 'vertical'

export const HORIZONTAL_LAYOUT_VALUES: readonly LayoutKind[] = ['bubble', 'side-by-side', 'screen', 'camera']
export const VERTICAL_LAYOUT_VALUES: readonly LayoutKind[] = ['screen-focus', 'stack', 'screen-wide', 'camera']
/** Layouts que mostram a câmera (sem câmera no projeto, não valem). */
const NEEDS_CAMERA = new Set<LayoutKind>(['side-by-side', 'camera', 'stack'])

// ---------------------------------------------------------------------------
// Operações

const idx = z.number().int().nonnegative()
const pair = z.tuple([idx, idx])

export const aiOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('cut'), from: idx, to: idx, reason: z.string().optional() }),
  z.object({ op: z.literal('restore'), from: idx, to: idx }),
  z.object({ op: z.literal('zoom'), from: idx, to: idx, scale: z.number().optional() }),
  z.object({ op: z.literal('layout'), from: idx, to: idx, layout: z.string() }),
  z.object({ op: z.literal('clip'), title: z.string(), hook: z.string().optional(), ranges: z.array(pair).min(1).max(3) }),
  z.object({
    op: z.literal('captions'),
    enabled: z.boolean().optional(),
    style: z.string().optional(),
    wordsPerLine: z.number().int().optional()
  }),
  z.object({ op: z.literal('title'), text: z.string() })
])
export type AiOp = z.infer<typeof aiOpSchema>
export type AiOpName = AiOp['op']

/** A resposta da IA: a lista é conferida operação por operação (uma operação ruim não derruba as outras). */
export const editSchema = z.object({ ops: z.array(z.unknown()), reply: z.string().optional() })
export type EditResponse = z.infer<typeof editSchema>

/** O que "editar pedindo" devolve à interface: as operações CRUAS (a interface as valida e aplica) e a frase da IA. */
export type AiEditResult = { ops: unknown[]; reply: string | null }

// ---------------------------------------------------------------------------
// O pedido à IA

export function editSystem(format: EditFormat, hasCamera: boolean): string {
  const layouts = (format === 'vertical' ? VERTICAL_LAYOUT_VALUES : HORIZONTAL_LAYOUT_VALUES).filter((l) => hasCamera || !NEEDS_CAMERA.has(l))
  const names: Record<string, string> = {
    bubble: 'tela com a câmera numa bolha',
    'side-by-side': 'tela e câmera lado a lado',
    screen: 'só a tela',
    camera: 'só a câmera',
    'screen-focus': 'tela em foco que segue o cursor',
    stack: 'câmera em cima e tela embaixo',
    'screen-wide': 'tela inteira na largura'
  }
  return `Você é o assistente de edição de um editor de vídeo de tela (demonstrações de programas narradas). A pessoa escreve um pedido em português e você devolve OPERAÇÕES que o programa aplica ao projeto dela.

A transcrição vem em linhas "início–fim · atividade na tela · [n]palavra [n]palavra …": cada palavra traz o número dela entre colchetes. Use SEMPRE esses números: "from" e "to" são números de palavra (inclusive nos dois lados).

OPERAÇÕES (cada uma é um objeto em "ops")
{"op":"cut","from":N,"to":M,"reason":"..."}     corta as palavras de N a M (a imagem e o som desse trecho saem do vídeo)
{"op":"restore","from":N,"to":M}                 devolve ao vídeo as palavras de N a M que estavam cortadas
{"op":"zoom","from":N,"to":M,"scale":1.7}        zoom no trecho (scale de 1.1 a 4; omita para o padrão)
{"op":"layout","from":N,"to":M,"layout":"..."}   troca o layout do trecho. Valores: ${layouts.map((l) => `"${l}" (${names[l]})`).join(', ')}
{"op":"clip","title":"...","hook":"...","ranges":[[N,M]]}   cria um corte vertical para TikTok, Reels e Shorts (de 30 a 60 s; começa no início e termina no fim de frases; até 3 trechos em ordem)
{"op":"captions","enabled":true,"style":"highlight|natural|clean|karaoke","wordsPerLine":3}   liga, desliga ou muda a legenda (todos os campos são opcionais)
{"op":"title","text":"..."}                       muda o título do projeto

COMO RESPONDER
Responda SOMENTE com um JSON, sem texto fora dele: {"ops":[...],"reply":"..."}
- "reply": uma frase curta dizendo o que você fez, ou por que não fez.
- Faça só o que foi pedido, e o mínimo para isso. Nunca invente números de palavra: use só os que aparecem na transcrição.
- Para cortar um assunto ("tira a parte do preço"), ache onde a pessoa FALA dele e corte as frases inteiras, do começo da primeira ao fim da última, sem deixar pedaço de frase.
- Não corte hesitações, pausas e silêncios soltos: outra etapa do programa cuida deles.
- Pedido vago ("deixa mais dinâmico"): poucas mudanças seguras: corte repetição e enrolação óbvias, ponha zoom onde a pessoa MOSTRA algo (frases com cliques e teclas) e diga o que fez no "reply".
- Corte vertical ("faz 3 cortes para TikTok"): cada um com 30 a 60 s do início da primeira frase ao fim da última, começando num gancho que afirma o resultado (não num cumprimento) e terminando fechando a ideia, com "title" (até 60 caracteres) e "hook" (até 8 palavras). Os cortes não podem se sobrepor.
- Se o pedido não dá para fazer com estas operações, ou é só uma pergunta, devolva "ops":[] e explique no "reply".`
}

const clean = (text: string): string => text.trim().replace(/\s+/g, ' ')
const clock = formatDuration

/** Quais palavras (números) um intervalo de tempo cobre: pelo ponto médio. `null` se nenhuma. */
function wordSpan(words: readonly Word[], start: number, end: number): { from: number; to: number } | null {
  let from = -1
  let to = -1
  for (const w of words) {
    if (w.kind === 'gap-speech') continue
    const mid = (w.start + w.end) / 2
    if (mid >= start && mid < end) {
      if (from < 0) from = w.i
      to = w.i
    }
  }
  return from < 0 ? null : { from, to }
}

export type EditPromptInput = {
  instruction: string
  words: readonly Word[]
  project: Project
  format: EditFormat
  durationMs: number
  clicks?: readonly number[]
  keys?: readonly number[]
}

/** O pedido: o que a pessoa escreveu, o estado do projeto (cortes, zooms, layouts, cortes verticais) e a transcrição com os números. */
export function buildEditPrompt(input: EditPromptInput): string {
  const { project, words, durationMs } = input
  const kept = keptRanges(durationMs, project.cuts)
  const outMs = kept.reduce((a, r) => a + (r.end - r.start), 0)
  const lines: string[] = []
  lines.push(`Pedido da pessoa: ${JSON.stringify(clean(input.instruction).slice(0, EDIT_INSTRUCTION_MAX))}`)
  lines.push('')
  lines.push(`Projeto "${clean(project.title).slice(0, 120)}" · formato aberto: ${input.format === 'vertical' ? '9:16 (vertical)' : '16:9 (horizontal)'} · gravação de ${formatSpan(durationMs)} · vídeo de ${formatSpan(outMs)} depois dos cortes · câmera: ${project.sources.camera ? 'sim' : 'não'} · legenda: ${project.captions.enabled ? `ligada (${project.captions.style})` : 'desligada'}`)

  const cuts = project.cuts.filter((c) => c.enabled)
  const silences = cuts.filter((c) => c.reason === 'silence')
  const others = cuts.filter((c) => c.reason !== 'silence')
  lines.push('')
  lines.push(`Cortes atuais: ${cuts.length === 0 ? 'nenhum' : ''}`.trimEnd())
  if (silences.length > 0) lines.push(`- ${silences.length} silêncios cortados (${formatSpan(silences.reduce((a, c) => a + (c.end - c.start), 0))} no total; não precisa mexer neles)`)
  for (const c of others.slice(0, 40)) {
    const span = wordSpan(words, c.start, c.end)
    lines.push(`- ${clock(c.start)}–${clock(c.end)} ${span ? `palavras ${span.from}–${span.to}` : 'sem palavras'} (${c.reason === 'manual' ? 'cortado pela pessoa' : c.reason === 'filler' ? 'hesitação' : c.reason === 'retake' ? 'recomeço' : 'cortado pela IA'})`)
  }
  if (others.length > 40) lines.push(`- e mais ${others.length - 40} cortes`)
  lines.push(`Zooms: ${project.zooms.length === 0 ? 'nenhum' : project.zooms.length}${project.zooms.length > 0 ? ` (de ${clock(project.zooms[0]!.start)} a ${clock(project.zooms[project.zooms.length - 1]!.end)})` : ''}`)
  lines.push(`Trechos de layout: ${project.layouts.length === 0 ? `nenhum (padrão: ${project.style.defaultLayout})` : project.layouts.map((l) => `${clock(l.start)}–${clock(l.end)} ${l.layout}`).join('; ')}`)
  lines.push(`Cortes verticais já criados: ${project.clips.length === 0 ? 'nenhum' : project.clips.map((c) => `"${clean(c.title)}" (${c.ranges.map((r) => `${clock(r.start)}–${clock(r.end)}`).join(' + ')})`).join('; ')}`)

  lines.push('')
  lines.push('Transcrição (início–fim da frase · atividade na tela · palavras numeradas):')
  const sentences = buildSentences(words, { ...(input.clicks ? { clicks: input.clicks } : {}), ...(input.keys ? { keys: input.keys } : {}) })
  const usable = words.map((w, pos) => ({ w, pos })).filter(({ w }) => w.kind !== 'gap-speech' && clean(w.text) !== '')
  let at = 0
  for (const s of sentences) {
    const body: string[] = []
    while (at < usable.length && usable[at]!.pos < s.firstPos) at++
    while (at < usable.length && usable[at]!.pos <= s.lastPos) {
      const { w } = usable[at]!
      body.push(`[${w.i}]${clean(w.text)}`)
      at++
    }
    const act: string[] = []
    if (s.clicks > 0) act.push(`${s.clicks} ${s.clicks === 1 ? 'clique' : 'cliques'}`)
    if (s.keys > 0) act.push(`${s.keys} ${s.keys === 1 ? 'tecla' : 'teclas'}`)
    lines.push(`${clock(s.startMs)}–${clock(s.endMs)} · ${act.length > 0 ? act.join(', ') : 'sem ação na tela'} · ${body.join(' ')}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Aplicar

export type AppliedOp = { op: AiOpName; text: string }
export type RefusedOp = { index: number; op: string; why: string }

export type AiEditPlan = {
  /** O documento depois da mudança (o mesmo objeto de entrada se nada mudou). */
  project: Project
  applied: AppliedOp[]
  refused: RefusedOp[]
  changed: boolean
  /** "Cortei 3 trechos (−42 s), adicionei 1 zoom." - ou o motivo de nada ter sido aplicado. */
  summary: string
  beforeMs: number
  afterMs: number
  /** Quanto o vídeo encolheu (negativo = cresceu). */
  removedMs: number
  /** Passou de 20% do vídeo: a interface pede confirmação. */
  needsConfirm: boolean
  /** O que a IA disse ("reply"), se veio. */
  reply: string | null
}

export type PlanInput = {
  project: Project
  words: readonly Word[]
  durationMs: number
  format: EditFormat
  ops: readonly unknown[]
  reply?: string | null
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Corta [start, end) com o motivo da IA; funde com os cortes da IA que se tocam. */
function addAiCut(cuts: readonly Cut[], start: number, end: number): Cut[] {
  let a = Math.round(start)
  let b = Math.round(end)
  const touching = cuts.filter((c) => c.reason === 'ai' && c.enabled && c.start <= b && c.end >= a)
  for (const c of touching) {
    a = Math.min(a, c.start)
    b = Math.max(b, c.end)
  }
  const keep = cuts.filter((c) => !touching.includes(c))
  const id = touching[0]?.id ?? nextSegId(cuts, 'cut')
  return [...keep, { id, start: a, end: b, reason: 'ai' as const, enabled: true }].sort((x, y) => x.start - y.start || x.end - y.end)
}

const MIN_AI_CUT_MS = 40
const ZOOM_LEAD_MS = 250
const ZOOM_TAIL_MS = 350

/**
 * Valida e aplica as operações da IA numa só passada. Cada operação ou é aplicada inteira ou é recusada com o motivo
 * (índice que não existe, trecho que não cabe, layout que o formato não tem…). Devolve o documento novo, o que foi feito,
 * o que foi recusado, o resumo em português e se precisa de confirmação (mais de 20% do vídeo).
 */
export function planAiEdit(input: PlanInput): AiEditPlan {
  const { words, durationMs, format } = input
  const base = input.project
  const byIndex = new Map(words.map((w, pos) => [w.i, pos]))
  const beforeMs = outputDuration(durationMs, base.cuts)
  const refused: RefusedOp[] = []
  const applied: AppliedOp[] = []
  const reply = input.reply?.trim() ? clean(input.reply).slice(0, 400) : null
  const none = (summary: string): AiEditPlan => ({ project: base, applied: [], refused, changed: false, summary, beforeMs, afterMs: beforeMs, removedMs: 0, needsConfirm: false, reply })

  if (input.ops.length === 0) return none(reply ?? 'A IA não propôs nenhuma mudança.')
  if (input.ops.length > EDIT_MAX_OPS) {
    refused.push({ index: 0, op: '', why: `a IA pediu ${input.ops.length} operações de uma vez (o máximo é ${EDIT_MAX_OPS})` })
    return none(`Recusei o pedido: a IA propôs operações demais (${input.ops.length}). Peça algo mais específico.`)
  }

  let p = base
  const counts = { cut: 0, restore: 0, zoom: 0, layout: 0, clip: 0, captions: 0, title: 0 }
  let cutMs = 0
  let restoredMs = 0
  const layoutsAllowed = format === 'vertical' ? VERTICAL_LAYOUT_VALUES : HORIZONTAL_LAYOUT_VALUES
  const zoomDefault = format === 'vertical' ? VERTICAL_ZOOM_SCALE.intense : 1.7

  const refuse = (index: number, op: string, why: string): void => {
    refused.push({ index, op, why })
  }
  /** Os dois números viram posições na transcrição, ou o motivo. */
  const span = (from: number, to: number): { a: number; b: number } | string => {
    const a = byIndex.get(from)
    const b = byIndex.get(to)
    if (a === undefined) return `a palavra ${from} não existe`
    if (b === undefined) return `a palavra ${to} não existe`
    if (to < from) return `o trecho ${from}–${to} termina antes de começar`
    return { a, b }
  }

  input.ops.forEach((raw, index) => {
    const parsed = aiOpSchema.safeParse(raw)
    if (!parsed.success) {
      const name = typeof (raw as { op?: unknown } | null)?.op === 'string' ? String((raw as { op: string }).op) : ''
      const known = ['cut', 'restore', 'zoom', 'layout', 'clip', 'captions', 'title'].includes(name)
      refuse(index, name, known ? `faltam dados ou há dados inválidos (${parsed.error.issues[0]?.path.join('.') || 'op'}: ${parsed.error.issues[0]?.message ?? 'inválido'})` : name ? `operação desconhecida "${name.slice(0, 40)}"` : 'não é uma operação')
      return
    }
    const op = parsed.data
    switch (op.op) {
      case 'cut': {
        const s = span(op.from, op.to)
        if (typeof s === 'string') return refuse(index, 'cut', s)
        const r = wordCutRange(words, s.a, s.b, durationMs)
        if (r.end - r.start < MIN_AI_CUT_MS) return refuse(index, 'cut', 'o trecho é curto demais para cortar')
        const next = addAiCut(p.cuts, r.start, r.end)
        const delta = outputDuration(durationMs, p.cuts) - outputDuration(durationMs, next)
        if (delta <= 0) return refuse(index, 'cut', 'esse trecho já estava cortado')
        p = { ...p, cuts: next }
        cutMs += delta
        counts.cut++
        applied.push({ op: 'cut', text: `cortei as palavras ${op.from}–${op.to} (−${formatSpan(delta)})` })
        return
      }
      case 'restore': {
        const s = span(op.from, op.to)
        if (typeof s === 'string') return refuse(index, 'restore', s)
        const next = restoreWords(p.cuts, words, s.a, s.b, durationMs)
        const delta = outputDuration(durationMs, next) - outputDuration(durationMs, p.cuts)
        if (delta <= 0) return refuse(index, 'restore', 'esse trecho não estava cortado')
        p = { ...p, cuts: next }
        restoredMs += delta
        counts.restore++
        applied.push({ op: 'restore', text: `devolvi as palavras ${op.from}–${op.to} (+${formatSpan(delta)})` })
        return
      }
      case 'zoom': {
        const s = span(op.from, op.to)
        if (typeof s === 'string') return refuse(index, 'zoom', s)
        if (op.scale !== undefined && (!Number.isFinite(op.scale) || op.scale < ZOOM_SCALE_MIN || op.scale > ZOOM_SCALE_MAX)) {
          return refuse(index, 'zoom', `a escala ${op.scale} está fora de ${ZOOM_SCALE_MIN} a ${ZOOM_SCALE_MAX}`)
        }
        const a = words[s.a]!.start - ZOOM_LEAD_MS
        const b = words[s.b]!.end + ZOOM_TAIL_MS
        const made = createZoom(p, Math.max(0, a), Math.min(durationMs, b), durationMs, op.scale ?? zoomDefault)
        if (!made) return refuse(index, 'zoom', 'o zoom não cabe ali (já há outro zoom no trecho, ou ele é curto demais)')
        p = made.project
        counts.zoom++
        applied.push({ op: 'zoom', text: `adicionei um zoom nas palavras ${op.from}–${op.to}` })
        return
      }
      case 'layout': {
        const s = span(op.from, op.to)
        if (typeof s === 'string') return refuse(index, 'layout', s)
        const layout = op.layout as LayoutKind
        if (!layoutsAllowed.includes(layout)) return refuse(index, 'layout', `o layout "${op.layout.slice(0, 30)}" não existe no formato ${format === 'vertical' ? '9:16' : '16:9'}`)
        if (NEEDS_CAMERA.has(layout) && !p.sources.camera) return refuse(index, 'layout', 'este projeto não tem câmera')
        const made = createLayoutSeg(p, Math.max(0, words[s.a]!.start - ZOOM_LEAD_MS), Math.min(durationMs, words[s.b]!.end + ZOOM_TAIL_MS), durationMs, layout)
        if (!made) return refuse(index, 'layout', 'o trecho não cabe ali (já há outro trecho de layout, ou ele é curto demais)')
        p = made.project
        counts.layout++
        applied.push({ op: 'layout', text: `troquei o layout das palavras ${op.from}–${op.to}` })
        return
      }
      case 'clip': {
        const title = limitTitle(op.title)
        if (title === '') return refuse(index, 'clip', 'o corte veio sem título')
        const item = { title, hook: limitHook(op.hook ?? ''), ranges: op.ranges, score: 60, reason: 'Pedido pela conversa de edição.' }
        const v = validateClips([item], { words, durationMs, cuts: p.cuts, existing: p.clips, minMs: 10_000, maxMs: 90_000, source: 'ai' })
        const drop = v.dropped[0]
        if (drop || v.clips.length === 0) {
          return refuse(index, 'clip', `o corte «${title}» foi recusado: ${drop?.why ?? 'não passou'}`)
        }
        const merged = mergeSuggestedClips(p.clips, v.clips)
        if (merged.added.length === 0) return refuse(index, 'clip', `o corte «${title}» repete um corte que já existe`)
        p = { ...p, clips: merged.clips }
        counts.clip++
        applied.push({ op: 'clip', text: `criei o corte «${title}»` })
        return
      }
      case 'captions': {
        const patch: Partial<Project['captions']> = {}
        if (op.enabled !== undefined) patch.enabled = op.enabled
        if (op.style !== undefined) {
          if (!(CAPTION_STYLE_IDS as readonly string[]).includes(op.style)) return refuse(index, 'captions', `o estilo de legenda "${op.style.slice(0, 30)}" não existe`)
          const style = op.style as CaptionStyleId
          Object.assign(patch, { style, ...CAPTION_STYLE_DEFAULTS[style] })
        }
        if (op.wordsPerLine !== undefined) {
          if (op.wordsPerLine < 1 || op.wordsPerLine > 5) return refuse(index, 'captions', 'palavras por linha vai de 1 a 5')
          patch.wordsPerLine = op.wordsPerLine
        }
        if (Object.keys(patch).length === 0) return refuse(index, 'captions', 'não diz o que mudar na legenda')
        const next = { ...p.captions, ...patch }
        if (JSON.stringify(next) === JSON.stringify(p.captions)) return refuse(index, 'captions', 'a legenda já está assim')
        p = { ...p, captions: next }
        counts.captions++
        applied.push({ op: 'captions', text: 'mudei a legenda' })
        return
      }
      case 'title': {
        const text = clean(op.text).slice(0, 200)
        if (text === '') return refuse(index, 'title', 'o título veio vazio')
        if (text === p.title) return refuse(index, 'title', 'o título já é esse')
        p = { ...p, title: text }
        counts.title++
        applied.push({ op: 'title', text: 'troquei o título' })
        return
      }
    }
  })

  const afterMs = outputDuration(durationMs, p.cuts)
  if (applied.length > 0 && afterMs <= 0) {
    refused.push({ index: -1, op: '', why: 'a mudança cortaria o vídeo inteiro' })
    return { ...none('Recusei o pedido: ele cortaria o vídeo inteiro.'), refused }
  }

  const parts: string[] = []
  if (counts.cut > 0) parts.push(`cortei ${plural(counts.cut, 'trecho', 'trechos')} (−${formatSpan(cutMs)})`)
  if (counts.restore > 0) parts.push(`devolvi ${plural(counts.restore, 'trecho', 'trechos')} (+${formatSpan(restoredMs)})`)
  if (counts.zoom > 0) parts.push(`adicionei ${plural(counts.zoom, 'zoom', 'zooms')}`)
  if (counts.layout > 0) parts.push(`mudei o layout de ${plural(counts.layout, 'trecho', 'trechos')}`)
  if (counts.clip > 0) parts.push(`criei ${plural(counts.clip, 'corte vertical', 'cortes verticais')}`)
  if (counts.captions > 0) parts.push('mudei a legenda')
  if (counts.title > 0) parts.push('troquei o título')
  let summary = ''
  if (parts.length > 0) {
    const joined = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]!}`
    summary = `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`
  } else if (refused.length > 0) {
    summary = `Não apliquei nada: ${refused.length === 1 ? 'a operação da IA era inválida' : `as ${refused.length} operações da IA eram inválidas`}.`
  } else {
    summary = reply ?? 'Não havia nada para mudar.'
  }
  if (parts.length > 0 && refused.length > 0) summary += ` ${plural(refused.length, 'operação foi recusada', 'operações foram recusadas')}: ${refused.slice(0, 3).map((r) => r.why).join('; ')}.`
  const removedMs = beforeMs - afterMs
  return {
    project: applied.length > 0 ? p : base,
    applied,
    refused,
    changed: applied.length > 0,
    summary,
    beforeMs,
    afterMs,
    removedMs,
    needsConfirm: beforeMs > 0 && removedMs > beforeMs * EDIT_CONFIRM_FRACTION,
    reply
  }
}

/** Frases de sugestão do painel (cada uma vira um pedido). */
export const EDIT_SUGGESTIONS = ['Deixa mais dinâmico', 'Corta as partes repetidas', 'Faz 3 cortes para TikTok', 'Gera título e descrição'] as const
