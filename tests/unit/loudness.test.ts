import { describe, expect, it } from 'vitest'
import { IntegratedLoudness, LOUDNESS_SAMPLE_RATE } from '@shared/loudness'

const SR = LOUDNESS_SAMPLE_RATE
const sine = (seconds: number, amplitude: number, hz = 997): Float32Array => Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / SR))
const measure = (pcm: Float32Array, chunk = 4096): number | null => {
  const meter = new IntegratedLoudness()
  for (let i = 0; i < pcm.length; i += chunk) meter.push(pcm.subarray(i, i + chunk))
  return meter.finish()
}

describe('volume integrado (LUFS) da voz bruta', () => {
  it('senoide de 997 Hz: -3,01 LUFS a 0 dBFS de pico, e cada -10 dB de amplitude vale -10 LU (BS.1770)', () => {
    expect(measure(sine(5, 1))!).toBeCloseTo(-3.01, 1)
    expect(measure(sine(5, 10 ** (-10 / 20)))!).toBeCloseTo(-13.01, 1)
    expect(measure(sine(5, 10 ** (-55 / 20)))!).toBeCloseTo(-58.01, 1)
  })

  it('o tamanho dos pedaços não muda o resultado (fluxo)', () => {
    const pcm = sine(3, 0.1)
    expect(measure(pcm, 777)).toBeCloseTo(measure(pcm, 48_000)!, 9)
  })

  it('silêncio, sinal curto demais e abaixo da porta absoluta (-70 LUFS) não têm volume', () => {
    expect(measure(new Float32Array(SR * 3))).toBeNull()
    expect(measure(sine(0.3, 0.5))).toBeNull()
    expect(measure(sine(5, 10 ** (-80 / 20)))).toBeNull()
  })

  it('a porta relativa ignora a pausa longa: fala + silêncio mede só a fala', () => {
    const speech = sine(4, 0.1)
    const mixed = new Float32Array(SR * 12)
    mixed.set(speech, 0)
    mixed.set(Float32Array.from(speech, (x) => x * 0.00001), SR * 4)
    // Os blocos de 400 ms que pegam a emenda da fala com a pausa entram na média: até 0,3 LU de diferença, nunca os 8 s de pausa.
    expect(Math.abs(measure(mixed)! - measure(speech)!)).toBeLessThan(0.3)
  })
})
