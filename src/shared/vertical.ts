/**
 * O FORMATO VERTICAL 1080×1920 (M4a): caixa segura, zonas das plataformas, medidas dos layouts V-A / V-B / V-C,
 * o recorte (a "view") de cada layout, a edição PRÓPRIA do vertical dentro do documento (visão do formato) e a escolha
 * automática de layout por atividade. Código puro: sem DOM, sem Node. Tempos em ms de ORIGEM.
 */
import type { CursorData, FormatSpec } from './scene'
import type { CursorGrid } from './cursor'
import { generateAutoZooms, zoomPresetFor, DEFAULT_VERTICAL_ZOOM_PRESET } from './zoom'
import type { CaptionStyle, ClickEvent, Corner, KeyEvent, LayoutKind, LayoutSeg, Project, Range, Size, VerticalEdit, Word } from './types'

// ---------------------------------------------------------------------------
// Caixa segura e zonas das plataformas (px num quadro de 1080×1920)

export const VERTICAL_W = 1080
export const VERTICAL_H = 1920

/** A caixa única: legenda, título e câmera ficam inteiros aqui dentro (x 65-940 × y 270-1440). */
export const SAFE_BOX = { x: 65, y: 270, w: 875, h: 1170 } as const

export type PlatformId = 'tiktok' | 'reels' | 'shorts'
/** O que cada plataforma cobre com a própria interface, em px a partir de cada borda (pesquisa §5.2, fontes secundárias). */
export type PlatformZone = { id: PlatformId; name: string; top: number; bottom: number; left: number; right: number }

export const PLATFORM_ZONES: readonly PlatformZone[] = [
  { id: 'tiktok', name: 'TikTok', top: 150, bottom: 484, left: 60, right: 140 },
  { id: 'reels', name: 'Reels', top: 250, bottom: 280, left: 0, right: 100 },
  { id: 'shorts', name: 'Shorts', top: 241, bottom: 381, left: 60, right: 201 }
]

/** Quanto do quadro (escala do formato) a caixa segura ocupa. */
export function safeBoxFor(format: Pick<FormatSpec, 'w'>): { x: number; y: number; w: number; h: number } {
  const s = format.w / VERTICAL_W
  return { x: SAFE_BOX.x * s, y: SAFE_BOX.y * s, w: SAFE_BOX.w * s, h: SAFE_BOX.h * s }
}

// ---------------------------------------------------------------------------
// Medidas dos layouts (px num quadro de 1080×1920; o chamador escala)

/** V-B "Câmera + tela": câmera em y 270-850 e o recorte da tela em y 850-1440. */
export const STACK_CAMERA = { x: 0, y: 270, w: 1080, h: 580 } as const
export const STACK_SCREEN = { x: 0, y: 850, w: 1080, h: 590 } as const
/** V-C "Tela na largura": a tela cabe nesta caixa (1080×608, centro em y 660). */
export const WIDE_BOX = { x: 0, y: 356, w: 1080, h: 608 } as const
/** Bolha da câmera no vertical: 250 px (220-280) no canto da caixa segura. */
export const VERTICAL_BUBBLE_SIZE = 250 / 1080
export const VERTICAL_BUBBLE_CORNER: Corner = 'top-left'
/** O título de gancho mora em y 280-440 e aparece nos 2 primeiros segundos de SAÍDA. */
export const HOOK_BAND = { top: 280, bottom: 440 } as const
export const HOOK_MS = 2000

/** O V-B mostra, com escala 1, esta fração da ALTURA da tela (2× numa tela de 1080 px). */
export const STACK_VIEW_HEIGHT = STACK_SCREEN.h / 2 / 1080

/** Layouts verticais (os que o formato 9:16 entende). */
export const VERTICAL_LAYOUTS: readonly LayoutKind[] = ['screen-focus', 'stack', 'screen-wide', 'camera']

// ---------------------------------------------------------------------------
// O recorte de cada layout

export type View = { w: number; h: number }

/**
 * Fração da fonte que um recorte de proporção `destAspect` (largura/altura) enxerga com escala 1 quando mostra `heightFrac`
 * da altura da tela. Com a altura inteira num 9:16 sobre uma tela 16:9: 31,6% da largura (607 px de 1920).
 */
export function cropView(destAspect: number, screen: Size | null, heightFrac = 1): View {
  if (!screen || !(screen.w > 0) || !(screen.h > 0) || !(destAspect > 0)) return { w: 1, h: 1 }
  const srcAspect = screen.w / screen.h
  const h = Math.min(1, heightFrac)
  const w = h * (destAspect / srcAspect)
  return w <= 1 ? { w, h } : { w: 1, h: Math.min(1, h / w) }
}

/**
 * O recorte padrão de um layout e quanto dos zooms ele aceita.
 *  - horizontal: a tela toda; zooms inteiros;
 *  - V-A: a altura inteira (preenche o quadro 9:16); zooms inteiros;
 *  - V-B: faixa larga de ~2×; metade da força do zoom (a base já é grande);
 *  - V-C: a tela inteira, sem seguir nada nem dar zoom (serve a interface grande).
 */
export function layoutFollow(layout: LayoutKind, format: Pick<FormatSpec, 'kind' | 'w' | 'h'>, screen: Size | null): { view: View; gain: number } {
  if (format.kind === 'horizontal') return { view: { w: 1, h: 1 }, gain: 1 }
  switch (layout) {
    case 'stack':
      return { view: cropView(STACK_SCREEN.w / STACK_SCREEN.h, screen, STACK_VIEW_HEIGHT), gain: 0.5 }
    case 'screen-wide':
      return { view: { w: 1, h: 1 }, gain: 0 }
    default:
      return { view: cropView(format.w / format.h, screen, 1), gain: 1 }
  }
}

// ---------------------------------------------------------------------------
// A edição do vertical dentro do documento (visão do formato)

/** Estilo de legenda de partida do vertical (Destaque, 3 palavras por linha, ligada). */
export const VERTICAL_CAPTION_DEFAULTS: Required<Pick<CaptionStyle, 'enabled' | 'style' | 'wordsPerLine' | 'position' | 'box'>> = {
  enabled: true,
  style: 'highlight',
  wordsPerLine: 3,
  position: 'bottom',
  box: false
}

/** Os campos de legenda que cada formato tem só para si (as cores valem para os dois). */
export const FORMAT_CAPTION_KEYS = ['enabled', 'style', 'wordsPerLine', 'position', 'box', 'size', 'positionY', 'uppercase'] as const

export function defaultVerticalEdit(): VerticalEdit {
  return { layout: 'screen-focus', layouts: [], zooms: [] }
}

function perFormatCaptions(captions: Partial<CaptionStyle> | undefined): Partial<CaptionStyle> {
  const out: Record<string, unknown> = {}
  if (captions) for (const k of FORMAT_CAPTION_KEYS) if (captions[k] !== undefined) out[k] = captions[k]
  return out as Partial<CaptionStyle>
}

/**
 * O documento como o formato o enxerga. No horizontal é o próprio documento (mesmo objeto). No vertical, `zooms`,
 * `layouts`, `zoomPreset`, `style.defaultLayout`, a bolha da câmera e os campos de legenda de cada formato vêm de
 * `project.vertical`: o resto (cortes, texto, fundo, cores) é o mesmo. É sobre esta visão que `evaluateScene`,
 * a linha do tempo e os painéis trabalham: o código dos dois formatos é um só.
 */
export function projectForFormat(doc: Project, kind: FormatSpec['kind']): Project {
  if (kind === 'horizontal') return doc
  const v = doc.vertical
  const per = { ...VERTICAL_CAPTION_DEFAULTS, ...perFormatCaptions(v?.captions) }
  const captions: CaptionStyle = {
    ...per,
    highlightColor: doc.captions.highlightColor,
    ...(doc.captions.textColor !== undefined ? { textColor: doc.captions.textColor } : {})
  }
  const view: Project = {
    ...doc,
    zooms: v?.zooms ?? [],
    layouts: v?.layouts ?? [],
    style: {
      ...doc.style,
      defaultLayout: v?.layout ?? 'screen-focus',
      camera: { ...doc.style.camera, corner: v?.camera?.corner ?? VERTICAL_BUBBLE_CORNER, size: v?.camera?.size ?? VERTICAL_BUBBLE_SIZE }
    },
    captions
  }
  if (v?.zoomPreset !== undefined) view.zoomPreset = v.zoomPreset
  else delete view.zoomPreset
  return view
}

/** Devolve ao documento o que a visão de um formato mudou (o inverso de `projectForFormat`). */
export function mergeFormatView(doc: Project, view: Project, kind: FormatSpec['kind']): Project {
  if (kind === 'horizontal') return view
  const { zooms, layouts, zoomPreset, vertical: viewVertical, captions, style, ...rest } = view
  const base = doc.vertical ?? defaultVerticalEdit()
  const vertical: VerticalEdit = {
    ...base,
    layout: style.defaultLayout,
    layouts,
    zooms,
    camera: { corner: style.camera.corner, size: style.camera.size },
    captions: perFormatCaptions(captions)
  }
  if (zoomPreset !== undefined) vertical.zoomPreset = zoomPreset
  else delete vertical.zoomPreset
  const hook = viewVertical?.hook
  if (hook !== undefined && hook !== '') vertical.hook = hook
  else delete vertical.hook

  const nextCaptions: CaptionStyle = { ...doc.captions, highlightColor: captions.highlightColor }
  if (captions.textColor !== undefined) nextCaptions.textColor = captions.textColor
  else delete nextCaptions.textColor

  const next: Project = {
    ...rest,
    zooms: doc.zooms,
    layouts: doc.layouts,
    style: { ...style, defaultLayout: doc.style.defaultLayout, camera: { ...style.camera, corner: doc.style.camera.corner, size: doc.style.camera.size } },
    captions: nextCaptions,
    vertical
  }
  if (doc.zoomPreset !== undefined) next.zoomPreset = doc.zoomPreset
  return next
}

// ---------------------------------------------------------------------------
// Escolha automática de layout por atividade

/** Fala sem atividade de tela por pelo menos isto (ms) → câmera + tela (V-B). */
export const QUIET_MIN_MS = 2000
/** O V-B começa um pouco depois da última atividade e termina antes da próxima (a tela já está em foco no clique). */
const QUIET_ENTER_DELAY_MS = 500
const QUIET_EXIT_LEAD_MS = 400
const MIN_STACK_MS = 1000
/** Dois V-B separados por menos que isto viram um só (sem piscar o layout). */
const MERGE_STACK_GAP_MS = 1500
/** Cursor que andou mais que isto (normalizado) em 100 ms está em atividade. */
const MOVE_DISTANCE = 0.02
/** Pelo menos esta fração do silêncio de tela precisa ter fala para valer como "explicando". */
const SPEECH_SHARE = 0.5

export type ActivityInput = {
  durationMs: number
  hasCamera: boolean
  clicks: readonly Pick<ClickEvent, 't'>[]
  keys: readonly KeyEvent[]
  cursor: CursorGrid
  /** Onde há fala (ms de origem). `null` = não há transcrição: supõe-se que há fala o tempo todo. */
  speech: readonly Range[] | null
}

/** Onde há fala: as palavras de verdade, unidas quando a pausa entre elas é curta. */
export function speechRanges(words: readonly Word[] | null | undefined, joinMs = 500): Range[] | null {
  if (!words || words.length === 0) return null
  const out: Range[] = []
  for (const w of words) {
    if (w.kind !== 'word') continue
    const last = out[out.length - 1]
    if (last && w.start - last.end <= joinMs) last.end = Math.max(last.end, w.end)
    else out.push({ start: w.start, end: w.end })
  }
  return out
}

function mergeRanges(list: Range[]): Range[] {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ start: r.start, end: r.end })
  }
  return out
}

/** Os trechos em que a tela está fazendo algo: clique, tecla ou cursor andando. */
export function screenActivity(input: Pick<ActivityInput, 'clicks' | 'keys' | 'cursor' | 'durationMs'>): Range[] {
  const marks: Range[] = []
  for (const c of input.clicks) marks.push({ start: c.t - 300, end: c.t + 1500 })
  for (const k of input.keys) marks.push({ start: k.t, end: k.t + 1000 })
  const g = input.cursor
  const lag = 6 // 6 amostras de 60 Hz = 100 ms
  for (let i = lag; i < g.t.length; i++) {
    if (Math.hypot(g.x[i]! - g.x[i - lag]!, g.y[i]! - g.y[i - lag]!) > MOVE_DISTANCE) marks.push({ start: g.t[i]! - 100, end: g.t[i]! + 400 })
  }
  return mergeRanges(marks.map((m) => ({ start: Math.max(0, m.start), end: Math.min(input.durationMs, m.end) })).filter((m) => m.end > m.start))
}

const overlapMs = (a: Range, ranges: readonly Range[]): number => {
  let sum = 0
  for (const r of ranges) {
    if (r.end <= a.start) continue
    if (r.start >= a.end) break
    sum += Math.min(a.end, r.end) - Math.max(a.start, r.start)
  }
  return sum
}

/**
 * Trechos de layout próprios do vertical: fala SEM atividade de tela por ≥ 2 s → V-B (câmera + tela); atividade → V-A (o
 * layout padrão, sem trecho). Sem câmera não há V-B: devolve vazio.
 */
export function autoVerticalLayouts(input: ActivityInput): LayoutSeg[] {
  if (!input.hasCamera || !(input.durationMs > 0)) return []
  const active = screenActivity(input)
  const quiet: Range[] = []
  let cursor = 0
  for (const a of active) {
    if (a.start > cursor) quiet.push({ start: cursor, end: a.start })
    cursor = Math.max(cursor, a.end)
  }
  if (cursor < input.durationMs) quiet.push({ start: cursor, end: input.durationMs })

  const stacks: Range[] = []
  for (const q of quiet) {
    if (q.end - q.start < QUIET_MIN_MS) continue
    if (input.speech !== null && overlapMs(q, input.speech) < (q.end - q.start) * SPEECH_SHARE) continue
    const start = q.start <= 0 ? 0 : q.start + QUIET_ENTER_DELAY_MS
    const end = q.end >= input.durationMs ? input.durationMs : q.end - QUIET_EXIT_LEAD_MS
    if (end - start >= MIN_STACK_MS) stacks.push({ start: Math.round(start), end: Math.round(end) })
  }
  const merged: Range[] = []
  for (const s of stacks) {
    const last = merged[merged.length - 1]
    if (last && s.start - last.end < MERGE_STACK_GAP_MS) last.end = s.end
    else merged.push({ ...s })
  }
  return merged.map((r, i) => ({ id: `layout-v${i + 1}`, start: r.start, end: r.end, layout: 'stack' as const }))
}

/**
 * Entrar no 9:16 pela primeira vez: zooms do preset Intenso (escala de vertical) e layouts escolhidos pela atividade.
 * Se o vertical já foi editado ou gerado, devolve o mesmo documento. "Nunca gerado" = sem edição vertical, ou com ela vazia e sem
 * preset (um ajuste de legenda no 9:16 antes da geração cria o bloco vazio). Chamar com `history: false` no editor.
 */
export function ensureVertical(
  project: Project,
  data: Pick<CursorData, 'clicks' | 'keys' | 'grid'>,
  opts: { durationMs: number; words?: readonly Word[] | null | undefined; hasCursorEvents?: boolean }
): Project {
  const v = project.vertical
  if (v && (v.zoomPreset !== undefined || v.zooms.length > 0 || v.layouts.length > 0)) return project
  const hasEvents = opts.hasCursorEvents ?? true
  const zooms = hasEvents
    ? generateAutoZooms({ clicks: data.clicks, keys: data.keys, cursor: data.grid, duration: opts.durationMs, preset: zoomPresetFor('vertical', DEFAULT_VERTICAL_ZOOM_PRESET) })
    : []
  const layouts = autoVerticalLayouts({
    durationMs: opts.durationMs,
    hasCamera: Boolean(project.sources.camera) && !project.style.camera.hidden,
    clicks: data.clicks,
    keys: data.keys,
    cursor: data.grid,
    speech: speechRanges(opts.words)
  })
  return { ...project, vertical: { ...v, layout: v?.layout ?? 'screen-focus', layouts, zooms, ...(hasEvents ? { zoomPreset: DEFAULT_VERTICAL_ZOOM_PRESET } : {}) } }
}
