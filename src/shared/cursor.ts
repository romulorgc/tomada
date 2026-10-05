/**
 * Processamento do cursor: grade uniforme a 60 Hz com anti-tremor para o
 * foco da câmera, consulta exata (a 120 Hz originais) para o que precisa coincidir com o
 * cursor do vídeo (halo, ripple), e a trilha do cursor SINTÉTICO (mola, apagar parado).
 *
 * Tempos em ms, coordenadas normalizadas 0..1 na área capturada. Código puro.
 */
import { CURSOR_SPRING, step as springStep, type SpringParams } from './spring'
import type { ClickEvent, CursorSample } from './types'

export const GRID_HZ = 60
export const GRID_STEP_MS = 1000 / GRID_HZ

/** Deslocamento (normalizado) abaixo do qual o movimento que dura pouco é tremor. */
export const TREMOR_DISTANCE = 0.015
/** Duração (ms) abaixo da qual um deslocamento pequeno é tremor; acima disso é movimento de verdade. */
export const TREMOR_MS = 100
/** Entre duas amostras válidas mais distantes que isto (ms) o cursor "segura" a posição em vez de interpolar. */
export const MAX_INTERP_GAP_MS = 250

export type CursorGrid = {
  hz: number
  /** ms: `t[i] = i · 1000/60`. */
  t: number[]
  x: number[]
  y: number[]
}

export type ProcessCursorOptions = {
  /** Duração da grade (ms). Padrão: o último instante conhecido (amostra ou clique). */
  durationMs?: number
  /** Liga o filtro de tremor (padrão: sim). */
  antiTremor?: boolean
}

type Pt = { t: number; x: number; y: number }

const finite = (n: number): boolean => Number.isFinite(n)

/** Pontos dentro da área, em ordem de tempo (amostras + cliques, que também dizem onde o cursor estava). */
function validPoints(samples: readonly CursorSample[], clicks: readonly ClickEvent[]): Pt[] {
  const pts: Pt[] = []
  for (const s of samples) {
    if (s.out || !finite(s.t) || !finite(s.x) || !finite(s.y)) continue
    pts.push({ t: s.t, x: s.x, y: s.y })
  }
  for (const c of clicks) {
    if (c.out || !finite(c.t) || !finite(c.x) || !finite(c.y)) continue
    pts.push({ t: c.t, x: c.x, y: c.y })
  }
  // ordenação estável: no mesmo instante a amostra do cursor vem antes do clique
  return pts.sort((a, b) => a.t - b.t)
}

/**
 * Anti-tremor: o ponto "aceito" só acompanha o cursor quando ele se desloca pelo menos
 * `TREMOR_DISTANCE`, ou quando um deslocamento menor dura `TREMOR_MS` (movimento lento de verdade).
 * Devolve um ponto por entrada (o aceito no momento), então a densidade de amostras é mantida.
 */
export function removeTremor(points: readonly Pt[], distance = TREMOR_DISTANCE, holdMs = TREMOR_MS): Pt[] {
  const out: Pt[] = []
  let px = 0
  let py = 0
  let driftStart: number | null = null
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    if (i === 0) {
      px = p.x
      py = p.y
    } else {
      const d = Math.hypot(p.x - px, p.y - py)
      if (d >= distance) {
        px = p.x
        py = p.y
        driftStart = null
      } else if (d > 0) {
        if (driftStart === null) driftStart = p.t
        if (p.t - driftStart >= holdMs) {
          px = p.x
          py = p.y
          driftStart = null
        }
      } else {
        driftStart = null
      }
    }
    out.push({ t: p.t, x: px, y: py })
  }
  return out
}

/**
 * Amostras (e cliques) → grade uniforme a 60 Hz.
 * - fora da área ou sem amostra por mais de `MAX_INTERP_GAP_MS` → segura a última posição válida;
 * - antes da primeira posição válida usa a primeira (sem nenhuma, o centro);
 * - tremor filtrado (opcional, padrão ligado).
 */
export function processCursor(
  samples: readonly CursorSample[],
  clicks: readonly ClickEvent[] = [],
  opts: ProcessCursorOptions = {}
): CursorGrid {
  let pts = validPoints(samples, clicks)
  if (opts.antiTremor !== false) pts = removeTremor(pts)

  const lastT = pts.length > 0 ? pts[pts.length - 1]!.t : 0
  const duration = Math.max(0, opts.durationMs ?? lastT)
  const n = Math.floor(duration / GRID_STEP_MS + 1e-9) + 1

  const t: number[] = new Array<number>(n)
  const x: number[] = new Array<number>(n)
  const y: number[] = new Array<number>(n)

  if (pts.length === 0) {
    for (let i = 0; i < n; i++) {
      t[i] = i * GRID_STEP_MS
      x[i] = 0.5
      y[i] = 0.5
    }
    return { hz: GRID_HZ, t, x, y }
  }

  let j = 0 // último ponto com t <= tempo da grade
  for (let i = 0; i < n; i++) {
    const g = i * GRID_STEP_MS
    t[i] = g
    while (j + 1 < pts.length && pts[j + 1]!.t <= g) j++
    const p = pts[j]!
    if (g < p.t) {
      // antes do primeiro ponto
      x[i] = p.x
      y[i] = p.y
      continue
    }
    const q = pts[j + 1]
    if (q && q.t > p.t && q.t - p.t <= MAX_INTERP_GAP_MS) {
      const u = (g - p.t) / (q.t - p.t)
      x[i] = p.x + (q.x - p.x) * u
      y[i] = p.y + (q.y - p.y) * u
    } else {
      x[i] = p.x
      y[i] = p.y
    }
  }
  return { hz: GRID_HZ, t, x, y }
}

/** Posição na grade em `tMs`, com interpolação linear (limitada às pontas). */
export function sampleGrid(grid: CursorGrid, tMs: number): { x: number; y: number } {
  const n = grid.t.length
  if (n === 0) return { x: 0.5, y: 0.5 }
  const f = tMs / GRID_STEP_MS
  if (!(f > 0)) return { x: grid.x[0]!, y: grid.y[0]! }
  if (f >= n - 1) return { x: grid.x[n - 1]!, y: grid.y[n - 1]! }
  const i = Math.floor(f)
  const u = f - i
  return {
    x: grid.x[i]! + (grid.x[i + 1]! - grid.x[i]!) * u,
    y: grid.y[i]! + (grid.y[i + 1]! - grid.y[i]!) * u
  }
}

// ---------------------------------------------------------------------------
// Consulta exata (sem anti-tremor): o que coincide com o cursor que está no vídeo

export type CursorLookup = {
  /** Posição do cursor em `tMs` e se ele estava fora da área. */
  at(tMs: number): { x: number; y: number; out: boolean }
  /** Há alguma amostra? */
  readonly empty: boolean
}

/**
 * Posição exata do cursor em qualquer instante: interpola linearmente entre as amostras
 * originais (120 Hz) quando as duas vizinhas estão dentro da área e próximas; senão segura
 * a anterior. Usa o ÍNDICE anterior como dica, então tempos crescentes custam O(1).
 */
export function createCursorLookup(samples: readonly CursorSample[]): CursorLookup {
  const list = samples.filter((s) => finite(s.t) && finite(s.x) && finite(s.y)).sort((a, b) => a.t - b.t)
  let hint = 0
  return {
    empty: list.length === 0,
    at(tMs) {
      if (list.length === 0) return { x: 0.5, y: 0.5, out: true }
      // posiciona `hint` no último índice com t <= tMs
      while (hint + 1 < list.length && list[hint + 1]!.t <= tMs) hint++
      while (hint > 0 && list[hint]!.t > tMs) hint--
      const a = list[hint]!
      if (tMs < a.t) return { x: a.x, y: a.y, out: Boolean(a.out) }
      const b = list[hint + 1]
      if (b && !a.out && !b.out && b.t > a.t && b.t - a.t <= MAX_INTERP_GAP_MS) {
        const u = (tMs - a.t) / (b.t - a.t)
        return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, out: false }
      }
      return { x: a.x, y: a.y, out: Boolean(a.out) }
    }
  }
}

// ---------------------------------------------------------------------------
// Cursor sintético: mola, apagar parado, apertar no clique

export type SyntheticTrack = {
  hz: number
  /** Posição suavizada pela mola do cursor. */
  x: number[]
  y: number[]
  /** Opacidade 0..1 (some depois de parado, reaparece com fade). */
  alpha: number[]
}

export type SyntheticOptions = {
  durationMs: number
  /** Some depois de parado por esse tempo (ms); 0 = nunca. */
  hideAfterIdleMs: number
  /** Instantes de atividade além do movimento (cliques): zeram o tempo parado e fazem o cursor reaparecer. */
  activity?: readonly number[]
  spring?: SpringParams
}

const MOVE_EPS = 0.0008 // deslocamento por quadro da grade que conta como "mexeu"
const FADE_OUT_MS = 250
const FADE_IN_MS = 150

/**
 * Trilha do cursor sintético a 60 Hz: segue a posição EXATA do cursor com a mola do projeto
 * (k=470, c=70, m=3), apaga depois de `hideAfterIdleMs` parado e quando sai da área, e
 * reaparece com fade ao se mexer. Determinística.
 */
export function computeSyntheticCursor(lookup: CursorLookup, opts: SyntheticOptions): SyntheticTrack {
  const spring = opts.spring ?? CURSOR_SPRING
  const n = Math.floor(Math.max(0, opts.durationMs) / GRID_STEP_MS + 1e-9) + 1
  const dt = 1 / GRID_HZ
  const x: number[] = new Array<number>(n)
  const y: number[] = new Array<number>(n)
  const alpha: number[] = new Array<number>(n)

  const first = lookup.at(0)
  let sx = { x: first.x, v: 0 }
  let sy = { x: first.y, v: 0 }
  let prev = first
  let idleMs = 0
  let a = 0
  const activity = [...(opts.activity ?? [])].sort((p, q) => p - q)
  let ai = 0

  for (let i = 0; i < n; i++) {
    const tMs = i * GRID_STEP_MS
    const p = lookup.at(tMs)
    if (i > 0) {
      sx = springStep(sx.x, sx.v, p.x, spring, dt)
      sy = springStep(sy.x, sy.v, p.y, spring, dt)
    }
    let moved = Math.hypot(p.x - prev.x, p.y - prev.y) > MOVE_EPS
    // um clique (ou qualquer atividade) entre o quadro anterior e este conta como "mexeu"
    while (ai < activity.length && activity[ai]! <= tMs) {
      if (activity[ai]! > tMs - GRID_STEP_MS) moved = true
      ai++
    }
    idleMs = moved ? 0 : idleMs + GRID_STEP_MS
    prev = p

    const hide = p.out || lookup.empty || (opts.hideAfterIdleMs > 0 && idleMs >= opts.hideAfterIdleMs)
    const target = hide ? 0 : 1
    const rate = target > a ? dt / (FADE_IN_MS / 1000) : dt / (FADE_OUT_MS / 1000)
    a = a + Math.max(-rate, Math.min(rate, target - a))
    if (i === 0) a = target // começa já no estado certo (sem fade de entrada no quadro 0)

    x[i] = sx.x
    y[i] = sy.x
    alpha[i] = a
  }
  return { hz: GRID_HZ, x, y, alpha }
}

/** Amostra a trilha sintética em `tMs` (interpolação linear). */
export function sampleSynthetic(track: SyntheticTrack, tMs: number): { x: number; y: number; alpha: number } {
  const n = track.x.length
  if (n === 0) return { x: 0.5, y: 0.5, alpha: 0 }
  const f = tMs / GRID_STEP_MS
  if (!(f > 0)) return { x: track.x[0]!, y: track.y[0]!, alpha: track.alpha[0]! }
  if (f >= n - 1) return { x: track.x[n - 1]!, y: track.y[n - 1]!, alpha: track.alpha[n - 1]! }
  const i = Math.floor(f)
  const u = f - i
  const lerp = (arr: number[]): number => arr[i]! + (arr[i + 1]! - arr[i]!) * u
  return { x: lerp(track.x), y: lerp(track.y), alpha: lerp(track.alpha) }
}

/** O cursor "aperta" no clique: escala 1 → 0,85 (40 ms), segura até 120 ms, solta em 80 ms. */
export const PRESS_SCALE = 0.85
export const PRESS_DOWN_MS = 40
export const PRESS_HOLD_MS = 120
export const PRESS_UP_MS = 80

/** Escala do cursor sintético em `tMs` por causa dos cliques (função pura dos cliques). */
export function pressScale(clicks: readonly Pick<ClickEvent, 't'>[], tMs: number): number {
  let bump = 0
  for (const c of clicks) {
    const u = tMs - c.t
    if (u < 0 || u > PRESS_HOLD_MS + PRESS_UP_MS) continue
    let b: number
    if (u < PRESS_DOWN_MS) b = u / PRESS_DOWN_MS
    else if (u <= PRESS_HOLD_MS) b = 1
    else b = 1 - (u - PRESS_HOLD_MS) / PRESS_UP_MS
    if (b > bump) bump = b
  }
  return 1 - (1 - PRESS_SCALE) * bump
}
