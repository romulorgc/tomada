import { describe, expect, it } from 'vitest'
import { VoiceNoiseMeter } from '../../src/main/voice-noise'
import type { Word } from '../../src/shared/types'

const SR = 48_000
const word = (start: number, end: number): Word => ({ i: 0, text: 'fala', start, end, prob: 1, kind: 'word' })

function signal(floorDb: number, speechStart = 1, speechEnd = 3): Float32Array {
  let seed = 12345
  const out = new Float32Array(SR * 4)
  const amplitude = Math.sqrt(3) * 10 ** (floorDb / 20)
  for (let i = 0; i < out.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const t = i / SR
    out[i] = (seed / 2 ** 32 * 2 - 1) * amplitude + (t >= speechStart && t < speechEnd ? 0.1 * Math.sin(2 * Math.PI * 200 * t) : 0)
  }
  return out
}

const measure = (pcm: Float32Array, words: Word[] | null, offsetMs = 0) => {
  const meter = new VoiceNoiseMeter()
  // Fragmentos atravessam amostras e quadros: o medidor deve conservar o relógio.
  for (let i = 0; i < pcm.length; i += 777) meter.push(pcm.subarray(i, i + 777))
  return meter.finish({ words, offsetMs })
}

describe('piso medido da própria gravação', () => {
  it.each([-58, -42])('mede %.0f dBFS em silêncio transcrito, sem incluir voz e sem piso fixo', (floor) => {
    const result = measure(signal(floor), [word(1000, 3000)])
    expect(result.source).toBe('transcript')
    expect(result.noiseFloorDb).toBeCloseTo(floor, 0)
    expect(result.silenceMs).toBeGreaterThan(1000)
    expect(result.silenceMs).toBeLessThan(2000) // exclui margens antes/depois da fala
  })

  it('palavras no relógio da gravação respeitam o offset da voz', () => {
    const result = measure(signal(-49), [word(1250, 3250)], 250)
    expect(result.source).toBe('transcript')
    expect(result.noiseFloorDb).toBeCloseTo(-49, 0)
  })

  it('sem transcrição usa VAD acústico local e rejeita a região periódica de fala', () => {
    const result = measure(signal(-47), null)
    expect(result.source).toBe('vad')
    expect(result.noiseFloorDb).toBeCloseTo(-47, 0)
    expect(result.silenceMs).toBeGreaterThan(1000)
    expect(result.silenceMs).toBeLessThanOrEqual(2000)
  })

  it('fala conhecida ocupa toda a gravação: não esquece a transcrição ao procurar silêncio', () => {
    expect(measure(signal(-52), [word(0, 4000)]).noiseFloorDb).toBeNull()
    // Sussurro/fricativas têm pouca periodicidade: a palavra conhecida ainda precisa protegê-los.
    expect(measure(signal(-40, 5, 6), [word(0, 4000)]).noiseFloorDb).toBeNull()
  })

  it('sem transcrição, fala periódica contínua não vira ruído presumido', () => {
    const continuous = signal(-52, 0, 4)
    expect(measure(continuous, null).noiseFloorDb).toBeNull()
  })

  it('silêncio digital, material vazio e silêncio curto não habilitam afftdn', () => {
    expect(measure(new Float32Array(SR), null).noiseFloorDb).toBeNull()
    expect(measure(new Float32Array(), null).noiseFloorDb).toBeNull()
    expect(measure(signal(-50).subarray(0, SR / 5), null).noiseFloorDb).toBeNull()
  })

  it('vozes não transcritas e estalos nos intervalos não entram na medição', () => {
    const pcm = signal(-55, 0.1, 0.8)
    const result = measure(pcm, [word(1000, 3000)])
    expect(result.noiseFloorDb).toBeCloseTo(-55, 0)
    expect(result.silenceMs).toBeLessThan(1400)
  })
})
