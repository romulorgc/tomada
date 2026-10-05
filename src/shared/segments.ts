/**
 * Operações sobre segmentos da linha do tempo (zooms e trechos de layout): criar, mover, redimensionar
 * e dividir SEM SOBREPOR os vizinhos. Tudo em milissegundos de ORIGEM. Código puro: sem DOM, sem Node.
 *
 * Todas as funções devolvem um array NOVO (os objetos que não mudam são reaproveitados) e nunca mexem no
 * que receberam. Os arrastes da interface partem do estado do instante em que o gesto começou e passam o
 * deslocamento TOTAL, então o resultado não acumula erro a cada movimento do mouse.
 */

export type Seg = { id: string; start: number; end: number }

/** Limites do eixo e comprimento mínimo de um segmento (ms). */
export type SegBounds = { min: number; max: number; minLen?: number }

/** Comprimento mínimo padrão de um segmento (ms). */
export const MIN_SEG_MS = 200

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const mid = (s: Seg): number => (s.start + s.end) / 2

/** Segmentos em ordem de início (cópia). */
export function sortedSegs<T extends Seg>(segs: readonly T[]): T[] {
  return [...segs].sort((a, b) => a.start - b.start || a.end - b.end)
}

/**
 * O espaço livre em volta de `seg`: do fim do vizinho da esquerda ao início do vizinho da direita
 * (ou aos limites do eixo). "Vizinho" é decidido pelo ponto médio, então funciona mesmo com dados
 * antigos que se sobrepõem.
 */
export function freeSpaceAround<T extends Seg>(segs: readonly T[], seg: Seg, bounds: SegBounds): { from: number; to: number } {
  let from = bounds.min
  let to = bounds.max
  const m = mid(seg)
  for (const o of segs) {
    if (o.id === seg.id) continue
    if (mid(o) <= m) from = Math.max(from, o.end)
    else to = Math.min(to, o.start)
  }
  return { from, to }
}

/** Há segmento cobrindo o instante `t` (início incluído, fim excluído)? */
export function segAt<T extends Seg>(segs: readonly T[], t: number): T | undefined {
  let found: T | undefined
  for (const s of segs) if (t >= s.start && t < s.end && (!found || s.start >= found.start)) found = s
  return found
}

/**
 * Move `id` por `delta` ms, parando no vizinho (nunca atravessa nem sobrepõe) e nos limites do eixo.
 * Sem espaço para andar, devolve o próprio array.
 */
export function moveSeg<T extends Seg>(segs: readonly T[], id: string, delta: number, bounds: SegBounds): T[] {
  const seg = segs.find((s) => s.id === id)
  if (!seg || !Number.isFinite(delta)) return [...segs]
  const len = seg.end - seg.start
  const { from, to } = freeSpaceAround(segs, seg, bounds)
  if (to - from < len) return [...segs]
  const start = Math.round(clamp(seg.start + delta, from, to - len))
  if (start === seg.start) return [...segs]
  return segs.map((s) => (s.id === id ? { ...s, start, end: start + len } : s))
}

/**
 * Arrasta a borda `edge` de `id` até `to`. A borda para no vizinho, nos limites do eixo e a
 * `minLen` da borda oposta (o segmento nunca vira de ponta-cabeça nem some).
 */
export function resizeSeg<T extends Seg>(segs: readonly T[], id: string, edge: 'start' | 'end', to: number, bounds: SegBounds): T[] {
  const seg = segs.find((s) => s.id === id)
  if (!seg || !Number.isFinite(to)) return [...segs]
  const minLen = bounds.minLen ?? MIN_SEG_MS
  const { from, to: limit } = freeSpaceAround(segs, seg, bounds)
  const next = { ...seg }
  if (edge === 'start') next.start = Math.round(clamp(to, from, seg.end - minLen))
  else next.end = Math.round(clamp(to, seg.start + minLen, limit))
  if (next.end - next.start < minLen) return [...segs]
  if (next.start === seg.start && next.end === seg.end) return [...segs]
  return segs.map((s) => (s.id === id ? next : s))
}

/**
 * O intervalo de um segmento novo criado ARRASTANDO de `a` até `b`: fica no espaço livre onde o
 * gesto começou (`a`) e tem pelo menos `minLen`. `null` quando `a` cai em cima de outro segmento ou o
 * espaço é pequeno demais.
 */
export function newSegRange(segs: readonly Seg[], a: number, b: number, bounds: SegBounds): { start: number; end: number } | null {
  const minLen = bounds.minLen ?? MIN_SEG_MS
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  if (segAt(segs, a)) return null
  let from = bounds.min
  let to = bounds.max
  for (const s of segs) {
    if (s.end <= a) from = Math.max(from, s.end)
    else if (s.start >= a) to = Math.min(to, s.start)
  }
  const start = Math.round(clamp(Math.min(a, b), from, to))
  const end = Math.round(clamp(Math.max(a, b), from, to))
  return end - start >= minLen ? { start, end } : null
}

/**
 * Divide `id` em `at`: o primeiro pedaço fica com o id original e o segundo recebe `newId`.
 * `null` se o ponto não deixa `minLen` dos dois lados.
 */
export function splitSeg<T extends Seg>(segs: readonly T[], id: string, at: number, newId: string, minLen = MIN_SEG_MS): T[] | null {
  const seg = segs.find((s) => s.id === id)
  if (!seg || at - seg.start < minLen || seg.end - at < minLen) return null
  const cut = Math.round(at)
  const out: T[] = []
  for (const s of segs) {
    if (s.id !== id) {
      out.push(s)
      continue
    }
    out.push({ ...s, end: cut }, { ...s, id: newId, start: cut })
  }
  return out
}

/** Próximo id livre da forma `<prefixo>-<n>` (n maior que todos os já usados com o prefixo). */
export function nextSegId(segs: readonly { id: string }[], prefix: string): string {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`)
  let max = 0
  for (const s of segs) {
    const m = re.exec(s.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}-${max + 1}`
}

/** Segmentos que se sobrepõem (para conferir documentos antigos). */
export function overlappingPairs(segs: readonly Seg[]): [string, string][] {
  const sorted = sortedSegs(segs)
  const out: [string, string][] = []
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const cur = sorted[i]!
    if (cur.start < prev.end) out.push([prev.id, cur.id])
  }
  return out
}
