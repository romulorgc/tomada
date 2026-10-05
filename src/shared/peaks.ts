/**
 * Picos da forma de onda (a trilha de vídeo da linha do tempo). O ffmpeg decodifica a voz UMA vez e o
 * resultado fica em `media/peaks.json`; a interface desenha a partir dele. Código puro.
 */

export const PEAKS_VERSION = 1
/** Colunas de pico por segundo de áudio (uma a cada 20 ms). */
export const PEAKS_PER_SECOND = 50

/** O que fica em `media/peaks.json`. */
export type PeaksFile = {
  version: number
  perSecond: number
  /** Duração do áudio analisado (ms). */
  durationMs: number
  /** Arquivo de onde vieram, relativo ao projeto, e a data dele (para saber quando refazer). */
  source: string
  sourceMtimeMs: number
  /** Pico de cada coluna, 0..255 (|amostra| máxima normalizada). */
  peaks: number[]
}

/** Amostras PCM de 16 bits (ordem little-endian, mono) → picos 0..255 por coluna. */
export function computePeaks(pcm: Int16Array, sampleRate: number, perSecond = PEAKS_PER_SECOND): number[] {
  if (!(sampleRate > 0) || pcm.length === 0) return []
  const per = sampleRate / perSecond
  const n = Math.ceil(pcm.length / per)
  const out: number[] = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const from = Math.floor(i * per)
    const to = Math.min(pcm.length, Math.floor((i + 1) * per))
    let max = 0
    for (let k = from; k < to; k++) {
      const v = Math.abs(pcm[k]!)
      if (v > max) max = v
    }
    out[i] = Math.min(255, Math.round((max / 32768) * 255))
  }
  return out
}

/** Bytes crus s16le (como o ffmpeg entrega) → Int16Array. */
export function pcmFromBytes(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.byteLength / 2)
  const out = new Int16Array(n)
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true)
  return out
}

/**
 * Pico (0..1) de cada coluna da tela: junta as colunas de áudio que caem em cada pixel. `fromMs`
 * e `msPerPx` estão no tempo do ARQUIVO de áudio.
 */
export function peaksForPixels(file: Pick<PeaksFile, 'peaks' | 'perSecond'>, fromMs: number, msPerPx: number, widthPx: number): number[] {
  const out: number[] = new Array<number>(Math.max(0, widthPx)).fill(0)
  const perMs = file.perSecond / 1000
  for (let x = 0; x < widthPx; x++) {
    const a = (fromMs + x * msPerPx) * perMs
    const b = (fromMs + (x + 1) * msPerPx) * perMs
    const lo = Math.max(0, Math.floor(a))
    const hi = Math.min(file.peaks.length - 1, Math.max(lo, Math.ceil(b) - 1))
    let max = 0
    for (let i = lo; i <= hi; i++) {
      const v = file.peaks[i]
      if (v !== undefined && v > max) max = v
    }
    out[x] = max / 255
  }
  return out
}
