/**
 * Recorte SUGERIDO por análise de quadros (C1, fallback): quando o rastreador não mediu a página (Firefox, ou um navegador que o
 * Tomada não reconhece), o editor oferece "Sugerir recorte": procura a borda de baixo da barra do navegador (abas, endereço,
 * favoritos), uma linha horizontal que atravessa a largura toda e fica estável. É SÓ uma sugestão: o editor mostra o retângulo
 * sobre a tela inteira para a pessoa conferir e ajustar. Código puro: sem DOM, sem Node.
 *
 * Os quadros chegam em cinza (um byte por pixel). Usa o quadro MEDIANO no tempo (o que muda de quadro a quadro, a página
 * rolando ou o cursor, não vira borda) e procura, no alto do quadro, a linha MAIS BAIXA em que quase toda a largura muda de tom
 * de uma linha para a seguinte.
 */
import type { Rect } from './types'

export type GrayFrame = { w: number; h: number; data: Uint8Array }

/** A barra do navegador não passa desta fração da altura do quadro (1080p com favoritos: ~15%). */
export const MAX_UI_FRACTION = 0.17
/** Diferença de tom (0..255) entre duas linhas seguidas para valer como borda. */
export const EDGE_STEP = 8
/** Fração das colunas em que a borda precisa aparecer. */
export const EDGE_COVERAGE = 0.75
/** O recorte sugerido tem de ser pelo menos esta fração da altura. */
const MIN_PAGE_HEIGHT = 0.5

export type CropSuggestion = {
  rect: Rect
  /** Fração das colunas em que a borda apareceu (0,75 a 1). */
  confidence: number
  /** A linha (px do quadro analisado) da primeira linha da página. */
  row: number
}

/** O quadro mediano (pixel a pixel). */
export function medianFrame(frames: readonly GrayFrame[]): GrayFrame | null {
  const first = frames[0]
  if (!first) return null
  const same = frames.filter((f) => f.w === first.w && f.h === first.h && f.data.length === first.w * first.h)
  const n = same.length
  const out = new Uint8Array(first.w * first.h)
  const col = new Uint8Array(n)
  for (let i = 0; i < out.length; i++) {
    for (let k = 0; k < n; k++) col[k] = same[k]!.data[i]!
    col.sort()
    out[i] = col[n >> 1]!
  }
  return { w: first.w, h: first.h, data: out }
}

/** A sugestão de recorte (ou `null` se não há uma barra de navegador à vista). */
export function suggestPageRect(frames: readonly GrayFrame[]): CropSuggestion | null {
  const m = medianFrame(frames)
  if (!m || m.h < 120 || m.w < 160) return null
  const limit = Math.floor(m.h * MAX_UI_FRACTION)
  const x0 = Math.floor(m.w * 0.02)
  const x1 = m.w - x0
  let best = -1
  let bestCoverage = 0
  for (let y = 1; y <= limit; y++) {
    let hits = 0
    for (let x = x0; x < x1; x++) {
      if (Math.abs(m.data[y * m.w + x]! - m.data[(y - 1) * m.w + x]!) >= EDGE_STEP) hits++
    }
    const coverage = hits / (x1 - x0)
    // a linha mais baixa vence (abas → endereço → favoritos → página)
    if (coverage >= EDGE_COVERAGE) {
      best = y
      bestCoverage = coverage
    }
  }
  if (best < 0) return null
  const top = best / m.h
  if (1 - top < MIN_PAGE_HEIGHT) return null
  return { rect: { x: 0, y: top, w: 1, h: 1 - top }, confidence: bestCoverage, row: best }
}
