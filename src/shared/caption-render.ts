/**
 * DESENHO das legendas e do título de gancho no Canvas 2D (M4a). Roda no mesmo `renderFrame` da prévia e da exportação:
 *
 *  - o layout do texto (quebra em até 2 linhas equilibradas, encolher para caber) é calculado UMA vez por página e
 *    fica em cache (`RenderCache.captionLayouts`); por quadro só se desenha;
 *  - contorno por `strokeText` de traço duplo ANTES do preenchimento (o contorno aparece só por fora, sem encher o furo das
 *    letras) e sombra dura por um segundo traço deslocado: nenhum `shadowBlur` por quadro;
 *  - a palavra acesa leva o "pop" (escala em torno do próprio centro) e, no Karaokê, uma pílula.
 *
 * Só desenha com as fontes carregadas (`cache.fontsReady`): melhor sem legenda por um instante do que com a fonte errada.
 * Código puro (fala com o canvas por interfaces estruturais): sem DOM, sem Node.
 */
import { inkMarginY, type CaptionRenderStyle, type HookRenderStyle } from './caption-style'
import type { Ctx2D, RenderCache } from './render'
import type { SceneCaptions, SceneHook } from './scene'

type LayoutWord = { text: string; idx: number; x: number; w: number }
type LayoutLine = { words: LayoutWord[]; w: number }

export type TextLayout = {
  fontPx: number
  lines: LayoutLine[]
  /** Largura da linha mais larga e altura total (linhas × altura de linha), em px. */
  blockW: number
  blockH: number
  lineH: number
}

const CAP_CENTER = 0.35 // o centro visual das maiúsculas fica ~0,35 em acima da linha de base

function fontOf(weight: number, px: number, family: string): string {
  return `${weight} ${px.toFixed(2)}px ${family}`
}

/** Onde quebrar `widths` (larguras das palavras) em até `maxLines` linhas dentro de `maxW`; `null` se não couber. */
export function breakWords(widths: readonly number[], space: number, maxW: number, maxLines: number): number[] | null {
  const n = widths.length
  const span = (a: number, b: number): number => {
    let sum = 0
    for (let k = a; k < b; k++) sum += widths[k]!
    return sum + Math.max(0, b - a - 1) * space
  }
  if (n === 0) return []
  if (span(0, n) <= maxW) return [n]
  if (maxLines >= 2 && n >= 2) {
    let best = -1
    let bestScore = Infinity
    for (let s = 1; s < n; s++) {
      const a = span(0, s)
      const b = span(s, n)
      if (a > maxW || b > maxW) continue
      const score = Math.max(a, b) + Math.abs(a - b) * 0.05
      if (score < bestScore) {
        bestScore = score
        best = s
      }
    }
    if (best > 0) return [best, n - best]
  }
  return null
}

/** Quebra gulosa sem limite de linhas: último recurso quando nem na fonte mínima cabe em 2 linhas. */
function greedy(widths: readonly number[], space: number, maxW: number): number[] {
  const out: number[] = []
  let count = 0
  let w = 0
  for (const cw of widths) {
    const next = count === 0 ? cw : w + space + cw
    if (count > 0 && next > maxW) {
      out.push(count)
      count = 1
      w = cw
    } else {
      count++
      w = next
    }
  }
  if (count > 0) out.push(count)
  return out
}

/** O layout de um texto: encolhe a fonte (até o mínimo) até caber em `maxLines` linhas de `maxW`. */
export function layoutText(
  ctx: Ctx2D,
  texts: readonly string[],
  o: { family: string; weight: number; fontPx: number; minFontPx: number; lineHeight: number; maxW: number; maxLines: number; gap?: number }
): TextLayout {
  let px = o.fontPx
  for (let attempt = 0; attempt < 12; attempt++) {
    ctx.font = fontOf(o.weight, px, o.family)
    const widths = texts.map((t) => ctx.measureText(t).width)
    // com contorno grosso o espaço natural não basta: os contornos de duas palavras quase se tocariam
    const space = ctx.measureText(' ').width + (o.gap ?? 0) * (px / o.fontPx)
    const counts = breakWords(widths, space, o.maxW, o.maxLines)
    const widest = Math.max(0, ...widths)
    // uma palavra sozinha mais larga que a caixa não cabe nem na fonte mínima: encolhe só o bastante para ela caber
    if (counts || attempt === 11 || (px <= o.minFontPx + 0.01 && widest <= o.maxW)) {
      const parts = counts ?? greedy(widths, space, o.maxW)
      const lines: LayoutLine[] = []
      let at = 0
      for (const c of parts) {
        const words: LayoutWord[] = []
        let x = 0
        for (let k = at; k < at + c; k++) {
          words.push({ text: texts[k]!, idx: k, x, w: widths[k]! })
          x += widths[k]! + space
        }
        lines.push({ words, w: Math.max(0, x - space) })
        at += c
      }
      const lineH = px * o.lineHeight
      return { fontPx: px, lines, blockW: Math.max(0, ...lines.map((l) => l.w)), blockH: lines.length * lineH, lineH }
    }
    px = px > o.minFontPx + 0.01 ? Math.max(o.minFontPx, px * 0.92) : px * (o.maxW / widest) * 0.99
  }
  return { fontPx: px, lines: [], blockW: 0, blockH: 0, lineH: px * o.lineHeight }
}

const MAX_LAYOUTS = 64

function cached<T>(map: Map<string, T>, key: string, make: () => T): T {
  const hit = map.get(key)
  if (hit !== undefined) {
    map.delete(key)
    map.set(key, hit)
    return hit
  }
  const value = make()
  map.set(key, value)
  if (map.size > MAX_LAYOUTS) map.delete(map.keys().next().value!)
  return value
}

const upper = (s: string): string => s.toLocaleUpperCase('pt-BR')

/** Retângulo de cantos arredondados (o mesmo caminho do `render.ts`, repetido aqui para os dois arquivos não se importarem). */
function roundedRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  ctx.beginPath()
  if (r <= 0.01) {
    ctx.rect(x, y, w, h)
    return
  }
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// ---------------------------------------------------------------------------
// Legenda

function drawWord(ctx: Ctx2D, text: string, x: number, baseline: number, style: CaptionRenderStyle, fill: string, px: number): void {
  if (style.shadow) {
    ctx.save()
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2
    ctx.strokeStyle = 'rgba(0,0,0,0.38)'
    ctx.lineWidth = style.outlinePx * 2 + px * 0.05
    ctx.strokeText(text, x, baseline + px * 0.065)
    ctx.restore()
  }
  if (style.outlinePx > 0) {
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2
    ctx.strokeStyle = style.outlineColor
    ctx.lineWidth = style.outlinePx * 2
    ctx.strokeText(text, x, baseline)
  }
  ctx.fillStyle = fill
  ctx.fillText(text, x, baseline)
}

export function drawCaptions(ctx: Ctx2D, cache: RenderCache, c: SceneCaptions): void {
  if (!cache.fontsReady || c.alpha <= 0.002 || c.words.length === 0) return
  const st = c.style
  const texts = st.uppercase ? c.words.map(upper) : c.words
  const padX = st.box?.padX ?? 0
  const padY = st.box?.padY ?? 0
  const key = `${c.key}|${st.fontPx.toFixed(1)}|${st.maxWidth.toFixed(0)}|${st.uppercase ? 'U' : 'n'}|${st.style}`
  const layout = cached(cache.captionLayouts, key, () =>
    layoutText(ctx, texts, { family: st.fontFamily, weight: st.fontWeight, fontPx: st.fontPx, minFontPx: st.minFontPx, lineHeight: st.lineHeight, maxW: st.maxWidth - 2 * padX, maxLines: st.maxLines, gap: st.active.mode === 'pill' ? st.fontPx * 0.1 : st.outlinePx * 0.9 })
  )
  if (layout.lines.length === 0) return

  const outerH = layout.blockH + 2 * padY
  let top = st.centerY - outerH / 2
  if (st.safeY) {
    // a tinta (contorno e sombra) também fica dentro da caixa segura
    const ink = st.box ? 0 : inkMarginY(st.outlinePx, layout.fontPx)
    top = Math.min(Math.max(top, st.safeY.min + ink), Math.max(st.safeY.min + ink, st.safeY.max - outerH - ink))
  }
  const px = layout.fontPx

  const prevAlpha = ctx.globalAlpha
  ctx.save()
  ctx.globalAlpha = prevAlpha * c.alpha
  ctx.translate(0, c.dy)
  ctx.font = fontOf(st.fontWeight, px, st.fontFamily)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  if (st.box) {
    const bw = layout.blockW + 2 * padX
    roundedRectPath(ctx, st.centerX - bw / 2, top, bw, outerH, st.box.radius)
    ctx.fillStyle = st.box.color
    ctx.fill()
  }

  const active = c.active
  let activeDraw: { text: string; x: number; baseline: number; w: number } | null = null
  layout.lines.forEach((line, li) => {
    const lineTop = top + padY + li * layout.lineH
    const baseline = lineTop + layout.lineH / 2 + px * CAP_CENTER
    const x0 = st.centerX - line.w / 2
    for (const w of line.words) {
      const x = x0 + w.x
      if (w.idx === active && st.active.mode !== 'none') {
        activeDraw = { text: w.text, x, baseline, w: w.w }
        continue
      }
      let fill = st.color
      let alpha = 1
      if (st.upcomingAlpha < 1 && w.idx > active) alpha = st.upcomingAlpha
      if (alpha !== 1) {
        ctx.save()
        ctx.globalAlpha = ctx.globalAlpha * alpha
        drawWord(ctx, w.text, x, baseline, st, fill, px)
        ctx.restore()
      } else {
        drawWord(ctx, w.text, x, baseline, st, fill, px)
      }
    }
  })

  const a = activeDraw as { text: string; x: number; baseline: number; w: number } | null
  if (a) {
    const cx = a.x + a.w / 2
    const cy = a.baseline - px * CAP_CENTER
    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(c.pop, c.pop)
    ctx.translate(-cx, -cy)
    if (st.active.mode === 'pill') {
      const padPillX = px * 0.14
      const h = layout.lineH * 0.9
      roundedRectPath(ctx, a.x - padPillX, cy - h / 2, a.w + 2 * padPillX, h, px * 0.3)
      ctx.fillStyle = st.active.color
      ctx.fill()
      drawWord(ctx, a.text, a.x, a.baseline, { ...st, outlinePx: 0, shadow: false }, st.active.textColor, px)
    } else {
      drawWord(ctx, a.text, a.x, a.baseline, st, st.active.color, px)
    }
    ctx.restore()
  }
  ctx.restore()
  ctx.globalAlpha = prevAlpha
}

// ---------------------------------------------------------------------------
// Título de gancho

function hookLayout(ctx: Ctx2D, text: string, st: HookRenderStyle): TextLayout {
  const words = upper(text).split(/\s+/).filter(Boolean)
  const bandH = st.bandBottom - st.bandTop
  let px = st.fontPx
  let layout = layoutText(ctx, words, { family: st.fontFamily, weight: st.fontWeight, fontPx: px, minFontPx: st.minFontPx, lineHeight: st.lineHeight, maxW: st.maxWidth, maxLines: 2, gap: st.outlinePx * 0.8 })
  // duas linhas precisam caber na faixa: reduz até caber
  for (let i = 0; i < 12 && layout.blockH > bandH && layout.fontPx > st.minFontPx + 0.01; i++) {
    px = Math.max(st.minFontPx, layout.fontPx * 0.94)
    layout = layoutText(ctx, words, { family: st.fontFamily, weight: st.fontWeight, fontPx: px, minFontPx: st.minFontPx, lineHeight: st.lineHeight, maxW: st.maxWidth, maxLines: 2, gap: st.outlinePx * 0.8 })
    if (px <= st.minFontPx + 0.01) break
  }
  return layout
}

export function drawHook(ctx: Ctx2D, cache: RenderCache, h: SceneHook): void {
  if (!cache.fontsReady || h.alpha <= 0.002 || h.text.trim() === '') return
  const st = h.style
  const key = `hook|${h.text}|${st.fontPx.toFixed(1)}|${st.maxWidth.toFixed(0)}`
  const layout = cached(cache.captionLayouts, key, () => hookLayout(ctx, h.text, st))
  if (layout.lines.length === 0) return
  const px = layout.fontPx
  const top = st.bandTop + (st.bandBottom - st.bandTop - layout.blockH) / 2
  const prevAlpha = ctx.globalAlpha
  ctx.save()
  ctx.globalAlpha = prevAlpha * h.alpha
  ctx.font = fontOf(st.fontWeight, px, st.fontFamily)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
  layout.lines.forEach((line, li) => {
    const baseline = top + li * layout.lineH + layout.lineH / 2 + px * CAP_CENTER
    const x0 = st.centerX - line.w / 2
    for (const w of line.words) {
      const x = x0 + w.x
      ctx.strokeStyle = 'rgba(0,0,0,0.38)'
      ctx.lineWidth = st.outlinePx * 2 + px * 0.05
      ctx.strokeText(w.text, x, baseline + px * 0.05)
      ctx.strokeStyle = st.outlineColor
      ctx.lineWidth = st.outlinePx * 2
      ctx.strokeText(w.text, x, baseline)
      ctx.fillStyle = st.color
      ctx.fillText(w.text, x, baseline)
    }
  })
  ctx.restore()
  ctx.globalAlpha = prevAlpha
}
