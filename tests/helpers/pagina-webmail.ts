/**
 * Uma página sintética de webmail em tons de cinza (nada de dado do usuário): faixa de abas no alto, barra de ícones colada à esquerda,
 * barra lateral de navegação com rótulos curtos, coluna central de texto e a barra de tarefas embaixo. É a forma da gravação real em
 * que a janela quadrada do 9:16 saía deslocada: a coluna do e-mail é estreita e fica no meio, o cursor para na borda esquerda dela.
 */
import { CONTENT_GRID, contentCellsFromGray, type ContentSample } from '@shared/content-map'

export const FRAME = { w: 640, h: 360 } as const

/** Onde cada coisa fica (fração da tela). A coluna do e-mail é `COLUMN`. */
export const PAGE = {
  tabs: { x0: 0, x1: 1, y0: 0, y1: 0.04 },
  taskbar: { x0: 0, x1: 1, y0: 0.96, y1: 1 },
  rail: { x0: 0, x1: 0.065, y0: 0.12, y1: 0.7 },
  sidebar: { x0: 0.085, x1: 0.2, y0: 0.18, y1: 0.62 },
  /** A coluna do e-mail: 630 px de uma tela de 1920. */
  column: { x0: 0.406, x1: 0.734, y0: 0.12, y1: 0.9 }
} as const
export const COLUMN = { start: PAGE.column.x0, end: PAGE.column.x1 }

type Box = { x0: number; x1: number; y0: number; y1: number }

/** Linhas de "texto": barras de 4 px a cada `pitch` px, com o brilho alternando de 2 em 2 px (contorno de letra). */
function paintText(gray: Uint8Array, box: Box, pitch: number, lineH = 4): void {
  const { w, h } = FRAME
  for (let y = Math.floor(box.y0 * h); y < Math.floor(box.y1 * h); y += pitch) {
    for (let yy = y; yy < Math.min(h, y + lineH); yy++) {
      for (let x = Math.floor(box.x0 * w); x < Math.min(w, Math.floor(box.x1 * w)); x++) gray[yy * w + x] = (x >> 1) % 2 === 0 ? 24 : 236
    }
  }
}

export type PageOptions = {
  /** A coluna do e-mail (padrão `PAGE.column`); `null` = a lista de e-mails, de ponta a ponta. */
  column?: Box | null
  /** Sem a faixa de abas e a barra de tarefas (a página já recortada). */
  bare?: boolean
}

/** O quadro cinza da página: fundo branco; o que é texto fica com bordas, o resto fica liso. */
export function pageGray(opts: PageOptions = {}): Uint8Array {
  const gray = new Uint8Array(FRAME.w * FRAME.h).fill(250)
  if (!opts.bare) {
    paintText(gray, PAGE.tabs, 9, 5)
    paintText(gray, PAGE.taskbar, 9, 5)
  }
  paintText(gray, PAGE.rail, 14, 8)
  paintText(gray, PAGE.sidebar, 22, 3)
  if (opts.column === null) paintText(gray, { x0: 0.22, x1: 0.96, y0: 0.12, y1: 0.9 }, 10)
  else paintText(gray, opts.column ?? PAGE.column, 10)
  return gray
}

/** A amostra do mapa de conteúdo dessa página no instante `t`. */
export function pageSample(t: number, opts: PageOptions = {}): ContentSample {
  return { t, cols: CONTENT_GRID.cols, rows: CONTENT_GRID.rows, cells: contentCellsFromGray(pageGray(opts), FRAME.w, FRAME.h) }
}
