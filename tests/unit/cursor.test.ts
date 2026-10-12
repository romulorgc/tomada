import { describe, expect, it } from 'vitest'
import {
  GRID_STEP_MS,
  MAX_INTERP_GAP_MS,
  PRESS_SCALE,
  computeSyntheticCursor,
  createCursorLookup,
  pressScale,
  processCursor,
  removeTremor,
  sampleGrid,
  sampleSynthetic
} from '@shared/cursor'
import type { ClickEvent, CursorSample } from '@shared/types'

const s = (t: number, x: number, y: number, out = false): CursorSample => (out ? { t, x, y, out: true } : { t, x, y })
const click = (t: number, x: number, y: number): ClickEvent => ({ t, x, y, button: 'left' })

describe('processCursor', () => {
  it('monta a grade uniforme a 60 Hz com a duração pedida', () => {
    const g = processCursor([s(0, 0.5, 0.5)], [], { durationMs: 1000 })
    expect(g.hz).toBe(60)
    expect(g.t).toHaveLength(61)
    expect(g.t[1]! - g.t[0]!).toBeCloseTo(GRID_STEP_MS, 9)
    expect(g.x).toHaveLength(61)
    expect(g.y).toHaveLength(61)
  })

  it('interpola linearmente entre amostras próximas', () => {
    const g = processCursor([s(0, 0, 0), s(100, 1, 0.5)], [], { durationMs: 200, antiTremor: false })
    expect(sampleGrid(g, 50).x).toBeCloseTo(0.5, 2)
    expect(sampleGrid(g, 50).y).toBeCloseTo(0.25, 2)
    expect(sampleGrid(g, 150).x).toBeCloseTo(1, 9) // depois da última: segura
  })

  it('antes da primeira amostra usa a primeira; sem nenhuma, o centro', () => {
    const g = processCursor([s(500, 0.2, 0.7)], [], { durationMs: 1000 })
    expect(g.x[0]).toBeCloseTo(0.2, 9)
    expect(g.y[0]).toBeCloseTo(0.7, 9)
    const empty = processCursor([], [], { durationMs: 100 })
    expect(empty.x.every((v) => v === 0.5) && empty.y.every((v) => v === 0.5)).toBe(true)
  })

  it('fora da área (out) e buracos longos seguram a última posição válida', () => {
    const samples = [s(0, 0.2, 0.2), s(100, 0.4, 0.4), s(200, 1, 1, true), s(300, 1, 1, true), s(400, 0.9, 0.1)]
    const g = processCursor(samples, [], { durationMs: 500, antiTremor: false })
    // entre 100 e 400 só há amostras de fora no meio: o gap 100→400 passa de 250 ms, segura (0.4, 0.4)
    expect(MAX_INTERP_GAP_MS).toBeLessThan(300)
    expect(sampleGrid(g, 250).x).toBeCloseTo(0.4, 9)
    expect(sampleGrid(g, 250).y).toBeCloseTo(0.4, 9)
    expect(sampleGrid(g, 450).x).toBeCloseTo(0.9, 9)
  })

  it('buraco sem amostras (> 250 ms) segura, não inventa movimento', () => {
    const g = processCursor([s(0, 0.1, 0.1), s(2000, 0.9, 0.9)], [], { durationMs: 2000, antiTremor: false })
    expect(sampleGrid(g, 1000).x).toBeCloseTo(0.1, 9)
    expect(sampleGrid(g, 1980).x).toBeCloseTo(0.1, 9)
    expect(sampleGrid(g, 2000).x).toBeCloseTo(0.9, 9)
  })

  it('cliques também dizem onde o cursor estava', () => {
    const g = processCursor([], [click(1000, 0.3, 0.6)], { durationMs: 2000 })
    expect(sampleGrid(g, 1500).x).toBeCloseTo(0.3, 9)
    expect(sampleGrid(g, 1500).y).toBeCloseTo(0.6, 9)
  })

  it('anti-tremor: oscilação menor que 0,015 por menos de 100 ms é ignorada', () => {
    const jitter: CursorSample[] = []
    for (let t = 0; t <= 400; t += 8) jitter.push(s(t, 0.5 + (Math.floor(t / 8) % 2 ? 0.004 : -0.004), 0.5))
    const kept = removeTremor(jitter.map((p) => ({ t: p.t, x: p.x, y: p.y })))
    // 400 ms de tremor ≥ 100 ms de duração: quando passa de 100 ms o movimento é aceito, mas nunca a 120 Hz
    const distinct = new Set(kept.map((p) => p.x.toFixed(4)))
    expect(distinct.size).toBeLessThanOrEqual(5)

    // tremor curto (< 100 ms) fica totalmente parado
    const shortTrack = [s(0, 0.5, 0.5), s(8, 0.504, 0.5), s(16, 0.496, 0.5), s(24, 0.5, 0.5), s(32, 0.5, 0.5)]
    const g = processCursor(shortTrack, [], { durationMs: 32 })
    expect(g.x.every((v) => v === 0.5)).toBe(true)
  })

  it('anti-tremor: deslocamento ≥ 0,015 passa na hora; menor mas sustentado passa depois de 100 ms', () => {
    const big = removeTremor([
      { t: 0, x: 0.5, y: 0.5 },
      { t: 8, x: 0.52, y: 0.5 }
    ])
    expect(big[1]!.x).toBe(0.52)

    const slow = removeTremor([
      { t: 0, x: 0.5, y: 0.5 },
      { t: 50, x: 0.508, y: 0.5 },
      { t: 99, x: 0.509, y: 0.5 },
      { t: 150, x: 0.51, y: 0.5 },
      { t: 200, x: 0.511, y: 0.5 }
    ])
    expect(slow[2]!.x).toBe(0.5) // 49 ms de deriva: ainda é tremor
    expect(slow[3]!.x).toBeCloseTo(0.51, 9) // 100 ms de deriva: é movimento
  })
})

describe('createCursorLookup (posição exata, sem anti-tremor)', () => {
  it('interpola entre as amostras originais e segura quando faltam', () => {
    const l = createCursorLookup([s(0, 0, 0), s(8, 0.01, 0), s(16, 0.02, 0), s(1000, 0.9, 0.9)])
    expect(l.at(4).x).toBeCloseTo(0.005, 9)
    expect(l.at(12).x).toBeCloseTo(0.015, 9)
    expect(l.at(500).x).toBeCloseTo(0.02, 9) // gap grande: segura
    expect(l.at(1000).x).toBeCloseTo(0.9, 9)
    expect(l.at(-5).x).toBe(0)
  })

  it('reporta fora da área e funciona também em tempo decrescente', () => {
    const l = createCursorLookup([s(0, 0.1, 0.1), s(100, 0.2, 0.2, true), s(200, 0.3, 0.3)])
    expect(l.at(100).out).toBe(true)
    expect(l.at(50).out).toBe(false)
    expect(l.at(200).out).toBe(false)
    expect(l.at(10).x).toBeCloseTo(0.1 + 0.1 * (10 / 100) * 0, 1)
    expect(createCursorLookup([]).empty).toBe(true)
    expect(createCursorLookup([]).at(0).out).toBe(true)
  })
})

describe('cursor sintético', () => {
  const line = (n: number): CursorSample[] => Array.from({ length: n }, (_, i) => s(i * 8, 0.2 + (0.6 * i) / n, 0.5))

  it('segue o cursor pela mola: atrasa um pouco e alcança', () => {
    const samples = line(250) // 2 s de movimento
    const track = computeSyntheticCursor(createCursorLookup(samples), { durationMs: 2000, hideAfterIdleMs: 2000 })
    const exact = createCursorLookup(samples)
    const at = sampleSynthetic(track, 1000)
    expect(at.x).toBeLessThan(exact.at(1000).x + 1e-9) // atrasa
    expect(exact.at(1000).x - at.x).toBeLessThan(0.1)
    const end = sampleSynthetic(track, 2000)
    expect(Math.abs(end.x - exact.at(1990).x)).toBeLessThan(0.06)
  })

  it('some depois de parado e reaparece com fade ao se mexer', () => {
    // anda 1 s, para 4 s, anda de novo
    const samples: CursorSample[] = []
    for (let t = 0; t <= 1000; t += 8) samples.push(s(t, 0.2 + 0.3 * (t / 1000), 0.5))
    for (let t = 1008; t <= 5000; t += 8) samples.push(s(t, 0.5, 0.5))
    for (let t = 5008; t <= 6000; t += 8) samples.push(s(t, 0.5 + 0.3 * ((t - 5000) / 1000), 0.5))
    const track = computeSyntheticCursor(createCursorLookup(samples), { durationMs: 6000, hideAfterIdleMs: 2000 })
    expect(sampleSynthetic(track, 500).alpha).toBeCloseTo(1, 6)
    expect(sampleSynthetic(track, 2500).alpha).toBeCloseTo(1, 6) // parado há 1,5 s
    expect(sampleSynthetic(track, 3200).alpha).toBeLessThan(1) // começando a sumir
    expect(sampleSynthetic(track, 4500).alpha).toBeCloseTo(0, 6)
    const early = sampleSynthetic(track, 5100).alpha
    expect(early).toBeGreaterThan(0)
    expect(early).toBeLessThan(1) // fade de entrada em curso
    expect(sampleSynthetic(track, 5800).alpha).toBeCloseTo(1, 6)
  })

  it('hideAfterIdleMs = 0 nunca some; fora da área some', () => {
    const still = Array.from({ length: 400 }, (_, i) => s(i * 8, 0.5, 0.5))
    const never = computeSyntheticCursor(createCursorLookup(still), { durationMs: 3000, hideAfterIdleMs: 0 })
    expect(sampleSynthetic(never, 2900).alpha).toBeCloseTo(1, 9)
    const out = [s(0, 0.5, 0.5), ...Array.from({ length: 200 }, (_, i) => s(8 + i * 8, 1, 0.5, true))]
    const t = computeSyntheticCursor(createCursorLookup(out), { durationMs: 1500, hideAfterIdleMs: 0 })
    expect(sampleSynthetic(t, 1200).alpha).toBeCloseTo(0, 6)
  })

  it('o clique aperta o cursor: 1 → 0,85 em 40 ms, segura até 120 ms e solta em 80 ms', () => {
    const clicks = [{ t: 1000 }]
    expect(pressScale(clicks, 900)).toBe(1)
    expect(pressScale(clicks, 1000)).toBe(1)
    expect(pressScale(clicks, 1020)).toBeCloseTo(1 - 0.15 * 0.5, 9)
    expect(pressScale(clicks, 1040)).toBeCloseTo(PRESS_SCALE, 9)
    expect(pressScale(clicks, 1120)).toBeCloseTo(PRESS_SCALE, 9)
    expect(pressScale(clicks, 1160)).toBeCloseTo(1 - 0.15 * 0.5, 9)
    expect(pressScale(clicks, 1201)).toBe(1)
  })
})
