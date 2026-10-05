import { describe, expect, it } from 'vitest'
import {
  MAX_PX_PER_MS,
  clampPxPerMs,
  clampScroll,
  contentWidthPx,
  createTimeMap,
  fitPxPerMs,
  msToPx,
  pxToMs,
  rulerLabel,
  rulerStepMs,
  rulerTicks,
  scrollToReveal,
  snapBlock,
  snapTime,
  visibleDisplayRange,
  zoomAround
} from '@shared/timeline-view'
import { keptRanges } from '@shared/timeline'

const kept = keptRanges(20_000, [
  { start: 2000, end: 5000, enabled: true },
  { start: 9000, end: 10_000, enabled: true }
])

describe('TimeMap', () => {
  it('com os cortes à mostra o eixo é o tempo de origem', () => {
    const m = createTimeMap({ durationMs: 20_000, kept, hideCuts: false })
    expect(m.totalMs).toBe(20_000)
    expect(m.toDisplay(7000)).toBe(7000)
    expect(m.fromDisplay(7000)).toBe(7000)
  })
  it('escondendo os cortes o eixo colapsa para o tempo de saída (ida e volta)', () => {
    const m = createTimeMap({ durationMs: 20_000, kept, hideCuts: true })
    expect(m.totalMs).toBe(16_000)
    expect(m.toDisplay(1000)).toBe(1000)
    expect(m.toDisplay(5000)).toBe(2000) // logo depois do primeiro corte
    expect(m.toDisplay(10_000)).toBe(6000)
    expect(m.fromDisplay(2000)).toBe(5000)
    expect(m.fromDisplay(6500)).toBe(10_500)
    for (const t of [0, 1999, 5000, 7777, 10_000, 19_999]) expect(m.fromDisplay(m.toDisplay(t))).toBeCloseTo(t, 6)
  })
  it('um instante dentro do corte cai no ponto de corte da saída', () => {
    const m = createTimeMap({ durationMs: 20_000, kept, hideCuts: true })
    expect(m.toDisplay(3500)).toBe(m.toDisplay(2000))
  })
})

describe('pixels e tempo', () => {
  it('ida e volta e conversões simples', () => {
    expect(msToPx(2000, 0.1)).toBe(200)
    expect(pxToMs(200, 0.1)).toBe(2000)
    expect(pxToMs(msToPx(1234, 0.37), 0.37)).toBeCloseTo(1234, 6)
  })
  it('fitPxPerMs faz o eixo caber na largura (com respiro)', () => {
    const px = fitPxPerMs(1024, 20_000)
    expect(contentWidthPx(20_000, px)).toBeLessThanOrEqual(1024)
    expect(fitPxPerMs(0, 20_000)).toBeGreaterThan(0)
  })
  it('clampPxPerMs fica entre "cabe tudo" e o máximo', () => {
    const lo = fitPxPerMs(1000, 20_000)
    expect(clampPxPerMs(0.00001, 1000, 20_000)).toBeCloseTo(lo, 9)
    expect(clampPxPerMs(5, 1000, 20_000)).toBe(MAX_PX_PER_MS)
    expect(clampPxPerMs(0.1, 1000, 20_000)).toBe(0.1)
  })
  it('clampScroll não passa do conteúdo', () => {
    expect(clampScroll(-50, 0.1, 500, 20_000)).toBe(0)
    expect(clampScroll(99_999, 0.1, 500, 20_000)).toBe(contentWidthPx(20_000, 0.1) - 500)
    expect(clampScroll(100, 0.01, 5000, 20_000)).toBe(0) // cabe tudo: não rola
  })
  it('zoomAround mantém o instante sob o ponteiro', () => {
    const before = { pxPerMs: 0.05, scrollLeft: 1200, anchorPx: 300, viewportPx: 800, totalMs: 60_000 }
    const anchorMs = (before.scrollLeft + before.anchorPx) / before.pxPerMs
    const after = zoomAround({ ...before, factor: 2 })
    expect(after.pxPerMs).toBeCloseTo(0.1, 9)
    expect((after.scrollLeft + before.anchorPx) / after.pxPerMs).toBeCloseTo(anchorMs, 3)
    const out = zoomAround({ ...before, factor: 0.5 })
    expect((out.scrollLeft + before.anchorPx) / out.pxPerMs).toBeCloseTo(anchorMs, 3)
  })
  it('zoomAround respeita o teto e o piso do zoom', () => {
    const z = zoomAround({ pxPerMs: 0.4, factor: 10, anchorPx: 100, scrollLeft: 0, viewportPx: 800, totalMs: 60_000 })
    expect(z.pxPerMs).toBe(MAX_PX_PER_MS)
    const f = zoomAround({ pxPerMs: 0.02, factor: 0.001, anchorPx: 100, scrollLeft: 300, viewportPx: 800, totalMs: 20_000 })
    expect(f.pxPerMs).toBeCloseTo(fitPxPerMs(800, 20_000), 9)
    expect(f.scrollLeft).toBe(0)
  })
  it('scrollToReveal só rola quando o instante sai da área visível', () => {
    const base = { pxPerMs: 0.1, viewportPx: 400, totalMs: 60_000 }
    expect(scrollToReveal({ ...base, ms: 2000, scrollLeft: 100 })).toBe(100) // 200 px: visível
    expect(scrollToReveal({ ...base, ms: 9000, scrollLeft: 100 })).toBe(900 - 400 + 48)
    expect(scrollToReveal({ ...base, ms: 500, scrollLeft: 300 })).toBe(2)
  })
  it('visibleDisplayRange', () => {
    expect(visibleDisplayRange(200, 400, 0.1)).toEqual({ from: 2000, to: 6000 })
  })
})

describe('régua', () => {
  it('escolhe o menor passo redondo que deixa os rótulos afastados', () => {
    expect(rulerStepMs(0.05)).toBe(2000) // 100 px por 2 s
    expect(rulerStepMs(0.5)).toBe(200)
    expect(rulerStepMs(0.005)).toBe(30_000) // 15 s só dão 75 px: falta para os 80 px
    expect(rulerStepMs(0.0001)).toBeGreaterThanOrEqual(600_000)
  })
  it('rótulos em m:ss, com frações abaixo de 1 s', () => {
    expect(rulerLabel(0, 1000)).toBe('0:00')
    expect(rulerLabel(65_000, 5000)).toBe('1:05')
    expect(rulerLabel(3_725_000, 5000)).toBe('1:02:05')
    expect(rulerLabel(1500, 500)).toBe('0:01.5')
    expect(rulerLabel(1250, 50)).toBe('0:01.25')
  })
  it('ticks: principais com rótulo, secundários sem', () => {
    const ticks = rulerTicks(0.05, 0, 10_000)
    const majors = ticks.filter((t) => t.major)
    expect(majors.map((t) => t.ms)).toEqual([0, 2000, 4000, 6000, 8000, 10_000])
    expect(majors.every((t) => t.label !== null)).toBe(true)
    expect(ticks.filter((t) => !t.major).every((t) => t.label === null)).toBe(true)
    expect(ticks.some((t) => !t.major)).toBe(true)
    // começa no tick anterior à área visível
    expect(rulerTicks(0.05, 5000, 7000)[0]!.ms).toBeLessThanOrEqual(5000)
  })
})

describe('ímã', () => {
  it('gruda no candidato mais próximo dentro do alcance em PIXELS', () => {
    expect(snapTime(1003, [1000, 2000], 8, 0.1)).toEqual({ ms: 1000, target: 1000 })
    expect(snapTime(1100, [1000, 2000], 8, 0.1)).toEqual({ ms: 1100, target: null }) // 10 px: fora
    // o mesmo alcance em pixels vale mais milissegundos com menos zoom
    expect(snapTime(1100, [1000], 8, 0.01)).toEqual({ ms: 1000, target: 1000 })
  })
  it('escolhe o mais perto entre dois', () => {
    expect(snapTime(1400, [1000, 1500], 80, 0.1)).toEqual({ ms: 1500, target: 1500 })
  })
  it('snapBlock gruda a borda que chegou mais perto', () => {
    expect(snapBlock(1990, 3500, [2000, 9000], 8, 0.1)).toEqual({ delta: 10, target: 2000 })
    expect(snapBlock(1000, 4996, [5000], 8, 0.1)).toEqual({ delta: 4, target: 5000 })
    expect(snapBlock(1000, 3000, [9000], 8, 0.1)).toEqual({ delta: 0, target: null })
  })
})
