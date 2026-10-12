/**
 * Nível do áudio por quadro (RMS em dBFS), para a limpeza de silêncio saber onde TUDO está quieto (microfone e som
 * do computador). O ffmpeg decodifica a faixa uma vez; o resultado fica em `media/levels.json`. Código puro.
 */

/** v2 (F1): quadros de 10 ms, para a borda do corte achar o vale de energia; o `levels.json` de v1 é refeito. */
export const LEVELS_VERSION = 2
/** Duração de cada quadro de nível (ms). */
export const LEVEL_FRAME_MS = 10
/** Silêncio digital. */
export const SILENT_DB = -120

/** O que fica em `media/levels.json`. */
export type LevelsFile = {
  version: number
  frameMs: number
  /** Instante de ORIGEM do primeiro quadro (o deslocamento da voz). */
  startMs: number
  /** Arquivos de onde vieram (relativos ao projeto) e a data deles, para saber quando refazer. */
  sources: { voice?: { path: string; mtimeMs: number }; system?: { path: string; mtimeMs: number } }
  /** RMS de cada quadro em dBFS inteiros; null = a faixa não existe. */
  mic: number[] | null
  system: number[] | null
}

/** PCM de 16 bits mono → dBFS (inteiro) de cada quadro de `frameMs`. */
export function computeLevels(pcm: Int16Array, sampleRate: number, frameMs = LEVEL_FRAME_MS): number[] {
  if (!(sampleRate > 0) || pcm.length === 0) return []
  const per = (sampleRate * frameMs) / 1000
  const n = Math.ceil(pcm.length / per)
  const out: number[] = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const from = Math.floor(i * per)
    const to = Math.min(pcm.length, Math.floor((i + 1) * per))
    let sum = 0
    for (let k = from; k < to; k++) {
      const v = pcm[k]! / 32768
      sum += v * v
    }
    const rms = to > from ? Math.sqrt(sum / (to - from)) : 0
    out[i] = rms > 0 ? Math.max(SILENT_DB, Math.round(20 * Math.log10(rms))) : SILENT_DB
  }
  return out
}

/**
 * Alinha uma faixa ao eixo da voz: `deltaFrames` > 0 acrescenta silêncio no começo (a faixa começou depois),
 * < 0 descarta quadros do começo (a faixa começou antes).
 */
export function alignLevels(frames: readonly number[], deltaFrames: number): number[] {
  if (deltaFrames > 0) return [...new Array<number>(deltaFrames).fill(SILENT_DB), ...frames]
  if (deltaFrames < 0) return frames.slice(-deltaFrames)
  return [...frames]
}
