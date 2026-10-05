/**
 * Matemática da linha do tempo. Tudo em milissegundos, tempo de
 * origem ↔ tempo de saída. Código puro: sem DOM, sem Node.
 */
import type { Cut, Range, Word } from './types'

/**
 * Trechos mantidos de [0, duration] depois de tirar os cortes LIGADOS.
 * - cortes desligados são ignorados;
 * - cortes sobrepostos ou adjacentes viram um só;
 * - cortes fora de [0, duration] são limitados; os que sobram vazios somem;
 * - duração zero (ou negativa/NaN) não corta nada;
 * - corte cobrindo tudo → [].
 * O resultado é ordenado, sem sobreposição e sem trechos vazios.
 */
export function keptRanges(duration: number, cuts: readonly Pick<Cut, 'start' | 'end' | 'enabled'>[]): Range[] {
  if (!Number.isFinite(duration) || duration <= 0) return []

  const spans: Range[] = []
  for (const cut of cuts) {
    if (!cut.enabled) continue
    const start = Math.max(0, cut.start)
    const end = Math.min(duration, cut.end)
    if (!(end > start)) continue // vazio, invertido, NaN ou fora da duração
    spans.push({ start, end })
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end)

  // Funde sobrepostos e adjacentes.
  const merged: Range[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start <= last.end) {
      if (span.end > last.end) last.end = span.end
    } else {
      merged.push({ start: span.start, end: span.end })
    }
  }

  // Complemento: o que sobra entre os cortes.
  const kept: Range[] = []
  let cursor = 0
  for (const span of merged) {
    if (span.start > cursor) kept.push({ start: cursor, end: span.start })
    cursor = span.end
  }
  if (cursor < duration) kept.push({ start: cursor, end: duration })
  return kept
}

/** Duração do vídeo de saída (ms): a soma dos trechos mantidos. */
export function outputDuration(duration: number, cuts: readonly Pick<Cut, 'start' | 'end' | 'enabled'>[]): number {
  return rangesLength(keptRanges(duration, cuts))
}

export function rangesLength(ranges: readonly Range[]): number {
  let total = 0
  for (const r of ranges) total += r.end - r.start
  return total
}

/**
 * Tempo de origem → tempo de saída.
 * Dentro de um trecho mantido, é o deslocamento acumulado. Dentro de um corte,
 * vale o instante de saída do ponto de corte (a saída é contínua ali). Antes de
 * 0 → 0; depois do fim → duração de saída.
 */
export function sourceToOutput(t: number, kept: readonly Range[]): number {
  let acc = 0
  for (const r of kept) {
    if (t < r.start) return acc // caiu num corte antes deste trecho
    if (t < r.end) return acc + (t - r.start)
    acc += r.end - r.start
  }
  return acc
}

/**
 * Tempo de saída → tempo de origem.
 * Na emenda entre dois trechos, devolve o INÍCIO do trecho seguinte (é o quadro
 * que aparece naquele instante). Em cima do fim da saída, devolve o fim do
 * último trecho. Sem trechos → 0. Fora de [0, total] é limitado.
 */
export function outputToSource(o: number, kept: readonly Range[]): number {
  if (kept.length === 0) return 0
  if (!(o > 0)) return kept[0]!.start
  let acc = 0
  for (const r of kept) {
    const len = r.end - r.start
    if (o < acc + len) return r.start + (o - acc)
    acc += len
  }
  return kept[kept.length - 1]!.end
}

export type SnapOptions = {
  /**
   * Fora de qualquer palavra (num silêncio), gruda na borda de palavra mais
   * próxima se estiver a no máximo esta distância (ms). Padrão 0 = não gruda.
   */
  gapSnapMs?: number
}

/**
 * Evita cortar uma palavra ao meio. Se `t` cai DENTRO de uma palavra
 * (start < t < end), vai para a borda mais próxima dela (empate → início).
 * Em silêncio fica onde está, a menos que `gapSnapMs` peça para grudar.
 * `words` precisa estar ordenado por `start`.
 */
export function snapToWord(t: number, words: readonly Pick<Word, 'start' | 'end'>[], opts: SnapOptions = {}): number {
  if (words.length === 0) return t

  // Última palavra que começa antes (ou em) t.
  let lo = 0
  let hi = words.length - 1
  let idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (words[mid]!.start <= t) {
      idx = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  if (idx >= 0) {
    const w = words[idx]!
    if (t > w.start && t < w.end) {
      return t - w.start <= w.end - t ? w.start : w.end
    }
  }

  const gap = opts.gapSnapMs ?? 0
  if (gap > 0) {
    let best = t
    let bestDist = Infinity
    const consider = (edge: number): void => {
      const d = Math.abs(edge - t)
      if (d < bestDist) {
        best = edge
        bestDist = d
      }
    }
    const prev = idx >= 0 ? words[idx] : undefined
    const next = words[idx + 1]
    if (prev) {
      consider(prev.start)
      consider(prev.end)
    }
    if (next) {
      consider(next.start)
      consider(next.end)
    }
    if (bestDist <= gap) return best
  }
  return t
}
