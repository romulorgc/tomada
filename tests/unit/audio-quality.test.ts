import { describe, expect, it } from 'vitest'
import { analyzeAudioQuality, analyzeAudioQualityBlocks, measureAudioQualityBlocks } from '@shared/audio-quality'

const SR = 48_000
function signal(durationMs: number, dbfs: number, from = 0, to = durationMs): Float32Array {
  const pcm = new Float32Array(Math.round(durationMs * SR / 1000))
  const amplitude = Math.SQRT2 * 10 ** (dbfs / 20)
  for (let i = Math.round(from * SR / 1000); i < Math.round(to * SR / 1000); i++) pcm[i] = amplitude * Math.sin(2 * Math.PI * 200 * i / SR)
  return pcm
}

describe('qualidade da voz PCM', () => {
  it('acumula amostras perto da escala máxima, mesmo em rajadas separadas e nos dois sinais', () => {
    const pcm = new Float32Array(SR)
    pcm.fill(0.95, 0, 2400)
    pcm.fill(-0.95, SR - 2400)
    const quality = analyzeAudioQuality(pcm, SR)
    expect(quality.clippingMs).toBe(100)
    expect(quality.peakDbfs).toBeCloseTo(-0.4455, 3)
    expect(quality.warnings).toContain('clipping')
    pcm[0] = 0.9
    expect(analyzeAudioQuality(pcm, SR).warnings).not.toContain('clipping')
  })

  it('um pico isolado ou 99 ms não gera aviso de estouro', () => {
    const pcm = new Float32Array(SR)
    pcm.fill(1, 0, 4752)
    expect(analyzeAudioQuality(pcm, SR).clippingMs).toBe(99)
    expect(analyzeAudioQuality(pcm, SR).warnings).not.toContain('clipping')
  })

  it('um sinal logo abaixo de -0,5 dBFS nunca conta como clipping', () => {
    const pcm = new Float32Array(SR).fill(0.943)
    expect(analyzeAudioQuality(pcm, SR).clippingMs).toBe(0)
  })

  it('voz ativa de -40 dBFS gera aviso, medindo fala sem diluir nos silêncios', () => {
    const quality = analyzeAudioQuality(signal(3000, -40, 1000, 1600), SR)
    expect(quality.activeMs).toBe(600)
    expect(quality.activeRmsDbfs).toBeCloseTo(-40, 3)
    expect(quality.warnings).toEqual(['low-voice'])
  })

  it('voz de -20 dBFS com silêncio longo mantém nível bom', () => {
    const quality = analyzeAudioQuality(signal(10_000, -20, 4000, 4600), SR)
    expect(quality.activeRmsDbfs).toBeCloseTo(-20, 3)
    expect(quality.warnings).toEqual([])
  })

  it('silêncio, sinal abaixo do piso e ruído estacionário não são rotulados como voz baixa', () => {
    let seed = 12345
    const noise = Float32Array.from({ length: SR }, () => {
      seed = (1664525 * seed + 1013904223) >>> 0
      return (seed / 0x1_0000_0000 * 2 - 1) * 0.01
    })
    for (const pcm of [new Float32Array(SR), signal(1000, -80, 300, 700), noise]) {
      const quality = analyzeAudioQuality(pcm, SR)
      expect(quality.activeMs).toBe(0)
      expect(quality.activeRmsDbfs).toBeNull()
      expect(quality.warnings).toEqual([])
    }
    expect(analyzeAudioQuality(new Float32Array(), SR).peakDbfs).toBeNull()
  })

  it('periodicidade vocal encontra voz contínua e modulada baixa, sem confundir zumbido de 60 Hz', () => {
    const continuous = signal(1000, -40)
    expect(analyzeAudioQuality(continuous, SR).warnings).toEqual(['low-voice'])
    const modulated = Float32Array.from(continuous, (v, i) => v * (0.7 + 0.3 * Math.sin(2 * Math.PI * 3 * i / SR)))
    expect(analyzeAudioQuality(modulated, SR).activeMs).toBeGreaterThan(300)
    expect(analyzeAudioQuality(modulated, SR).warnings).toEqual(['low-voice'])
    const hum = Float32Array.from(continuous, (_, i) => 0.01 * Math.SQRT2 * Math.sin(2 * Math.PI * 60 * i / SR))
    expect(analyzeAudioQuality(hum, SR).warnings).toEqual([])
  })

  it('regiões VAD/transcritas podem confirmar fala contínua, mas não convertem silêncio em fala', () => {
    const ranges = { activeRanges: [{ start: 0, end: 1000 }] }
    expect(analyzeAudioQuality(signal(1000, -40), SR, ranges).warnings).toEqual(['low-voice'])
    expect(analyzeAudioQuality(new Float32Array(SR), SR, ranges).warnings).toEqual([])
    expect(analyzeAudioQuality(signal(1000, -40), SR, { activeRanges: [] }).activeMs).toBe(0)
  })

  it('fala de -35 dBFS não é abaixo do limiar e rajada curta não sustenta aviso de nível', () => {
    expect(analyzeAudioQuality(signal(1000, -35, 300, 700), SR).warnings).toEqual([])
    expect(analyzeAudioQuality(signal(1000, -40, 300, 500), SR).warnings).toEqual([])
  })

  it('mede blocos equivalentes ao buffer integral, inclusive último bloco parcial', () => {
    const pcm = signal(1023, -40, 300, 800)
    const blocks = measureAudioQualityBlocks(pcm, SR)
    expect(blocks.at(-1)?.sampleCount).toBe(144)
    expect(analyzeAudioQualityBlocks(blocks, SR)).toEqual(analyzeAudioQuality(pcm, SR))
    expect(analyzeAudioQuality(pcm, SR).durationMs).toBe(1023)
  })

  it('recusa taxa inválida e amostra não finita, em vez de ocultar arquivo ruim', () => {
    expect(() => analyzeAudioQuality(new Float32Array([0]), 0)).toThrow(/taxa/i)
    expect(() => analyzeAudioQuality(new Float32Array([NaN]), SR)).toThrow(/amostra/i)
    expect(() => analyzeAudioQuality(new Float32Array([Infinity]), SR)).toThrow(/amostra/i)
  })
})
