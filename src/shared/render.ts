/**
 * O MOTOR DE RENDER: `renderFrame` desenha UM quadro em Canvas 2D a partir de uma
 * `Scene` e das imagens de origem. Funciona igual em `CanvasRenderingContext2D` (prévia) e em
 * `OffscreenCanvasRenderingContext2D` (exportação).
 *
 * Desempenho, por construção:
 *  - o fundo é um bitmap em cache (uma vez por estilo + tamanho), já com dither;
 *  - a sombra NUNCA usa `shadowBlur` por quadro: é um sprite pré-renderizado, em 9 fatias para
 *    retângulos grandes (qualquer tamanho sem refazer) e em cache por tamanho para os pequenos;
 *  - a tela é recortada com cantos arredondados (clip antialiased) e desenhada com
 *    `drawImage` de retângulo de origem FRACIONÁRIO (zoom suave, sem degrau de pixel).
 *
 * Este arquivo vive em `shared` (compilado também sem DOM), então fala com o canvas por
 * interfaces ESTRUTURAIS mínimas: os contextos do navegador as satisfazem.
 */
import { drawCaptions, drawHook, type TextLayout } from './caption-render'
import { backgroundKey, coverCrop, gradientEndpoints } from './styles'
import type { Scene, SceneBackdrop, SceneCamera, SceneScreen, ShadowSpec } from './scene'
import type { Background, Rect } from './types'

// ---------------------------------------------------------------------------
// Interfaces estruturais do canvas

export interface Gradient {
  addColorStop(offset: number, color: string): void
}

/** O subconjunto de `CanvasRenderingContext2D` / `OffscreenCanvasRenderingContext2D` que o motor usa. */
export interface Ctx2D {
  save(): void
  restore(): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  rect(x: number, y: number, w: number, h: number): void
  clip(): void
  fill(): void
  stroke(): void
  fillRect(x: number, y: number, w: number, h: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  translate(x: number, y: number): void
  scale(x: number, y: number): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  drawImage(image: unknown, dx: number, dy: number): void
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void
  drawImage(image: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): Gradient
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): Gradient
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray }
  putImageData(image: never, dx: number, dy: number): void
  createImageData(w: number, h: number): { data: Uint8ClampedArray }
  globalAlpha: number
  globalCompositeOperation: string
  fillStyle: unknown
  strokeStyle: unknown
  lineWidth: number
  lineJoin: string
  lineCap: string
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: string
  shadowBlur: number
  shadowColor: string
  shadowOffsetX: number
  shadowOffsetY: number
  // texto (legendas e título de gancho, M4a)
  font: string
  textAlign: string
  textBaseline: string
  miterLimit: number
  fillText(text: string, x: number, y: number): void
  strokeText(text: string, x: number, y: number): void
  measureText(text: string): { width: number }
}

export interface CanvasLike {
  width: number
  height: number
  getContext(contextId: '2d'): Ctx2D | null
}

export type CanvasFactory = (w: number, h: number) => CanvasLike

/** Uma imagem de origem (frame decodificado, `<video>`, bitmap…) com o tamanho em px da fonte. */
export type FrameSource = { image: unknown; w: number; h: number }
export type FrameSet = { screen?: FrameSource | null; camera?: FrameSource | null }

// ---------------------------------------------------------------------------
// Cache

type Sprite = { canvas: CanvasLike; margin: number; w: number; h: number }

export type RenderStats = {
  /** Quantas vezes o fundo foi montado (deve ser 1 por estilo + tamanho). */
  backgroundBuilds: number
  /** Quantas vezes um sprite de sombra foi montado (com `shadowBlur`, UMA vez cada). */
  shadowBuilds: number
  /** Quadros desenhados. */
  frames: number
}

export type RenderCache = {
  factory: CanvasFactory
  backgrounds: Map<string, CanvasLike>
  /** Imagens de fundo pré-carregadas, por `Background.path`. */
  images: Map<string, FrameSource>
  nine: Map<string, Sprite>
  sized: Map<string, Sprite>
  /** Camadas de trabalho (uma por elemento) para o recorte arredondado com antialiasing. */
  layers: Map<string, CanvasLike>
  /** O layout do texto de cada página de legenda (quebra de linhas, tamanho), calculado uma vez. */
  captionLayouts: Map<string, TextLayout>
  /**
   * As fontes das legendas já estão carregadas? Enquanto não, a legenda NÃO é desenhada (melhor sem ela por um instante do
   * que com a fonte errada). A exportação espera as fontes antes do primeiro quadro; a prévia liga isto quando carregam.
   */
  fontsReady: boolean
  stats: RenderStats
}

const MAX_SIZED_SPRITES = 48

export function createRenderCache(factory: CanvasFactory): RenderCache {
  return {
    factory,
    backgrounds: new Map(),
    images: new Map(),
    nine: new Map(),
    sized: new Map(),
    layers: new Map(),
    captionLayouts: new Map(),
    fontsReady: true,
    stats: { backgroundBuilds: 0, shadowBuilds: 0, frames: 0 }
  }
}

function ctxOf(canvas: CanvasLike): Ctx2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Não consegui criar o contexto 2D do canvas.')
  return ctx
}

// ---------------------------------------------------------------------------
// Fundo

function parseHex(color: string): [number, number, number] {
  let h = color.trim().replace(/^#/, '')
  if (h.length === 3) h = h.replace(/(.)/g, '$1$1')
  const n = Number.parseInt(h.slice(0, 6), 16)
  if (!Number.isFinite(n) || h.length < 6) return [0, 0, 0]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Gerador pseudoaleatório determinístico (o fundo sai igual em toda máquina e em todo quadro). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Gradiente linear calculado em ponto flutuante, com ruído triangular de ±1 nível somado antes
 * de arredondar (dither): o gradiente de 8 bits "em degraus" some, e o H.264 não o transforma em
 * faixas visíveis nos fundos escuros.
 */
function paintGradient(ctx: Ctx2D, w: number, h: number, from: string, to: string, angle: number): void {
  const [r0, g0, b0] = parseHex(from)
  const [r1, g1, b1] = parseHex(to)
  const img = ctx.createImageData(w, h)
  const d = img.data
  const { x0, y0, x1, y1 } = gradientEndpoints(angle, w, h)
  const vx = x1 - x0
  const vy = y1 - y0
  const len2 = vx * vx + vy * vy || 1
  const rand = mulberry32(0x7a6d)
  let o = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let u = ((x + 0.5 - x0) * vx + (y + 0.5 - y0) * vy) / len2
      u = u < 0 ? 0 : u > 1 ? 1 : u
      const n = rand() + rand() - 1 // triangular em (−1, 1)
      d[o++] = r0 + (r1 - r0) * u + n
      d[o++] = g0 + (g1 - g0) * u + n
      d[o++] = b0 + (b1 - b0) * u + n
      d[o++] = 255
    }
  }
  ctx.putImageData(img as never, 0, 0)
}

function buildBackground(cache: RenderCache, bg: Background, w: number, h: number): CanvasLike {
  cache.stats.backgroundBuilds++
  const canvas = cache.factory(w, h)
  const ctx = ctxOf(canvas)
  if (bg.type === 'gradient' && bg.from.toLowerCase() !== bg.to.toLowerCase()) {
    paintGradient(ctx, w, h, bg.from, bg.to, bg.angle)
  } else if (bg.type === 'image') {
    const img = cache.images.get(bg.path)
    ctx.fillStyle = '#0b0c10'
    ctx.fillRect(0, 0, w, h)
    if (img) {
      const c = coverCrop({ w: img.w, h: img.h }, w / h)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img.image, c.x * img.w, c.y * img.h, c.w * img.w, c.h * img.h, 0, 0, w, h)
    }
  } else {
    ctx.fillStyle = bg.type === 'solid' ? bg.color : bg.type === 'gradient' ? bg.from : '#0b0c10'
    ctx.fillRect(0, 0, w, h)
  }
  return canvas
}

/** O fundo em cache para o estilo e o tamanho (monta na primeira vez). Imagem ainda não carregada: não guarda. */
export function backgroundBitmap(cache: RenderCache, bg: Background, w: number, h: number): CanvasLike {
  const loaded = bg.type !== 'image' || cache.images.has(bg.path)
  const key = `${backgroundKey(bg)}|${w}x${h}${loaded ? '' : '|pending'}`
  let bitmap = cache.backgrounds.get(key)
  if (!bitmap) {
    bitmap = buildBackground(cache, bg, w, h)
    cache.backgrounds.set(key, bitmap)
    // só um fundo por vez fica na memória (4K = 33 MB cada)
    if (cache.backgrounds.size > 3) cache.backgrounds.delete(cache.backgrounds.keys().next().value!)
  }
  return bitmap
}

// ---------------------------------------------------------------------------
// Formas

/** Caminho de retângulo com cantos arredondados (arcos circulares). */
export function roundedRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, radius: number): void {
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
// Sombra (sprites; nenhum `shadowBlur` por quadro)

/** Sprite de sombra de um retângulo `w × h` com raio `radius`: só a sombra, sem a forma. */
function buildShadowSprite(cache: RenderCache, w: number, h: number, radius: number, spec: ShadowSpec): Sprite {
  cache.stats.shadowBuilds++
  const margin = Math.ceil(spec.blur * 1.5) + 2
  const W = Math.ceil(w + 2 * margin)
  const H = Math.ceil(h + 2 * margin)
  const canvas = cache.factory(W, H)
  const ctx = ctxOf(canvas)
  // A forma é desenhada longe, fora do canvas, e o deslocamento da sombra a traz de volta:
  // sobra só a sombra (a forma não precisa ser apagada depois).
  const far = W + H + 400
  ctx.shadowColor = `rgba(0,0,0,${spec.opacity})`
  ctx.shadowBlur = spec.blur
  ctx.shadowOffsetX = -far
  ctx.shadowOffsetY = 0
  ctx.fillStyle = '#000'
  roundedRectPath(ctx, margin + far, margin, w, h, radius)
  ctx.fill()
  return { canvas, margin, w: W, h: H }
}

const q = (v: number, step: number): number => Math.max(step, Math.round(v / step) * step)

function lru<K, V>(map: Map<K, V>, key: K, make: () => V, max: number): V {
  const hit = map.get(key)
  if (hit !== undefined) {
    map.delete(key) // reinsere: o mais recente fica por último
    map.set(key, hit)
    return hit
  }
  const value = make()
  map.set(key, value)
  if (map.size > max) map.delete(map.keys().next().value!)
  return value
}

/**
 * Desenha a sombra de `rect`. Retângulos grandes usam 9 fatias de um único sprite (cantos
 * intactos, bordas e miolo esticados: a sombra é constante ao longo da borda); os pequenos (a
 * bolha da câmera) usam um sprite do tamanho, em cache com tamanho quantizado de 4 px.
 */
export function drawShadow(ctx: Ctx2D, cache: RenderCache, rect: Rect, radius: number, spec: ShadowSpec, alpha = 1): void {
  if (spec.opacity <= 0 || spec.blur <= 0 || alpha <= 0) return
  const k = Math.ceil(spec.blur * 1.5)
  const margin = k + 2
  const r = Math.max(0, radius)
  const slice = margin + Math.ceil(r) + k
  const dy = spec.offsetY
  const prevAlpha = ctx.globalAlpha
  ctx.globalAlpha = prevAlpha * alpha

  if (rect.w + 2 * margin >= 2 * slice + 4 && rect.h + 2 * margin >= 2 * slice + 4) {
    const key = `${Math.round(spec.blur * 2) / 2}|${spec.opacity}|${Math.round(r)}`
    const sprite = lru(
      cache.nine,
      key,
      () => {
        const inner = 2 * (Math.ceil(r) + k) + 4
        return buildShadowSprite(cache, inner, inner, Math.ceil(r), spec)
      },
      6
    )
    const sw = sprite.w
    const sh = sprite.h
    const c = slice
    const x0 = rect.x - margin
    const y0 = rect.y - margin + dy
    const W = rect.w + 2 * margin
    const H = rect.h + 2 * margin
    const midSW = sw - 2 * c
    const midSH = sh - 2 * c
    const midW = W - 2 * c
    const midH = H - 2 * c
    const img = sprite.canvas
    // linha de cima
    ctx.drawImage(img, 0, 0, c, c, x0, y0, c, c)
    ctx.drawImage(img, c, 0, midSW, c, x0 + c, y0, midW, c)
    ctx.drawImage(img, sw - c, 0, c, c, x0 + W - c, y0, c, c)
    // meio
    ctx.drawImage(img, 0, c, c, midSH, x0, y0 + c, c, midH)
    ctx.drawImage(img, c, c, midSW, midSH, x0 + c, y0 + c, midW, midH)
    ctx.drawImage(img, sw - c, c, c, midSH, x0 + W - c, y0 + c, c, midH)
    // linha de baixo
    ctx.drawImage(img, 0, sh - c, c, c, x0, y0 + H - c, c, c)
    ctx.drawImage(img, c, sh - c, midSW, c, x0 + c, y0 + H - c, midW, c)
    ctx.drawImage(img, sw - c, sh - c, c, c, x0 + W - c, y0 + H - c, c, c)
  } else {
    const qw = q(rect.w, 4)
    const qh = q(rect.h, 4)
    const qr = Math.round(Math.min(r, qw / 2, qh / 2) / 2) * 2
    const key = `${qw}x${qh}|${qr}|${Math.round(spec.blur * 2) / 2}|${spec.opacity}`
    const sprite = lru(cache.sized, key, () => buildShadowSprite(cache, qw, qh, qr, spec), MAX_SIZED_SPRITES)
    const cx = rect.x + rect.w / 2
    const cy = rect.y + rect.h / 2 + dy
    ctx.drawImage(sprite.canvas, cx - sprite.w / 2, cy - sprite.h / 2)
  }
  ctx.globalAlpha = prevAlpha
}

// ---------------------------------------------------------------------------
// Elementos

function drawSource(ctx: Ctx2D, frame: FrameSource | null | undefined, src: Rect, dest: Rect, mirror = false): void {
  if (!frame || !(frame.w > 0) || !(frame.h > 0)) {
    ctx.fillStyle = '#0b0c10'
    ctx.fillRect(dest.x, dest.y, dest.w, dest.h)
    return
  }
  const sx = src.x * frame.w
  const sy = src.y * frame.h
  const sw = src.w * frame.w
  const sh = src.h * frame.h
  if (mirror) {
    ctx.save()
    ctx.translate(dest.x + dest.w / 2, 0)
    ctx.scale(-1, 1)
    ctx.translate(-(dest.x + dest.w / 2), 0)
    ctx.drawImage(frame.image, sx, sy, sw, sh, dest.x, dest.y, dest.w, dest.h)
    ctx.restore()
  } else {
    ctx.drawImage(frame.image, sx, sy, sw, sh, dest.x, dest.y, dest.w, dest.h)
  }
}

function drawRipples(ctx: Ctx2D, scene: Scene): void {
  for (const r of scene.ripples) {
    if (r.radius <= 0.5 || r.alpha <= 0.002) continue
    const a = r.alpha
    // disco claro e translúcido (mais denso na borda): lê bem sobre tela escura e sobre tela azul
    const g = ctx.createRadialGradient(r.x, r.y, 0, r.x, r.y, r.radius)
    g.addColorStop(0, `rgba(255,255,255,${(a * 0.1).toFixed(4)})`)
    g.addColorStop(0.7, `rgba(255,255,255,${(a * 0.42).toFixed(4)})`)
    g.addColorStop(1, `rgba(255,255,255,${(a * 0.16).toFixed(4)})`)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2)
    ctx.fill()
    // anel claro com um filete escuro por fora: aparece também sobre tela clara
    const lw = Math.max(1.2, 2.4 * scene.unit)
    ctx.lineWidth = lw
    ctx.strokeStyle = `rgba(0,0,0,${Math.min(1, a * 0.7).toFixed(4)})`
    ctx.beginPath()
    ctx.arc(r.x, r.y, r.radius + lw * 0.5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = `rgba(255,255,255,${Math.min(1, a * 2).toFixed(4)})`
    ctx.beginPath()
    ctx.arc(r.x, r.y, Math.max(0.5, r.radius - lw * 0.5), 0, Math.PI * 2)
    ctx.stroke()
  }
}

function drawHalo(ctx: Ctx2D, scene: Scene): void {
  const h = scene.halo
  if (!h || h.alpha <= 0) return
  const g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, h.radius)
  g.addColorStop(0, 'rgba(255,214,64,0.0)')
  g.addColorStop(0.35, 'rgba(255,214,64,0.45)')
  g.addColorStop(1, 'rgba(255,214,64,0.0)')
  const prev = ctx.globalAlpha
  ctx.globalAlpha = prev * h.alpha
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(h.x, h.y, h.radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = prev
}

/** Seta do cursor (ponta em 0,0): contorno do ponteiro padrão do Windows, em unidades de ~px. */
function arrowPath(ctx: Ctx2D): void {
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(0, 16.4)
  ctx.lineTo(3.9, 12.6)
  ctx.lineTo(6.9, 19.6)
  ctx.lineTo(9.7, 18.4)
  ctx.lineTo(6.8, 11.5)
  ctx.lineTo(12, 11.5)
  ctx.closePath()
}

function drawCursor(ctx: Ctx2D, scene: Scene): void {
  const c = scene.cursor
  if (!c || c.alpha <= 0) return
  const prev = ctx.globalAlpha
  ctx.globalAlpha = prev * c.alpha
  ctx.save()
  ctx.translate(c.x, c.y)
  ctx.scale(c.scale, c.scale)
  // sombra barata: a mesma seta, deslocada e translúcida (nada de shadowBlur por quadro)
  ctx.save()
  ctx.translate(1.1, 1.6)
  arrowPath(ctx)
  ctx.fillStyle = 'rgba(0,0,0,0.28)'
  ctx.fill()
  ctx.restore()
  arrowPath(ctx)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.lineJoin = 'round'
  ctx.lineWidth = 1.5
  ctx.strokeStyle = '#111111'
  ctx.stroke()
  ctx.restore()
  ctx.globalAlpha = prev
}

/**
 * Camada de trabalho de um elemento: cresce quando precisa e é reaproveitada (nada de criar um
 * canvas por quadro). Tamanho arredondado para cima em múltiplos de 64.
 */
function layerFor(cache: RenderCache, key: string, w: number, h: number): CanvasLike {
  const cw = Math.ceil(w / 64) * 64
  const ch = Math.ceil(h / 64) * 64
  let layer = cache.layers.get(key)
  if (!layer || layer.width < cw || layer.height < ch) {
    layer = cache.factory(Math.max(cw, layer?.width ?? 0), Math.max(ch, layer?.height ?? 0))
    cache.layers.set(key, layer)
  }
  return layer
}

/**
 * Desenha um cartão de cantos arredondados COM antialiasing. O `clip()` do canvas NÃO é
 * antialiased no Chromium (medido: serrilhado nos cantos e no círculo da câmera), então o
 * conteúdo vai para uma camada: o `fill()` do caminho arredondado (antialiased) vira a máscara e
 * o conteúdo entra com `source-in`; ripples e cursor entram com `source-atop`. A camada é
 * copiada para o quadro em pixels inteiros.
 */
function drawCard(
  ctx: Ctx2D,
  cache: RenderCache,
  key: string,
  dest: Rect,
  radius: number,
  opacity: number,
  content: (lc: Ctx2D, w: number, h: number) => void,
  overlay?: (lc: Ctx2D, dx: number, dy: number) => void
): void {
  const w = Math.max(1, Math.round(dest.w))
  const h = Math.max(1, Math.round(dest.h))
  const x = Math.round(dest.x)
  const y = Math.round(dest.y)
  const canvas = layerFor(cache, key, w, h)
  const lc = ctxOf(canvas)
  lc.save()
  lc.setTransform(1, 0, 0, 1, 0, 0)
  lc.globalAlpha = 1
  lc.globalCompositeOperation = 'source-over'
  lc.imageSmoothingEnabled = true
  lc.imageSmoothingQuality = 'high'
  lc.clearRect(0, 0, canvas.width, canvas.height)
  // limita os efeitos "fora da área desenhada" dos modos source-in/atop ao retângulo do cartão
  lc.beginPath()
  lc.rect(0, 0, w, h)
  lc.clip()
  roundedRectPath(lc, 0, 0, w, h, radius)
  lc.fillStyle = '#000'
  lc.fill()
  lc.globalCompositeOperation = 'source-in'
  content(lc, w, h)
  if (overlay) {
    lc.globalCompositeOperation = 'source-atop'
    overlay(lc, x, y)
  }
  lc.restore()
  const prev = ctx.globalAlpha
  ctx.globalAlpha = prev * opacity
  ctx.drawImage(canvas, 0, 0, w, h, x, y, w, h)
  ctx.globalAlpha = prev
}

function drawScreen(ctx: Ctx2D, cache: RenderCache, scene: Scene, s: SceneScreen, frame: FrameSource | null | undefined): void {
  if (s.shadow) drawShadow(ctx, cache, s.dest, s.radius, s.shadow, s.opacity)
  drawCard(
    ctx,
    cache,
    'screen',
    s.dest,
    s.radius,
    s.opacity,
    (lc, w, h) => drawSource(lc, frame, s.src, { x: 0, y: 0, w, h }),
    (lc, dx, dy) => {
      // ripples, halo e cursor usam coordenadas do quadro: leva a origem para o canto do cartão
      lc.translate(-dx, -dy)
      drawRipples(lc, scene)
      drawHalo(lc, scene)
      drawCursor(lc, scene)
    }
  )
}

function drawCamera(ctx: Ctx2D, cache: RenderCache, c: SceneCamera, frame: FrameSource | null | undefined): void {
  if (c.shadow) drawShadow(ctx, cache, c.dest, c.radius, c.shadow, c.opacity)
  drawCard(ctx, cache, 'camera', c.dest, c.radius, c.opacity, (lc, w, h) => drawSource(lc, frame, c.src, { x: 0, y: 0, w, h }, c.mirror))
  if (c.border && c.border.width > 0) {
    // borda por dentro do cartão, traço antialiased (nada de clip)
    const bw = c.border.width
    const x = Math.round(c.dest.x)
    const y = Math.round(c.dest.y)
    const w = Math.max(1, Math.round(c.dest.w))
    const h = Math.max(1, Math.round(c.dest.h))
    const prev = ctx.globalAlpha
    ctx.globalAlpha = prev * c.opacity
    roundedRectPath(ctx, x + bw / 2, y + bw / 2, w - bw, h - bw, Math.max(0, c.radius - bw / 2))
    ctx.strokeStyle = c.border.color
    ctx.lineWidth = bw
    ctx.stroke()
    ctx.globalAlpha = prev
  }
}

/**
 * Fundo do V-C (tela na largura): o PRÓPRIO vídeo da tela, desfocado e escurecido. O desfoque é barato e igual na prévia e
 * na exportação: a imagem desce para um canvas minúsculo (filtro de média na descida) e volta esticada com suavização
 * (nada de `filter: blur()` por quadro).
 */
function drawBackdrop(ctx: Ctx2D, cache: RenderCache, b: SceneBackdrop, frame: FrameSource | null | undefined, w: number, h: number): void {
  if (!frame || !(frame.w > 0) || !(frame.h > 0)) return
  const tw = Math.max(8, Math.round(w / 14))
  const th = Math.max(8, Math.round(h / 14))
  const small = layerFor(cache, 'backdrop', tw, th)
  const sc = ctxOf(small)
  sc.save()
  sc.setTransform(1, 0, 0, 1, 0, 0)
  sc.globalAlpha = 1
  sc.globalCompositeOperation = 'source-over'
  sc.imageSmoothingEnabled = true
  sc.imageSmoothingQuality = 'high'
  sc.clearRect(0, 0, small.width, small.height)
  sc.drawImage(frame.image, b.src.x * frame.w, b.src.y * frame.h, b.src.w * frame.w, b.src.h * frame.h, 0, 0, tw, th)
  sc.restore()
  const prev = ctx.globalAlpha
  ctx.globalAlpha = prev * b.alpha
  ctx.drawImage(small, 0, 0, tw, th, 0, 0, w, h)
  ctx.fillStyle = `rgba(0,0,0,${b.darken})`
  ctx.fillRect(0, 0, w, h)
  ctx.globalAlpha = prev
}

// ---------------------------------------------------------------------------
// Quadro

/**
 * Desenha o quadro da `scene` em `ctx`. O canvas precisa ter o tamanho de `scene.format`.
 * Faltando o quadro de uma fonte (ainda carregando), o retângulo dela sai escuro: nunca lança.
 */
export function renderFrame(ctx: Ctx2D, scene: Scene, frames: FrameSet, cache: RenderCache): void {
  const { w, h } = scene.format
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  ctx.drawImage(backgroundBitmap(cache, scene.background, w, h), 0, 0)
  if (scene.backdrop) drawBackdrop(ctx, cache, scene.backdrop, frames.screen, w, h)

  if (scene.screen) drawScreen(ctx, cache, scene, scene.screen, frames.screen)
  if (scene.camera) drawCamera(ctx, cache, scene.camera, frames.camera)
  if (scene.hook) drawHook(ctx, cache, scene.hook)
  if (scene.captions) drawCaptions(ctx, cache, scene.captions)
  cache.stats.frames++
}
