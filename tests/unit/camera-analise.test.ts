import { describe, expect, it } from 'vitest'
// @ts-expect-error módulo .mjs de script (sem tipos): a análise do medidor da câmera real
import { gapStats, laplacianVariance, meanLuma } from '../../scripts/medir-camera/analise.mjs'

describe('análise do medidor da câmera real', () => {
  it('nitidez: imagem lisa vale 0, tabuleiro fino vale muito, borravação derruba', () => {
    const w = 64
    const h = 64
    const flat = new Uint8Array(w * h).fill(128)
    const board = new Uint8Array(w * h).map((_, i) => ((i % w) + Math.floor(i / w)) % 2 === 0 ? 40 : 220)
    // o mesmo tabuleiro depois de uma média 2×2 (o que um codificador mole faz)
    const soft = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) soft[y * w + x] = Math.round((board[y * w + x]! + board[y * w + Math.min(w - 1, x + 1)]! + board[Math.min(h - 1, y + 1) * w + x]! + board[Math.min(h - 1, y + 1) * w + Math.min(w - 1, x + 1)]!) / 4)
    expect(laplacianVariance(flat, w, h)).toBe(0)
    expect(laplacianVariance(board, w, h)).toBeGreaterThan(500_000)
    expect(laplacianVariance(soft, w, h)).toBeLessThan(laplacianVariance(board, w, h) / 10)
  })

  it('luma média', () => {
    expect(meanLuma(new Uint8Array([0, 100, 200, 100]))).toBe(100)
  })

  it('qps efetivos contam os buracos: 150 quadros em 10 s a 15 qps, intervalos de ~66 ms', () => {
    const pts = Array.from({ length: 150 }, (_, i) => (i * 1000) / 15 / 1000)
    const g = gapStats(pts)
    expect(g.frames).toBe(150)
    expect(g.fpsEffective).toBeCloseTo(15, 1)
    expect(g.gapMedianMs).toBeCloseTo(66.67, 1)
    expect(g.over50ms).toBe(149)
  })

  it('um buraco de 300 ms no meio de 30 qps aparece nos maiores intervalos e baixa a taxa efetiva', () => {
    const pts: number[] = []
    for (let i = 0; i < 100; i++) pts.push(i / 30)
    for (let i = 100; i < 200; i++) pts.push(i / 30 + 0.3)
    const g = gapStats(pts)
    expect(g.gapMaxMs).toBeCloseTo(33.3 + 300, 0)
    expect(g.over100ms).toBe(1)
    expect(g.fpsEffective).toBeLessThan(30)
  })
})
