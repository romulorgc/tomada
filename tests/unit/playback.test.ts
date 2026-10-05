import { describe, expect, it } from 'vitest'
import {
  DRIFT_FRAMES,
  DRIFT_SETTLE_FRAMES,
  SHUTTLE_RATES,
  advanceClock,
  driftFix,
  frameDurationMs,
  keptIndexAt,
  prefetchTarget,
  shuttleRate,
  stepOutputMs
} from '@shared/playback'
import { keptRanges } from '@shared/timeline'

const kept = keptRanges(10_000, [
  { start: 2000, end: 3000, enabled: true },
  { start: 6000, end: 7000, enabled: true }
]) // [0,2000) [3000,6000) [7000,10000)

describe('advanceClock', () => {
  it('avança dentro do trecho', () => {
    expect(advanceClock(500, 16, 1, kept)).toEqual({ t: 516, jump: null, ended: false })
    expect(advanceClock(500, 16, 2, kept).t).toBe(532)
  })
  it('cruzando o fim do trecho pula para o início do próximo (sem passar pelo corte)', () => {
    const s = advanceClock(1995, 16, 1, kept)
    expect(s.t).toBe(3000)
    expect(s.jump).toEqual({ from: 2011, to: 3000 })
    expect(s.ended).toBe(false)
  })
  it('depois do último trecho termina no fim', () => {
    expect(advanceClock(9995, 16, 1, kept)).toEqual({ t: 10_000, jump: null, ended: true })
  })
  it('um relógio que está dentro de um corte (busca) cai no próximo trecho', () => {
    expect(advanceClock(2500, 16, 1, kept).t).toBe(3000)
  })
  it('para trás: pula para o fim do trecho anterior; no começo termina', () => {
    const s = advanceClock(3005, 16, -1, kept)
    expect(s.jump).toEqual({ from: 2989, to: 1999 })
    expect(s.t).toBe(1999)
    expect(advanceClock(5, 16, -1, kept)).toEqual({ t: 0, jump: null, ended: true })
    expect(advanceClock(4000, 16, -1, kept)).toEqual({ t: 3984, jump: null, ended: false })
  })
  it('sem trechos mantidos termina', () => {
    expect(advanceClock(0, 16, 1, []).ended).toBe(true)
  })
})

describe('prefetchTarget', () => {
  it('só avisa quando falta pouco para o fim do trecho e há próximo', () => {
    expect(prefetchTarget(kept, 500, 700)).toBeNull()
    expect(prefetchTarget(kept, 1400, 700)).toEqual({ index: 1, start: 3000 })
    expect(prefetchTarget(kept, 9500, 700)).toBeNull() // último trecho
    expect(prefetchTarget(kept, 2500, 700)).toBeNull() // dentro do corte
  })
  it('keptIndexAt', () => {
    expect(keptIndexAt(kept, 0)).toBe(0)
    expect(keptIndexAt(kept, 2000)).toBe(-1)
    expect(keptIndexAt(kept, 3000)).toBe(1)
  })
})

describe('driftFix', () => {
  const frame = frameDurationMs(30)
  it('até 1,5 quadro não corrige', () => {
    expect(driftFix(frame * DRIFT_FRAMES - 1, frame, 1)).toEqual({ kind: 'ok', rate: 1 })
    expect(driftFix(-frame, frame, 1)).toEqual({ kind: 'ok', rate: 1 })
  })
  it('deriva média acelera ou freia um pouco (nunca busca)', () => {
    const behind = driftFix(-120, frame, 1)
    const ahead = driftFix(120, frame, 1)
    expect(behind.kind).toBe('nudge')
    expect(behind.rate).toBeGreaterThan(1)
    expect(ahead.rate).toBeLessThan(1)
    expect(driftFix(-120, frame, 2).rate).toBeCloseTo(2 * behind.rate, 9)
  })
  it('deriva grande busca', () => {
    expect(driftFix(900, frame, 1).kind).toBe('seek')
    expect(driftFix(-401, frame, 1).kind).toBe('seek')
  })
  it('histerese: quem já está alcançando só para de ajustar abaixo de meio quadro', () => {
    expect(driftFix(-30, frame, 1).kind).toBe('ok') // 30 ms < 1,5 quadro: começando do zero, tudo bem
    expect(driftFix(-30, frame, 1, { toleranceFrames: DRIFT_SETTLE_FRAMES }).kind).toBe('nudge') // já ajustando: continua
    expect(driftFix(-10, frame, 1, { toleranceFrames: DRIFT_SETTLE_FRAMES }).kind).toBe('ok')
  })
  it('entrada inválida não corrige', () => {
    expect(driftFix(Number.NaN, frame, 1).kind).toBe('ok')
  })
})

describe('quadros e teclas', () => {
  it('frameDurationMs', () => {
    expect(frameDurationMs(30)).toBeCloseTo(33.333, 3)
    expect(frameDurationMs(60)).toBeCloseTo(16.667, 3)
    expect(frameDurationMs(0)).toBeCloseTo(33.333, 3)
    expect(frameDurationMs(undefined)).toBeCloseTo(33.333, 3)
  })
  it('stepOutputMs anda quadros sem sair do vídeo', () => {
    expect(stepOutputMs(1000, 1, 30, 20_000)).toBeCloseTo(1033.333, 3)
    expect(stepOutputMs(1000, -3, 30, 20_000)).toBeCloseTo(900, 6)
    expect(stepOutputMs(10, -5, 30, 20_000)).toBe(0)
    expect(stepOutputMs(19_990, 5, 30, 20_000)).toBe(20_000)
  })
  it('J/K/L: L toca e acelera, J volta, K para', () => {
    expect(shuttleRate(0, 'L')).toBe(1)
    expect(shuttleRate(1, 'L')).toBe(2)
    expect(shuttleRate(2, 'L')).toBe(4)
    expect(shuttleRate(4, 'L')).toBe(4) // teto
    expect(shuttleRate(0, 'J')).toBe(-1)
    expect(shuttleRate(-1, 'J')).toBe(-2)
    expect(shuttleRate(2, 'J')).toBe(-1) // inverte para voltar
    expect(shuttleRate(-2, 'L')).toBe(1)
    expect(shuttleRate(4, 'K')).toBe(0)
    expect(SHUTTLE_RATES).toEqual([1, 2, 4])
  })
})
