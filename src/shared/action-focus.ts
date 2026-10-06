/**
 * Foco da ação (acabamento C): onde a janela quadrada do 9:16 (metade de tela do V-B, Tela ao centro e a faixa de tela do V-D) se
 * posiciona. O V-A segue o cursor o tempo todo; a janela quadrada, não: ela enquadra a AÇÃO (clique, digitação, cursor parado) e
 * fica quieta enquanto a ação continua nela, para o espectador saber onde olhar.
 *
 *  - pontos de ação: cliques dentro da página, o lugar de cada rajada de digitação (onde foi o último clique) e cursor parado;
 *  - o MAPA DE CONTEÚDO da imagem (`content-map.ts`) diz onde está o bloco de texto da página: entre as posições que mantêm a ação
 *    forte (clique, digitação) no quadro, a janela fica onde cobre o máximo desse bloco, com ele centrado (a coluna de um webmail não
 *    sai cortada só porque o cursor ficou parado na borda dela). Sem ação forte a janela fica centrada no bloco principal; o cursor
 *    parado, com o mapa, não puxa mais a janela. Sem mapa, nada disto vale e o comportamento é o de antes;
 *  - a janela só se mexe quando a ação cai fora da faixa central dela (`FOCUS_SAFE`): uma ação que já está enquadrada não move nada;
 *  - ao se mexer, escolhe a posição que contém a ação e mantém no quadro o maior número possível de ações dos 10 s anteriores e dos
 *    6 s seguintes: a coluna de conteúdo onde se clica várias vezes não é cortada;
 *  - antecipa a ação (`FOCUS_LEAD_MS`), espera `FOCUS_MIN_HOLD_MS` entre dois movimentos e ignora movimento pequeno demais;
 *  - quem anda é a mola da câmera (`computeCameraPath`): a transição é suave.
 *
 * Tudo em coordenadas normalizadas 0..1 na ÁREA-BASE (a página já recortada pelo C1); tempo em ms de origem. Código puro.
 */
import { blockCover, mainBlock, type ContentBlock, type ContentTrack } from './content-map'
import { sampleGrid, type CursorGrid } from './cursor'
import { CAMERA_SPRING, springWithRiseTime } from './spring'
import type { ClickEvent, KeyEvent } from './types'
import { findDwells, findTypingBursts } from './zoom'

/** A câmera começa a andar um pouco ANTES da ação (o vídeo já está gravado), para ela já cair enquadrada. */
export const FOCUS_LEAD_MS = 350
/** Permanência mínima: dois movimentos da janela ficam separados por pelo menos isto. */
export const FOCUS_MIN_HOLD_MS = 1600
/** Ações até este tempo ANTES da que vai ser enquadrada pesam na escolha do enquadramento. */
export const FOCUS_MEMORY_MS = 10_000
/** E as que vêm até este tempo DEPOIS (o vídeo já está gravado): a janela abraça o conjunto, não só o primeiro clique. */
export const FOCUS_AHEAD_MS = 6000
/** A ação conta como enquadrada dentro desta fração central da janela. */
export const FOCUS_SAFE = 0.7
/** Ao escolher o enquadramento, as ações recentes contam se ficam a esta fração do centro da janela. */
export const FOCUS_COVER = 0.92
/** Movimento menor que isto (fração da janela) não vale a pena: a janela fica onde está. */
export const FOCUS_MIN_MOVE = 0.06
/** A mola do centro da janela: um movimento de ~0,7 s, mais calmo que a do cursor (`CAMERA_SPRING`), para o olho acompanhar. */
export const FOCUS_SPRING = springWithRiseTime(CAMERA_SPRING, 700)
/** Cursor parado por pelo menos isto (ms) também é ação. */
export const FOCUS_DWELL_MS = 700
/** A digitação acontece onde foi o último clique, se ele foi até 8 s antes. */
const TYPING_CLICK_MAX_AGE_MS = 8000
/** O que a ação vai mostrar só aparece depois dela: o conteúdo de uma ação é o da imagem este tempo (ms) adiante. */
export const FOCUS_CONTENT_LOOKAHEAD_MS = 1000
/** A imagem mudou de verdade entre duas medidas de 1 s: a janela começa a andar este tempo (ms) antes da medida que viu a mudança. */
export const FOCUS_CONTENT_LEAD_MS = 500
/** A janela só se mexe por causa do conteúdo (sem a ação sair do quadro) quando passa a cobrir pelo menos esta fração a mais do bloco. */
export const FOCUS_COVER_GAIN = 0.04
/** Folga (fração da área-base) que o bloco de conteúdo precisa ter até a borda da janela: texto colado na borda do quadro conta como cortado. */
export const FOCUS_EDGE_MARGIN = 0.02
/** Coberturas do bloco que diferem menos que isto contam como iguais; passo (fração da área-base) da busca de posições. */
const COVER_STEP = 0.02
const SCAN_STEP = 0.02

/** `strong`: clique ou digitação. O cursor parado é ação fraca: só enquadra quando não há mapa de conteúdo para dizer o que ver. */
export type FocusPoint = { t: number; x: number; y: number; strong: boolean }
/** O enquadramento pedido a partir de `t`: centro da janela na área-base. */
export type FocusStep = { t: number; cx: number; cy: number }

export type ActionFocusInput = {
  clicks: readonly ClickEvent[]
  keys: readonly KeyEvent[]
  cursor: CursorGrid
  /** Fração da área-base que a janela enxerga (escala 1). */
  view: { w: number; h: number }
  /** O mapa de conteúdo da imagem na área-base (ver `createContentTrack`); sem ele, só as ações enquadram. */
  content?: ContentTrack | null
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** Pontos de ação em ordem de tempo. */
export function focusPoints(input: Pick<ActionFocusInput, 'clicks' | 'keys' | 'cursor'>): FocusPoint[] {
  const clicks = input.clicks.filter((c) => !c.out && Number.isFinite(c.t) && Number.isFinite(c.x) && Number.isFinite(c.y)).sort((a, b) => a.t - b.t)
  const points: FocusPoint[] = clicks.map((c) => ({ t: c.t, x: c.x, y: c.y, strong: true }))
  for (const burst of findTypingBursts(input.keys)) {
    const last = [...clicks].reverse().find((c) => c.t <= burst.first && burst.first - c.t <= TYPING_CLICK_MAX_AGE_MS)
    const at = last ? { x: last.x, y: last.y } : sampleGrid(input.cursor, burst.first)
    points.push({ t: burst.first, x: at.x, y: at.y, strong: true })
  }
  for (const dwell of findDwells(input.cursor)) {
    if (dwell.end - dwell.start >= FOCUS_DWELL_MS) points.push({ t: dwell.start, x: dwell.x, y: dwell.y, strong: false })
  }
  return points.sort((a, b) => a.t - b.t)
}

/**
 * O centro da janela, num eixo, que contém `p` na faixa central e mantém no quadro o maior número de pontos recentes
 * (empate: o mais perto de onde a janela já estava). `v` é a fração da área-base que a janela enxerga nesse eixo.
 */
function chooseCenter(p: number, recent: readonly number[], previous: number | null, v: number): number {
  if (v >= 0.999) return 0.5
  const lo = v / 2
  const hi = 1 - v / 2
  const safe = (v / 2) * FOCUS_SAFE
  const from = Math.max(lo, p - safe)
  const to = Math.min(hi, p + safe)
  if (from > to) return clamp(p, lo, hi)
  const reach = (v / 2) * FOCUS_COVER
  const candidates = new Set<number>([from, to, clamp(previous ?? p, from, to)])
  for (const q of recent) for (const edge of [q - reach, q + reach]) candidates.add(clamp(edge, from, to))
  if (recent.length > 0) candidates.add(clamp((Math.min(...recent, p) + Math.max(...recent, p)) / 2, from, to))
  let best = from
  let bestScore = -1
  let bestOffCenter = Infinity
  let bestDistance = Infinity
  for (const c of candidates) {
    const covered = recent.filter((q) => Math.abs(q - c) <= reach)
    const score = covered.length
    // entre as posições que cobrem o mesmo número de ações, a que deixa o grupo mais ao centro da janela; depois, a mais perto de onde estava
    const offCenter = covered.length > 0 ? Math.abs(c - (Math.min(...covered) + Math.max(...covered)) / 2) : 0
    const distance = Math.abs(c - (previous ?? p))
    if (score > bestScore || (score === bestScore && (offCenter < bestOffCenter - 1e-9 || (Math.abs(offCenter - bestOffCenter) <= 1e-9 && distance < bestDistance)))) {
      best = c
      bestScore = score
      bestOffCenter = offCenter
      bestDistance = distance
    }
  }
  return best
}

/** O que o mapa de conteúdo diz de um eixo num instante: o perfil e o bloco principal dele. */
type AxisContext = { profile: readonly number[]; block: ContentBlock }
type FocusContext = { x: AxisContext | null; y: AxisContext | null }

/** O conteúdo da imagem no instante `t`, nos eixos em que a janela não enxerga tudo; `null` sem mapa ou sem nada a ver. */
function contentContext(track: ContentTrack | null, t: number, view: { w: number; h: number }): FocusContext | null {
  if (!track) return null
  const axis = (which: 'x' | 'y', v: number): AxisContext | null => {
    if (v >= 0.999) return null
    const profile = track.profileAt(t, which)
    const block = mainBlock(profile)
    return block ? { profile, block } : null
  }
  const x = axis('x', view.w)
  const y = axis('y', view.h)
  return x || y ? { x, y } : null
}

/** Que fração do bloco a janela de centro `c` e tamanho `v` mostra, com a folga de borda (`FOCUS_EDGE_MARGIN`) de cada lado. */
function coverAt(ax: AxisContext, c: number, v: number): number {
  return blockCover(ax.profile, ax.block, c - v / 2 + FOCUS_EDGE_MARGIN, c + v / 2 - FOCUS_EDGE_MARGIN)
}

/**
 * O centro da janela, num eixo, quando se sabe onde está o conteúdo: entre as posições que mantêm a ação forte `p` na faixa central
 * (sem `p`, todas), a que cobre o MÁXIMO do bloco principal; empatando, a que deixa o bloco centrado na janela (se ele cabe) e
 * então a que mantém mais ações recentes no quadro e anda menos.
 */
function chooseCenterByContent(p: number | null, recent: readonly number[], previous: number | null, v: number, ax: AxisContext): number {
  const lo = v / 2
  const hi = 1 - v / 2
  let from = lo
  let to = hi
  if (p !== null) {
    const safe = (v / 2) * FOCUS_SAFE
    from = Math.max(lo, p - safe)
    to = Math.min(hi, p + safe)
    if (from > to) return clamp(p, lo, hi)
  }
  const { block } = ax
  const reach = (v / 2) * FOCUS_COVER
  const blockCenter = (block.start + block.end) / 2
  const fits = block.end - block.start <= v - 2 * FOCUS_EDGE_MARGIN + 1e-9
  const candidates = new Set<number>()
  const add = (c: number): void => void candidates.add(clamp(c, from, to))
  for (const c of [from, to, blockCenter, block.end - v / 2 + FOCUS_EDGE_MARGIN, block.start + v / 2 - FOCUS_EDGE_MARGIN, previous ?? p ?? blockCenter]) add(c)
  for (const q of recent) {
    add(q - reach)
    add(q + reach)
  }
  for (let c = from; c <= to; c += SCAN_STEP) add(c)
  const origin = previous ?? p ?? blockCenter
  let best = from
  let bestKey: number[] | null = null
  const better = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i]! - b[i]!) > 1e-12) return a[i]! < b[i]!
    }
    return false
  }
  for (const c of candidates) {
    const cover = Math.round(coverAt(ax, c, v) / COVER_STEP)
    const off = fits ? Math.round(Math.abs(c - blockCenter) / COVER_STEP) : 0
    const kept = recent.filter((q) => Math.abs(q - c) <= reach).length
    // quanto mais bloco coberto, melhor; depois o bloco centrado; depois mais ações recentes no quadro; depois a que anda menos
    const key = [-cover, off, -kept, Math.abs(c - origin)]
    if (!bestKey || better(key, bestKey)) {
      best = c
      bestKey = key
    }
  }
  return best
}

/**
 * Os enquadramentos da gravação inteira: o primeiro vale desde o início (o vídeo já começa enquadrado) e cada seguinte entra
 * quando uma ação cai fora do enquadramento atual, ou quando a janela atual corta bem mais do bloco de conteúdo do que uma posição
 * que mantém a ação no quadro cortaria (ver o cabeçalho do arquivo). `null` quando não houve nenhuma ação e não há o que ver no
 * mapa de conteúdo: quem chama segue o cursor.
 */
export function buildActionFocus(input: ActionFocusInput): FocusStep[] | null {
  const view = input.view
  const points = focusPoints(input)
  const track = input.content ?? null
  /** As ações que pesam no enquadramento de `p`: as dos 10 s anteriores e as dos 6 s seguintes (a própria entra também). */
  const around = (p: FocusPoint): FocusPoint[] => points.filter((q) => q.t >= p.t - FOCUS_MEMORY_MS && q.t <= p.t + FOCUS_AHEAD_MS)
  // Com o mapa, a primeira ação que enquadra é a primeira forte, e só se vem logo (as de depois movem a janela quando chegam: o vídeo
  // não começa deslocado para onde só se vai clicar muito adiante); sem ele, a primeira de todas.
  const firstStrong = track ? points.find((p) => p.strong) : null
  let first = track ? (firstStrong && firstStrong.t <= FOCUS_AHEAD_MS ? firstStrong : null) : (points[0] ?? null)
  let startCtx = contentContext(track, (first?.t ?? 0) + FOCUS_CONTENT_LOOKAHEAD_MS, view)
  if (track && !startCtx) {
    // nada a ver no mapa onde o vídeo começa (página lisa, ainda carregando): enquadra como se não houvesse mapa
    first = points[0] ?? null
    startCtx = contentContext(track, (first?.t ?? 0) + FOCUS_CONTENT_LOOKAHEAD_MS, view)
  }
  // Sem nenhuma ação (a gravação só passeou com o cursor) e sem o que ver na imagem não há o que enquadrar: quem chama segue o cursor, como o V-A.
  if (!first && !startCtx) return null

  /** O enquadramento que se escolheria para a ação `p` (ou, sem ação, só pelo conteúdo) com `ctx` de conteúdo e `previous` como o atual. */
  const decide = (p: FocusPoint | null, ctx: FocusContext | null, previous: FocusStep | null): { cx: number; cy: number } => {
    const near = p ? around(p) : []
    const one = (axis: 'x' | 'y', v: number): number => {
      if (v >= 0.999) return 0.5
      const prior = previous ? (axis === 'x' ? previous.cx : previous.cy) : null
      const ax = ctx?.[axis] ?? null
      if (ax) return chooseCenterByContent(p && p.strong ? p[axis] : null, near.map((q) => q[axis]), prior, v, ax)
      return p ? chooseCenter(p[axis], near.map((q) => q[axis]), prior, v) : (prior ?? 0.5)
    }
    return { cx: one('x', view.w), cy: one('y', view.h) }
  }

  /** O quanto de bloco de conteúdo (0-1) a mais `to` cobre do que `from`, no eixo em que isso mais muda. */
  const coverGain = (ctx: FocusContext, from: { cx: number; cy: number }, to: { cx: number; cy: number }): number => {
    let gain = 0
    for (const axis of ['x', 'y'] as const) {
      const ax = ctx[axis]
      const v = axis === 'x' ? view.w : view.h
      // Só importa quando o bloco cabe na janela: com um bloco mais largo que ela toda posição corta alguma coisa e o ganho não diz nada.
      if (!ax || ax.block.end - ax.block.start > v - 2 * FOCUS_EDGE_MARGIN + 1e-9) continue
      const at = (s: { cx: number; cy: number }): number => (axis === 'x' ? s.cx : s.cy)
      gain = Math.max(gain, coverAt(ax, at(to), v) - coverAt(ax, at(from), v))
    }
    return gain
  }

  const steps: FocusStep[] = [{ t: 0, ...decide(first, startCtx, null) }]
  let current = steps[0]!
  let lastMoveAt = -Infinity

  // Os instantes que podem mudar a janela: cada ação e cada vez que a imagem muda.
  type Moment = { t: number; p: FocusPoint | null }
  const moments: Moment[] = points.filter((p) => p !== first).map((p) => ({ t: p.t, p }))
  if (track) for (const t of track.times) if (t > 0) moments.push({ t, p: null })
  moments.sort((a, b) => a.t - b.t || (a.p ? 0 : 1) - (b.p ? 0 : 1))

  for (const m of moments) {
    const p = m.p
    const ctx = contentContext(track, p ? p.t + FOCUS_CONTENT_LOOKAHEAD_MS : m.t, view)
    // Com o mapa, só a ação forte tira a janela do lugar: o cursor parado fora do bloco de conteúdo não a puxa.
    // (e num eixo em que a janela já enxerga tudo, nada fica fora do quadro)
    const counts = (axis: 'x' | 'y'): boolean => (axis === 'x' ? view.w : view.h) < 0.999 && !(p && !p.strong && ctx?.[axis])
    const framed = p
      ? (!counts('x') || Math.abs(p.x - current.cx) <= (view.w / 2) * FOCUS_SAFE + 1e-9) && (!counts('y') || Math.abs(p.y - current.cy) <= (view.h / 2) * FOCUS_SAFE + 1e-9)
      : true
    // Ação já enquadrada: o que se mantém no quadro é a ação forte mais recente (se houver), e a janela só anda se o conteúdo ganhar bastante.
    const recentStrong = p?.strong ? p : ([...points].reverse().find((q) => q.strong && q.t <= m.t && m.t - q.t <= FOCUS_MEMORY_MS) ?? null)
    const next = decide(framed ? recentStrong : p, ctx, current)
    const gains = framed && ctx !== null && coverGain(ctx, current, next) >= FOCUS_COVER_GAIN - 1e-9
    if (framed && !gains) continue
    const tooSmall = Math.abs(next.cx - current.cx) < FOCUS_MIN_MOVE * view.w && Math.abs(next.cy - current.cy) < FOCUS_MIN_MOVE * view.h
    if (tooSmall) continue
    const t = Math.max(m.t - (p ? FOCUS_LEAD_MS : FOCUS_CONTENT_LEAD_MS), lastMoveAt + FOCUS_MIN_HOLD_MS, 0)
    current = { t, ...next }
    steps.push(current)
    lastMoveAt = t
  }
  return steps
}

/** O centro pedido em `t`: o último enquadramento que já começou. */
export function actionFocusAt(steps: readonly FocusStep[], t: number): { cx: number; cy: number } {
  let lo = 0
  let hi = steps.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (steps[mid]!.t <= t) lo = mid
    else hi = mid - 1
  }
  const step = steps[lo]
  return step ? { cx: step.cx, cy: step.cy } : { cx: 0.5, cy: 0.5 }
}
