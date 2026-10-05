/**
 * Geometria 2D usada pelo rastreador, pela cena e pelo motor de render.
 * Código puro: sem DOM, sem Node.
 */
import type { Point, Rect, Size } from './types'

export type NormalizedPoint = {
  /** 0..1 dentro da área, já com clamp. */
  x: number
  y: number
  /** true quando o ponto original estava fora da área. */
  outside: boolean
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Ponto em pixels FÍSICOS da tela → coordenada 0..1 dentro da área capturada.
 * A área é [x, x+w) × [y, y+h): a borda direita/inferior já é "fora".
 * Fora da área, x/y recebem clamp e `outside` fica true.
 * Retângulo degenerado (w ou h ≤ 0, NaN) → {0, 0, outside: true}.
 */
export function normalizePoint(pointPx: Point, captureRectPx: Rect): NormalizedPoint {
  const { x: rx, y: ry, w, h } = captureRectPx
  if (!(w > 0) || !(h > 0) || !Number.isFinite(pointPx.x) || !Number.isFinite(pointPx.y)) {
    return { x: 0, y: 0, outside: true }
  }
  const outside = pointPx.x < rx || pointPx.y < ry || pointPx.x >= rx + w || pointPx.y >= ry + h
  return {
    x: clamp01((pointPx.x - rx) / w),
    y: clamp01((pointPx.y - ry) / h),
    outside
  }
}

/** Maior retângulo com a proporção de `src` que CABE dentro de `box`, centralizado. */
export function fitRect(src: Size, box: Rect): Rect {
  return scaleToBox(src, box, Math.min)
}

/** Menor retângulo com a proporção de `src` que COBRE `box`, centralizado (pode vazar). */
export function coverRect(src: Size, box: Rect): Rect {
  return scaleToBox(src, box, Math.max)
}

function scaleToBox(src: Size, box: Rect, pick: (a: number, b: number) => number): Rect {
  if (!(src.w > 0) || !(src.h > 0)) return { x: box.x, y: box.y, w: 0, h: 0 }
  const scale = pick(box.w / src.w, box.h / src.h)
  const w = src.w * scale
  const h = src.h * scale
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
}
