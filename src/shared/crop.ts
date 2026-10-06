/**
 * Recorte da tela (C1): a ÁREA-BASE que o vídeo mostra. Em vez da tela gravada inteira (com abas, barra de endereço e favoritos),
 * só a página do navegador, ou um retângulo escolhido à mão. Código puro: sem DOM, sem Node.
 *
 * Tudo em coordenadas NORMALIZADAS 0..1 na tela gravada (o quadro do vídeo de origem), tempo em ms de origem.
 *
 *  - `stabilizeContentRects`: o retângulo medido a cada 100 ms vira passos "grudados" (nada de tremer por 1 px: só muda quando
 *    a janela muda de verdade);
 *  - `buildCropTimeline`: os passos viram uma linha do tempo com transição curta (200 ms) e uma PROPORÇÃO de referência (a que
 *    vigora por mais tempo): o retângulo efetivo tem sempre essa proporção (cabe dentro da página medida), então o destino do
 *    layout, o caminho da câmera e o recorte vertical trabalham sobre uma área de forma fixa mesmo se a janela mudar de forma;
 *  - o cursor e os cliques passam para o espaço do recorte (`CropTimeline.toCrop`); o que cai fora dele (uma aba, a barra de
 *    endereço) é "fora": não abre zoom, não faz ripple e não puxa a câmera.
 */
import type { ContentRectSample, Point, Rect, ScreenCrop, Size } from './types'

/** Variação (px da tela gravada) abaixo da qual o retângulo medido NÃO muda o recorte (anti-tremor; a medida varia 1 px). */
export const STICKY_PX = 3
/** Duração (ms) da transição quando o recorte muda de verdade (a janela foi movida, redimensionada, DevTools abriu…). */
export const CROP_TRANSITION_MS = 200
/** Menor fração da tela que um recorte pode ter (um retângulo menor que isto é lixo da medida ou do arraste). */
export const MIN_CROP_FRACTION = 0.08

export const FULL_RECT: Rect = { x: 0, y: 0, w: 1, h: 1 }

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u
const easeInOutCubic = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)

export function lerpRect(a: Rect, b: Rect, u: number): Rect {
  return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), w: lerp(a.w, b.w, u), h: lerp(a.h, b.h, u) }
}

/** Retângulo dentro de [0,1]² e com tamanho mínimo; `null` se não é um retângulo (NaN, vazio). */
export function sanitizeRect(r: Rect | null | undefined): Rect | null {
  if (!r || ![r.x, r.y, r.w, r.h].every(Number.isFinite)) return null
  const x0 = clamp(r.x, 0, 1)
  const y0 = clamp(r.y, 0, 1)
  const x1 = clamp(r.x + r.w, 0, 1)
  const y1 = clamp(r.y + r.h, 0, 1)
  if (x1 - x0 < MIN_CROP_FRACTION || y1 - y0 < MIN_CROP_FRACTION) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** O retângulo é (quase) a tela toda? Então recortar não muda nada. */
export function isFullRect(r: Rect, sourcePx: Size, tolPx = STICKY_PX): boolean {
  return r.x * sourcePx.w <= tolPx && r.y * sourcePx.h <= tolPx && (1 - r.x - r.w) * sourcePx.w <= tolPx && (1 - r.y - r.h) * sourcePx.h <= tolPx
}

// ---------------------------------------------------------------------------
// Do medido ao "grudado"

export type CropStep = { t: number; rect: Rect }

/**
 * Passos "grudados": o primeiro retângulo vale; os seguintes só entram quando algum lado muda mais que `STICKY_PX` (em px da tela
 * gravada) do retângulo que está valendo. Retângulo inválido (menor que 8% da tela) é ignorado. Ordenado por tempo.
 */
export function stabilizeContentRects(samples: readonly ContentRectSample[], sourcePx: Size, stickyPx = STICKY_PX): CropStep[] {
  const sorted = samples
    .filter((s) => Number.isFinite(s.t))
    .map((s) => ({ t: s.t, rect: sanitizeRect(s) }))
    .filter((s): s is { t: number; rect: Rect } => s.rect !== null)
    .sort((a, b) => a.t - b.t)
  const steps: CropStep[] = []
  for (const s of sorted) {
    const cur = steps[steps.length - 1]
    if (!cur) {
      steps.push({ t: s.t, rect: s.rect })
      continue
    }
    const d = Math.max(
      Math.abs(s.rect.x - cur.rect.x) * sourcePx.w,
      Math.abs(s.rect.y - cur.rect.y) * sourcePx.h,
      Math.abs(s.rect.x + s.rect.w - cur.rect.x - cur.rect.w) * sourcePx.w,
      Math.abs(s.rect.y + s.rect.h - cur.rect.y - cur.rect.h) * sourcePx.h
    )
    if (d > stickyPx + 1e-6) steps.push({ t: s.t, rect: s.rect })
  }
  return steps
}

// ---------------------------------------------------------------------------
// A linha do tempo do recorte

export type CropTimeline = {
  /** Retângulo de referência (normalizado, na tela gravada): o que vigora por mais tempo. Dá a proporção da área-base. */
  ref: Rect
  /** Tamanho da área-base em px da tela gravada (a referência). É o "tamanho da tela" que o resto da cena enxerga. */
  sizePx: Size
  /** Retângulo EFETIVO em `t` (normalizado, na tela gravada): proporção da referência, dentro da página medida. */
  at(t: number): Rect
  /** O recorte é o mesmo o tempo todo? (recorte manual, ou uma janela que nunca mudou) */
  readonly constant: boolean
  /** Passos grudados (para as amostras de teste e para o editor). */
  readonly steps: readonly CropStep[]
}

/** Maior retângulo com a proporção de pixels `aspect` (largura/altura) que cabe em `r`, centrado nele. */
export function fitAspectInside(r: Rect, aspect: number, sourcePx: Size): Rect {
  if (!(aspect > 0)) return r
  const wPx = r.w * sourcePx.w
  const hPx = r.h * sourcePx.h
  let w = wPx
  let h = hPx
  if (wPx / hPx > aspect) w = hPx * aspect
  else h = wPx / aspect
  const nw = w / sourcePx.w
  const nh = h / sourcePx.h
  return { x: r.x + (r.w - nw) / 2, y: r.y + (r.h - nh) / 2, w: nw, h: nh }
}

/**
 * Passos → linha do tempo. Cada mudança aceita em `t_i` vira uma rampa de 200 ms (`easeInOutCubic`) do retângulo que valia
 * naquele instante até o novo; se outra mudança chega no meio da rampa, a nova rampa parte de onde a anterior estava.
 */
export function buildCropTimeline(steps: readonly CropStep[], sourcePx: Size, transitionMs = CROP_TRANSITION_MS): CropTimeline | null {
  if (steps.length === 0) return null
  // 1) rampas: cada passo aceito parte de onde o recorte estava naquele instante (a anterior, se ainda não terminou)
  type Ramp = { t: number; from: Rect; to: Rect }
  const ramps: Ramp[] = []
  for (let i = 1; i < steps.length; i++) {
    const s = steps[i]!
    const prev = ramps[ramps.length - 1]
    let from: Rect
    if (!prev) from = steps[i - 1]!.rect
    else {
      const u = clamp((s.t - prev.t) / transitionMs, 0, 1)
      from = u >= 1 ? prev.to : lerpRect(prev.from, prev.to, easeInOutCubic(u))
    }
    ramps.push({ t: s.t, from, to: s.rect })
  }
  const first = steps[0]!.rect
  const measured = (t: number): Rect => {
    if (ramps.length === 0 || t < ramps[0]!.t) return first
    // última rampa com início <= t
    let lo = 0
    let hi = ramps.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (ramps[mid]!.t <= t) lo = mid
      else hi = mid - 1
    }
    const r = ramps[lo]!
    const u = clamp((t - r.t) / transitionMs, 0, 1)
    return u >= 1 ? r.to : lerpRect(r.from, r.to, easeInOutCubic(u))
  }

  // 2) a referência: o retângulo que vigora por mais tempo (o último passo vale até o fim: conta um pouco, 1 s, para desempatar)
  const holds = new Map<string, { rect: Rect; ms: number }>()
  for (let i = 0; i < steps.length; i++) {
    const start = i === 0 ? 0 : steps[i]!.t
    const end = i + 1 < steps.length ? steps[i + 1]!.t : steps[i]!.t + 1000
    const key = steps[i]!.rect.x.toFixed(4) + steps[i]!.rect.y.toFixed(4) + steps[i]!.rect.w.toFixed(4) + steps[i]!.rect.h.toFixed(4)
    const hold = holds.get(key)
    const ms = Math.max(0, end - Math.max(start, 0))
    if (hold) hold.ms += ms
    else holds.set(key, { rect: steps[i]!.rect, ms })
  }
  let ref = steps[0]!.rect
  let best = -1
  for (const h of holds.values()) {
    if (h.ms > best) {
      best = h.ms
      ref = h.rect
    }
  }
  const sizePx: Size = { w: Math.max(2, Math.round(ref.w * sourcePx.w)), h: Math.max(2, Math.round(ref.h * sourcePx.h)) }
  const aspect = sizePx.w / sizePx.h
  const constant = steps.length === 1
  const refFit = fitAspectInside(ref, aspect, sourcePx)

  return {
    ref,
    sizePx,
    constant,
    steps,
    at: constant ? () => refFit : (t) => fitAspectInside(measured(t), aspect, sourcePx)
  }
}

/** Recorte fixo (manual): a mesma coisa que uma janela que nunca mudou. */
export function constantCrop(rect: Rect, sourcePx: Size): CropTimeline | null {
  const r = sanitizeRect(rect)
  return r ? buildCropTimeline([{ t: 0, rect: r }], sourcePx) : null
}

/**
 * O recorte que o documento pede, ou `null` (tela inteira). `auto` usa as medidas da página; sem medida (ou medida que é a tela
 * toda) não há recorte. `manual` sem retângulo válido também não.
 */
export function resolveScreenCrop(crop: ScreenCrop | undefined, samples: readonly ContentRectSample[] | undefined, sourcePx: Size | null): CropTimeline | null {
  if (!crop || crop.mode === 'off' || !sourcePx || !(sourcePx.w > 0) || !(sourcePx.h > 0)) return null
  if (crop.mode === 'manual') {
    const tl = crop.manual ? constantCrop(crop.manual, sourcePx) : null
    return tl && !isFullRect(tl.ref, sourcePx) ? tl : null
  }
  const steps = stabilizeContentRects(samples ?? [], sourcePx)
  const tl = buildCropTimeline(steps, sourcePx)
  if (!tl) return null
  // a página ocupa a tela toda em todo o tempo (tela cheia): nada a recortar
  if (steps.every((s) => isFullRect(s.rect, sourcePx))) return null
  return tl
}

/** Chave estável do que o recorte do documento pede (para guardar o resultado em cache). */
export function cropSignature(crop: ScreenCrop | undefined): string {
  if (!crop || crop.mode === 'off') return 'off'
  if (crop.mode === 'manual') {
    const m = crop.manual
    return m ? `manual:${m.x.toFixed(5)},${m.y.toFixed(5)},${m.w.toFixed(5)},${m.h.toFixed(5)}` : 'manual:-'
  }
  return 'auto'
}

// ---------------------------------------------------------------------------
// Do espaço da tela ao espaço do recorte e de volta

/** Ponto normalizado na tela → no recorte `c`. `out` = caiu fora dele (x/y já com clamp). */
export function pointToCrop(c: Rect, p: Point): { x: number; y: number; out: boolean } {
  const x = (p.x - c.x) / c.w
  const y = (p.y - c.y) / c.h
  const out = x < 0 || x > 1 || y < 0 || y > 1
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), out }
}

/** Retângulo no espaço do recorte `c` (0..1 dentro dele) → na tela gravada. */
export function rectFromCrop(c: Rect, r: Rect): Rect {
  return { x: c.x + r.x * c.w, y: c.y + r.y * c.h, w: r.w * c.w, h: r.h * c.h }
}
