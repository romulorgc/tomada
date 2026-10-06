/**
 * A CENA: tudo que um quadro precisa, calculado de forma PURA e determinística a partir do
 * documento, dos eventos e do instante de origem. A prévia e a exportação chamam
 * as mesmas `evaluateScene` + `renderFrame`, então prévia = exportação por construção.
 *
 * Tempos em ms (tempo de ORIGEM); geometria em px do quadro de saída. Código puro: sem DOM, sem Node.
 */
import {
  computeSyntheticCursor,
  createCursorLookup,
  pressScale,
  processCursor,
  sampleSynthetic,
  type CursorGrid,
  type CursorLookup,
  type SyntheticTrack
} from './cursor'
import { buildCaptionTrack, captionAt, pageAlpha, popScale, PAGE_FADE_MS, type CaptionTrack } from './captions'
import { resolveCaptionStyle, resolveHookStyle, type CaptionRenderStyle, type HookRenderStyle } from './caption-style'
import { cropSignature, pointToCrop, rectFromCrop, resolveScreenCrop, type CropTimeline } from './crop'
import { projectDurationMs } from './project'
import { coverCrop, cameraBoxAspect, cameraRadius, cornerFractions, styleUnit } from './styles'
import { keptRanges, outputDuration, sourceToOutput } from './timeline'
import type { Background, ClickEvent, ContentRectSample, CursorSample, KeyEvent, LayoutKind, Project, Range, Rect, Size, Style, Word } from './types'
import { GRID_HZ } from './cursor'
import { HOOK_BAND, HOOK_CLEAR_Y, HOOK_MS, VERTICAL_W, WIDE_BOX, cropView, layoutFollow, safeBoxFor, stackRects, verticalCaptionY, type View } from './vertical'
import { ZOOM_SCALE_SPRING } from './spring'
import { computeCameraPath, sampleCameraPath, visibleRect, type CameraPath } from './zoom'
import { fitRect } from './geometry'

// ---------------------------------------------------------------------------
// Formato de saída

export type FormatSpec = {
  kind: 'horizontal' | 'vertical'
  /** Tamanho do quadro em px. */
  w: number
  h: number
}

export const HORIZONTAL_1080: FormatSpec = { kind: 'horizontal', w: 1920, h: 1080 }
export const VERTICAL_1080: FormatSpec = { kind: 'vertical', w: 1080, h: 1920 }

/** Constantes do projeto / especificação (tempos em ms, tamanhos em px na altura de 1080). */
export const LAYOUT_TRANSITION_MS = 400
export const RIPPLE_MS = 500
export const RIPPLE_RADIUS = 40
export const RIPPLE_ALPHA = 0.5
export const HALO_RADIUS = 30
/** A bolha da câmera encolhe esta fração durante o zoom. */
export const CAMERA_ZOOM_SHRINK = 0.3
/** Margem da bolha até a borda da tela, fração do lado menor do quadro. */
export const BUBBLE_INSET = 0.035
/** Lado a lado: fatia da largura útil que fica com a tela. */
export const SIDE_BY_SIDE_SCREEN_SHARE = 0.7

// ---------------------------------------------------------------------------
// Eventos e dados derivados

export type EventsData = {
  cursor: CursorSample[]
  clicks: ClickEvent[]
  keys: KeyEvent[]
  /** A página do navegador medida (C1), na tela gravada. */
  contentRects?: ContentRectSample[]
}

/** Eventos já processados (independem do estilo e dos zooms: reaproveitáveis entre edições). */
export type CursorData = {
  grid: CursorGrid
  lookup: CursorLookup
  /** Cliques dentro da área, em ordem de tempo. */
  clicks: ClickEvent[]
  keys: KeyEvent[]
  durationMs: number
  /** A página do navegador medida (C1), na tela gravada, para o recorte automático. */
  contentRects: ContentRectSample[]
  /**
   * O recorte aplicado (C1): cursor e cliques JÁ estão no espaço dele (0..1 dentro do recorte; o que caiu fora é `out`).
   * `null` = a tela inteira.
   */
  crop: CropTimeline | null
  /** Os dados da tela inteira, de onde o recorte parte; ausente neste mesmo (os dados "crus"). */
  origin?: CursorData
  /** Os eventos crus (tela inteira), para refazer a grade quando o recorte muda. */
  events: EventsData
}

function buildData(events: EventsData, durationMs: number, crop: CropTimeline | null): CursorData {
  const clicks = events.clicks.filter((c) => !c.out && Number.isFinite(c.t)).sort((a, b) => a.t - b.t)
  return {
    grid: processCursor(events.cursor, clicks, { durationMs }),
    lookup: createCursorLookup(events.cursor),
    clicks,
    keys: [...events.keys].sort((a, b) => a.t - b.t),
    durationMs,
    contentRects: events.contentRects ?? [],
    crop,
    events
  }
}

export function prepareEvents(events: EventsData, durationMs: number): CursorData {
  return buildData(events, durationMs, null)
}

const cropCache = new WeakMap<CursorData, Map<string, CursorData>>()

/**
 * O recorte do documento aplicado aos eventos (C1): cursor e cliques passam para o espaço do recorte (o que cai fora - uma aba, a
 * barra de endereço - vira `out`: não abre zoom, não faz ripple e não puxa a câmera). Sem recorte (ou sem a tela gravada) devolve os
 * dados crus. Guarda o resultado: só refaz a grade quando o recorte pedido muda (arrastar um controle não a recalcula).
 */
export function applyScreenCrop(data: CursorData, project: Pick<Project, 'screenCrop' | 'sources'>): CursorData {
  const origin = data.origin ?? data
  const src = project.sources.screen
  const sourcePx = src && src.w > 0 && src.h > 0 ? { w: src.w, h: src.h } : null
  const sig = `${cropSignature(project.screenCrop)}|${sourcePx ? `${sourcePx.w}x${sourcePx.h}` : '-'}`
  let byOrigin = cropCache.get(origin)
  if (!byOrigin) {
    byOrigin = new Map()
    cropCache.set(origin, byOrigin)
  }
  const hit = byOrigin.get(sig)
  if (hit) return hit
  const crop = resolveScreenCrop(project.screenCrop, origin.contentRects, sourcePx)
  let out: CursorData
  if (!crop) {
    out = origin
  } else {
    const events = origin.events
    const cursor: CursorSample[] = events.cursor.map((p) => {
      const c = pointToCrop(crop.at(p.t), p)
      const next: CursorSample = { t: p.t, x: c.x, y: c.y }
      if (p.out || c.out) next.out = true
      return next
    })
    const clicks: ClickEvent[] = events.clicks.map((k) => {
      const c = pointToCrop(crop.at(k.t), k)
      const next: ClickEvent = { ...k, x: c.x, y: c.y }
      if (k.out || c.out) next.out = true
      return next
    })
    out = { ...buildData({ cursor, clicks, keys: events.keys, contentRects: events.contentRects }, origin.durationMs, crop), origin, events: origin.events }
  }
  byOrigin.set(sig, out)
  return out
}

type LayoutPoint = { t: number; layout: LayoutKind }

export type Derived = {
  format: FormatSpec
  /** Duração da gravação (ms, tempo de origem). */
  durationMs: number
  kept: Range[]
  /** Duração do vídeo de saída (ms). */
  outputDurationMs: number
  data: CursorData
  /** O recorte da tela (C1) ou `null` (a tela inteira). Com ele, `data` está no espaço do recorte e `screenSize` é o tamanho dele. */
  crop: CropTimeline | null
  /** A moldura de navegador (C1, opcional): a fração da ALTURA do cartão da tela que a barra ocupa, e o texto. Só no 16:9. */
  bar: { fraction: number; text: string } | null
  /** O caminho da câmera do layout padrão (no 16:9 é o único; no vertical há um por layout, em `paths`). */
  cameraPath: CameraPath
  /** Um caminho de câmera por recorte: no 16:9 só `main`; no vertical, um por layout usado (V-A, V-B, V-C). */
  paths: Record<string, { view: View; path: CameraPath }>
  synthetic: SyntheticTrack
  /** Fração da fonte visível com escala 1 (proporção do recorte do layout padrão). */
  view: { w: number; h: number }
  /** As legendas (M4a): páginas no tempo de SAÍDA, ou `null` (desligadas ou sem transcrição). */
  captions: CaptionTrack | null
  /** O tamanho da área-base da tela em px: o recorte (com a barra, se houver) ou a tela gravada inteira. */
  screenSize: Size | null
  cameraSize: Size | null
  layoutPoints: LayoutPoint[]
}

/** A barra da moldura de navegador, em fração da altura da página (C1). */
export const BROWSER_BAR_RATIO = 0.06

/** Fração da fonte que um recorte do formato enxerga com escala 1. Horizontal: tudo. Vertical: faixa 9:16. */
export function baseView(format: FormatSpec, screen: Size | null): { w: number; h: number } {
  if (format.kind === 'horizontal') return { w: 1, h: 1 }
  return cropView(format.w / format.h, screen, 1)
}

const sizeOf = (src: { w: number; h: number } | undefined): Size | null => (src && src.w > 0 && src.h > 0 ? { w: src.w, h: src.h } : null)

/** Camadas de layout ao longo do tempo: `[{t, layout}]`, o primeiro em −∞ com o layout padrão. */
export function buildLayoutPoints(project: Pick<Project, 'layouts' | 'style'>): LayoutPoint[] {
  const base = project.style.defaultLayout
  const segs = project.layouts.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
  const bounds = [...new Set(segs.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b)
  const points: LayoutPoint[] = [{ t: Number.NEGATIVE_INFINITY, layout: base }]
  for (const b of bounds) {
    let layout: LayoutKind = base
    let bestStart = Number.NEGATIVE_INFINITY
    for (const s of segs) {
      if (s.start <= b && b < s.end && s.start >= bestStart) {
        layout = s.layout
        bestStart = s.start
      }
    }
    if (points[points.length - 1]!.layout !== layout) points.push({ t: b, layout })
  }
  return points
}

/** Layout vigente em `t`, o anterior e quando a troca começou. */
export function layoutAt(points: readonly LayoutPoint[], t: number): { layout: LayoutKind; prev: LayoutKind; since: number } {
  let lo = 0
  let hi = points.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (points[mid]!.t <= t) lo = mid
    else hi = mid - 1
  }
  const cur = points[lo]!
  const prev = lo > 0 ? points[lo - 1]!.layout : cur.layout
  return { layout: cur.layout, prev, since: cur.t }
}

const TRIVIAL_PATH: CameraPath = { hz: GRID_HZ, t: [0], scale: [1], cx: [0.5], cy: [0.5], maxScale: 1 }

/**
 * Tudo que depende do documento (zooms, cortes, layouts, estilo do cursor) e do formato. No vertical, `project` é a VISÃO do
 * vertical (`projectForFormat`): os zooms e layouts dele. `words` são as palavras da transcrição (legendas).
 */
export function deriveProject(project: Project, rawData: CursorData, format: FormatSpec, words?: readonly Word[] | null): Derived {
  const durationMs = projectDurationMs(project)
  const kept = keptRanges(durationMs, project.cuts)
  // O recorte da tela (C1): a área-base passa a ser a página; o cursor e os cliques já vêm no espaço dela
  const data = applyScreenCrop(rawData, project)
  const crop = data.crop
  const full = sizeOf(project.sources.screen)
  const barOn = crop !== null && format.kind === 'horizontal' && project.screenCrop?.browserFrame?.enabled === true
  const baseSize: Size | null = crop ? crop.sizePx : full
  const screenSize: Size | null = baseSize && barOn ? { w: baseSize.w, h: Math.round(baseSize.h * (1 + BROWSER_BAR_RATIO)) } : baseSize
  const bar = barOn ? { fraction: BROWSER_BAR_RATIO / (1 + BROWSER_BAR_RATIO), text: (project.screenCrop?.browserFrame?.domain ?? '').trim() } : null
  const cameraSize = project.style.camera.hidden ? null : sizeOf(project.sources.camera)
  const sourceAspect = baseSize ? baseSize.w / baseSize.h : 16 / 9
  const layoutPoints = buildLayoutPoints(project)

  // Um caminho de câmera por RECORTE: no 16:9 o recorte é sempre a fonte toda (um caminho só); no vertical cada layout
  // (V-A, V-B, V-C) enxerga uma fatia diferente da tela e dá aos zooms uma força diferente.
  const paths: Derived['paths'] = {}
  const hasScreen = screenSize !== null
  const hasCamera = cameraSize !== null
  const mainKey = resolveLayout(project.style.defaultLayout, hasScreen, hasCamera, format.kind)
  if (format.kind === 'horizontal') {
    const view = { w: 1, h: 1 }
    paths.main = { view, path: computeCameraPath(project, data.grid, { durationMs, view, sourceAspect, scaleSpring: ZOOM_SCALE_SPRING.horizontal }) }
  } else {
    const keys = new Set<string>([mainKey])
    for (const pt of layoutPoints) keys.add(resolveLayout(pt.layout, hasScreen, hasCamera, format.kind))
    for (const key of keys) {
      const f = layoutFollow(key as LayoutKind, format, baseSize)
      if (key === 'camera' || !hasScreen || f.gain === 0) {
        paths[key] = { view: f.view, path: TRIVIAL_PATH }
        continue
      }
      const zooms = project.zooms.map((z) => ({ ...z, scale: 1 + (z.scale - 1) * f.gain }))
      paths[key] = { view: f.view, path: computeCameraPath({ zooms }, data.grid, { durationMs, view: f.view, sourceAspect, scaleSpring: ZOOM_SCALE_SPRING.vertical }) }
    }
  }
  const main = paths.main ?? paths[mainKey] ?? Object.values(paths)[0] ?? { view: { w: 1, h: 1 }, path: TRIVIAL_PATH }
  const view = main.view
  const cameraPath = main.path
  const synthetic = computeSyntheticCursor(data.lookup, {
    durationMs,
    hideAfterIdleMs: project.style.cursor.hideAfterIdleMs,
    activity: data.clicks.map((c) => c.t)
  })
  return {
    format,
    durationMs,
    kept,
    outputDurationMs: outputDuration(durationMs, project.cuts),
    data,
    crop,
    bar,
    cameraPath,
    paths,
    synthetic,
    view,
    captions: buildCaptionTrack(words, project, durationMs),
    screenSize,
    cameraSize,
    layoutPoints
  }
}

// ---------------------------------------------------------------------------
// Geometria dos layouts

export type CameraBox = { rect: Rect; radius: number }
export type LayoutGeometry = { screen: Rect | null; camera: CameraBox | null }

/**
 * Layout efetivo: o que o documento pede, ajustado ao que existe (sem câmera não há bolha;
 * sem tela só há câmera) e ao formato. No vertical valem V-A `screen-focus`, V-B `stack`, V-C `screen-wide` e só câmera;
 * o que é do 16:9 vira V-A. No horizontal, os verticais caem nos equivalentes horizontais.
 */
export function resolveLayout(layout: LayoutKind, hasScreen: boolean, hasCamera: boolean, kind: FormatSpec['kind']): LayoutKind {
  if (!hasScreen && hasCamera) return 'camera'
  if (!hasScreen && !hasCamera) return 'screen'
  let l = layout
  if (kind === 'horizontal') {
    if (l === 'stack') l = 'side-by-side'
    if (l === 'screen-focus' || l === 'screen-wide') l = 'bubble'
  } else if (l !== 'camera' && l !== 'stack' && l !== 'screen-wide') {
    l = 'screen-focus'
  }
  if (!hasCamera) {
    // sem câmera: no vertical sobram o recorte que segue o cursor e a tela na largura; no 16:9, só a tela
    if (kind === 'vertical') return l === 'screen-wide' ? 'screen-wide' : 'screen-focus'
    if (l === 'bubble' || l === 'side-by-side' || l === 'camera') return 'screen'
  }
  return l
}

const snap = (r: Rect): Rect => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)) })

/**
 * Retângulos (px do quadro de saída) de cada elemento num layout. `zoomProgress` (0..1) é quanto
 * o zoom já está aberto: a bolha da câmera encolhe até 30% com ele.
 */
export function layoutGeometry(
  layout: LayoutKind,
  style: Style,
  format: FormatSpec,
  sources: { screen: Size | null; camera: Size | null },
  zoomProgress = 0
): LayoutGeometry {
  const L = resolveLayout(layout, Boolean(sources.screen), Boolean(sources.camera), format.kind)
  const { w: W, h: H } = format
  const unit = styleUnit(format)
  const side = Math.min(W, H)
  const pad = Math.round(Math.max(0, Math.min(0.3, style.padding)) * side)
  const inner: Rect = { x: pad, y: pad, w: W - 2 * pad, h: H - 2 * pad }
  const cornerRadius = style.radius * unit
  const full: Rect = { x: 0, y: 0, w: W, h: H }

  if (L === 'camera') {
    if (!sources.camera) return { screen: null, camera: null }
    if (format.kind === 'vertical') return { screen: null, camera: { rect: snap(full), radius: 0 } }
    const rect = snap(fitRect(sources.camera, inner))
    return { screen: null, camera: { rect, radius: cornerRadius } }
  }

  if (L === 'screen-focus') {
    // vertical V-A: o recorte da tela ocupa o quadro todo; a câmera é uma bolha no canto da caixa segura
    return { screen: snap(full), camera: sources.camera ? bubbleVertical(style, format, zoomProgress) : null }
  }

  if (L === 'stack') {
    // vertical V-B SEM barras: a tela em cima (y 0-960) e a câmera embaixo (y 960-1920), de ponta a ponta e sem cantos; com
    // `stackCameraTop` as duas trocam de lugar
    const k = format.w / VERTICAL_W
    const sc = (r: { x: number; y: number; w: number; h: number }): Rect => snap({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k })
    const halves = stackRects(style.stackCameraTop === true)
    return { screen: sources.screen ? sc(halves.screen) : null, camera: sources.camera ? { rect: sc(halves.camera), radius: 0 } : null }
  }

  if (L === 'screen-wide') {
    // vertical V-C: o vídeo 16:9 com 94% da largura e o centro em y 50%; o fundo é o mesmo vídeo desfocado
    const k = format.w / VERTICAL_W
    const box: Rect = { x: WIDE_BOX.x * k, y: WIDE_BOX.y * k, w: WIDE_BOX.w * k, h: WIDE_BOX.h * k }
    return { screen: sources.screen ? snap(fitRect(sources.screen, box)) : null, camera: sources.camera ? bubbleVertical(style, format, zoomProgress) : null }
  }

  if (!sources.screen) return { screen: null, camera: null }

  if (L === 'screen') return { screen: snap(fitRect(sources.screen, inner)), camera: null }

  if (L === 'side-by-side') {
    const gap = Math.round(pad * 0.6)
    const aspect = sources.screen.w / sources.screen.h
    let screenW = (inner.w - gap) * SIDE_BY_SIDE_SCREEN_SHARE
    let cardH = screenW / aspect
    if (cardH > inner.h) {
      cardH = inner.h
      screenW = cardH * aspect
    }
    const camW = Math.max(1, inner.w - gap - screenW)
    const x0 = inner.x + (inner.w - (screenW + gap + camW)) / 2
    const y0 = inner.y + (inner.h - cardH) / 2
    const screen = snap({ x: x0, y: y0, w: screenW, h: cardH })
    const camera = snap({ x: screen.x + screen.w + gap, y: screen.y, w: camW, h: screen.h })
    return { screen, camera: { rect: camera, radius: cornerRadius } }
  }

  // 'bubble': tela grande + bolha no canto
  const screen = snap(fitRect(sources.screen, inner))
  return { screen, camera: sources.camera ? bubble(style, format, screen, zoomProgress) : null }
}

/** Bolha da câmera do vertical: na posição 3×3 do estilo, mas dentro da CAIXA SEGURA (nunca sob a interface da plataforma). */
function bubbleVertical(style: Style, format: FormatSpec, zoomProgress: number): CameraBox {
  const side = Math.min(format.w, format.h)
  const factor = 1 - CAMERA_ZOOM_SHRINK * clamp01(zoomProgress)
  const d = style.camera.size * side * factor
  const aspect = cameraBoxAspect(style.camera.shape)
  const w = d * aspect
  const h = d
  const box = safeBoxFor(format)
  const { fx, fy } = cornerFractions(style.camera.corner)
  const x = fx === 0 ? box.x : fx === 1 ? box.x + box.w - w : box.x + (box.w - w) / 2
  const y = fy === 0 ? box.y : fy === 1 ? box.y + box.h - h : box.y + (box.h - h) / 2
  const rect = snap({ x, y, w, h })
  return { rect, radius: cameraRadius(style.camera.shape, rect.w, rect.h) }
}

/** Bolha da câmera dentro de `ref` (a tela), na posição 3×3 do estilo. */
function bubble(style: Style, format: FormatSpec, ref: Rect, zoomProgress: number): CameraBox {
  const side = Math.min(format.w, format.h)
  const factor = 1 - CAMERA_ZOOM_SHRINK * clamp01(zoomProgress)
  const d = style.camera.size * side * factor
  const aspect = cameraBoxAspect(style.camera.shape)
  const w = d * aspect
  const h = d
  const inset = BUBBLE_INSET * side
  const { fx, fy } = cornerFractions(style.camera.corner)
  const x = fx === 0 ? ref.x + inset : fx === 1 ? ref.x + ref.w - inset - w : ref.x + (ref.w - w) / 2
  const y = fy === 0 ? ref.y + inset : fy === 1 ? ref.y + ref.h - inset - h : ref.y + (ref.h - h) / 2
  const rect = snap({ x, y, w, h })
  return { rect, radius: cameraRadius(style.camera.shape, rect.w, rect.h) }
}

// ---------------------------------------------------------------------------
// Cena

export type ShadowSpec = { blur: number; opacity: number; offsetY: number }

export type SceneScreen = {
  dest: Rect
  /** Recorte da fonte (normalizado 0..1 na TELA GRAVADA): o que o zoom enxerga dentro da área-base (o recorte da tela, se houver). */
  src: Rect
  /** Moldura de navegador (C1): a barra ocupa o topo do cartão (`h` px de `dest`); a página é desenhada abaixo dela. */
  bar?: { h: number; text: string }
  radius: number
  opacity: number
  shadow: ShadowSpec | null
}

export type SceneCamera = {
  dest: Rect
  /** Recorte "cobrir" da fonte da câmera (normalizado). */
  src: Rect
  radius: number
  opacity: number
  mirror: boolean
  border: { width: number; color: string } | null
  shadow: ShadowSpec | null
}

export type SceneBackdrop = { src: Rect; darken: number; alpha: number }

export type SceneCaptions = {
  /** Identifica a página (cache do layout do texto): trilha + página. */
  key: string
  style: CaptionRenderStyle
  /** As palavras da página como se mostram (a caixa-alta, se o estilo pede, o desenho aplica). */
  words: string[]
  /** Palavra acesa (índice na página) ou −1. */
  active: number
  /** Escala da palavra acesa (o "pop"). */
  pop: number
  /** Opacidade da página (entrada e saída) e quanto ela ainda sobe ao entrar (px). */
  alpha: number
  dy: number
}

export type SceneHook = { text: string; alpha: number; style: HookRenderStyle }

export type SceneRipple = { x: number; y: number; radius: number; alpha: number }
export type SceneHalo = { x: number; y: number; radius: number; alpha: number }
export type SceneCursor = { x: number; y: number; scale: number; alpha: number }

export type Scene = {
  t: number
  format: FormatSpec
  /** px por "px de 1080" (ver `styleUnit`). */
  unit: number
  background: Background
  screen: SceneScreen | null
  camera: SceneCamera | null
  ripples: SceneRipple[]
  halo: SceneHalo | null
  /** Cursor sintético (só no modo `synthetic`). */
  cursor: SceneCursor | null
  /** Fundo do V-C: a própria tela, desfocada e escurecida (substitui o fundo do estilo, com `alpha`). */
  backdrop: SceneBackdrop | null
  /** A legenda na tela agora (M4a). */
  captions: SceneCaptions | null
  /** O título de gancho dos 2 primeiros segundos do vertical. */
  hook: SceneHook | null
  debug: { layout: LayoutKind; previous: LayoutKind; transition: number; zoom: { scale: number; cx: number; cy: number } }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u
const lerpRect = (a: Rect, b: Rect, u: number): Rect => ({
  x: lerp(a.x, b.x, u),
  y: lerp(a.y, b.y, u),
  w: lerp(a.w, b.w, u),
  h: lerp(a.h, b.h, u)
})
const scaleAround = (r: Rect, s: number): Rect => ({
  x: r.x + (r.w * (1 - s)) / 2,
  y: r.y + (r.h * (1 - s)) / 2,
  w: r.w * s,
  h: r.h * s
})

export const easeInOutCubic = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)
export const easeOutCubic = (u: number): number => 1 - Math.pow(1 - u, 3)
const smoothstep = (u: number): number => u * u * (3 - 2 * u)

/** Elemento que existe em um dos layouts da transição (ou nos dois). */
function blendElement<T extends { rect: Rect; radius: number }>(
  a: T | null,
  b: T | null,
  e: number
): { rect: Rect; radius: number; opacity: number } | null {
  if (a && b) return { rect: lerpRect(a.rect, b.rect, e), radius: lerp(a.radius, b.radius, e), opacity: 1 }
  if (b) return { rect: scaleAround(b.rect, 0.94 + 0.06 * e), radius: b.radius, opacity: e }
  if (a) return { rect: scaleAround(a.rect, 1 - 0.06 * e), radius: a.radius, opacity: 1 - e }
  return null
}

/** O raio dos cantos do cartão da tela: no 16:9, o do estilo; no vertical, só a tela na largura (V-C) é um cartão. */
function screenRadius(layout: LayoutKind, style: Style, unit: number, kind: FormatSpec['kind'], hasScreen: boolean, hasCamera: boolean): number {
  if (kind === 'horizontal') return style.radius * unit
  return resolveLayout(layout, hasScreen, hasCamera, kind) === 'screen-wide' ? style.radius * unit : 0
}

/** O recorte da tela (normalizado na fonte) num instante, para o layout `key`. */
function sourceRectOf(derived: Derived, key: string, t: number): { src: Rect; scale: number } {
  const entry = derived.paths[key] ?? derived.paths.main ?? { view: derived.view, path: derived.cameraPath }
  const sample = sampleCameraPath(entry.path, t)
  return { src: visibleRect(sample, entry.view), scale: sample.scale }
}

/**
 * A cena do quadro em `sourceT` (ms, tempo de origem). Pura e determinística: mesma entrada,
 * mesma saída; sem estado entre quadros (o caminho do zoom foi pré-calculado em `deriveProject`).
 */
export function evaluateScene(project: Project, derived: Derived, sourceT: number, format: FormatSpec): Scene {
  const style = project.style
  const unit = styleUnit(format)
  const kind = format.kind
  const vertical = kind === 'vertical'
  const sources = { screen: derived.screenSize, camera: derived.cameraSize }
  const hasScreen = sources.screen !== null
  const hasCamera = sources.camera !== null

  const { layout, prev, since } = layoutAt(derived.layoutPoints, sourceT)
  // um trecho que começa no instante 0 não "chega": o vídeo já abre nele (senão o primeiro meio segundo seria uma transição)
  const p = layout === prev || since <= 0 ? 1 : clamp01((sourceT - since) / LAYOUT_TRANSITION_MS)
  const e = p >= 1 ? 1 : easeInOutCubic(p)
  const curKey = resolveLayout(layout, hasScreen, hasCamera, kind)
  const prevKey = resolveLayout(prev, hasScreen, hasCamera, kind)

  const cur = sourceRectOf(derived, curKey, sourceT)
  // "encolher no zoom" desligado: a bolha mantém o tamanho com o zoom aberto
  const zoomProgress = style.camera.shrinkOnZoom ? smoothstep(clamp01((cur.scale - 1) / 0.5)) : 0
  const sample = sampleCameraPath((derived.paths[curKey] ?? derived.paths.main ?? { path: derived.cameraPath }).path, sourceT)

  const gCur = layoutGeometry(layout, style, format, sources, zoomProgress)
  const gPrev = p < 1 ? layoutGeometry(prev, style, format, sources, zoomProgress) : null

  const rCur = screenRadius(layout, style, unit, kind, hasScreen, hasCamera)
  const rPrev = screenRadius(prev, style, unit, kind, hasScreen, hasCamera)
  const screenBox = gPrev
    ? blendElement(gPrev.screen ? { rect: gPrev.screen, radius: rPrev } : null, gCur.screen ? { rect: gCur.screen, radius: rCur } : null, e)
    : gCur.screen
      ? { rect: gCur.screen, radius: rCur, opacity: 1 }
      : null
  const cameraBox = gPrev ? blendElement(gPrev.camera, gCur.camera, e) : gCur.camera ? { ...gCur.camera, opacity: 1 } : null

  // o recorte da fonte: durante a troca de layout (V-A ↔ V-B…) a janela passa de um enquadramento ao outro
  let srcRect = cur.src
  if (p < 1 && prevKey !== curKey) {
    const before = sourceRectOf(derived, prevKey, sourceT)
    srcRect = lerpRect(before.src, cur.src, e)
  }

  // a tela flutua (com sombra) no 16:9 e na tela na largura do vertical; nos outros verticais ela é de borda a borda
  const wide = curKey === 'screen-wide' || (p < 1 && prevKey === 'screen-wide')
  const shadowOn = !vertical || wide
  const shadowOf = (scaleBlur: number, scaleOffset: number): ShadowSpec | null =>
    style.shadow.opacity > 0 && style.shadow.blur > 0
      ? { blur: style.shadow.blur * unit * scaleBlur, opacity: style.shadow.opacity, offsetY: style.shadow.offsetY * unit * scaleOffset }
      : null

  // O recorte da tela (C1): `srcRect` está no espaço do recorte (0..1 dentro dele); o desenho precisa dele na tela gravada
  const cropAt = derived.crop ? derived.crop.at(sourceT) : null
  const inSource = (r: Rect): Rect => (cropAt ? rectFromCrop(cropAt, r) : r)
  const barOf = (dest: Rect): { h: number; text: string } | undefined => (derived.bar ? { h: Math.round(dest.h * derived.bar.fraction), text: derived.bar.text } : undefined)

  const screen: SceneScreen | null = screenBox
    ? {
        dest: screenBox.rect,
        src: inSource(srcRect),
        ...(derived.bar ? { bar: barOf(screenBox.rect)! } : {}),
        radius: screenBox.radius,
        opacity: screenBox.opacity,
        shadow: shadowOn ? shadowOf(1, 1) : null
      }
    : null

  const camera: SceneCamera | null =
    cameraBox && derived.cameraSize
      ? {
          dest: cameraBox.rect,
          src: coverCrop(derived.cameraSize, cameraBox.rect.w / cameraBox.rect.h),
          radius: cameraBox.radius,
          opacity: cameraBox.opacity,
          mirror: style.camera.mirror,
          border: style.camera.borderWidth > 0 && !(vertical && curKey === 'stack') ? { width: style.camera.borderWidth * unit, color: style.camera.borderColor } : null,
          shadow: vertical && curKey === 'stack' ? null : shadowOf(0.6, 0.5)
        }
      : null

  // fundo da tela na largura: o próprio vídeo, desfocado e escurecido
  let backdrop: SceneBackdrop | null = null
  const wideWeight = (curKey === 'screen-wide' ? e : 0) + (p < 1 && prevKey === 'screen-wide' && prevKey !== curKey ? 1 - e : 0)
  if (vertical && derived.screenSize && wideWeight > 0.002) {
    backdrop = { src: inSource(coverCrop(derived.screenSize, format.w / format.h)), darken: 0.58, alpha: Math.min(1, wideWeight) }
  }

  // posição normalizada na fonte → px do quadro de saída (pelo recorte do zoom)
  const toDest = (nx: number, ny: number): { x: number; y: number } | null => {
    if (!screen) return null
    // com a barra da moldura, a página é só a parte do cartão abaixo dela
    const barH = screen.bar?.h ?? 0
    return {
      x: screen.dest.x + ((nx - srcRect.x) / srcRect.w) * screen.dest.w,
      y: screen.dest.y + barH + ((ny - srcRect.y) / srcRect.h) * (screen.dest.h - barH)
    }
  }

  // no vertical o ripple, o halo e o cursor ficam maiores: o vídeo passa num celular
  const rippleK = vertical ? 1.7 : 1
  const haloK = vertical ? 1.5 : 1
  const cursorK = vertical ? 1.4 : 1

  const ripples: SceneRipple[] = []
  if (screen && style.cursor.ripple) {
    const clicks = derived.data.clicks
    // primeiro clique que ainda pode estar ativo (busca binária)
    let lo = 0
    let hi = clicks.length
    const from = sourceT - RIPPLE_MS
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (clicks[mid]!.t < from) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < clicks.length; i++) {
      const c = clicks[i]!
      if (c.t > sourceT) break
      const u = (sourceT - c.t) / RIPPLE_MS
      if (u < 0 || u >= 1) continue
      const eased = easeOutCubic(u)
      const pos = toDest(c.x, c.y)
      if (!pos) continue
      ripples.push({ x: pos.x, y: pos.y, radius: RIPPLE_RADIUS * unit * rippleK * eased, alpha: RIPPLE_ALPHA * (1 - eased) * screen.opacity })
    }
  }

  let halo: SceneHalo | null = null
  let cursor: SceneCursor | null = null
  if (screen) {
    if (style.cursor.mode === 'real') {
      if (style.cursor.halo) {
        const c = derived.data.lookup.at(sourceT)
        const pos = c.out ? null : toDest(c.x, c.y)
        if (pos) halo = { x: pos.x, y: pos.y, radius: HALO_RADIUS * unit * haloK, alpha: screen.opacity }
      }
    } else {
      const s = sampleSynthetic(derived.synthetic, sourceT)
      const pos = toDest(s.x, s.y)
      if (pos && s.alpha > 0.003) {
        cursor = { x: pos.x, y: pos.y, scale: style.cursor.scale * unit * cursorK * pressScale(derived.data.clicks, sourceT), alpha: s.alpha * screen.opacity }
      }
    }
  }

  // --- legenda e título de gancho (tempo de SAÍDA) ------------------------------------------------------------------
  let captions: SceneCaptions | null = null
  let hook: SceneHook | null = null
  const hookText = vertical ? (project.vertical?.hook ?? '').trim() : ''
  if (derived.captions || hookText !== '') {
    const outT = sourceToOutput(sourceT, derived.kept)
    if (derived.captions) {
      const m = captionAt(derived.captions, outT)
      if (m) {
        // no vertical a posição padrão vem do layout (V-B: a emenda tela/câmera; tela na largura: 71%; senão 70%) e acompanha a
        // troca de layout, para a legenda não dar um salto no meio de uma página
        const autoY = vertical ? lerp(verticalCaptionY(prevKey), verticalCaptionY(curKey), e) : undefined
        const rs = resolveCaptionStyle(project.captions, format, autoY)
        captions = {
          key: `${derived.captions.id}:${m.page.id}`,
          style: rs,
          words: m.page.words.map((w) => w.shown),
          active: m.active,
          pop: rs.active.pop > 0 && m.active >= 0 ? popScale(m.sinceActive, rs.active.pop) : 1,
          alpha: pageAlpha(m),
          dy: (1 - clamp01(m.sinceStart / PAGE_FADE_MS)) * 8 * unit
        }
      }
    }
    if (hookText !== '' && outT < HOOK_MS) {
      const alpha = Math.min(clamp01(outT / 150), clamp01((HOOK_MS - outT) / 300))
      hook = { text: hookText, alpha, style: resolveHookStyle(format, HOOK_BAND) }
    }
  }

  // O gancho e a bolha da câmera nunca se sobrepõem: enquanto o gancho está na tela a bolha desce para abaixo dele (a descida
  // acompanha o fade do gancho, então não há salto). Só as bolhas (V-A e V-C): no V-B a câmera é metade do quadro e o gancho fica
  // por cima dela, e no "só câmera" não há bolha.
  if (hook && camera && vertical && (curKey === 'screen-focus' || curKey === 'screen-wide')) {
    const k = format.w / VERTICAL_W
    const clearY = HOOK_CLEAR_Y * k
    const top = camera.dest.y
    if (top < clearY && top + camera.dest.h > HOOK_BAND.top * k) {
      camera.dest = { ...camera.dest, y: lerp(top, clearY, hook.alpha) }
    }
  }

  return {
    t: sourceT,
    format,
    unit,
    background: style.background,
    screen,
    camera,
    ripples,
    halo,
    cursor,
    backdrop,
    captions,
    hook,
    debug: { layout, previous: prev, transition: p, zoom: sample }
  }
}
