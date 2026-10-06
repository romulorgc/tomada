/**
 * O FORMATO VERTICAL 1080×1920 (M4a): caixa segura, zonas das plataformas, medidas dos layouts V-A / V-B / V-C,
 * o recorte (a "view") de cada layout, a edição PRÓPRIA do vertical dentro do documento (visão do formato) e a escolha
 * automática de layout por atividade. Código puro: sem DOM, sem Node. Tempos em ms de ORIGEM.
 */
import type { CursorData, FormatSpec } from './scene'
import type { CursorGrid } from './cursor'
import { PRESENTER, resolvePresenter } from './styles'
import { keptRanges } from './timeline'
import { generateAutoZooms, zoomPresetFor, DEFAULT_VERTICAL_ZOOM_PRESET } from './zoom'
import type { CaptionStyle, ClickEvent, Corner, KeyEvent, LayoutKind, LayoutSeg, PresenterStyle, Project, Range, Size, VerticalEdit, Word } from './types'

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

/**
 * V-B "Tela + câmera" SEM BARRAS (estudo E1, 05/10/2026: nos vídeos reais a tela ocupa 48% [44-61] da altura e a câmera 50%
 * [38-50], de ponta a ponta, 0-100%): a tela em cima (y 0-960) e a câmera embaixo (y 960-1920). A opção "câmera em cima"
 * (`Style.stackCameraTop`) troca as duas de lugar. A emenda fica a meio do quadro.
 */
export const STACK_SPLIT = 960
export const STACK_SCREEN = { x: 0, y: 0, w: 1080, h: STACK_SPLIT } as const
export const STACK_CAMERA = { x: 0, y: STACK_SPLIT, w: 1080, h: VERTICAL_H - STACK_SPLIT } as const
/** As duas metades do V-B (px de um quadro de 1080×1920), na ordem pedida. */
export function stackRects(cameraTop = false): { screen: { x: number; y: number; w: number; h: number }; camera: { x: number; y: number; w: number; h: number } } {
  return cameraTop
    ? { screen: { x: 0, y: VERTICAL_H - STACK_SCREEN.h, w: 1080, h: STACK_SCREEN.h }, camera: { x: 0, y: 0, w: 1080, h: STACK_CAMERA.h } }
    : { screen: { ...STACK_SCREEN }, camera: { ...STACK_CAMERA } }
}
/** V-C "Tela na largura": o vídeo 16:9 com 94% da largura e centro em y 50% (1016×572, y 674-1246). */
export const WIDE_BOX = { x: 32, y: 674, w: 1016, h: 572 } as const
/** Quadrado entre o gancho (y 15%) e a legenda (y 70%): 900 px de destino, 1080 px de fonte em 1080p. */
export const CENTER_BOX = { x: 90, y: 384, w: 900, h: 900 } as const
export const CENTER_ZOOM_MAX = 1.35
/** Bolha da câmera no vertical: 250 px (220-280) no canto da caixa segura. */
export const VERTICAL_BUBBLE_SIZE = 250 / 1080
export const VERTICAL_BUBBLE_CORNER: Corner = 'top-left'
/**
 * O título de gancho: maiúscula de 46 px (Anton de 54 px), centro em y 15% (288 px) e fica ≥ 4 s de SAÍDA (E1: 44 px [41-48],
 * y 14,7% [11-29], e em 3 de 3 canais com título fixo ele fica o vídeo todo). A faixa dá folga para duas linhas.
 */
export const HOOK_CENTER_Y = 288
export const HOOK_BAND = { top: HOOK_CENTER_Y - 60, bottom: HOOK_CENTER_Y + 60 } as const
export const HOOK_MS = 4000
/** Enquanto o gancho está na tela a bolha da câmera fica abaixo dele (os dois nunca se sobrepõem). */
export const HOOK_CLEAR_Y = HOOK_BAND.bottom + 16

/** O V-B usa agora a altura inteira da fonte no quadrado; não amplia mais a faixa estreita de 2×. */
export const STACK_VIEW_HEIGHT = 1

/** Centro vertical padrão da legenda no vertical: y 70% (E1: 70,3% [58,7-77,9]); na tela na largura, 71%. */
export const CAPTION_Y_VERTICAL = 0.7
export const CAPTION_Y_WIDE = 0.71

/**
 * Onde a legenda do vertical fica (fração da altura) em cada layout, quando a pessoa não escolheu uma posição: em 70% (≈ y 1344);
 * na tela na largura, 71%; no V-B, na EMENDA tela/câmera quando ela cai entre 45% e 70% (3 de 5 canais com essa estrutura).
 */
export function verticalCaptionY(layout: LayoutKind, presenter?: PresenterStyle): number {
  if (layout === 'screen-wide') return CAPTION_Y_WIDE
  // V-D (apresentador recortado): logo ACIMA da cabeça, sem cobrir o rosto (nos Shorts verdes medidos o centro da legenda fica de 3 a 12 pontos acima do topo da cabeça, mediana 4,5; ver `estudo/green-screen-2026-10-05.md`)
  if (layout === 'presenter') return 1 - resolvePresenter(presenter).heightV - PRESENTER.captionGapV
  if (layout === 'stack') {
    const seam = STACK_SPLIT / VERTICAL_H
    return seam >= 0.45 && seam <= CAPTION_Y_VERTICAL ? seam : CAPTION_Y_VERTICAL
  }
  return CAPTION_Y_VERTICAL
}

/** Layouts verticais (os que o formato 9:16 entende). `presenter` (V-D) só vale com o recorte do fundo pronto. */
export const VERTICAL_LAYOUTS: readonly LayoutKind[] = ['screen-center', 'screen-focus', 'stack', 'screen-wide', 'presenter', 'camera']

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
 *  - Tela ao centro, V-B e V-D: quadrado da fonte; cliques limitados a 1,35× na cena (V-B mantém metade da força);
 *  - V-C: a tela inteira, sem seguir nada nem dar zoom (serve a interface grande).
 */
export function layoutFollow(
  layout: LayoutKind,
  format: Pick<FormatSpec, 'kind' | 'w' | 'h'>,
  screen: Size | null,
  _presenter?: PresenterStyle
): { view: View; gain: number } {
  if (format.kind === 'horizontal') return { view: { w: 1, h: 1 }, gain: 1 }
  switch (layout) {
    case 'screen-center':
    case 'presenter':
      return { view: cropView(1, screen), gain: 1 }
    case 'stack':
      return { view: cropView(1, screen), gain: 0.5 }
    case 'screen-wide':
      return { view: { w: 1, h: 1 }, gain: 0 }
    default:
      return { view: cropView(format.w / format.h, screen, 1), gain: 1 }
  }
}

// ---------------------------------------------------------------------------
// A edição do vertical dentro do documento (visão do formato)

/**
 * Estilo de legenda de partida do vertical (estudo E1: 72% das legendas brasileiras são em caixa mista, sem caixa atrás, e uma
 * linha de 2 palavras [1-3]): Natural em caixa mista, sem caixa, 1 linha × 2 palavras, a palavra falada em destaque (a pessoa
 * desliga), ligada.
 */
export const VERTICAL_CAPTION_DEFAULTS: Required<Pick<CaptionStyle, 'enabled' | 'style' | 'wordsPerLine' | 'position' | 'box'>> = {
  enabled: true,
  style: 'natural',
  wordsPerLine: 2,
  position: 'bottom',
  box: false
}

/** Os campos de legenda de cada formato; cores próprias são opcionais para preservar projetos antigos. */
export const FORMAT_CAPTION_KEYS = ['enabled', 'style', 'wordsPerLine', 'position', 'box', 'size', 'positionY', 'uppercase', 'highlightWord', 'highlightColor', 'textColor'] as const

export function defaultVerticalEdit(): VerticalEdit {
  return { layout: 'screen-center', layouts: [], zooms: [] }
}

function perFormatCaptions(captions: Partial<CaptionStyle> | undefined): Partial<CaptionStyle> {
  const out: Record<string, unknown> = {}
  if (captions) for (const k of FORMAT_CAPTION_KEYS) if (captions[k] !== undefined) out[k] = captions[k]
  return out as Partial<CaptionStyle>
}

/**
 * O documento como o formato o enxerga. No horizontal é o próprio documento (mesmo objeto). No vertical, `zooms`,
 * `layouts`, `zoomPreset`, `style.defaultLayout`, a bolha da câmera e os campos de legenda de cada formato vêm de
 * `project.vertical`: o resto (cortes, texto, fundo) é o mesmo; cores ausentes herdam as do horizontal. É sobre esta visão que `evaluateScene`,
 * a linha do tempo e os painéis trabalham: o código dos dois formatos é um só.
 */
export function projectForFormat(doc: Project, kind: FormatSpec['kind']): Project {
  if (kind === 'horizontal') return doc
  const v = doc.vertical
  const per = { ...VERTICAL_CAPTION_DEFAULTS, ...perFormatCaptions(v?.captions) }
  const captions: CaptionStyle = {
    highlightColor: doc.captions.highlightColor,
    ...(doc.captions.textColor !== undefined ? { textColor: doc.captions.textColor } : {}),
    ...per
  }
  const view: Project = {
    ...doc,
    autoExclusions:v?.autoExclusions,
    zooms: v?.zooms ?? [],
    layouts: v?.layouts ?? [],
    style: {
      ...doc.style,
      defaultLayout: v?.layout ?? 'screen-center',
      camera: { ...doc.style.camera, corner: v?.camera?.corner ?? VERTICAL_BUBBLE_CORNER, size: v?.camera?.size ?? VERTICAL_BUBBLE_SIZE },
      // "câmera em cima" é do vertical: o 16:9 nunca a vê (o `mergeFormatView` a devolve ao `project.vertical`)
      ...(v?.cameraTop ? { stackCameraTop: true } : {})
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
  const { zooms, layouts, zoomPreset, autoExclusions, vertical: viewVertical, captions, style: viewStyle, ...rest } = view
  const { stackCameraTop, ...style } = viewStyle
  const base = doc.vertical ?? defaultVerticalEdit()
  const ownCaptions = perFormatCaptions(captions)
  // Editar outro campo não transforma uma cor herdada em uma escolha independente.
  for (const key of ['highlightColor', 'textColor'] as const) if (base.captions?.[key] === undefined && captions[key] === doc.captions[key]) delete ownCaptions[key]
  const vertical: VerticalEdit = {
    ...base,
    autoExclusions,
    layout: style.defaultLayout,
    layouts,
    zooms,
    camera: { corner: style.camera.corner, size: style.camera.size },
    captions: ownCaptions
  }
  if (stackCameraTop) vertical.cameraTop = true
  else delete vertical.cameraTop
  if (zoomPreset !== undefined) vertical.zoomPreset = zoomPreset
  else delete vertical.zoomPreset
  const hook = viewVertical?.hook
  if (hook !== undefined && hook !== '') vertical.hook = hook
  else delete vertical.hook

  const next: Project = {
    ...rest,
    autoExclusions:doc.autoExclusions,
    zooms: doc.zooms,
    layouts: doc.layouts,
    style: { ...style, defaultLayout: doc.style.defaultLayout, camera: { ...style.camera, corner: doc.style.camera.corner, size: doc.style.camera.size } },
    captions: doc.captions,
    vertical
  }
  if (doc.zoomPreset !== undefined) next.zoomPreset = doc.zoomPreset
  return next
}

// ---------------------------------------------------------------------------
// Escolha automática de layout por atividade

/**
 * HISTERESE: para ENTRAR no V-B a fala precisa ficar sem atividade de tela por pelo menos isto (ms); para SAIR basta a próxima
 * atividade. Entrar pede mais que sair, senão uma pausa de 2 s qualquer faria o layout piscar.
 */
export const QUIET_MIN_MS = 3000
/**
 * PERMANÊNCIA MÍNIMA (ms): nenhum layout fica menos que isto na tela antes de trocar (nota de conferência da R1: a troca a cada
 * poucos segundos incomodava). Medido no tempo de SAÍDA (o que o espectador vê, já sem os trechos cortados). Nos vídeos reais
 * há um corte a cada ~10 s (5,7 por minuto, E1) e a troca de layout não pode ser mais frequente que isso.
 */
export const MIN_DWELL_MS = 6000
/** O V-B começa um pouco depois da última atividade e termina antes da próxima (a tela já está em foco no clique). */
const QUIET_ENTER_DELAY_MS = 500
const QUIET_EXIT_LEAD_MS = 400
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
  /** Os trechos que ficam no vídeo (sem os cortes). A permanência mínima conta só o que se vê; ausente = a gravação inteira. */
  kept?: readonly Range[]
  /** O recorte do fundo da câmera existe (M4c): a fala sem atividade de tela vira V-D (apresentador) em vez de V-B (tela + câmera). */
  hasMatte?: boolean
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

/** Um trecho contínuo da gravação num só estado: `on` = no V-B, senão no layout padrão. */
export type LayoutRun = { start: number; end: number; on: boolean }

/** Os V-B candidatos viram uma linha do tempo de `[0, total]` que alterna "fora" e "no V-B". */
function layoutRuns(stacks: readonly Range[], total: number): LayoutRun[] {
  const runs: LayoutRun[] = []
  let at = 0
  for (const s of stacks) {
    if (s.start > at) runs.push({ start: at, end: s.start, on: false })
    runs.push({ start: s.start, end: s.end, on: true })
    at = s.end
  }
  if (at < total) runs.push({ start: at, end: total, on: false })
  return runs
}

/**
 * PERMANÊNCIA MÍNIMA: enquanto algum trecho dura menos que `minMs` (contando só o que fica no vídeo, `kept`), o MAIS CURTO troca
 * de estado e se junta aos vizinhos (uma folga curta entre dois V-B some; um V-B curto demais some). Empate: o mais cedo. Cada
 * volta tira pelo menos um trecho, então termina; sobra um trecho só quando nada mais pode ser juntado.
 */
export function enforceMinDwell(runs: readonly LayoutRun[], minMs: number, kept?: readonly Range[]): LayoutRun[] {
  let list: LayoutRun[] = runs.map((r) => ({ ...r }))
  for (;;) {
    if (list.length <= 1) return list
    let pick = -1
    let pickLen = Number.POSITIVE_INFINITY
    list.forEach((r, i) => {
      const len = kept ? overlapMs(r, kept) : r.end - r.start
      if (len < minMs && len < pickLen) {
        pick = i
        pickLen = len
      }
    })
    if (pick < 0) return list
    list[pick]!.on = !list[pick]!.on
    const merged: LayoutRun[] = []
    for (const r of list) {
      const last = merged[merged.length - 1]
      if (last && last.on === r.on) last.end = r.end
      else merged.push({ ...r })
    }
    list = merged
  }
}

/**
 * Trechos de layout próprios do vertical: fala SEM atividade de tela por ≥ 3 s → V-B (tela + câmera); atividade → layout
 * padrão (Tela ao centro, sem trecho). Nenhum layout fica menos de 6 s na tela (`MIN_DWELL_MS`, no tempo de saída). Sem câmera não há V-B:
 * devolve vazio.
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
    if (end > start) stacks.push({ start: Math.round(start), end: Math.round(end) })
  }
  const runs = enforceMinDwell(layoutRuns(stacks, input.durationMs), MIN_DWELL_MS, input.kept)
  return runs
    .filter((r) => r.on)
    .map((r, i) => ({ id: `layout-v${i + 1}`, start: Math.round(r.start), end: Math.round(r.end), layout: input.hasMatte ? ('presenter' as const) : ('stack' as const) }))
}

/**
 * Fixa o layout de um corte vertical DEPOIS de `ensureVertical`. `reviewDocument` já fixa o layout do corte (ou o escolhido na
 * Revisão), mas um vertical nunca gerado fica com zooms e layouts vazios e o `ensureVertical` da exportação gera segmentos por
 * atividade que prevaleceriam sobre o layout fixo. Aqui os segmentos que não são do usuário saem; os manuais ficam.
 */
export function pinVerticalLayout(project: Project, layout: LayoutKind): Project {
  const v = project.vertical ?? defaultVerticalEdit()
  return { ...project, vertical: { ...v, layout, layouts: v.layouts.filter((s) => s.origin === 'manual') } }
}

/**
 * Entrar no 9:16 pela primeira vez: zooms do preset padrão do vertical (escala e teto de vertical) e layouts escolhidos pela atividade.
 * Se o vertical já foi editado ou gerado, devolve o mesmo documento. "Nunca gerado" = sem edição vertical, ou com ela vazia e sem
 * preset (um ajuste de legenda no 9:16 antes da geração cria o bloco vazio). Chamar com `history: false` no editor.
 */
export function ensureVertical(
  project: Project,
  data: Pick<CursorData, 'clicks' | 'keys' | 'grid'>,
  opts: { durationMs: number; words?: readonly Word[] | null | undefined; hasCursorEvents?: boolean; hasMatte?: boolean }
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
    speech: speechRanges(opts.words),
    kept: keptRanges(opts.durationMs, project.cuts),
    ...(opts.hasMatte ? { hasMatte: true } : {})
  })
  return { ...project, vertical: { ...v, layout: v?.layout ?? 'screen-center', layouts, zooms, ...(hasEvents ? { zoomPreset: DEFAULT_VERTICAL_ZOOM_PRESET } : {}) } }
}
