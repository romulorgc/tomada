/**
 * Ritmo (F1, item 3): olha o CONJUNTO de cortes e desfaz os que deixariam o vídeo picotado. Código puro: sem DOM, sem Node.
 *
 * A limpeza decidia corte a corte, só pelo áudio: nada impedia uma lasca de 170 ms entre dois cortes, nem 40 emendas por minuto
 * (G1: 40,6/min, G2: 24,6/min; as referências profissionais ficam em 9,3/min no vertical e 1,8/min no horizontal). Regras, em ordem:
 *
 *  (a) **lasca** (< 400 ms entre dois cortes): sem palavra, os dois cortes viram um só (a lasca sai junto); com palavra, o corte vizinho
 *      de MENOR ganho é desfeito. Vale também nas pontas do vídeo (a lasca de 190 ms de ruído no fim de G1);
 *  (b) **fala curta** (trecho com fala < 1,2 s ENTRE dois cortes): o vizinho de menor ganho é desfeito, até todos respeitarem;
 *  (c) **orçamento**: mais emendas por minuto do vídeo de saída que o teto do formato (vertical 12, horizontal 6): os cortes de
 *      menor ganho são desfeitos até caber.
 *
 * "Ganho" é o tempo que o corte tira (ms) e, nos recomeços, mais `RETAKE_GAIN_BONUS_MS` (um "errei" e uma repetição valem mais que
 * um silêncio: a pessoa pediu ou a IA achou). Cortes FIXOS (manuais, marcas de "errei") nunca são desfeitos, mas contam como emenda.
 *
 * A linha do tempo do Tomada é UMA só (`project.cuts`) para o YouTube e para o vertical: o ritmo padrão é o do horizontal
 * (pausa 280 ms, silêncio a partir de 0,6 s, 6 emendas/min), que também cabe no teto do vertical (12/min).
 */
import type { Range } from './types'

export type PacingId = 'horizontal' | 'vertical'

export type Pacing = {
  id: PacingId
  /** Silêncio só é removido a partir deste tamanho (ms). */
  minSilenceMs: number
  /** Pausa que SOBRA na emenda (ms): ~2/3 depois da palavra anterior, ~1/3 antes da seguinte. */
  keepMs: number
  /** Teto de emendas por minuto do vídeo de saída. */
  maxSeamsPerMin: number
}

export const PACING: Record<PacingId, Pacing> = {
  horizontal: { id: 'horizontal', minSilenceMs: 600, keepMs: 280, maxSeamsPerMin: 6 },
  vertical: { id: 'vertical', minSilenceMs: 400, keepMs: 150, maxSeamsPerMin: 12 }
}

/** Entre dois cortes, menos que isto (ms) é lasca. */
export const SLIVER_MS = 400
/** Trecho com fala entre dois cortes tem de durar ao menos isto (ms). */
export const MIN_SPEECH_KEEP_MS = 1200
/** Um recomeço vale isto a mais (ms) na conta de ganho. */
export const RETAKE_GAIN_BONUS_MS = 5000
/** Fala dentro de um trecho: a palavra precisa cobrir ao menos isto (ms) dele. */
const SPEECH_OVERLAP_MS = 40

/** Um corte candidato (ou fixo) para o ritmo. `id` é qualquer identificador estável (índice do item). */
export type ShapeCut = { id: number; start: number; end: number; gain: number; fixed: boolean }

export type ShapeSpeech = { start: number; end: number }

export type ShapeInput = {
  durationMs: number
  cuts: readonly ShapeCut[]
  /** Onde há fala que NÃO é cortada (palavras que ficam, inclusive a "fala sem palavra" mantida). */
  speech: readonly ShapeSpeech[]
  pacing: Pacing
}

export type ShapeResult = {
  /** Ids dos cortes mantidos. */
  keep: Set<number>
  /** Lascas sem palavra que viram parte do corte: trechos novos a cortar. */
  fill: Range[]
  dropped: { sliver: number; speech: number; budget: number }
}

type Span = { start: number; end: number; gain: number; fixed: boolean; ids: number[] }

function mergeSpans(cuts: readonly ShapeCut[]): Span[] {
  const sorted = [...cuts].filter((c) => c.end > c.start).sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Span[] = []
  for (const c of sorted) {
    const last = out[out.length - 1]
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end)
      last.gain += c.gain
      last.fixed = last.fixed || c.fixed
      last.ids.push(c.id)
    } else out.push({ start: c.start, end: c.end, gain: c.gain, fixed: c.fixed, ids: [c.id] })
  }
  return out
}

const hasSpeech = (speech: readonly ShapeSpeech[], a: number, b: number): boolean => speech.some((w) => Math.min(w.end, b) - Math.max(w.start, a) >= SPEECH_OVERLAP_MS)

const unionLen = (spans: readonly Span[]): number => spans.reduce((acc, s) => acc + (s.end - s.start), 0)

/** Emendas visíveis: os cortes que não encostam no começo nem no fim do vídeo. */
export function countSeams(spans: readonly Pick<Range, 'start' | 'end'>[], durationMs: number): number {
  return spans.filter((s) => s.start > 0 && s.end < durationMs).length
}

export function shapeCuts(input: ShapeInput): ShapeResult {
  const { durationMs, speech, pacing } = input
  let spans = mergeSpans(input.cuts)
  const fill: Range[] = []
  const dropped = { sliver: 0, speech: 0, budget: 0 }
  const drop = (idx: number, why: keyof typeof dropped): void => {
    spans.splice(idx, 1)
    dropped[why]++
  }

  // (a) e (b): enquanto algum trecho entre cortes (ou ponta) desrespeitar, conserta um e recomeça.
  for (let guard = 0; guard < 10_000; guard++) {
    let changed = false
    for (let i = 0; i <= spans.length && !changed; i++) {
      const prev = spans[i - 1]
      const next = spans[i]
      const a = prev ? prev.end : 0
      const b = next ? next.start : durationMs
      const len = b - a
      if (len <= 0) continue
      const talks = hasSpeech(speech, a, b)
      if (len < SLIVER_MS) {
        if (!talks) {
          // lasca sem palavra: vira parte do corte. Entre dois cortes junta os dois; na ponta estica o corte até a ponta.
          if (prev && next) {
            if (prev.fixed && next.fixed) continue
            fill.push({ start: a, end: b })
            prev.end = next.end
            prev.gain += next.gain + len
            prev.fixed = prev.fixed || next.fixed
            prev.ids.push(...next.ids)
            spans.splice(i, 1)
            changed = true
          } else if (prev && !prev.fixed) {
            fill.push({ start: a, end: b })
            prev.end = b
            prev.gain += len
            changed = true
          } else if (next && !next.fixed) {
            fill.push({ start: a, end: b })
            next.start = a
            next.gain += len
            changed = true
          }
        } else {
          // lasca com palavra: o vizinho de menor ganho é desfeito
          const loser = pickLoser(prev, next)
          if (loser === 'prev') drop(i - 1, 'sliver')
          else if (loser === 'next') drop(i, 'sliver')
          else continue
          changed = true
        }
      } else if (len < MIN_SPEECH_KEEP_MS && talks && prev && next) {
        const loser = pickLoser(prev, next)
        if (loser === 'prev') drop(i - 1, 'speech')
        else if (loser === 'next') drop(i, 'speech')
        else continue
        changed = true
      }
    }
    if (!changed) break
  }

  // (c) orçamento de emendas por minuto do vídeo de saída
  for (let guard = 0; guard < 10_000; guard++) {
    const outMs = durationMs - unionLen(spans)
    if (!(outMs > 0)) break
    const seams = countSeams(spans, durationMs)
    if ((seams / outMs) * 60_000 <= pacing.maxSeamsPerMin) break
    let worst = -1
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i]!
      if (s.fixed || s.start <= 0 || s.end >= durationMs) continue
      if (worst < 0 || s.gain < spans[worst]!.gain) worst = i
    }
    if (worst < 0) break
    drop(worst, 'budget')
  }

  const keep = new Set<number>()
  for (const s of spans) for (const id of s.ids) keep.add(id)
  return { keep, fill, dropped }
}

/** Qual vizinho desfazer: o de menor ganho entre os não fixos. */
function pickLoser(prev: Span | undefined, next: Span | undefined): 'prev' | 'next' | null {
  const p = prev && !prev.fixed ? prev : null
  const n = next && !next.fixed ? next : null
  if (p && n) return p.gain <= n.gain ? 'prev' : 'next'
  if (p) return 'prev'
  if (n) return 'next'
  return null
}
