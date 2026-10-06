/**
 * Acabamento A: gravação de TELA com um navegador à frente. O piloto recorta para a página (sem abas, barra de endereço nem barra
 * de tarefas) quando o navegador ocupa a maior parte da gravação; se o usuário trocar de programa no meio, o trecho volta à tela
 * inteira pela transição do C1. Sem navegador (ou só de passagem), nada muda.
 */
import { describe, expect, it } from 'vitest'
import { AUTO_CROP_MIN_SHARE, FULL_RECT, browserPageShare, resolveScreenCrop } from '@shared/crop'
import type { ContentRectSample, Rect } from '@shared/types'

const SRC = { w: 1920, h: 1080 }
/** Chrome maximizado em 1080p: a página sem abas nem barra de endereço e sem a barra de tarefas do Windows. */
const PAGE: Rect = { x: 0, y: 128 / 1080, w: 1, h: 904 / 1080 }
const at = (t: number, r: Rect): ContentRectSample => ({ t, x: r.x, y: r.y, w: r.w, h: r.h })

describe('fração da gravação com a página do navegador à frente', () => {
  it('navegador o tempo todo: 1', () => {
    expect(browserPageShare([at(0, { ...PAGE, x: 0.01, w: 0.98 })], SRC, 18_000)).toBe(1)
  })

  it('outro programa no início e no fim: só conta o trecho do navegador', () => {
    const samples = [at(0, FULL_RECT), at(3000, { ...PAGE, x: 0.01, w: 0.98 }), at(15_000, FULL_RECT)]
    expect(browserPageShare(samples, SRC, 18_000)).toBeCloseTo(12 / 18, 6)
  })

  it('tela cheia do navegador (F11) ou nenhum programa medido não contam', () => {
    expect(browserPageShare([at(0, FULL_RECT)], SRC, 18_000)).toBe(0)
    expect(browserPageShare([], SRC, 18_000)).toBe(0)
    expect(browserPageShare([at(0, { ...PAGE, x: 0.01, w: 0.98 })], SRC, 0)).toBe(0)
  })

  it('o limite do piloto é a metade da gravação', () => {
    expect(AUTO_CROP_MIN_SHARE).toBe(0.5)
    const samples = [at(0, FULL_RECT), at(9000, { ...PAGE, x: 0.01, w: 0.98 })]
    expect(browserPageShare(samples, SRC, 18_000)).toBeGreaterThanOrEqual(AUTO_CROP_MIN_SHARE)
    expect(browserPageShare([at(0, FULL_RECT), at(9100, { ...PAGE, x: 0.01, w: 0.98 })], SRC, 18_000)).toBeLessThan(AUTO_CROP_MIN_SHARE)
  })
})

describe('o recorte automático numa gravação de tela do usuário (Chrome maximizado, 18 s)', () => {
  // página medida (um pouco menor que a tela por causa das bordas da janela), com 3 s em outro programa no meio
  const page = { ...PAGE, x: 8 / 1920, w: 1904 / 1920 }
  const samples = [at(0, page), at(6000, FULL_RECT), at(9000, page)]
  const tl = resolveScreenCrop({ mode: 'auto' }, samples, SRC, 18_000)!

  it('no navegador: só a página, sem abas, barra de endereço e barra de tarefas', () => {
    const r = tl.at(3000)
    expect(r.y * SRC.h).toBeGreaterThanOrEqual(128 - 1e-6)
    expect((r.y + r.h) * SRC.h).toBeLessThanOrEqual(128 + 904 + 1e-6)
    expect(r.x * SRC.w).toBeGreaterThanOrEqual(8 - 1e-6)
  })

  it('em outro programa: volta à tela inteira (na proporção da página), com a barra de tarefas fora', () => {
    const r = tl.at(7500)
    expect(r.w * SRC.w).toBeGreaterThan(1900) // a largura da tela toda
    expect(r.h * SRC.h).toBeGreaterThan(904) // mais alta que a página: mostra o programa, não a página
  })

  it('a troca é uma transição suave (sem salto de um quadro para o outro)', () => {
    let maxStepPx = 0
    for (let t = 5800; t < 6600; t += 16) {
      const a = tl.at(t), b = tl.at(t + 16)
      maxStepPx = Math.max(maxStepPx, Math.abs(b.y - a.y) * SRC.h, Math.abs(b.h - a.h) * SRC.h)
    }
    expect(maxStepPx).toBeLessThan(40)
  })
})
