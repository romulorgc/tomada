/**
 * Borda do corte (F1, item 2). Código puro: sem DOM, sem Node.
 *
 * O Whisper erra o tempo de uma palavra em 60-100 ms e a folga antiga era de 60 ms (e 0 quando duas palavras se encostam):
 * em G2, 5 das 26 bordas caíam em fala. Agora:
 *  - a folga que SOBRA na emenda é de ~150 ms, repartida como nos vídeos de referência: ~100 ms depois da palavra que fica
 *    antes (`EDGE_AFTER_MS`) e ~50 ms antes da que fica depois (`EDGE_BEFORE_MS`);
 *  - a borda é ajustada ao VALE de energia (RMS de 10 ms, busca de ±80 ms), o que compensa o erro de tempo;
 *  - a borda tem de cair numa pausa de verdade: acima do teto do perfil da voz ela é recusada, e o corte NÃO é feito. Sem nível
 *    (ou com a voz perto demais do chiado), só vale uma pausa de pelo menos `EDGE_MIN_PAUSE_MS` entre as palavras: nunca se corta
 *    0 ms entre palavras encostadas.
 */
import type { Range, Word } from './types'
import { levelAt, type VoiceProfile } from './voice-profile'

/** Pausa que fica depois da última palavra que sobra (ms). */
export const EDGE_AFTER_MS = 100
/** Pausa que fica antes da primeira palavra que sobra (ms). */
export const EDGE_BEFORE_MS = 50
/** Busca do vale de energia em volta da borda (ms para cada lado). */
export const VALLEY_SEARCH_MS = 80
/** Quanto a busca pode entrar na palavra vizinha, cujo tempo o motor também erra (ms). */
export const WORD_TIME_TOLERANCE_MS = 40
/** Sem nível, a pausa disponível numa borda tem de ser ao menos isto (ms), senão o corte não é feito. */
export const EDGE_MIN_PAUSE_MS = 40
/** Quantos dB o vale pode ficar abaixo do quadro da borda nominal para a borda se mover (histerese: sem mexer à toa). */
const MOVE_GAIN_DB = 2

export type EdgePlan = {
  /** Instante de origem da borda (ms). */
  t: number
  /** A borda cai numa pausa. Falso = o corte que usa essa borda não deve ser feito. */
  ok: boolean
  /** A borda foi movida ao vale de energia. */
  snapped: boolean
  /** Nível do quadro da borda (dBFS), quando houve medição. */
  levelDb: number | null
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * Procura o vale de energia perto de `nominal`, dentro de `[lo, hi]` ∩ `nominal ± VALLEY_SEARCH_MS`. Fica onde está se o quadro
 * dele já é uma pausa e o vale não é melhor por mais de `MOVE_GAIN_DB`. `ok` quando o quadro escolhido está abaixo do teto.
 */
export function snapToValley(nominal: number, lo: number, hi: number, profile: VoiceProfile): EdgePlan {
  const a = Math.max(lo, nominal - VALLEY_SEARCH_MS)
  const b = Math.min(hi, nominal + VALLEY_SEARCH_MS)
  const here = levelAt(profile, nominal)
  if (b < a) return { t: nominal, ok: here !== null && here <= profile.ceilingDb, snapped: false, levelDb: here }
  const first = Math.ceil((a - profile.startMs) / profile.frameMs)
  const last = Math.floor((b - profile.startMs) / profile.frameMs)
  let bestK = -1
  let best = Infinity
  let bestDist = Infinity
  for (let k = first; k <= last; k++) {
    if (k < 0 || k >= profile.db.length) continue
    // média de 3 quadros: um quadro isolado de ruído não faz um vale
    const v = (profile.db[Math.max(0, k - 1)]! + profile.db[k]! + profile.db[Math.min(profile.db.length - 1, k + 1)]!) / 3
    const t = profile.startMs + (k + 0.5) * profile.frameMs
    const dist = Math.abs(t - nominal)
    if (v < best - 1e-9 || (Math.abs(v - best) <= 1e-9 && dist < bestDist)) {
      best = v
      bestK = k
      bestDist = dist
    }
  }
  if (bestK < 0) return { t: nominal, ok: false, snapped: false, levelDb: here }
  const nominalOk = here !== null && here <= profile.ceilingDb
  const bestT = profile.startMs + (bestK + 0.5) * profile.frameMs
  // a borda nominal já é pausa e o vale não ganha o suficiente: fica onde está
  if (nominalOk && best > here - MOVE_GAIN_DB) return { t: nominal, ok: true, snapped: false, levelDb: here }
  return { t: Math.round(clamp(bestT, a, b)), ok: best <= profile.ceilingDb, snapped: true, levelDb: best }
}

export type EdgeContext = {
  /** `null` ou `ok: false`: sem nível que separe voz de ruído; vale só a pausa entre as palavras. */
  profile: VoiceProfile | null
}

/** Uma borda de corte com a pausa disponível entre a palavra que fica e a que sai. */
function decideEdge(nominal: number, lo: number, hi: number, pauseMs: number, ctx: EdgeContext): EdgePlan {
  const p = ctx.profile
  if (p && p.ok) return snapToValley(nominal, lo, hi, p)
  return { t: nominal, ok: pauseMs >= EDGE_MIN_PAUSE_MS, snapped: false, levelDb: null }
}

export type CutRange = Range & {
  /** As duas bordas caem em pausa de verdade. */
  ok: boolean
  snapped: boolean
}

/**
 * O trecho a cortar para tirar as palavras `a..b` (índices na lista ordenada, inclusive), com as bordas já decididas pelo nível.
 * Começo e fim do vídeo vão até a ponta e sempre são `ok`.
 */
export function cutRangeAround(words: readonly Pick<Word, 'start' | 'end'>[], a: number, b: number, durationMs: number, ctx: EdgeContext): CutRange {
  const first = words[a]
  const last = words[b]
  if (!first || !last || b < a) throw new RangeError(`cutRangeAround: palavras ${a}..${b} fora da lista (${words.length}).`)
  const prevEnd = a > 0 ? words[a - 1]!.end : 0
  const nextStart = b + 1 < words.length ? words[b + 1]!.start : durationMs
  const gapL = Math.max(0, first.start - prevEnd)
  const gapR = Math.max(0, nextStart - last.end)

  let start = 0
  let end = durationMs
  let ok = true
  let snapped = false
  if (a > 0) {
    // a pausa que fica depois da palavra anterior, sem passar do começo da palavra que sai
    const nominal = prevEnd + Math.min(EDGE_AFTER_MS, gapL)
    const e = decideEdge(nominal, prevEnd - WORD_TIME_TOLERANCE_MS, first.start + WORD_TIME_TOLERANCE_MS, gapL, ctx)
    start = e.t
    ok = ok && e.ok
    snapped = snapped || e.snapped
  }
  if (b < words.length - 1) {
    const nominal = nextStart - Math.min(EDGE_BEFORE_MS, gapR)
    const e = decideEdge(nominal, last.end - WORD_TIME_TOLERANCE_MS, nextStart + WORD_TIME_TOLERANCE_MS, gapR, ctx)
    end = e.t
    ok = ok && e.ok
    snapped = snapped || e.snapped
  }
  if (end <= start) ok = false
  return { start: Math.round(start), end: Math.round(end), ok, snapped }
}
