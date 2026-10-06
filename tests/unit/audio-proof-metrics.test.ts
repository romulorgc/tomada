import { describe, expect, it } from 'vitest'
import { compare, cyclicOffset, exactLag, fractionalOffset, relativeDelay, repeatAligned, repeatFractional } from '../medir/audio-metrics'

function reference(count: number): Float32Array {
  const out = new Float32Array(count)
  let seed = 173, low = 0
  for (let i = 0; i < count; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    low = .9 * low + .1 * ((seed / 0x100000000) * 2 - 1)
    out[i] = low
  }
  return out
}

describe('método de medição da prova de áudio', () => {
  it('recupera a fase de uma entrada cíclica e normaliza ganho sem inventar ruído', () => {
    const input = reference(48_000), phase = 12_347
    const output = repeatAligned(input, phase, 96_000)
    for (let i = 0; i < output.length; i++) output[i] = output[i]! * .4
    expect(cyclicOffset(output, input)).toBe(phase)
    const metrics = compare(output, repeatAligned(input, phase, output.length))
    expect(metrics.gain).toBeCloseTo(.4, 6)
    expect(metrics.correlation).toBeCloseTo(1, 6)
    expect(metrics.residualSnrDb).toBeGreaterThan(90)
  })

  it.each([481, -317, 0])('mantém explícito o atraso conhecido de %i amostras', delay => {
    const input = reference(96_000), output = new Float32Array(input.length)
    for (let i = 0; i < output.length; i++) if (i - delay >= 0 && i - delay < input.length) output[i] = .6 * input[i - delay]!
    expect(relativeDelay(output, input)).toBe(delay)
  })

  it('mede atraso subamostra contra senoides analíticas independentes até 20 kHz', () => {
    const at = (sample: number): number => [2000, 7000, 20000].reduce((sum, hz) => sum + .1 * Math.sin(2 * Math.PI * hz * sample / 48_000), 0)
    const input = Float32Array.from({ length: 48_000 }, (_, i) => at(i))
    const output = Float32Array.from({ length: 48_000 }, (_, i) => .6 * at(i + 31.375))
    const phase = fractionalOffset(output, input, 31)
    expect(phase).toBeCloseTo(31.375, 2)
    const metric = compare(output, repeatFractional(input, phase, output.length))
    expect(metric.residualSnrDb).toBeGreaterThan(60)
    expect(metric.gain).toBeCloseTo(.6, 4)
  })

  it.each([0, 1, 4799, 12_345])('acha o atraso inteiro exato de %i amostras', delay => {
    const input = reference(200_000), output = new Float32Array(260_000)
    output.set(input.map(x => x * .5), delay)
    expect(exactLag(output, input, 20_000)).toBe(delay)
  })

  it.each([1038, 13_969, 4_800 + 17, 960 * 13 + 3])('acha o atraso de %i amostras mesmo com zumbido de 50 Hz dominante e só ruído no primeiro segundo', delay => {
    const input = reference(48_000 * 8)
    for (let i = 0; i < input.length; i++) {
      // fala (envelope que muda) só depois de 1,2 s; zumbido de 50 Hz forte o tempo todo
      const speech = i > 57_600 ? Math.sin(i / 3_000) ** 2 * 0.5 : 0.05
      input[i] = input[i]! * speech + 0.2 * Math.sin(2 * Math.PI * 50 * i / 48_000)
    }
    const output = new Float32Array(input.length + 40_000)
    output.set(input, delay)
    expect(exactLag(output, input, 96_000)).toBe(delay)
  })
})
