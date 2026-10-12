/**
 * 9:16 LEGÍVEL (F2, R3): o zoom e o movimento da janela de tela nos layouts verticais em que a página aparece numa janela
 * (Tela ao centro, V-B, V-D e o V-E "Green screen"). Código puro: sem DOM, sem Node. Prévia e exportação leem o mesmo caminho
 * (`deriveProject`).
 *
 * O problema medido (gravações de 09/10, `C:\tmp\tomada-diag-1012\DIAGNOSTICO.md`): a página gravada tem 1920 × 912 px e o texto de
 * corpo 12-14 px; os layouts quadrados mostravam a página 1:1 (14-16 px no quadro de 1080) e só o V-A chegava a ~30 px. Nas
 * referências profissionais (125 vídeos) a letra do corpo tem 22-35 px (mediana 30) no quadro de 1080 e a página fica PARADA ~90% do
 * tempo. Aqui:
 *
 *  - o zoom é calculado pela LETRA: `zoom = 30 px ÷ (altura da letra na fonte × escala do layout)`, nunca pela geometria da janela;
 *  - a janela segue o FOCO (clique, digitação, cursor parado) sem andar à toa: só se mexe quando o foco sai da zona segura, espera
 *    pelo menos `WINDOW_MIN_HOLD_MS` entre dois movimentos (plateau de ~4 s do Screen Studio) e se move em ease-out cúbico de ~0,9 s
 *    (a rampa medida no Screen Studio: 0,89 s). Como o movimento é uma interpolação entre dois pontos (não uma mola atrás do cursor),
 *    não treme;
 *  - numa troca de página (o mapa de conteúdo varia muito) ela pode abrir para a visão geral por menos de 1 s e volta a aproximar;
 *  - `legibilityIssues` diz onde a letra estimada fica abaixo de 22 px (a Revisão avisa; nada de silêncio).
 *
 * A altura da letra na fonte é uma ESTIMATIVA documentada (`BODY_TEXT_PX_1080`): a medida do usuário é 12-14 px numa tela de 1080 de
 * altura e o app não tem como medir o texto de cada página. Quando o projeto trouxer uma medida (`Project.screenTextPx`), ela vale.
 */
import type { ContentMap, ContentTrack } from './content-map'
import { focusPoints, type FocusPoint } from './action-focus'
import { GRID_HZ, GRID_STEP_MS, sampleGrid, type CursorGrid } from './cursor'
import { contentDifference } from './punch-in'
import type { CameraPath } from './zoom'
import type { ClickEvent, KeyEvent, LayoutKind, Range, Rect, Size } from './types'

// ---------------------------------------------------------------------------
// Tamanho da letra

/** Letra do corpo (ascendente + descendente) alvo no quadro final, em px de 1080 de largura: o meio da faixa 28-32 das referências. */
export const TEXT_TARGET_PX = 30
export const TEXT_RANGE_PX = { min: 28, max: 32 } as const
/** Abaixo disto a letra fica ilegível no celular: a Revisão avisa. */
export const TEXT_MIN_PX = 22
/** Altura estimada do texto de corpo da página numa tela gravada com 1080 px de altura (medida em 12-14 px nas gravações do usuário). */
export const BODY_TEXT_PX_1080 = 13
/** O zoom nunca passa disto: acima de ~3× a janela mostra um pedaço pequeno demais para se entender onde se está. */
export const LEGIBLE_MAX_ZOOM = 3.2

/**
 * Altura da letra do corpo na TELA GRAVADA (px): a estimativa de 13 px por 1080 de altura, escalada pela altura gravada (uma tela de
 * 1440 ou 2160 px de altura vem com o texto proporcionalmente maior, por causa da escala do Windows). `measured` (px) vence a estimativa.
 */
export function bodyTextPx(screen: Size | null, measured?: number): number {
  if (typeof measured === 'number' && Number.isFinite(measured) && measured > 2) return measured
  if (!screen || !(screen.h > 0)) return BODY_TEXT_PX_1080
  return (BODY_TEXT_PX_1080 * Math.min(2.2, Math.max(0.6, screen.h / 1080)))
}

/** Letra no quadro final: altura na fonte × (largura do destino ÷ largura da janela na fonte), os dois em px. */
export function textPxOnFrame(textSrcPx: number, destW: number, windowSrcW: number): number {
  return windowSrcW > 0 ? (textSrcPx * destW) / windowSrcW : 0
}

/**
 * O zoom (sobre a janela de `view`, fração da área-base com zoom 1) que põe a letra no alvo. `destW` = largura do destino no quadro (px),
 * `baseW` = largura da área-base na fonte (px), `textSrcPx` = altura da letra na fonte. Preso a [`minZoom`, `LEGIBLE_MAX_ZOOM`].
 */
export function legibleZoom(args: { textSrcPx: number; destW: number; baseW: number; view: { w: number }; minZoom?: number; target?: number }): number {
  const { textSrcPx, destW, baseW, view } = args
  const windowPx = view.w * baseW
  if (!(textSrcPx > 0) || !(windowPx > 0) || !(destW > 0)) return Math.max(1, args.minZoom ?? 1)
  const scaleAtOne = destW / windowPx
  const z = (args.target ?? TEXT_TARGET_PX) / (textSrcPx * scaleAtOne)
  return Math.min(LEGIBLE_MAX_ZOOM, Math.max(args.minZoom ?? 1, z))
}

// ---------------------------------------------------------------------------
// Perfis dos layouts

/**
 * Como cada layout usa a janela. `anchorY` = onde o ponto de foco cai na altura da janela (0 = topo): nos quadrados no centro; no
 * V-E, acima da cabeça de quem fala (a pessoa cobre a metade de baixo). `safeY` = faixa da altura da janela em que o foco conta como
 * enquadrado. `minZoom` dá folga para a janela andar na vertical (no V-E a altura inteira da página não deixa folga).
 */
export type LegibleProfile = {
  anchorY: number
  safeY: readonly [number, number]
  safeX: number
  minZoom: number
  /** Fração de cima da janela que não fica atrás de ninguém: o conteúdo da página vale mais ali (V-E centrado: a pessoa cobre a metade de baixo). */
  visibleFrac: number
}

const SQUARE: LegibleProfile = { anchorY: 0.5, safeY: [0.12, 0.88], safeX: 0.8, minZoom: 1, visibleFrac: 1 }
export const LEGIBLE_PROFILES: Partial<Record<LayoutKind, LegibleProfile>> = {
  'screen-center': SQUARE,
  stack: SQUARE,
  presenter: SQUARE,
  greenscreen: { anchorY: 0.36, safeY: [0.08, 0.44], safeX: 0.8, minZoom: 1.25, visibleFrac: 0.5 },
  'greenscreen-corner': { anchorY: 0.42, safeY: [0.1, 0.84], safeX: 0.8, minZoom: 1.1, visibleFrac: 1 }
}

/** O layout usa a janela legível? (os outros verticais mantêm o enquadramento de sempre) */
export function isLegibleLayout(layout: LayoutKind): boolean {
  return LEGIBLE_PROFILES[layout] !== undefined
}

// ---------------------------------------------------------------------------
// Movimento

/** Movimento da janela: ease-out cúbico de ~0,9 s (a rampa medida no Screen Studio: 0,89 s). Movimento curto leva menos. */
export const WINDOW_MOVE_MS = 900
export const WINDOW_MOVE_SHORT_MS = 600
/** Plateau: dois movimentos começam com pelo menos isto (ms de SAÍDA) entre si, salvo ação forte fora do quadro. */
export const WINDOW_MIN_HOLD_MS = 4000
/** Ação forte (clique, digitação) fora da zona segura: o intervalo mínimo entre movimentos cai para isto. */
export const WINDOW_FORCED_GAP_MS = 1600
/** A janela começa a andar um pouco ANTES da ação (o vídeo já está gravado). */
export const WINDOW_LEAD_MS = 350
/** Movimento menor que esta fração da janela não vale a pena: a janela fica onde está. */
export const WINDOW_MIN_MOVE = 0.08
/** O cursor fora da janela por tanto tempo (ms) vira um movimento mesmo sem ficar parado. */
export const STRAY_MS = 900
/** Visão geral numa troca de página: abre em 350 ms, segura 150 ms e volta a aproximar em 700 ms (menos de 1 s fora do alvo). */
export const OVERVIEW_IN_MS = 350
export const OVERVIEW_HOLD_MS = 150
export const OVERVIEW_OUT_MS = 700
/** A janela só abre para a visão geral se o zoom de lá for pelo menos esta fração menor que o legível; senão a diferença não se vê. */
export const OVERVIEW_MIN_GAIN = 0.12
/** Quanto o mapa de conteúdo varia (0-1) entre duas medidas de 1 s para valer como troca de página (rolagem e hover ficam abaixo). */
export const PAGE_CHANGE_MIN = 0.1
/** Variações do mapa separadas por até isto (ms) são a mesma troca de página; uma troca "em andamento" dura no máximo `PAGE_CHANGE_RUN_MAX_MS`. */
export const PAGE_CHANGE_RUN_GAP_MS = 1500
export const PAGE_CHANGE_RUN_MAX_MS = 3000
/** O cursor parado só puxa a janela se há conteúdo (densidade ≥ isto) num quadrado de 14% da página em volta dele. */
export const NEAR_CONTENT_MIN = 0.05
/** Duas visões gerais ficam separadas por pelo menos isto (ms de saída). */
export const OVERVIEW_MIN_GAP_MS = 6000

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const easeOutCubic = (u: number): number => 1 - Math.pow(1 - clamp(u, 0, 1), 3)

export type WindowState = { cx: number; cy: number; zoom: number }
/** Um movimento: de `from` (o estado em `t0`) até `to` (alcançado em `t1`), em ease-out cúbico. */
export type LegibleKey = { t0: number; t1: number; from: WindowState; to: WindowState; reason: 'start' | 'focus' | 'page' | 'overview' | 'stray' }

export type LegibleInput = {
  durationMs: number
  /** Onde o vídeo de saída termina (fim do último trecho mantido): depois disso nada se move. Ausente = `durationMs`. */
  endMs?: number
  /** Fração da área-base que a janela enxerga com zoom 1 (altura inteira num 9:16 = 0,27 × 1; num quadrado 0,475 × 1). */
  view: { w: number; h: number }
  /** O zoom legível (ver `legibleZoom`). */
  zoom: number
  /** O zoom da visão geral (1 = a janela inteira de `view`). */
  overviewZoom?: number
  profile: LegibleProfile
  clicks: readonly ClickEvent[]
  keys: readonly KeyEvent[]
  cursor: CursorGrid
  /** O mapa de conteúdo na área-base (onde está o bloco de texto) e o mapa cru (para detectar a troca de página). */
  content?: ContentTrack | null
  contentMap?: ContentMap
  /** Tempo de origem ↔ de saída (os cortes): o plateau de 4 s conta o que o espectador vê. Ausente = identidade. */
  toOutput?: (sourceMs: number) => number
  fromOutput?: (outputMs: number) => number
}

export type LegiblePlan = {
  keys: LegibleKey[]
  zoom: number
  /** Janela com o zoom legível, fração da área-base. */
  window: { w: number; h: number }
  moves: number
  overviews: number
}

/** O ponto (no espaço da área-base) que a janela quer mostrar e quando. */
type Focus = { t: number; x: number; y: number; strong: boolean; kind: 'point' | 'page' }

/** O quanto o conteúdo pesa contra o ponto fora do lugar ideal na escolha da janela (densidade 0-1 × este peso). */
const DEVIATION_WEIGHT = 0.3
/** Densidade média abaixo da qual a janela mostra praticamente só o vazio da página. */
const EMPTY_WINDOW = 0.04
const SCAN_X = 0.02
const SCAN_Y = 0.03
/**
 * Quanto texto atravessando as bordas da janela pesa contra ela (a soma da densidade das duas faixas de borda x este peso, descontada do valor
 * da janela): a janela prefere ter as bordas num vão entre colunas, onde não corta uma palavra ao meio, a abraçar mais texto cortando as pontas.
 */
const EDGE_CUT_WEIGHT = 0.5
/**
 * O desconto das bordas nunca passa desta fração do valor da própria janela: uma janela com conteúdo sempre vale mais que uma vazia (que vale zero),
 * mesmo com o texto cortado nas duas pontas.
 */
const EDGE_CUT_CAP = 0.8
/** A faixa de borda tem esta fração da largura da janela. */
const EDGE_STRIP = 0.04

/**
 * O centro da janela de tamanho `win` para mostrar o ponto `p` (ou o começo da página, sem `p`). O ponto fica na zona segura (perfil) e,
 * dentro dela, a janela vai para onde há MAIS conteúdo (`density` = densidade média no retângulo, 0-1; só a parte visível da janela
 * conta): um cursor parado numa área em branco não leva a janela para o vazio. Sem mapa de conteúdo, centra o ponto no lugar do perfil.
 */
export function placeWindow(
  p: { x: number; y: number } | null,
  win: { w: number; h: number },
  profile: LegibleProfile,
  density?: ((rect: Rect) => number) | null
): { cx: number; cy: number } {
  const loX = win.w / 2
  const hiX = 1 - win.w / 2
  const loY = win.h / 2
  const hiY = 1 - win.h / 2
  const fromTop = (cx: number, cy: number): Rect => ({ x: cx - win.w / 2, y: cy - win.h / 2, w: win.w, h: win.h * profile.visibleFrac })
  // o valor da janela: a densidade do que ela mostra, menos o desconto pelo texto atravessando as bordas esquerda e direita (nenhum com a janela na
  // largura inteira: não há borda interna para cortar)
  const worth = (cx: number, cy: number): number => {
    const d = density ? density(fromTop(cx, cy)) : 0
    if (!density || win.w >= 0.999) return d
    const w = Math.max(0.005, win.w * EDGE_STRIP)
    const y = cy - win.h / 2
    const h = win.h * profile.visibleFrac
    const cut = density({ x: cx - win.w / 2, y, w, h }) + density({ x: cx + win.w / 2 - w, y, w, h })
    return d - Math.min(EDGE_CUT_WEIGHT * cut, EDGE_CUT_CAP * d)
  }
  if (!p) {
    // começo de uma página: topo; na horizontal, onde há mais conteúdo, com um leve gosto pela esquerda (onde a leitura começa)
    const cy = clamp(loY, loY, hiY)
    if (!density || win.w >= 0.999) return { cx: clamp(0.5, loX, hiX), cy }
    let best = loX
    let bestScore = Number.NEGATIVE_INFINITY
    for (let cx = loX; cx <= hiX + 1e-9; cx += SCAN_X) {
      const score = worth(cx, cy) - 0.03 * ((cx - loX) / Math.max(1e-6, hiX - loX))
      if (score > bestScore + 1e-9) {
        bestScore = score
        best = cx
      }
    }
    return { cx: clamp(best, loX, hiX), cy }
  }
  const sx = profile.safeX * (win.w / 2)
  const xFrom = win.w >= 0.999 ? 0.5 : clamp(p.x - sx, loX, hiX)
  const xTo = win.w >= 0.999 ? 0.5 : clamp(p.x + sx, loX, hiX)
  // o ponto cai na faixa segura da altura da janela: f = 0,5 + (p.y − cy) / h ∈ safeY
  const yFrom = win.h >= 0.999 ? 0.5 : clamp(p.y - (profile.safeY[1] - 0.5) * win.h, loY, hiY)
  const yTo = win.h >= 0.999 ? 0.5 : clamp(p.y + (0.5 - profile.safeY[0]) * win.h, loY, hiY)
  const idealY = clamp(p.y + (0.5 - profile.anchorY) * win.h, yFrom, yTo)
  const idealX = clamp(p.x, xFrom, xTo)
  if (!density) return { cx: idealX, cy: idealY }
  let best = { cx: idealX, cy: idealY }
  let bestScore = Number.NEGATIVE_INFINITY
  const spanY = Math.max(1e-6, Math.max(profile.anchorY - profile.safeY[0], profile.safeY[1] - profile.anchorY))
  const xs: number[] = []
  for (let x = xFrom; x <= xTo + 1e-9; x += SCAN_X) xs.push(x)
  xs.push(xTo, idealX)
  const ys: number[] = []
  for (let y = yFrom; y <= yTo + 1e-9; y += SCAN_Y) ys.push(y)
  ys.push(yTo, idealY)
  for (const cx of xs) {
    for (const cy of ys) {
      const f = 0.5 + (p.y - cy) / win.h
      const devX = sx > 0 ? (p.x - cx) / sx : 0
      const devY = (f - profile.anchorY) / spanY
      const score = worth(cx, cy) - DEVIATION_WEIGHT * (0.5 * devX * devX + 0.5 * devY * devY)
      if (score > bestScore + 1e-9) {
        bestScore = score
        best = { cx, cy }
      }
    }
  }
  // A janela cai num vazio (o cursor parado numa área em branco): vai para o conteúdo mais próximo, mesmo com o ponto fora dela.
  if (density(fromTop(best.cx, best.cy)) < EMPTY_WINDOW) {
    let near = best
    let nearScore = Number.NEGATIVE_INFINITY
    for (let cx = loX; cx <= hiX + 1e-9; cx += SCAN_X) {
      for (let cy = loY; cy <= hiY + 1e-9; cy += SCAN_Y) {
        const score = density(fromTop(cx, cy)) - 0.25 * Math.hypot(cx - p.x, cy - p.y)
        if (score > nearScore + 1e-9) {
          nearScore = score
          near = { cx, cy }
        }
      }
    }
    if (density(fromTop(near.cx, near.cy)) > density(fromTop(best.cx, best.cy))) best = near
  }
  return best
}

/** O ponto `p` está dentro da zona segura da janela centrada em `s`? */
export function isFramed(p: { x: number; y: number }, s: WindowState, win: { w: number; h: number }, profile: LegibleProfile): boolean {
  if (win.w < 0.999 && Math.abs(p.x - s.cx) > profile.safeX * (win.w / 2) + 1e-9) return false
  if (win.h < 0.999) {
    // posição do ponto na altura da janela (0 = topo)
    const f = 0.5 + (p.y - s.cy) / win.h
    if (f < profile.safeY[0] - 1e-9 || f > profile.safeY[1] + 1e-9) return false
  }
  return true
}

/**
 * Quando a página troca: cada medida de 1 s do mapa de conteúdo que varia ≥ `PAGE_CHANGE_MIN`. Uma sequência de variações (a página
 * carregando, uma rolagem) conta uma vez só e vale quando ela ASSENTA (a última): é a página que o espectador vai ler.
 */
export function pageChanges(map: ContentMap | undefined): number[] {
  if (!map || map.length < 2) return []
  const out: number[] = []
  let first = 0
  let last = 0
  let open = false
  const close = (): void => {
    if (open) out.push(last)
    open = false
  }
  for (let i = 1; i < map.length; i++) {
    const t = map[i]!.t
    const changed = contentDifference(map, map[i - 1]!.t, t) >= PAGE_CHANGE_MIN
    if (!changed) continue
    if (open && (t - last > PAGE_CHANGE_RUN_GAP_MS || t - first > PAGE_CHANGE_RUN_MAX_MS)) close()
    if (!open) {
      open = true
      first = t
    }
    last = t
  }
  close()
  return out
}

/**
 * Planeja a janela da gravação inteira. O primeiro movimento é o estado inicial (instantâneo); cada seguinte é um ease-out até o novo
 * centro. Determinístico: depende só da entrada.
 */
export function planLegibleWindow(input: LegibleInput): LegiblePlan {
  const { profile } = input
  const win = { w: input.view.w / input.zoom, h: input.view.h / input.zoom }
  const toOut = input.toOutput ?? ((t: number): number => t)
  const fromOut = input.fromOutput ?? ((t: number): number => t)
  const track = input.content ?? null
  const points: FocusPoint[] = focusPoints({ clicks: input.clicks, keys: input.keys, cursor: input.cursor })
  const changes = pageChanges(input.contentMap)

  // A ação fraca (cursor parado) só puxa a janela quando há conteúdo em volta dele: o cursor parado numa área em branco não leva a janela para o vazio.
  const counts = (p: FocusPoint): boolean => {
    if (p.strong || !track) return true
    return track.densityIn(p.t + 600, { x: p.x - 0.07, y: p.y - 0.07, w: 0.14, h: 0.14 }) >= NEAR_CONTENT_MIN
  }

  type Ev = { t: number; point: FocusPoint | null; change: boolean }
  const events: Ev[] = [
    ...points.filter(counts).map((p) => ({ t: p.t, point: p, change: false })),
    ...changes.map((t) => ({ t, point: null, change: true }))
  ].sort((a, b) => a.t - b.t || (a.change ? 0 : 1) - (b.change ? 0 : 1))

  // --- estado inicial: a primeira ação forte logo no começo, senão o começo da página (topo, esquerda do bloco)
  const placeAt = (p: { x: number; y: number } | null, t: number): { cx: number; cy: number } =>
    placeWindow(p, win, profile, track && (win.w < 0.999 || win.h < 0.999) ? (r: Rect): number => track.densityIn(t, r) : null)
  const pageStart = (t: number): { cx: number; cy: number } => placeAt(null, t)
  const endMs = input.endMs ?? input.durationMs
  // O vídeo já abre enquadrado: a primeira ação (clique, ou o cursor parado) nos primeiros 3 s, senão o começo da página.
  const early = points.find((p) => p.t <= 3000 && counts(p))
  const start0 = early ? placeAt(early, early.t + 600) : pageStart(600)
  let cur: WindowState = { ...start0, zoom: input.zoom }
  const keys: LegibleKey[] = [{ t0: 0, t1: 0, from: cur, to: cur, reason: 'start' }]
  let lastStartOut = Number.NEGATIVE_INFINITY
  let lastEndSrc = 0
  let lastOverviewOut = Number.NEGATIVE_INFINITY
  let moves = 0
  let overviews = 0

  const stateAt = (t: number): WindowState => {
    // o estado em `t` (para um movimento que começa antes de o anterior acabar)
    let k = keys[0]!
    for (const key of keys) if (key.t0 <= t) k = key
    const u = k.t1 > k.t0 ? easeOutCubic((t - k.t0) / (k.t1 - k.t0)) : 1
    return { cx: k.from.cx + (k.to.cx - k.from.cx) * u, cy: k.from.cy + (k.to.cy - k.from.cy) * u, zoom: k.from.zoom + (k.to.zoom - k.from.zoom) * u }
  }
  const earliestStart = (gap: number): number => (Number.isFinite(lastStartOut) ? fromOut(lastStartOut + gap) : Number.NEGATIVE_INFINITY)
  const push = (t0: number, to: WindowState, reason: LegibleKey['reason'], ms: number): void => {
    const start = Math.max(0, t0)
    const from = stateAt(start)
    const t1 = start + ms
    keys.push({ t0: start, t1, from, to, reason })
    cur = to
    lastEndSrc = t1
    lastStartOut = toOut(start)
    moves++
  }
  const moveMs = (to: WindowState, from: WindowState): number => {
    const d = Math.max(Math.abs(to.cx - from.cx) / Math.max(win.w, 1e-6), Math.abs(to.cy - from.cy) / Math.max(win.h, 1e-6))
    return d < 0.6 ? WINDOW_MOVE_SHORT_MS : WINDOW_MOVE_MS
  }

  /** O cursor ficou fora da janela por `STRAY_MS` entre `from` e `to`? Devolve o ponto onde ele pousou e quando. */
  const findStray = (from: number, to: number): Focus | null => {
    let since: number | null = null
    for (let t = from; t < to; t += 100) {
      const c = sampleGrid(input.cursor, t)
      const outside = win.w < 0.999 && Math.abs(c.x - cur.cx) > win.w / 2
      if (!outside) {
        since = null
        continue
      }
      since ??= t
      if (t - since >= STRAY_MS) {
        const land = sampleGrid(input.cursor, t + 300)
        return { t, x: land.x, y: land.y, strong: false, kind: 'point' }
      }
    }
    return null
  }

  const handlePoint = (f: Focus): void => {
    if (f.t >= endMs || isFramed(f, cur, win, profile)) return
    const target = placeAt(f, f.t + 600)
    const next: WindowState = { ...target, zoom: input.zoom }
    if (Math.abs(next.cx - cur.cx) < WINDOW_MIN_MOVE * win.w && Math.abs(next.cy - cur.cy) < WINDOW_MIN_MOVE * win.h) return
    let t0 = f.t - WINDOW_LEAD_MS
    const gap = f.strong ? WINDOW_FORCED_GAP_MS : WINDOW_MIN_HOLD_MS
    const earliest = earliestStart(gap) // o plateau conta em tempo de saída
    if (t0 < earliest) {
      // ação fraca barrada pelo plateau: ignora (o próximo ponto a pega); a forte espera só o mínimo
      if (!f.strong) return
      t0 = earliest
    }
    if (t0 >= endMs) return
    push(t0, next, f.kind === 'page' ? 'page' : 'focus', moveMs(next, cur))
  }

  const handleChange = (tc: number): void => {
    if (tc >= endMs) return
    const gainOk = input.overviewZoom !== undefined && (input.zoom - input.overviewZoom) / input.zoom >= OVERVIEW_MIN_GAIN
    // onde a página nova pede o olhar: a primeira ação nos 2,5 s seguintes, senão o começo da página
    const soon = points.find((p) => p.t >= tc - 200 && p.t <= tc + 2500 && counts(p))
    const aim = soon ? placeAt(soon, soon.t + 600) : pageStart(tc + 600)
    const next: WindowState = { ...aim, zoom: input.zoom }
    const sameSpot = Math.abs(next.cx - cur.cx) < WINDOW_MIN_MOVE * win.w && Math.abs(next.cy - cur.cy) < WINDOW_MIN_MOVE * win.h
    const open = tc - 500
    const wantOverview = gainOk && toOut(open) - lastOverviewOut >= OVERVIEW_MIN_GAP_MS
    if (wantOverview) {
      const wide: WindowState = { cx: next.cx, cy: next.cy, zoom: input.overviewZoom! }
      // com a janela maior, o centro precisa caber na página
      const ww = input.view.w / wide.zoom
      const hh = input.view.h / wide.zoom
      wide.cx = clamp(wide.cx, ww / 2, 1 - ww / 2)
      wide.cy = clamp(wide.cy, hh / 2, 1 - hh / 2)
      push(Math.max(open, earliestStart(WINDOW_FORCED_GAP_MS)), wide, 'overview', OVERVIEW_IN_MS)
      const closeAt = keys[keys.length - 1]!.t1 + OVERVIEW_HOLD_MS
      push(closeAt, next, 'page', OVERVIEW_OUT_MS)
      lastOverviewOut = toOut(open)
      overviews++
      moves-- // abrir e fechar contam como um movimento só
      return
    }
    if (sameSpot) return
    if (toOut(tc - 300) - lastStartOut < WINDOW_FORCED_GAP_MS) return
    push(tc - 300, next, 'page', moveMs(next, cur))
  }

  let prevT = 0
  const settle = (until: number): void => {
    // o cursor que se afastou da janela e não voltou: vira movimento antes da próxima ação
    for (let guard = 0; guard < 400; guard++) {
      const stray = findStray(Math.max(prevT, lastEndSrc), until)
      if (!stray) return
      const before = keys.length
      handlePoint(stray)
      if (keys.length === before) {
        prevT = stray.t + 100
      } else {
        prevT = stray.t
      }
    }
  }
  for (const ev of events) {
    if (ev.t >= endMs) break
    settle(ev.t - WINDOW_LEAD_MS)
    prevT = Math.max(prevT, ev.t - WINDOW_LEAD_MS)
    if (ev.change) handleChange(ev.t)
    else handlePoint({ t: ev.t, x: ev.point!.x, y: ev.point!.y, strong: ev.point!.strong, kind: 'point' })
  }
  settle(endMs)
  return { keys, zoom: input.zoom, window: win, moves, overviews }
}

/** O estado da janela em `t` (ms de origem). */
export function legibleStateAt(plan: LegiblePlan, t: number): WindowState {
  const keys = plan.keys
  let lo = 0
  let hi = keys.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (keys[mid]!.t0 <= t) lo = mid
    else hi = mid - 1
  }
  const k = keys[lo]!
  const u = k.t1 > k.t0 ? easeOutCubic((t - k.t0) / (k.t1 - k.t0)) : 1
  return { cx: k.from.cx + (k.to.cx - k.from.cx) * u, cy: k.from.cy + (k.to.cy - k.from.cy) * u, zoom: k.from.zoom + (k.to.zoom - k.from.zoom) * u }
}

/** O plano como caminho de câmera a 60 Hz (o formato que `sampleCameraPath` e `visibleRect` leem). */
export function legiblePath(plan: LegiblePlan, input: Pick<LegibleInput, 'durationMs' | 'view'>): CameraPath {
  const n = Math.floor(Math.max(0, input.durationMs) / GRID_STEP_MS + 1e-9) + 1
  const t: number[] = new Array<number>(n)
  const scale: number[] = new Array<number>(n)
  const cx: number[] = new Array<number>(n)
  const cy: number[] = new Array<number>(n)
  let maxScale = 1
  for (let i = 0; i < n; i++) {
    const ms = i * GRID_STEP_MS
    const s = legibleStateAt(plan, ms)
    const w = input.view.w / s.zoom
    const h = input.view.h / s.zoom
    t[i] = ms
    scale[i] = s.zoom
    cx[i] = clamp(s.cx, w / 2, 1 - w / 2)
    cy[i] = clamp(s.cy, h / 2, 1 - h / 2)
    if (s.zoom > maxScale) maxScale = s.zoom
  }
  return { hz: GRID_HZ, t, scale, cx, cy, maxScale }
}

// ---------------------------------------------------------------------------
// Aviso da Revisão

/** Um trecho de letra pequena só vale aviso se dura pelo menos isto (ms). */
export const ISSUE_MIN_MS = 1500
export type LegibilityIssue = { startMs: number; endMs: number; textPx: number; layout: LayoutKind }

/**
 * Onde a letra estimada fica abaixo de `TEXT_MIN_PX`: amostra os trechos mantidos a cada `stepMs` e junta amostras vizinhas do mesmo
 * layout. `textPxAt(t)` devolve a letra no quadro (px) e o layout vigente, ou `null` onde a página não aparece (só câmera).
 */
export function legibilityIssues(args: {
  kept: readonly Range[]
  textPxAt: (sourceMs: number) => { textPx: number; layout: LayoutKind } | null
  minPx?: number
  stepMs?: number
  /** Trechos menores que isto (ms) não contam: a visão geral de uma troca de página (< 1 s) é de propósito. */
  minDurationMs?: number
}): LegibilityIssue[] {
  const min = args.minPx ?? TEXT_MIN_PX
  const step = args.stepMs ?? 250
  const minDuration = args.minDurationMs ?? ISSUE_MIN_MS
  const out: LegibilityIssue[] = []
  for (const r of args.kept) {
    let open: LegibilityIssue | null = null
    for (let t = r.start; t < r.end; t += step) {
      const sample = args.textPxAt(t)
      if (sample && sample.textPx < min) {
        const end = Math.min(r.end, t + step)
        if (open && open.layout === sample.layout && t - open.endMs <= step + 1) {
          open.endMs = end
          open.textPx = Math.min(open.textPx, sample.textPx)
        } else {
          open = { startMs: t, endMs: end, textPx: sample.textPx, layout: sample.layout }
          out.push(open)
        }
      } else open = null
    }
  }
  return out.filter((i) => i.endMs - i.startMs >= minDuration)
}

/** Resumo dos avisos de letra pequena para a Revisão e para o editor: a menor letra (px), quanto tempo dura e em que layouts. `null` = nada a avisar. */
export function legibilitySummary(issues: readonly LegibilityIssue[]): { minPx: number; totalMs: number; layouts: LayoutKind[] } | null {
  if (issues.length === 0) return null
  const layouts: LayoutKind[] = []
  for (const i of issues) if (!layouts.includes(i.layout)) layouts.push(i.layout)
  return { minPx: Math.round(Math.min(...issues.map((i) => i.textPx))), totalMs: issues.reduce((n, i) => n + (i.endMs - i.startMs), 0), layouts }
}
