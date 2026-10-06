/** Arrastar e redimensionar o retângulo do recorte manual (C1): dentro da tela, com proporção travada em pixels. */
import { describe, expect, it } from 'vitest'
import { cropMinPx } from '@shared/crop'
import { CROP_LOCKS, defaultManualCrop, dragCrop, lockAspect, type CropHandle } from '@shared/crop-drag'
import type { Rect } from '@shared/types'

const SRC = { w: 1920, h: 1080 }
const start: Rect = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 } // 960×540 px
const aspectPx = (r: Rect): number => (r.w * SRC.w) / (r.h * SRC.h)
const within = (r: Rect): boolean => r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9

describe('mover o recorte', () => {
  it('anda pelo deslocamento e para na borda da tela', () => {
    const m = dragCrop(start, 'move', 0.1, -0.05, SRC)
    expect(m.x).toBeCloseTo(0.3, 9)
    expect(m.y).toBeCloseTo(0.15, 9)
    expect(m.w).toBe(0.5)
    expect(dragCrop(start, 'move', 5, 5, SRC)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
    expect(dragCrop(start, 'move', -5, -5, SRC)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 })
  })
})

describe('redimensionar com proporção livre', () => {
  it('cada lado anda sozinho e o oposto fica parado', () => {
    const e = dragCrop(start, 'e', 0.1, 0.3, SRC)
    expect(e.x).toBeCloseTo(start.x, 9)
    expect(e.w).toBeCloseTo(0.6, 9)
    expect(e.y).toBeCloseTo(start.y, 9)
    expect(e.h).toBeCloseTo(start.h, 9)
    const nw = dragCrop(start, 'nw', -0.1, -0.1, SRC)
    expect(nw.x + nw.w).toBeCloseTo(start.x + start.w, 9)
    expect(nw.y + nw.h).toBeCloseTo(start.y + start.h, 9)
    expect(nw.x).toBeCloseTo(0.1, 9)
  })

  it('nunca sai da tela nem fica menor que o mínimo', () => {
    for (const h of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as CropHandle[]) {
      for (const [dx, dy] of [[9, 9], [-9, -9], [9, -9], [-9, 9]] as const) {
        const r = dragCrop(start, h, dx, dy, SRC)
        expect(within(r), `${h} ${dx},${dy}`).toBe(true)
        expect(r.w * SRC.w).toBeGreaterThanOrEqual(cropMinPx(SRC).w - 1e-6)
        expect(r.h * SRC.h).toBeGreaterThanOrEqual(cropMinPx(SRC).h - 1e-6)
      }
    }
  })
})

describe('redimensionar com proporção travada (em pixels da tela gravada)', () => {
  it.each(Object.entries(CROP_LOCKS))('%s: o canto arrastado mantém a proporção e o canto oposto fica parado', (_nome, aspect) => {
    const r = dragCrop(start, 'se', 0.12, 0.02, SRC, aspect)
    expect(aspectPx(r)).toBeCloseTo(aspect, 6)
    expect(r.x).toBeCloseTo(start.x, 9)
    expect(r.y).toBeCloseTo(start.y, 9)
    expect(within(r)).toBe(true)
  })

  it('aresta lateral: a altura acompanha ao redor do centro', () => {
    const r = dragCrop(start, 'e', 0.1, 0, SRC, 16 / 9)
    expect(aspectPx(r)).toBeCloseTo(16 / 9, 6)
    expect(r.y + r.h / 2).toBeCloseTo(start.y + start.h / 2, 9)
    expect(r.x).toBeCloseTo(start.x, 9)
  })

  it('aresta de cima: a largura acompanha ao redor do centro', () => {
    const r = dragCrop(start, 'n', 0, -0.1, SRC, 4 / 3)
    expect(aspectPx(r)).toBeCloseTo(4 / 3, 6)
    expect(r.x + r.w / 2).toBeCloseTo(start.x + start.w / 2, 9)
    expect(r.y + r.h).toBeCloseTo(start.y + start.h, 9)
  })

  it('puxar para fora da tela encolhe até caber, sem perder a proporção', () => {
    for (const h of ['ne', 'nw', 'se', 'sw', 'e', 'w', 'n', 's'] as CropHandle[]) {
      const r = dragCrop(start, h, 3, 3, SRC, 16 / 10)
      expect(within(r), h).toBe(true)
      expect(aspectPx(r), h).toBeCloseTo(16 / 10, 5)
    }
  })

  it('travar a proporção de um recorte que já existe: o maior que cabe, com o mesmo centro', () => {
    const r = lockAspect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, 16 / 9, SRC)
    expect(aspectPx(r)).toBeCloseTo(16 / 9, 9)
    expect(r.x + r.w / 2).toBeCloseTo(0.5, 9)
    expect(r.y + r.h / 2).toBeCloseTo(0.5, 9)
    expect(r.w).toBeCloseTo(0.8, 9)
    expect(within(r)).toBe(true)
  })

  it('o recorte inicial é um retângulo bom dentro da tela', () => {
    expect(within(defaultManualCrop())).toBe(true)
  })
})
