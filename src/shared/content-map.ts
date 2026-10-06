/**
 * Mapa de CONTEÚDO da tela (correção do enquadramento do 9:16): onde, na imagem, está o que vale ser visto.
 *
 * O enquadramento da janela quadrada (`action-focus.ts`) inferia a coluna de conteúdo só pelas ações (cliques, digitação, cursor
 * parado). Com poucos cliques e o cursor parado numa borda da coluna, a janela saía deslocada e cortava o texto. Este arquivo mede a
 * própria imagem: no processamento, a cada segundo da tela, a densidade de bordas (texto, ícones, linhas) em uma grade de
 * `CONTENT_GRID.cols × CONTENT_GRID.rows` células. Áreas uniformes (fundo branco) ficam em 0; texto fica alto.
 *
 * Fica guardado em `events/content-map.jsonl` (uma linha por mudança de imagem: tela parada não ocupa espaço) e a cena o lê já
 * pronto: nada aqui roda por quadro da prévia. A grade é da tela gravada INTEIRA; o recorte do navegador (C1) é aplicado na hora
 * de montar o perfil de cada eixo (`axisProfile`), então abas e barra de tarefas não contam e mudar o recorte não pede nova medida.
 *
 * Código puro: sem DOM, sem Node. O ffmpeg e o disco ficam em `src/main/content-map.ts`.
 */
import { FULL_RECT, type CropTimeline } from './crop'
import type { Rect } from './types'

export const CONTENT_GRID = { cols: 64, rows: 36 } as const
export const CONTENT_MAP_FILE = 'content-map.jsonl'

/** Diferença de brilho (|dx| + |dy|, 0-255) a partir da qual um pixel é "borda": o contorno de uma letra passa de longe. */
export const EDGE_THRESHOLD = 30
/** Fração de pixels de borda numa célula que vale densidade 1 (uma célula cheia de texto fica em 0,12-0,25). */
export const EDGE_FULL = 0.25
/** Variação média da grade (0-1) abaixo da qual a imagem é "a mesma" e a amostra não é guardada. */
export const SAME_CONTENT_EPS = 0.004

/** Uma amostra: a grade (densidade 0-255 por célula, linha a linha) vale de `t` até a próxima amostra. */
export type ContentSample = { t: number; cols: number; rows: number; cells: Uint8Array }
export type ContentMap = ContentSample[]

// ---------------------------------------------------------------------------
// Da imagem à grade

/**
 * Tons de cinza (`w × h`, 1 byte por pixel) → densidade de bordas por célula, 0-255. A célula `(c, r)` cobre os pixels
 * `[c·w/cols, (c+1)·w/cols) × [r·h/rows, (r+1)·h/rows)`.
 */
export function contentCellsFromGray(gray: Uint8Array, w: number, h: number, cols: number = CONTENT_GRID.cols, rows: number = CONTENT_GRID.rows): Uint8Array {
  if (!(w > 1) || !(h > 1) || gray.length < w * h) throw new RangeError(`quadro cinza inválido: ${w}×${h}, ${gray.length} bytes`)
  const edges = new Float64Array(cols * rows)
  const area = new Float64Array(cols * rows)
  for (let y = 0; y < h; y++) {
    const r = Math.min(rows - 1, Math.floor((y * rows) / h))
    for (let x = 0; x < w; x++) {
      const c = Math.min(cols - 1, Math.floor((x * cols) / w))
      const i = r * cols + c
      area[i]! += 1
      if (x < w - 1 && y < h - 1) {
        const p = gray[y * w + x]!
        const g = Math.abs(gray[y * w + x + 1]! - p) + Math.abs(gray[(y + 1) * w + x]! - p)
        if (g >= EDGE_THRESHOLD) edges[i]! += 1
      }
    }
  }
  const out = new Uint8Array(cols * rows)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(1, edges[i]! / Math.max(1, area[i]!) / EDGE_FULL) * 255)
  return out
}

/** As duas grades são (quase) a mesma imagem? Só a variação média conta. */
export function sameContent(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!)
  return sum / a.length / 255 < SAME_CONTENT_EPS
}

/** Tira as amostras que repetem a anterior: a tela parada por um minuto vira UMA linha no arquivo. A primeira fica sempre. */
export function dedupeContentMap(samples: readonly ContentSample[]): ContentMap {
  const out: ContentMap = []
  for (const s of [...samples].sort((a, b) => a.t - b.t)) {
    const last = out[out.length - 1]
    if (last && last.cols === s.cols && last.rows === s.rows && sameContent(last.cells, s.cells)) continue
    out.push(s)
  }
  return out
}

// ---------------------------------------------------------------------------
// Arquivo (JSON Lines: `{"t":1000,"c":64,"r":36,"g":"<base64>"}`)

export function encodeCells(cells: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < cells.length; i += 0x2000) bin += String.fromCharCode(...cells.subarray(i, i + 0x2000))
  return btoa(bin)
}

export function decodeCells(text: string): Uint8Array | null {
  try {
    const bin = atob(text)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export function contentMapToJsonLines(map: readonly ContentSample[]): string {
  return map.map((s) => JSON.stringify({ t: Math.round(s.t), c: s.cols, r: s.rows, g: encodeCells(s.cells) })).join('\n') + (map.length > 0 ? '\n' : '')
}

/** Uma linha lida do arquivo; só vale se o tamanho da grade bate com `c × r`. */
export function contentSampleFromLine(line: unknown): ContentSample | null {
  if (typeof line !== 'object' || line === null) return null
  const { t, c, r, g } = line as { t?: unknown; c?: unknown; r?: unknown; g?: unknown }
  if (typeof t !== 'number' || !Number.isFinite(t) || typeof c !== 'number' || typeof r !== 'number' || typeof g !== 'string') return null
  if (!Number.isInteger(c) || !Number.isInteger(r) || c < 2 || r < 2 || c > 512 || r > 512) return null
  const cells = decodeCells(g)
  return cells && cells.length === c * r ? { t, cols: c, rows: r, cells } : null
}

// ---------------------------------------------------------------------------
// Do mapa ao perfil de um eixo, na área-base (a página já recortada)

/** Quantos trechos o perfil de um eixo tem. */
export const PROFILE_BINS = 64

/**
 * A densidade média (0-1) de cada trecho da área-base ao longo do eixo `axis`, vista pela amostra: `rect` (normalizado na tela
 * gravada) é a área-base; as células fora dela não contam, as que ela corta contam pela fração que fica dentro.
 */
export function axisProfile(sample: ContentSample, rect: Rect, axis: 'x' | 'y', bins: number = PROFILE_BINS): number[] {
  const along = axis === 'x' ? { n: sample.cols, a0: rect.x, len: rect.w } : { n: sample.rows, a0: rect.y, len: rect.h }
  const across = axis === 'x' ? { n: sample.rows, a0: rect.y, len: rect.h } : { n: sample.cols, a0: rect.x, len: rect.w }
  const cell = (u: number, v: number): number => (axis === 'x' ? sample.cells[v * sample.cols + u]! : sample.cells[u * sample.cols + v]!) / 255
  const out: number[] = new Array<number>(bins).fill(0)
  // a faixa de células cruzada (o outro eixo) e o peso de cada uma: a fração dela que o recorte cobre
  const crossLo = across.a0
  const crossHi = across.a0 + across.len
  const crossWeights: { v: number; w: number }[] = []
  for (let v = Math.max(0, Math.floor(crossLo * across.n)); v < Math.min(across.n, Math.ceil(crossHi * across.n)); v++) {
    const w = Math.min(crossHi, (v + 1) / across.n) - Math.max(crossLo, v / across.n)
    if (w > 1e-9) crossWeights.push({ v, w })
  }
  const crossTotal = crossWeights.reduce((s, c) => s + c.w, 0)
  if (crossTotal <= 0 || !(along.len > 0)) return out
  for (let j = 0; j < bins; j++) {
    const lo = along.a0 + (j / bins) * along.len
    const hi = along.a0 + ((j + 1) / bins) * along.len
    let sum = 0
    let weight = 0
    for (let u = Math.max(0, Math.floor(lo * along.n)); u < Math.min(along.n, Math.ceil(hi * along.n)); u++) {
      const wu = Math.min(hi, (u + 1) / along.n) - Math.max(lo, u / along.n)
      if (wu <= 1e-9) continue
      for (const { v, w } of crossWeights) {
        sum += cell(u, v) * wu * w
        weight += wu * w
      }
    }
    out[j] = weight > 0 ? sum / weight : 0
  }
  return out
}

/** O bloco principal de conteúdo num eixo: `start`/`end` na área-base (0-1) e `mass`, a soma da densidade dele. */
export type ContentBlock = { start: number; end: number; mass: number }

/** Densidade média (0-1) abaixo da qual o eixo está vazio: página em branco, tela apagada. */
export const BLOCK_MIN_PEAK = 0.04
/** Um trecho entra no bloco quando passa desta fração do que é denso neste eixo (o percentil 90 do perfil). */
export const BLOCK_THRESHOLD = 0.35
/** Vãos menores que isto (trechos do perfil) não separam dois blocos: entrelinhas, margens entre colunas de texto. */
export const BLOCK_MERGE_GAP = 3

/**
 * O bloco principal de conteúdo num eixo: a faixa contínua mais "pesada" (a que soma mais densidade). Áreas uniformes e faixas
 * esparsas ficam de fora; uma barra de navegação estreita, ainda que densa, perde para a coluna central que tem mais conteúdo.
 * `null` quando não há o que ver (perfil vazio).
 */
export function mainBlock(profile: readonly number[]): ContentBlock | null {
  const n = profile.length
  if (n < 4) return null
  const smooth = profile.map((_, i) => ((profile[i - 1] ?? profile[i]!) + profile[i]! + (profile[i + 1] ?? profile[i]!)) / 3)
  const sorted = [...smooth].sort((a, b) => a - b)
  const p90 = sorted[Math.min(n - 1, Math.floor(n * 0.9))]!
  if (p90 < BLOCK_MIN_PEAK) return null
  const limit = Math.max(BLOCK_MIN_PEAK * 0.5, BLOCK_THRESHOLD * p90)
  const runs: { a: number; b: number }[] = []
  for (let i = 0; i < n; i++) {
    if (smooth[i]! < limit) continue
    const last = runs[runs.length - 1]
    if (last && i - last.b - 1 <= BLOCK_MERGE_GAP) last.b = i
    else runs.push({ a: i, b: i })
  }
  let best: ContentBlock | null = null
  for (const r of runs) {
    let mass = 0
    for (let i = r.a; i <= r.b; i++) mass += profile[i]!
    if (!best || mass > best.mass) best = { start: r.a / n, end: (r.b + 1) / n, mass }
  }
  return best
}

/** Que fração da densidade do bloco cabe na janela `[lo, hi]` (0-1)? */
export function blockCover(profile: readonly number[], block: ContentBlock, lo: number, hi: number): number {
  const n = profile.length
  let inside = 0
  let total = 0
  for (let i = Math.max(0, Math.floor(block.start * n + 1e-9)); i < Math.min(n, Math.ceil(block.end * n - 1e-9)); i++) {
    const v = profile[i]!
    total += v
    inside += v * Math.max(0, Math.min(hi, (i + 1) / n) - Math.max(lo, i / n)) * n
  }
  return total > 0 ? inside / total : 1
}

// ---------------------------------------------------------------------------
// O mapa ao longo do tempo, na área-base

export type ContentTrack = {
  /** O perfil (0-1) do eixo na área-base no instante `t` (ms de origem): o da amostra que vale em `t`. */
  profileAt(t: number, axis: 'x' | 'y'): number[]
  /** Quando a imagem muda (início de cada amostra), em ms. */
  readonly times: readonly number[]
}

/**
 * O mapa visto pela área-base: a cada instante, o recorte vigente (`crop`, ou a tela inteira). `null` sem mapa. Guarda cada perfil
 * já calculado: a janela do 9:16 pergunta o mesmo instante várias vezes.
 */
export function createContentTrack(map: readonly ContentSample[] | undefined, crop: Pick<CropTimeline, 'at'> | null): ContentTrack | null {
  const samples = (map ?? []).filter((s) => Number.isFinite(s.t) && s.cells.length === s.cols * s.rows)
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a.t - b.t)
  const memo = new Map<string, number[]>()
  const indexAt = (t: number): number => {
    let lo = 0
    let hi = sorted.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (sorted[mid]!.t <= t) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  return {
    times: sorted.map((s) => s.t),
    profileAt(t, axis) {
      const i = indexAt(t)
      const rect = crop ? crop.at(t) : FULL_RECT
      const key = `${i}|${axis}|${rect.x.toFixed(4)},${rect.y.toFixed(4)},${rect.w.toFixed(4)},${rect.h.toFixed(4)}`
      let hit = memo.get(key)
      if (!hit) {
        hit = axisProfile(sorted[i]!, rect, axis)
        memo.set(key, hit)
      }
      return hit
    }
  }
}
