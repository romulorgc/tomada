/**
 * Mola massa-mola-amortecedor com SOLUÇÃO ANALÍTICA.
 *
 * Integrar por Euler a passos de 1/60 s deixa a mola nervosa e instável com k alto; a solução
 * exata de `m·x'' + c·x' + k·(x − alvo) = 0` vale para qualquer `dt` (o caminho da câmera usa
 * 1/60 s, o do cursor também, mas o resultado não depende do passo).
 *
 * A velocidade é CARREGADA: quando o alvo muda, quem chama passa o `v` que saiu do passo
 * anterior e a animação continua sem degrau de velocidade (nunca reinicia do zero).
 *
 * Código puro: sem DOM, sem Node.
 */

export type SpringParams = {
  /** Rigidez. */
  k: number
  /** Amortecimento. */
  c: number
  /** Massa. */
  m: number
}

export type SpringState = { x: number; v: number }

/** Câmera do zoom: ζ ≈ 0,94, assenta em ~0,4 s. */
export const CAMERA_SPRING: SpringParams = { k: 200, c: 40, m: 2.25 }

/** Cursor sintético, estilo "Mellow": ζ ≈ 0,93. */
export const CURSOR_SPRING: SpringParams = { k: 470, c: 70, m: 3 }

/** Razão de amortecimento ζ = c / (2·√(k·m)): < 1 sub, = 1 crítico, > 1 super-amortecido. */
export function dampingRatio(p: SpringParams): number {
  return p.c / (2 * Math.sqrt(p.k * p.m))
}

/** Frequência natural ω0 = √(k/m) em rad/s. */
export function naturalFrequency(p: SpringParams): number {
  return Math.sqrt(p.k / p.m)
}

/** Dentro desta distância do crítico (|ζ − 1|) usa a fórmula crítica, que não divide por ~0. */
const CRITICAL_EPS = 1e-6
/** Abaixo disto (posição e velocidade) a mola já parou: encaixa no alvo (evita números denormais). */
const REST_EPS = 1e-9

/**
 * Avança a mola por `dt` segundos.
 *
 * - `dt <= 0` (ou não finito) devolve o estado como está;
 * - alvo igual à posição com velocidade zero devolve o próprio estado;
 * - entradas não finitas ou resultado não finito (valores extremos) viram "no alvo, parado":
 *   nunca devolve NaN.
 */
export function step(x: number, v: number, target: number, p: SpringParams, dt: number): SpringState {
  if (!(p.k > 0) || !(p.m > 0) || !(p.c >= 0)) {
    throw new RangeError(`mola inválida: k=${p.k} c=${p.c} m=${p.m}`)
  }
  if (!Number.isFinite(target)) return { x, v }
  if (!Number.isFinite(x) || !Number.isFinite(v)) return { x: target, v: 0 }
  if (!(dt > 0) || !Number.isFinite(dt)) return { x, v }

  const y0 = x - target
  if (y0 === 0 && v === 0) return { x, v: 0 }

  const w0 = Math.sqrt(p.k / p.m)
  const zeta = p.c / (2 * Math.sqrt(p.k * p.m))
  let y: number
  let vy: number

  if (Math.abs(zeta - 1) < CRITICAL_EPS) {
    // crítico: y = e^(−ω t)·(y0 + (v0 + ω·y0)·t)
    const e = Math.exp(-w0 * dt)
    const b = v + w0 * y0
    y = e * (y0 + b * dt)
    vy = e * (v - w0 * b * dt)
  } else if (zeta < 1) {
    // sub-amortecido: y = e^(−ζω t)·(A·cos(ωd t) + B·sin(ωd t))
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    const a = zeta * w0
    const e = Math.exp(-a * dt)
    const cos = Math.cos(wd * dt)
    const sin = Math.sin(wd * dt)
    const A = y0
    const B = (v + a * y0) / wd
    y = e * (A * cos + B * sin)
    vy = e * ((-a * A + B * wd) * cos + (-a * B - A * wd) * sin)
  } else {
    // super-amortecido: y = C1·e^(r1 t) + C2·e^(r2 t), r1 > r2 (ambos negativos)
    const root = w0 * Math.sqrt(zeta * zeta - 1)
    const r1 = -zeta * w0 + root
    const r2 = -zeta * w0 - root
    const C2 = (v - r1 * y0) / (r2 - r1)
    const C1 = y0 - C2
    const e1 = Math.exp(r1 * dt)
    const e2 = Math.exp(r2 * dt)
    y = C1 * e1 + C2 * e2
    vy = C1 * r1 * e1 + C2 * r2 * e2
  }

  if (!Number.isFinite(y) || !Number.isFinite(vy)) return { x: target, v: 0 }
  if (Math.abs(y) < REST_EPS && Math.abs(vy) < REST_EPS) return { x: target, v: 0 }
  return { x: target + y, v: vy }
}

/** Avança `n` passos iguais (útil em testes e para "assentar" uma mola). */
export function stepMany(state: SpringState, target: number, p: SpringParams, dt: number, n: number): SpringState {
  let s = state
  for (let i = 0; i < n; i++) s = step(s.x, s.v, target, p, dt)
  return s
}
