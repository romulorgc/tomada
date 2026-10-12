/**
 * Perfil de nível da voz (F1, item 7): decide pelo nível RELATIVO da voz, nunca por um número absoluto, para uma voz fraca
 * (G1: −48,7 dBFS de mediana das palavras) valer tanto quanto uma forte (G2: −25,6). Código puro: sem DOM, sem Node.
 *
 *  - `refDb`: mediana do nível das palavras (a "voz" desta gravação); `floorDb`: o chão de ruído (percentil 10 dos quadros);
 *  - `gainDb`: quanto seria preciso somar para a voz ficar em −20 dBFS (só informação: aparece no aviso e no registro);
 *  - `ceilingDb`: até onde um quadro ainda é "pausa" para uma borda de corte: 12 dB abaixo da voz, mas nunca abaixo do chão + 4 dB;
 *  - `ok`: a voz fica pelo menos `MIN_SNR_DB` acima do chão. Sem isso o nível não separa voz de ruído e as bordas se decidem só
 *    pelos tempos das palavras (com aviso visível: falha silenciosa é defeito).
 *
 * O nível vem de `Levels` (quadros de 10 ms em `media/levels.json`). Os tempos são de ORIGEM, em milissegundos.
 */
import type { Levels } from './clean'
import type { Range, Word } from './types'

/** A voz precisa ficar tanto acima do chão de ruído (dB) para o nível decidir uma borda. G1: 8,3 dB (não); G2: 33 dB. */
export const MIN_SNR_DB = 12
/** Um quadro ainda é "pausa" até tanto abaixo da voz (dB). */
export const PAUSE_BELOW_VOICE_DB = 12
/** …e nunca abaixo do chão de ruído mais isto (dB). */
export const PAUSE_ABOVE_FLOOR_DB = 4
/** Onde a voz de referência é posta para as decisões (dBFS). */
export const NORMALIZED_VOICE_DB = -20
/** Palavras mais curtas que isto (ms) não entram na mediana: o tempo delas é impreciso demais. */
const MIN_WORD_MS = 60
/** Quantas palavras medidas são o mínimo para confiar na referência. */
const MIN_WORDS = 5
/** O ganho de normalização nunca passa deste valor (dB). */
const MAX_GAIN_DB = 40

export type VoiceProfile = {
  frameMs: number
  startMs: number
  db: readonly number[]
  refDb: number
  floorDb: number
  gainDb: number
  ceilingDb: number
  ok: boolean
  /** Quando `ok` é falso: o motivo, em português, para o aviso. */
  reason: string | null
}

const median = (v: readonly number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const percentile = (v: readonly number[], q: number): number => {
  const s = [...v].sort((a, b) => a - b)
  return s.length === 0 ? -120 : s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]!
}

/** Nível (dBFS) do quadro que contém `t`; `null` fora do arquivo. */
export function levelAt(p: Pick<VoiceProfile, 'frameMs' | 'startMs' | 'db'>, t: number): number | null {
  const k = Math.floor((t - p.startMs) / p.frameMs)
  return k >= 0 && k < p.db.length ? p.db[k]! : null
}

/** Nível médio (dB) dos quadros em [a, b); `null` se nenhum cai dentro do arquivo. */
export function meanLevel(p: Pick<VoiceProfile, 'frameMs' | 'startMs' | 'db'>, a: number, b: number): number | null {
  const k0 = Math.max(0, Math.floor((a - p.startMs) / p.frameMs))
  const k1 = Math.min(p.db.length, Math.ceil((b - p.startMs) / p.frameMs))
  if (k1 <= k0) return null
  let sum = 0
  for (let k = k0; k < k1; k++) sum += p.db[k]!
  return sum / (k1 - k0)
}

/**
 * Monta o perfil do microfone. `null` quando não há faixa de microfone nem quadros (o chamador cai nos tempos das palavras e
 * avisa). Com poucas palavras para medir, devolve um perfil `ok: false` com o motivo.
 */
export function buildVoiceProfile(levels: Levels | null | undefined, words: readonly Pick<Word, 'start' | 'end' | 'kind'>[]): VoiceProfile | null {
  const mic = levels?.mic
  if (!levels || !mic || mic.length === 0) return null
  const base = { frameMs: levels.frameMs, startMs: levels.startMs, db: mic }
  const floorDb = percentile(mic, 0.1)
  const perWord: number[] = []
  for (const w of words) {
    if (w.kind !== 'word' || w.end - w.start < MIN_WORD_MS) continue
    const m = meanLevel(base, w.start, w.end)
    if (m !== null) perWord.push(m)
  }
  if (perWord.length < MIN_WORDS) {
    return { ...base, refDb: floorDb, floorDb, gainDb: 0, ceilingDb: floorDb + PAUSE_ABOVE_FLOOR_DB, ok: false, reason: 'poucas palavras para medir o nível da voz' }
  }
  const refDb = median(perWord)
  const snr = refDb - floorDb
  const ok = snr >= MIN_SNR_DB
  return {
    ...base,
    refDb,
    floorDb,
    gainDb: Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, NORMALIZED_VOICE_DB - refDb)),
    ceilingDb: Math.max(refDb - PAUSE_BELOW_VOICE_DB, floorDb + PAUSE_ABOVE_FLOOR_DB),
    ok,
    reason: ok ? null : `a voz fica só ${snr.toFixed(1).replace('.', ',')} dB acima do chiado (precisa de ${MIN_SNR_DB} dB)`
  }
}

/**
 * Fala sem palavra que o motor não transcreveu: é fala de verdade (e não hesitação a cortar) quando o nível médio dela passa de
 * `max(voz − 10 dB, chão + 3 dB)`. Calibrado nas gravações de 09/10: os 16 trechos de G1 e o de G2 ficam entre −3,6 e +1,6 dB da
 * mediana das palavras (limiar: 10 dB, folga de 6 dB para o mais baixo). Não depende de `ok`: a comparação é relativa.
 */
export const GAP_SPEECH_BELOW_VOICE_DB = 10
export const GAP_SPEECH_ABOVE_FLOOR_DB = 3

export function isLoudGapSpeech(p: VoiceProfile | null, range: Range): boolean {
  if (!p) return false
  const m = meanLevel(p, range.start, range.end)
  if (m === null) return false
  return m >= Math.max(p.refDb - GAP_SPEECH_BELOW_VOICE_DB, p.floorDb + GAP_SPEECH_ABOVE_FLOOR_DB)
}
