import { expect, it } from 'vitest'
import { correlatePcm } from '../../src/shared/pcm-alignment'
it('mede offset positivo e negativo sem alterar o PCM, silêncio não inventa sincronia', () => {
  let seed = 73
  const pcm = Float32Array.from({ length: 48000 }, () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return seed / 0x80000000 * 0.1 })
  for (const shift of [0, 218, -110]) {
    const reference = Float32Array.from(pcm, (_, i) => (pcm[i - shift] ?? 0) * 0.8)
    expect(correlatePcm(reference, pcm)!.offsetMs).toBe(shift / 8)
    expect(correlatePcm(reference, pcm)!.correlation).toBeGreaterThan(0.99999)
  }
  expect(correlatePcm(new Float32Array(48000), new Float32Array(48000))).toBeNull()
})
it('não confunde ciclos de vogal/tom com deslocamento confiável', () => {
  for (const hz of [120, 200, 440]) {
    const pcm = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i * 2 * Math.PI * hz / 8000) * 0.1)
    const reference = Float32Array.from(pcm, (_, i) => pcm[i - 218] ?? 0)
    expect(correlatePcm(reference, pcm)).toBeNull()
  }
})
