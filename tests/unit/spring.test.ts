import { describe, expect, it } from 'vitest'
import { CAMERA_SPRING, CURSOR_SPRING, dampingRatio, naturalFrequency, step, stepMany, type SpringParams } from '@shared/spring'

const DT = 1 / 60
const critical: SpringParams = { k: 200, c: 2 * Math.sqrt(200 * 2.25), m: 2.25 }
const over: SpringParams = { k: 200, c: 120, m: 2.25 }

describe('mola analítica', () => {
  it('as molas do projeto são sub-amortecidas, a super é super e a crítica é crítica', () => {
    expect(dampingRatio(CAMERA_SPRING)).toBeCloseTo(0.943, 2)
    expect(dampingRatio(CURSOR_SPRING)).toBeCloseTo(0.932, 2)
    expect(dampingRatio(over)).toBeGreaterThan(1)
    expect(dampingRatio(critical)).toBeCloseTo(1, 12)
    expect(naturalFrequency(CAMERA_SPRING)).toBeCloseTo(Math.sqrt(200 / 2.25), 12)
  })

  for (const [nome, p] of [
    ['sub-amortecida (câmera)', CAMERA_SPRING],
    ['sub-amortecida (cursor)', CURSOR_SPRING],
    ['crítica', critical],
    ['super-amortecida', over]
  ] as const) {
    it(`converge para o alvo: ${nome}`, () => {
      const end = stepMany({ x: 0, v: 0 }, 1, p, DT, 60 * 6)
      expect(end.x).toBeCloseTo(1, 4)
      expect(Math.abs(end.v)).toBeLessThan(1e-3)
    })

    it(`a solução é exata: um passo de 1 s = 60 passos de 1/60 s (${nome})`, () => {
      const one = step(0.2, 0.7, 1.5, p, 1)
      const many = stepMany({ x: 0.2, v: 0.7 }, 1.5, p, DT, 60)
      expect(many.x).toBeCloseTo(one.x, 9)
      expect(many.v).toBeCloseTo(one.v, 9)
    })

    it(`bate com a integração numérica fina (${nome})`, () => {
      // Euler semi-implícito com passo de 10 µs como referência independente
      let x = 0.3
      let v = -0.4
      const h = 1e-5
      for (let i = 0; i < 100_000; i++) {
        const a = (-p.k * (x - 2) - p.c * v) / p.m
        v += a * h
        x += v * h
      }
      const exact = step(0.3, -0.4, 2, p, 1)
      expect(exact.x).toBeCloseTo(x, 3)
      expect(exact.v).toBeCloseTo(v, 3)
    })
  }

  it('a mola sub-amortecida da câmera quase não passa do alvo (≈ 0,01%)', () => {
    let s = { x: 0, v: 0 }
    let max = 0
    for (let i = 0; i < 300; i++) {
      s = step(s.x, s.v, 1, CAMERA_SPRING, DT)
      max = Math.max(max, s.x)
    }
    expect(max).toBeLessThan(1.001)
  })

  it('assenta em cerca de 0,4 s (95% do caminho em menos de 0,6 s)', () => {
    let s = { x: 0, v: 0 }
    let t95 = -1
    for (let i = 1; i <= 120; i++) {
      s = step(s.x, s.v, 1, CAMERA_SPRING, DT)
      if (t95 < 0 && s.x >= 0.95) t95 = i * DT
    }
    expect(t95).toBeGreaterThan(0.15)
    expect(t95).toBeLessThan(0.6)
  })

  it('carrega a velocidade quando o alvo muda (nunca reinicia)', () => {
    let s = { x: 0, v: 0 }
    for (let i = 0; i < 12; i++) s = step(s.x, s.v, 1, CAMERA_SPRING, DT)
    expect(Math.abs(s.v)).toBeGreaterThan(1) // em pleno movimento
    const before = s
    // muda o alvo para trás: a velocidade NÃO zera, só vai sendo freada pela mola
    const after = step(before.x, before.v, 0.4, CAMERA_SPRING, DT)
    const accel = (CAMERA_SPRING.k * Math.abs(before.x - 0.4) + CAMERA_SPRING.c * Math.abs(before.v)) / CAMERA_SPRING.m
    expect(Math.abs(after.v - before.v)).toBeLessThanOrEqual(DT * accel * 1.05)
    expect(Math.sign(after.v)).toBe(Math.sign(before.v))
    // posição também contínua: avançou com a velocidade que já tinha
    expect(after.x).toBeGreaterThan(before.x)
    // um reinício (v = 0) andaria bem menos
    const restart = step(before.x, 0, 0.4, CAMERA_SPRING, DT)
    expect(after.x).toBeGreaterThan(restart.x)
  })

  it('sem NaN: dt = 0, alvo igual e valores extremos', () => {
    expect(step(0.5, 0.25, 1, CAMERA_SPRING, 0)).toEqual({ x: 0.5, v: 0.25 })
    expect(step(1, 0, 1, CAMERA_SPRING, DT)).toEqual({ x: 1, v: 0 })
    expect(step(1, 0, 1, CAMERA_SPRING, 5)).toEqual({ x: 1, v: 0 })
    const cases: [number, number, number, number][] = [
      [1e308, 1e308, -1e308, 1],
      [1e-320, 0, 0, DT],
      [0, 0, 1, 1e9],
      [0, 0, 1, Number.POSITIVE_INFINITY],
      [0, 0, 1, -1],
      [0, 0, 1, Number.NaN],
      [Number.NaN, 0, 1, DT],
      [0, Number.POSITIVE_INFINITY, 1, DT],
      [0, 0, Number.NaN, DT],
      [5e300, -5e300, 1, 3]
    ]
    for (const [x, v, target, dt] of cases) {
      for (const p of [CAMERA_SPRING, critical, over]) {
        const r = step(x, v, target, p, dt)
        expect(Number.isNaN(r.x), `x NaN para ${[x, v, target, dt]}`).toBe(false)
        expect(Number.isNaN(r.v), `v NaN para ${[x, v, target, dt]}`).toBe(false)
      }
    }
    // resultado não finito vira "no alvo, parado"
    expect(step(1e308, 1e308, -1e308, CAMERA_SPRING, 1)).toEqual({ x: -1e308, v: 0 })
  })

  it('sem amortecimento a mola oscila sem perder amplitude', () => {
    const free: SpringParams = { k: 100, c: 0, m: 1 }
    const w = 10
    const r = step(1, 0, 0, free, Math.PI / w) // meio período: do outro lado
    expect(r.x).toBeCloseTo(-1, 9)
    expect(Math.abs(r.v)).toBeLessThan(1e-9)
  })

  it('molas inválidas lançam erro claro', () => {
    expect(() => step(0, 0, 1, { k: 0, c: 1, m: 1 }, DT)).toThrow(RangeError)
    expect(() => step(0, 0, 1, { k: 1, c: -1, m: 1 }, DT)).toThrow(RangeError)
    expect(() => step(0, 0, 1, { k: 1, c: 1, m: 0 }, DT)).toThrow(RangeError)
  })
})
