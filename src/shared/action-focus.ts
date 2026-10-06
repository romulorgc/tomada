/**
 * Foco da ação (acabamento C): onde a janela quadrada do 9:16 (metade de tela do V-B, Tela ao centro e a faixa de tela do V-D) se
 * posiciona. O V-A segue o cursor o tempo todo; a janela quadrada, não: ela enquadra a AÇÃO (clique, digitação, cursor parado) e
 * fica quieta enquanto a ação continua nela, para o espectador saber onde olhar.
 *
 *  - pontos de ação: cliques dentro da página, o lugar de cada rajada de digitação (onde foi o último clique) e cursor parado;
 *  - a janela só se mexe quando a ação cai fora da faixa central dela (`FOCUS_SAFE`): uma ação que já está enquadrada não move nada;
 *  - ao se mexer, escolhe a posição que contém a ação e mantém no quadro o maior número possível de ações dos 10 s anteriores e dos
 *    6 s seguintes: a coluna de conteúdo onde se clica várias vezes não é cortada;
 *  - antecipa a ação (`FOCUS_LEAD_MS`), espera `FOCUS_MIN_HOLD_MS` entre dois movimentos e ignora movimento pequeno demais;
 *  - quem anda é a mola da câmera (`computeCameraPath`): a transição é suave.
 *
 * Tudo em coordenadas normalizadas 0..1 na ÁREA-BASE (a página já recortada pelo C1); tempo em ms de origem. Código puro.
 */
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

export type FocusPoint = { t: number; x: number; y: number }
/** O enquadramento pedido a partir de `t`: centro da janela na área-base. */
export type FocusStep = { t: number; cx: number; cy: number }

export type ActionFocusInput = {
  clicks: readonly ClickEvent[]
  keys: readonly KeyEvent[]
  cursor: CursorGrid
  /** Fração da área-base que a janela enxerga (escala 1). */
  view: { w: number; h: number }
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** Pontos de ação em ordem de tempo. */
export function focusPoints(input: Pick<ActionFocusInput, 'clicks' | 'keys' | 'cursor'>): FocusPoint[] {
  const clicks = input.clicks.filter((c) => !c.out && Number.isFinite(c.t) && Number.isFinite(c.x) && Number.isFinite(c.y)).sort((a, b) => a.t - b.t)
  const points: FocusPoint[] = clicks.map((c) => ({ t: c.t, x: c.x, y: c.y }))
  for (const burst of findTypingBursts(input.keys)) {
    const last = [...clicks].reverse().find((c) => c.t <= burst.first && burst.first - c.t <= TYPING_CLICK_MAX_AGE_MS)
    const at = last ? { x: last.x, y: last.y } : sampleGrid(input.cursor, burst.first)
    points.push({ t: burst.first, x: at.x, y: at.y })
  }
  for (const dwell of findDwells(input.cursor)) {
    if (dwell.end - dwell.start >= FOCUS_DWELL_MS) points.push({ t: dwell.start, x: dwell.x, y: dwell.y })
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

/**
 * Os enquadramentos da gravação inteira: o primeiro vale desde o início (o vídeo já começa enquadrado) e cada seguinte entra
 * quando uma ação cai fora do enquadramento atual (ver o cabeçalho do arquivo). `null` quando não houve nenhuma ação.
 */
export function buildActionFocus(input: ActionFocusInput): FocusStep[] | null {
  const view = input.view
  const points = focusPoints(input)
  // Sem nenhuma ação (a gravação só passeou com o cursor) não há o que enquadrar: quem chama segue o cursor, como o V-A.
  if (points.length === 0) return null
  /** As ações que pesam no enquadramento de `p`: as dos 10 s anteriores e as dos 6 s seguintes (a própria entra também). */
  const around = (p: FocusPoint): FocusPoint[] => points.filter((q) => q.t >= p.t - FOCUS_MEMORY_MS && q.t <= p.t + FOCUS_AHEAD_MS)
  const first = points[0]!
  const near = around(first)
  const steps: FocusStep[] = [{ t: 0, cx: chooseCenter(first.x, near.map((q) => q.x), null, view.w), cy: chooseCenter(first.y, near.map((q) => q.y), null, view.h) }]
  let current = steps[0]!
  let lastMoveAt = -Infinity
  for (const p of points.slice(1)) {
    const framed = Math.abs(p.x - current.cx) <= (view.w / 2) * FOCUS_SAFE + 1e-9 && Math.abs(p.y - current.cy) <= (view.h / 2) * FOCUS_SAFE + 1e-9
    if (framed) continue
    const neighbours = around(p)
    const cx = chooseCenter(p.x, neighbours.map((q) => q.x), current.cx, view.w)
    const cy = chooseCenter(p.y, neighbours.map((q) => q.y), current.cy, view.h)
    const tooSmall = Math.abs(cx - current.cx) < FOCUS_MIN_MOVE * view.w && Math.abs(cy - current.cy) < FOCUS_MIN_MOVE * view.h
    if (tooSmall) continue
    const t = Math.max(p.t - FOCUS_LEAD_MS, lastMoveAt + FOCUS_MIN_HOLD_MS, 0)
    current = { t, cx, cy }
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
