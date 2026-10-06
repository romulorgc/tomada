export type DiskEstimate = {
  freeBytes: number | null
  estimatedBytes: number
  durationMs: number
  status: 'ok' | 'low' | 'unknown'
  reason: string
}

/** Bruto, normalizado e espaço da conversão; áudio WAV e 20% de folga. */
export function estimateRecordingBytes(input: { durationMs: number; screenBitrate: number; cameraBitrate: number; audioTracks: number }): number {
  const seconds = Math.max(0, input.durationMs) / 1000
  const video = (Math.max(0, input.screenBitrate) + Math.max(0, input.cameraBitrate)) / 8
  const audio = Math.max(0, input.audioTracks) * (48_000 * 4 + 192_000 / 8)
  return Math.ceil(seconds * (video * 3 + audio) * 1.2 + 100_000_000)
}

/** O vídeo sem áudio e o mux coexistem; +20% e reserva para índices/arquivos pequenos. */
export function estimateExportBytes(durationMs: number, videoBitrate: number, audioBitrate: number): number {
  return Math.ceil(Math.max(0, durationMs) / 1000 * (Math.max(0, videoBitrate) + Math.max(0, audioBitrate)) / 8 * 2.4 + 100_000_000)
}

export function diskEstimate(freeBytes: number | null, estimatedBytes: number, durationMs: number, reason: string): DiskEstimate {
  return { freeBytes, estimatedBytes, durationMs, reason, status: freeBytes === null ? 'unknown' : freeBytes < estimatedBytes ? 'low' : 'ok' }
}
