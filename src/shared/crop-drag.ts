/**
 * Arrastar e redimensionar o retângulo do recorte manual (C1) sobre a prévia da tela inteira. Código puro: sem DOM, sem Node.
 *
 * Tudo NORMALIZADO 0..1 na tela gravada; as proporções travadas (16:9, 16:10, 4:3) valem em PIXELS da tela gravada (uma tela de
 * 1920×1080 com um retângulo de 0,5 × 0,5 de largura e altura não é quadrado: é 960×540).
 */
import type { Rect, Size } from './types'

export type CropHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** As proporções travadas que o editor oferece (`null` = livre). */
export const CROP_LOCKS = { '16:9': 16 / 9, '16:10': 16 / 10, '4:3': 4 / 3 } as const
export type CropLockId = keyof typeof CROP_LOCKS

/** Menor lado do recorte, em pixels da tela gravada (menor que isso não serve para nada). */
export const MIN_CROP_PX = 64

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * Move ou redimensiona `start` pelo deslocamento (`dx`, `dy`, normalizados) do ponteiro. `aspect` (largura/altura em px) trava a
 * proporção: o canto oposto (ou a aresta oposta) fica no lugar e o retângulo nunca sai da tela nem fica menor que `MIN_CROP_PX`.
 */
export function dragCrop(start: Rect, handle: CropHandle, dx: number, dy: number, sourcePx: Size, aspect: number | null = null): Rect {
  if (handle === 'move') {
    return { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) }
  }
  const minW = MIN_CROP_PX / sourcePx.w
  const minH = MIN_CROP_PX / sourcePx.h
  let x0 = start.x
  let y0 = start.y
  let x1 = start.x + start.w
  let y1 = start.y + start.h
  if (handle.includes('w')) x0 = clamp(x0 + dx, 0, x1 - minW)
  if (handle.includes('e')) x1 = clamp(x1 + dx, x0 + minW, 1)
  if (handle.includes('n')) y0 = clamp(y0 + dy, 0, y1 - minH)
  if (handle.includes('s')) y1 = clamp(y1 + dy, y0 + minH, 1)
  if (aspect === null) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }

  // proporção travada: o tamanho pedido pelo ponteiro vira o maior retângulo da proporção, preso ao lado/canto que não se mexe
  const ratio = aspect * (sourcePx.h / sourcePx.w) // largura normalizada ÷ altura normalizada
  const asked = { w: x1 - x0, h: y1 - y0 }
  const horizontal = handle === 'e' || handle === 'w'
  const vertical = handle === 'n' || handle === 's'
  // quem manda no tamanho: a aresta que se mexeu; no canto, a dimensão em que o ponteiro foi mais longe
  let w: number
  let h: number
  if (horizontal) {
    w = asked.w
    h = w / ratio
  } else if (vertical) {
    h = asked.h
    w = h * ratio
  } else {
    const byW = asked.w / ratio
    if (Math.abs(asked.w - start.w) * 1 >= Math.abs(asked.h - start.h) * ratio) {
      w = asked.w
      h = byW
    } else {
      h = asked.h
      w = h * ratio
    }
  }
  // ponto que fica parado
  const anchorX = handle.includes('w') ? start.x + start.w : handle.includes('e') ? start.x : start.x + start.w / 2
  const anchorY = handle.includes('n') ? start.y + start.h : handle.includes('s') ? start.y : start.y + start.h / 2
  const growsLeft = handle.includes('w')
  const growsRight = handle.includes('e')
  const growsUp = handle.includes('n')
  const growsDown = handle.includes('s')
  // o quanto cabe a partir da âncora
  const roomX = growsLeft ? anchorX : growsRight ? 1 - anchorX : 2 * Math.min(anchorX, 1 - anchorX)
  const roomY = growsUp ? anchorY : growsDown ? 1 - anchorY : 2 * Math.min(anchorY, 1 - anchorY)
  const scale = Math.min(1, roomX / w, roomY / h)
  w *= scale
  h *= scale
  // não menor que o mínimo (mantendo a proporção)
  const grow = Math.max(1, minW / w, minH / h)
  w = Math.min(roomX, w * grow)
  h = w / ratio
  const x = growsLeft ? anchorX - w : growsRight ? anchorX : anchorX - w / 2
  const y = growsUp ? anchorY - h : growsDown ? anchorY : anchorY - h / 2
  return { x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - h), w, h }
}

/** O maior retângulo da proporção `aspect` (px) que cabe em `r`, com o mesmo centro (ao travar a proporção de um recorte que já existe). */
export function lockAspect(r: Rect, aspect: number, sourcePx: Size): Rect {
  const ratio = aspect * (sourcePx.h / sourcePx.w)
  let w = r.w
  let h = w / ratio
  if (h > r.h) {
    h = r.h
    w = h * ratio
  }
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h }
}

/** O retângulo inicial de um recorte manual quando não há nenhum: a tela com uma margem (para a pessoa ver o que está recortando). */
export function defaultManualCrop(): Rect {
  return { x: 0.05, y: 0.08, w: 0.9, h: 0.84 }
}
