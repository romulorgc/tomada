/** Recorte sugerido por análise de quadros (C1, fallback): onde acaba a barra do navegador, achada na imagem. */
import { describe, expect, it } from 'vitest'
import { MAX_UI_FRACTION, medianFrame, suggestPageRect, type GrayFrame } from '@shared/crop-detect'
import { buildGrayFramesArgs } from '../../src/main/ffmpeg-args'

const W = 480
const H = 270

/** Um quadro cinza: abas (0..tab), barra de endereço (..toolbar), uma linha de 1 px e a página (conteúdo `page(x, y, k)`). */
function frame(k: number, opts: { tab?: number; toolbar?: number; line?: boolean; page?: (x: number, y: number, k: number) => number } = {}): GrayFrame {
  const tab = opts.tab ?? 14
  const toolbar = opts.toolbar ?? 30
  const data = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v: number
      if (y < tab) v = 200 // faixa das abas
      else if (y < toolbar) v = 245 // barra de endereço
      else if (y === toolbar && opts.line !== false) v = 218 // filete
      else v = (opts.page ?? (() => 255))(x, y, k)
      data[y * W + x] = v
    }
  }
  return { w: W, h: H, data }
}

describe('recorte sugerido pela imagem', () => {
  it('acha onde a barra do navegador acaba (a página começa na linha seguinte ao filete)', () => {
    const found = suggestPageRect([frame(0), frame(1), frame(2)])!
    expect(found).not.toBeNull()
    expect(found.row).toBe(31) // filete na linha 30, página a partir da 31
    expect(found.rect.x).toBe(0)
    expect(found.rect.w).toBe(1)
    expect(found.rect.y).toBeCloseTo(31 / H, 6)
    expect(found.rect.h).toBeCloseTo(1 - 31 / H, 6)
    expect(found.confidence).toBeGreaterThan(0.75)
  })

  it('sem o filete também (a barra de endereço direto na página)', () => {
    const found = suggestPageRect([frame(0, { line: false, page: () => 120 })])!
    expect(found.row).toBe(30)
  })

  it('a página que se mexe de quadro a quadro (rolagem, cursor) não vira borda: vale o quadro mediano', () => {
    // o conteúdo muda a cada quadro (um bloco anda pela página) e a barra é a mesma
    const moving = (x: number, y: number, k: number): number => (Math.abs(x - 60 * (k + 1)) < 20 && y > 80 && y < 120 ? 20 : 255)
    const found = suggestPageRect([0, 1, 2, 3, 4].map((k) => frame(k, { page: moving })))!
    expect(found.row).toBe(31)
  })

  it('o cabeçalho do PRÓPRIO site, mais abaixo, não é confundido com a barra do navegador', () => {
    // a página tem uma faixa escura de cabeçalho em 70..100 px de 270 (26% a 37%), bem abaixo do limite da barra do navegador
    const withHeader = (_x: number, y: number): number => (y >= 70 && y < 100 ? 40 : 255)
    const found = suggestPageRect([frame(0, { page: withHeader })])!
    expect(found.row).toBe(31)
    expect(70 / H).toBeGreaterThan(MAX_UI_FRACTION)
  })

  it('sem nenhuma barra à vista (a tela é só uma imagem lisa): nada a sugerir', () => {
    const flat: GrayFrame = { w: W, h: H, data: new Uint8Array(W * H).fill(128) }
    expect(suggestPageRect([flat, flat])).toBeNull()
  })

  it('uma borda que não atravessa a largura não conta (um botão, um ícone)', () => {
    const data = new Uint8Array(W * H).fill(255)
    for (let y = 20; y < 30; y++) for (let x = 40; x < 140; x++) data[y * W + x] = 30 // um bloco escuro pequeno
    expect(suggestPageRect([{ w: W, h: H, data }])).toBeNull()
  })

  it('quadro pequeno demais ou lista vazia: nada', () => {
    expect(suggestPageRect([])).toBeNull()
    expect(suggestPageRect([{ w: 100, h: 60, data: new Uint8Array(6000) }])).toBeNull()
  })

  it('o quadro mediano pega o valor do meio de cada pixel', () => {
    const mk = (v: number): GrayFrame => ({ w: 2, h: 1, data: new Uint8Array([v, 255 - v]) })
    const m = medianFrame([mk(10), mk(200), mk(100)])!
    expect(Array.from(m.data)).toEqual([100, 155])
    expect(medianFrame([])).toBeNull()
  })

  it('argumentos do ffmpeg: caminho absoluto, N quadros em cinza crus, altura pedida', () => {
    const args = buildGrayFramesArgs({ input: 'C:\\x\\screen.mp4', output: 'C:\\x\\q.gray', count: 8, durationMs: 40_000, width: 960, height: 540 })
    expect(args).toContain('-frames:v')
    expect(args[args.indexOf('-frames:v') + 1]).toBe('8')
    expect(args.join(' ')).toContain('scale=960:540')
    expect(args.join(' ')).toContain('format=gray')
    expect(args).toContain('rawvideo')
    expect(() => buildGrayFramesArgs({ input: 'relativo.mp4', output: 'C:\\x\\q.gray', count: 8, durationMs: 1000, width: 960, height: 540 })).toThrow()
    expect(() => buildGrayFramesArgs({ input: '-i', output: 'C:\\x\\q.gray', count: 8, durationMs: 1000, width: 960, height: 540 })).toThrow()
  })
})
