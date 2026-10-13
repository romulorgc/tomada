/**
 * Zoom do 16:9 que respeita a FALA (F3, item 3). Código puro: sem DOM, sem Node. A prévia e a exportação leem os mesmos zooms
 * do documento, então a regra vale nas duas.
 *
 * O zoom por clique nasce de `[clique − antecipação, clique + segura]`: um instante qualquer, que cai no meio de uma palavra e
 * larga a frase pela metade. Aqui cada janela ganha forma de zoom de verdade (medida no Screen Studio, estudo 12/10, seção 2.2):
 *
 *  - **começa num limite da fala**: o início de uma frase (até 1,5 s antes do pedido, que já abre 0,5 s antes do clique: no máximo 2 s
 *    de zoom antes da ação) ou, na falta, o início de uma palavra (até 1 s antes). Nunca no meio de uma palavra: a rampa de entrada
 *    chega junto com o que está sendo dito. Antes de a ação aparecer a imagem ainda é outra: abrir mais cedo seria zoom sem motivo;
 *  - **termina num limite da fala**: o fim da frase (até 3 s depois do mínimo) ou o fim de uma palavra. Nunca no meio de uma palavra:
 *    o zoom só começa a sair depois que a palavra acabou;
 *  - **platô de pelo menos 4 s** (mediana medida: 4,0 s), contado no tempo de SAÍDA quando há cortes: o zoom que vira um pisca-pisca
 *    de 1 s não ajuda ninguém. Rampa de 0,9 s (`ZOOM_RAMP_MS`), em ease-out (ver `computeCameraPath`);
 *  - **separação de 1,5 s** entre dois zooms: a tela larga entre eles precisa respirar; mais perto que isso viram um só;
 *  - **cortes**: o início e o fim nunca caem DENTRO de um trecho cortado, e a rampa de entrada não atravessa uma emenda (um corte no
 *    meio da rampa faz a imagem "pular" para um zoom já adiantado). O punch-in do F1 age na câmera e muda na emenda; o zoom da tela
 *    não toca nele.
 *
 * Tempos em ms de ORIGEM (o relógio da gravação), como as palavras e os cortes.
 */
import { buildSentences } from './sentences'
import type { Range, Word } from './types'

/** Rampa de entrada e de saída do zoom no 16:9 (ms): 0,89 s medido no Screen Studio (0,73-1,00). */
export const ZOOM_RAMP_MS = 900
/** Platô mínimo (ms): o zoom fica na escala cheia por pelo menos isto (mediana medida: 4,0 s). */
export const ZOOM_PLATEAU_MIN_MS = 4000
/** Entre dois zooms a tela larga fica pelo menos isto (ms); mais perto que isso os dois viram um só. */
export const ZOOM_SEPARATION_MS = 1500
/** Faixa de escala do zoom automático do 16:9 (1,5-1,8×; mediana medida 1,73×). */
export const ZOOM_SCALE_RANGE = { min: 1.5, max: 1.8 } as const

export type ZoomShaping = {
  rampMs: number
  plateauMinMs: number
  separationMs: number
  /** Quanto ANTES do pedido se aceita o início de uma frase / o início de uma palavra (ms). */
  startBackSentenceMs: number
  startBackWordMs: number
  /** Último recurso: começo de palavra mais distante (até tanto antes) só para a rampa de entrada não atravessar uma emenda. */
  startBackSeamMs: number
  /** Quanto DEPOIS do pedido ainda se aceita um início (o clique cai um pouco mais adiante na rampa, que já está em 70%+). */
  startAheadMs: number
  /** Quanto DEPOIS do fim mínimo se aceita o fim de uma frase / o fim de uma palavra (ms). */
  endSentenceMs: number
  endWordMs: number
  /** Zoom que sobraria com menos que isto de platô (fim do vídeo) some. */
  minPlateauMs: number
}

export const HORIZONTAL_SHAPING: ZoomShaping = {
  rampMs: ZOOM_RAMP_MS,
  plateauMinMs: ZOOM_PLATEAU_MIN_MS,
  separationMs: ZOOM_SEPARATION_MS,
  startBackSentenceMs: 1500,
  startBackWordMs: 1000,
  startBackSeamMs: 2500,
  startAheadMs: 150,
  endSentenceMs: 3000,
  endWordMs: 1500,
  minPlateauMs: 1500
}

/** O que a janela de zoom precisa ter para ser moldada (o `Win` de `zoom.ts` tem isto e mais). */
export type ZoomWindow = {
  start: number
  end: number
  hits: number
  click: boolean
  focus: 'auto' | { x: number; y: number }
}

export type SpeechContext = {
  /** Palavras da transcrição (tempo de origem). Sem elas só vale o platô, a separação e os cortes. */
  words?: readonly Word[] | null
  /** Trechos mantidos (`keptRanges`). Sem eles o tempo de saída é o de origem. */
  kept?: readonly Range[] | null
  durationMs: number
}

type Token = { start: number; end: number }

const finiteToken = (w: Word): boolean => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start

/** Os limites da fala: cada palavra (de qualquer tipo: hesitação e fala sem palavra também são fala) e cada frase. */
export type SpeechBounds = {
  tokens: Token[]
  tokenStarts: number[]
  tokenEnds: number[]
  sentences: Token[]
}

export function speechBounds(words: readonly Word[] | null | undefined): SpeechBounds {
  const tokens = (words ?? []).filter(finiteToken).map((w) => ({ start: w.start, end: w.end })).sort((a, b) => a.start - b.start || a.end - b.end)
  const sentences = buildSentences((words ?? []).filter(finiteToken)).map((s) => ({ start: s.startMs, end: s.endMs })).sort((a, b) => a.start - b.start)
  return { tokens, tokenStarts: tokens.map((t) => t.start), tokenEnds: tokens.map((t) => t.end).sort((a, b) => a - b), sentences }
}

/** `t` cai no MEIO de uma palavra (estritamente entre o começo e o fim dela)? */
export function insideWord(words: readonly Word[] | null | undefined, t: number): boolean {
  return (words ?? []).some((w) => finiteToken(w) && w.start < t && t < w.end)
}

/** Primeiro índice de `sorted` com valor ≥ `v`. */
function lowerBound(sorted: readonly number[], v: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid]! < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Os valores de `sorted` em `[lo, hi]`, do último para o primeiro (o mais perto de `hi` primeiro). */
function descendingIn(sorted: readonly number[], lo: number, hi: number): number[] {
  const out: number[] = []
  for (let i = lowerBound(sorted, hi + 1e-9) - 1; i >= 0 && sorted[i]! >= lo; i--) out.push(sorted[i]!)
  return out
}

/** O primeiro valor de `sorted` em `[lo, hi]`, ou `null`. */
function earliestIn(sorted: readonly number[], lo: number, hi: number): number | null {
  const i = lowerBound(sorted, lo)
  return i < sorted.length && sorted[i]! <= hi ? sorted[i]! : null
}

/** A palavra que contém `t` no meio dela, se houver. */
function tokenAround(b: SpeechBounds, t: number): Token | null {
  // as palavras são ordenadas por início: a candidata é a última que começa antes de `t`
  const i = lowerBound(b.tokenStarts, t) - 1
  for (let k = i; k >= 0 && k >= i - 3; k--) {
    const tok = b.tokens[k]!
    if (tok.start < t && t < tok.end) return tok
  }
  return null
}

/** A frase em andamento em `t` (estritamente entre o começo e o fim dela), se houver. */
function sentenceAround(b: SpeechBounds, t: number): Token | null {
  let lo = 0
  let hi = b.sentences.length - 1
  let at = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (b.sentences[mid]!.start < t) {
      at = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  const s = at >= 0 ? b.sentences[at]! : null
  return s && t < s.end ? s : null
}

/**
 * Os inícios possíveis para um zoom pedido em `want`, do melhor para o pior:
 *  1. numa pausa (fora de qualquer frase e de qualquer palavra) o próprio pedido: a rampa começa no silêncio, antes da frase;
 *  2. dentro de uma frase, o começo dela (até `startBackSentenceMs` antes): o zoom chega junto com o que está sendo dito;
 *  3. o começo de uma palavra (até `startBackWordMs` antes); mais perto do pedido primeiro;
 *  4. de último, começos de palavra mais distantes (`startBackSeamMs`, 2,5 s): só servem para a rampa não atravessar uma emenda.
 * Nenhum deles cai no meio de uma palavra.
 */
export function zoomStartCandidates(b: SpeechBounds, want: number, s: ZoomShaping = HORIZONTAL_SHAPING): number[] {
  const out: number[] = []
  const inToken = tokenAround(b, want) !== null
  const sentence = sentenceAround(b, want)
  if (!inToken && !sentence) out.push(want)
  if (sentence && want - sentence.start <= s.startBackSentenceMs) out.push(sentence.start)
  out.push(...descendingIn(b.tokenStarts, want - s.startBackWordMs, want + s.startAheadMs))
  out.push(...descendingIn(b.tokenStarts, want - s.startBackSeamMs, want - s.startBackWordMs - 1e-6))
  if (!inToken && sentence) out.push(want) // entre duas palavras de uma frase (a pausa de respiração): pior que o começo da palavra, melhor que nada
  const around = tokenAround(b, want)
  if (around) out.push(around.start)
  return [...new Set(out)]
}

/** Para onde vai o INÍCIO do zoom pedido em `want`: o melhor limite da fala (ver `zoomStartCandidates`). */
export function snapZoomStart(b: SpeechBounds, want: number, s: ZoomShaping = HORIZONTAL_SHAPING): number {
  return zoomStartCandidates(b, want, s)[0] ?? want
}

/**
 * Para onde vai o FIM do zoom (o instante em que ele começa a sair), que não pode ser antes de `min`:
 *  - no meio de uma palavra, só depois que ela acaba;
 *  - no meio de uma frase, no fim dela (até `endSentenceMs` adiante) ou, se ela é longa, no fim de uma palavra;
 *  - numa pausa, onde está.
 */
export function snapZoomEnd(b: SpeechBounds, min: number, s: ZoomShaping = HORIZONTAL_SHAPING): number {
  const around = tokenAround(b, min)
  const from = around ? around.end : min
  const sentence = sentenceAround(b, from)
  if (!sentence) return from
  if (sentence.end - from <= s.endSentenceMs) return sentence.end
  return earliestIn(b.tokenEnds, from, from + s.endWordMs) ?? from
}

// ---------------------------------------------------------------------------
// Cortes

/** O INÍCIO `t` cai num trecho mantido? (o começo do trecho conta, o fim não) */
function startKept(kept: readonly Range[], t: number): boolean {
  return kept.some((r) => t >= r.start && t < r.end)
}

/** O FIM `t` cai num trecho mantido? (as duas pontas do trecho contam: um zoom que sai exatamente na emenda está certo) */
function endKept(kept: readonly Range[], t: number): boolean {
  return kept.some((r) => t >= r.start && t <= r.end)
}

/** O começo do primeiro trecho mantido que começa depois de `t`, ou `null`. */
function nextKeptStart(kept: readonly Range[], t: number): number | null {
  const r = kept.find((x) => x.start > t)
  return r ? r.start : null
}

/** Quanto de `[a, b]` (origem) é mantido, em ms: o tempo que o zoom aparece no vídeo de saída. */
export function keptOverlap(kept: readonly Range[], a: number, b: number): number {
  let sum = 0
  for (const r of kept) {
    if (r.end <= a) continue
    if (r.start >= b) break
    sum += Math.min(r.end, b) - Math.max(r.start, a)
  }
  return sum
}

/** Onde, a partir de `from` (origem), já se acumularam `ms` de tempo mantido. Sem cortes, `from + ms`. */
function advanceKept(kept: readonly Range[] | null | undefined, from: number, ms: number): number {
  if (!kept || kept.length === 0) return from + ms
  let left = ms
  let t = from
  for (const r of kept) {
    if (r.end <= t) continue
    const a = Math.max(r.start, t)
    const room = r.end - a
    if (room >= left) return a + left
    left -= room
    t = r.end
  }
  // acabou o vídeo antes de juntar tudo
  return t + left
}

/** Há um corte dentro da rampa `(a, a + ramp)`? */
function seamInside(kept: readonly Range[], a: number, ramp: number): boolean {
  for (let i = 0; i + 1 < kept.length; i++) {
    const cutStart = kept[i]!.end
    if (cutStart > a && cutStart < a + ramp) return true
    if (cutStart >= a + ramp) break
  }
  return false
}

// ---------------------------------------------------------------------------
// A forma do zoom

/**
 * Molda as janelas de zoom (já fundidas e recortadas na gravação): começo e fim em limites da fala, platô mínimo, separação entre
 * dois zooms e cortes. Devolve janelas novas, ordenadas, sem sobreposição.
 */
export function shapeZoomWindows<T extends ZoomWindow>(wins: readonly T[], shaping: ZoomShaping, ctx: SpeechContext): T[] {
  const bounds = speechBounds(ctx.words)
  const kept = ctx.kept && ctx.kept.length > 0 ? ctx.kept : null
  const duration = ctx.durationMs
  const sorted = [...wins].sort((a, b) => a.start - b.start || a.end - b.end)

  const shaped: T[] = []
  for (const w of sorted) {
    const want = w.start
    // o início: o melhor limite da fala em que o zoom pode começar e cuja rampa de entrada não atravessa uma emenda
    const candidates = zoomStartCandidates(bounds, want, shaping)
    const next = kept ? nextKeptStart(kept, want) : null
    if (next !== null && next <= want + shaping.startAheadMs + 250) candidates.push(next) // logo depois da emenda, se ainda chega a tempo do clique
    let start = candidates.find((c) => !kept || (startKept(kept, c) && !seamInside(kept, c, shaping.rampMs))) ?? candidates.find((c) => !kept || startKept(kept, c)) ?? want
    if (kept && !startKept(kept, start)) {
      // o início não cai num trecho cortado: vai para o primeiro quadro que sobra depois dele
      const after = nextKeptStart(kept, start)
      if (after !== null) start = after
    }
    start = Math.max(0, start)

    // o fim: o pedido, ou o platô mínimo depois da rampa (no tempo de saída), o que for maior; depois, o limite da fala
    const plateauFrom = start + shaping.rampMs
    const plateauEnd = advanceKept(kept, plateauFrom, shaping.plateauMinMs)
    let end = snapZoomEnd(bounds, Math.max(w.end, plateauEnd), shaping)
    if (kept && !endKept(kept, end)) {
      // o zoom só começa a sair depois do corte: a rampa de saída acontece dentro do trecho seguinte, sem pular no meio dela
      const next = nextKeptStart(kept, end)
      end = next !== null ? snapZoomEnd(bounds, next, shaping) : kept[kept.length - 1]!.end
    }
    end = Math.min(duration, end)

    // sem espaço para um platô de verdade (final do vídeo): o zoom não vale a pena
    const plateau = kept ? keptOverlap(kept, plateauFrom, end) : end - plateauFrom
    if (!(end > start) || plateau < shaping.minPlateauMs) continue
    shaped.push({ ...w, start, end })
  }

  // separação: zooms mais perto que `separationMs` viram um só (o foco passa a seguir o cursor se os dois eram diferentes).
  // A distância é a do vídeo de SAÍDA: um corte entre os dois não os afasta (o espectador vê o zoom sair e entrar de novo em seguida).
  const out: T[] = []
  for (const w of shaped) {
    const last = out[out.length - 1]
    const gap = last ? (kept ? keptOverlap(kept, last.end, w.start) : w.start - last.end) : 0
    if (last && gap < shaping.separationMs) {
      const sameFocus = last.focus !== 'auto' && w.focus !== 'auto' && last.focus.x === w.focus.x && last.focus.y === w.focus.y
      out[out.length - 1] = { ...last, end: Math.max(last.end, w.end), hits: last.hits + w.hits, click: last.click || w.click, focus: sameFocus ? last.focus : 'auto' }
    } else out.push({ ...w })
  }
  return out
}

/**
 * Os problemas de uma lista de zooms contra a fala (para teste e diagnóstico): começo ou fim no meio de uma palavra, e em
 * trecho cortado. Lista vazia = tudo alinhado.
 */
export function zoomBoundaryProblems(
  zooms: readonly { id: string; start: number; end: number }[],
  words: readonly Word[] | null | undefined,
  kept?: readonly Range[] | null,
  durationMs: number = Number.POSITIVE_INFINITY
): string[] {
  const problems: string[] = []
  for (const z of zooms) {
    if (insideWord(words, z.start)) problems.push(`${z.id}: começa no meio de uma palavra (${Math.round(z.start)} ms)`)
    // o zoom que vai até o último quadro do vídeo termina onde o vídeo termina (a última palavra pode passar do fim do arquivo)
    if (z.end < durationMs && insideWord(words, z.end)) problems.push(`${z.id}: termina no meio de uma palavra (${Math.round(z.end)} ms)`)
    if (kept && kept.length > 0) {
      if (!startKept(kept, z.start)) problems.push(`${z.id}: começa dentro de um corte (${Math.round(z.start)} ms)`)
      if (!endKept(kept, z.end)) problems.push(`${z.id}: termina dentro de um corte (${Math.round(z.end)} ms)`)
    }
  }
  return problems
}
