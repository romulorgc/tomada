/** WAV IEEE float32: preserva as amostras entregues pelo Web Audio, sem codec com perda. */
export const PCM_SAMPLE_RATE = 48_000
export const PCM_HEADER_BYTES = 44
export function pcmWavHeader(sampleRate = PCM_SAMPLE_RATE, dataBytes = 0): ArrayBuffer {
  const out = new ArrayBuffer(PCM_HEADER_BYTES)
  const v = new DataView(out)
  const tag = (at: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)) }
  tag(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); tag(8, 'WAVE'); tag(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true)
  v.setUint16(32, 4, true); v.setUint16(34, 32, true); tag(36, 'data'); v.setUint32(40, dataBytes, true)
  return out
}
