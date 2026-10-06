import type { Page } from '@playwright/test'

/** WCAG 2.x: luminância sRGB e fundo efetivo composto. Mídia não é uma cor de interface. */
export async function measureContrast(page: Page) {
  return page.evaluate(() => {
    const ctx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!
    const rgba = (color: string) => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255]
    }
    const blend = (a: number[], b: number[]) => a.slice(0, 3).map((c, i) => c * a[3]! + b[i]! * (1 - a[3]!))
    const lum = (c: number[]) => c.slice(0, 3).map((x) => x / 255).map((x) => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4).reduce((n, x, i) => n + x * [0.2126, 0.7152, 0.0722][i]!, 0)
    const rows: { text: string; selector: string; ratio: number; minimum: number; foreground: string; background: number[] }[] = []
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      let text = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim()
      let placeholder = false
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el instanceof HTMLInputElement && ['checkbox', 'radio', 'range', 'color', 'hidden'].includes(el.type)) continue
        placeholder = !el.value && Boolean(el.placeholder)
        text = el.value || el.placeholder
      } else if (el instanceof HTMLSelectElement) text = el.selectedOptions[0]?.text ?? ''
      if (!text || el.closest('svg, script, style, [disabled], [aria-disabled="true"]')) continue
      const style = getComputedStyle(el), rect = el.getBoundingClientRect()
      if (style.visibility !== 'visible' || rect.width < 3 || rect.height < 3) continue
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom)
      const chain: HTMLElement[] = []
      let opacity = 1
      for (let p: HTMLElement | null = el; p; p = p.parentElement) {
        const s = getComputedStyle(p)
        opacity *= Number(s.opacity)
        chain.push(p)
        if (p !== el && /(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) {
          const r = p.getBoundingClientRect()
          left = Math.max(left, r.left); top = Math.max(top, r.top); right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom)
        }
      }
      if (right - left < 3 || bottom - top < 3 || opacity < 0.99) continue // inativos/transições
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
      if (hit && !el.contains(hit) && !hit.contains(el)) continue // sob um diálogo
      let bg: number[] = [19, 18, 17]
      const x = (left + right) / 2, y = (top + bottom) / 2
      for (const p of chain.reverse()) {
        const r = p.getBoundingClientRect()
        // Um filho absoluto pode estar fora da caixa do pai (ex.: rótulo sobre um filete da régua).
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) bg = blend(rgba(getComputedStyle(p).backgroundColor), bg)
      }
      const color = placeholder ? getComputedStyle(el, '::placeholder').color : style.color
      const fg = blend(rgba(color), bg)
      const a = lum(fg), b = lum(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      const px = parseFloat(style.fontSize), bold = Number(style.fontWeight) >= 700
      rows.push({ text: text.slice(0, 120), selector: el.getAttribute('data-testid') ?? el.className, ratio: Math.round(ratio * 100) / 100, minimum: px >= 24 || (bold && px >= 18.667) ? 3 : 4.5, foreground: color, background: bg.map(Math.round) })
    }
    return { measured: rows.length, failures: rows.filter((r) => r.ratio < r.minimum), rows }
  })
}
