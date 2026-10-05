import { describe, expect, it } from 'vitest'
import { coverRect, fitRect, normalizePoint } from '@shared/geometry'

describe('normalizePoint', () => {
  // Monitor externo posicionado acima do principal (y negativo), 2560×1080 físicos.
  const rect = { x: 0, y: -1080, w: 2560, h: 1080 }

  it('centro da área = 0,5 / 0,5', () => {
    expect(normalizePoint({ x: 1280, y: -540 }, rect)).toEqual({ x: 0.5, y: 0.5, outside: false })
  })

  it('canto superior esquerdo é 0,0 e está dentro', () => {
    expect(normalizePoint({ x: 0, y: -1080 }, rect)).toEqual({ x: 0, y: 0, outside: false })
  })

  it('último pixel está dentro; a borda direita/inferior já é fora', () => {
    const last = normalizePoint({ x: 2559, y: -1 }, rect)
    expect(last.outside).toBe(false)
    expect(last.x).toBeCloseTo(2559 / 2560, 10)
    expect(normalizePoint({ x: 2560, y: -1 }, rect).outside).toBe(true)
    expect(normalizePoint({ x: 100, y: 0 }, rect).outside).toBe(true)
  })

  it('fora da área: clamp em 0..1 e flag', () => {
    expect(normalizePoint({ x: -50, y: -2000 }, rect)).toEqual({ x: 0, y: 0, outside: true })
    expect(normalizePoint({ x: 9999, y: 500 }, rect)).toEqual({ x: 1, y: 1, outside: true })
  })

  it('janela com origem fora do zero (pixels físicos do Win32)', () => {
    const win = { x: 400, y: 200, w: 800, h: 600 }
    expect(normalizePoint({ x: 800, y: 500 }, win)).toEqual({ x: 0.5, y: 0.5, outside: false })
  })

  it('retângulo degenerado ou ponto inválido não explode', () => {
    expect(normalizePoint({ x: 1, y: 1 }, { x: 0, y: 0, w: 0, h: 100 })).toEqual({ x: 0, y: 0, outside: true })
    expect(normalizePoint({ x: Number.NaN, y: 1 }, rect)).toEqual({ x: 0, y: 0, outside: true })
  })
})

describe('fitRect / coverRect', () => {
  const box = { x: 100, y: 50, w: 1000, h: 500 }

  it('fit de fonte mais larga que a caixa: encaixa na largura, sobra em cima/baixo', () => {
    const r = fitRect({ w: 2000, h: 500 }, box) // 4:1 dentro de 2:1
    expect(r).toEqual({ x: 100, y: 175, w: 1000, h: 250 })
  })

  it('fit de fonte mais alta que a caixa: encaixa na altura, sobra dos lados', () => {
    const r = fitRect({ w: 500, h: 500 }, box)
    expect(r).toEqual({ x: 350, y: 50, w: 500, h: 500 })
  })

  it('fit da mesma proporção ocupa a caixa toda', () => {
    const r = fitRect({ w: 1920, h: 960 }, box)
    expect(r.x).toBeCloseTo(box.x, 6)
    expect(r.y).toBeCloseTo(box.y, 6)
    expect(r.w).toBeCloseTo(box.w, 6)
    expect(r.h).toBeCloseTo(box.h, 6)
  })

  it('cover de fonte mais larga: cobre a altura e vaza dos lados (centralizado)', () => {
    const r = coverRect({ w: 2000, h: 500 }, box)
    expect(r).toEqual({ x: -400, y: 50, w: 2000, h: 500 })
  })

  it('cover de fonte mais alta: cobre a largura e vaza em cima/baixo', () => {
    const r = coverRect({ w: 500, h: 500 }, box)
    expect(r).toEqual({ x: 100, y: -200, w: 1000, h: 1000 })
  })

  it('fonte vazia devolve retângulo vazio na origem da caixa', () => {
    expect(fitRect({ w: 0, h: 10 }, box)).toEqual({ x: 100, y: 50, w: 0, h: 0 })
    expect(coverRect({ w: 10, h: 0 }, box)).toEqual({ x: 100, y: 50, w: 0, h: 0 })
  })

  it('vertical 9:16 de uma tela 16:9 (recorte do foco)', () => {
    const r = coverRect({ w: 1920, h: 1080 }, { x: 0, y: 0, w: 1080, h: 1920 })
    expect(r.h).toBe(1920)
    expect(r.w).toBeCloseTo(1920 * (1920 / 1080), 6)
    expect(r.x).toBeCloseTo((1080 - r.w) / 2, 6)
  })
})
