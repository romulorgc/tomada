import { describe, expect, it } from 'vitest'
import { PEAKS_PER_SECOND, computePeaks, pcmFromBytes, peaksForPixels } from '@shared/peaks'

describe('computePeaks', () => {
  it('uma coluna a cada 20 ms com o pico normalizado em 0..255', () => {
    const sr = 8000
    const pcm = new Int16Array(sr) // 1 s de silêncio
    pcm[10] = 16384 // metade da escala na coluna 0
    pcm[400] = -32768 // fundo de escala na coluna 2 (160 amostras por coluna)
    const peaks = computePeaks(pcm, sr)
    expect(peaks).toHaveLength(PEAKS_PER_SECOND)
    expect(peaks[0]).toBe(128)
    expect(peaks[1]).toBe(0)
    expect(peaks[2]).toBe(255)
  })
  it('entrada vazia ou taxa inválida dá lista vazia; a última coluna parcial conta', () => {
    expect(computePeaks(new Int16Array(0), 8000)).toEqual([])
    expect(computePeaks(new Int16Array(10), 0)).toEqual([])
    expect(computePeaks(new Int16Array(170), 8000)).toHaveLength(2)
  })
  it('pcmFromBytes lê s16le', () => {
    const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f])
    expect([...pcmFromBytes(bytes)]).toEqual([16384, -16384, 32767])
    expect(pcmFromBytes(new Uint8Array([1, 2, 3])).length).toBe(1)
  })
})

describe('peaksForPixels', () => {
  const file = { perSecond: 50, peaks: [0, 51, 0, 255, 0, 0, 102, 0, 0, 0] } // 200 ms no total
  it('um pixel por coluna: devolve cada pico', () => {
    const out = peaksForPixels(file, 0, 20, 10)
    expect(out[1]).toBeCloseTo(0.2, 5)
    expect(out[3]).toBe(1)
    expect(out[6]).toBeCloseTo(0.4, 5)
  })
  it('vários picos por pixel: vale o maior', () => {
    const out = peaksForPixels(file, 0, 100, 2)
    expect(out[0]).toBe(1) // colunas 0..4
    expect(out[1]).toBeCloseTo(0.4, 5) // colunas 5..9
  })
  it('fora do áudio é zero', () => {
    expect(peaksForPixels(file, 5000, 20, 3)).toEqual([0, 0, 0])
    expect(peaksForPixels(file, -100, 20, 5).slice(0, 5)).toEqual([0, 0, 0, 0, 0])
  })
})
