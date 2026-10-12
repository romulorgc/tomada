/**
 * Prova de emenda (F1, item 8 · R6): o app mede o PRÓPRIO vídeo exportado. Código puro: recebe o áudio já decodificado (mono, de
 * qualquer taxa) e os instantes de saída das emendas, e devolve o que o usuário sente ao assistir:
 *
 *  - **emendas por minuto** do vídeo final e o **menor trecho** entre duas emendas (e quantos têm menos de 1,5 s);
 *  - a **queda de nível** em cada emenda: o quadro de 10 ms mais baixo em ±25 ms da emenda contra o nível (mediana dos quadros de
 *    10 ms) dos 100 ms em volta, nas laterais, de 35 a 50 ms de cada lado. A mediana não se deixa levar por uma palavra que começa
 *    na beira da janela. O fade a zero de antes deixava ~45 dB de buraco ("tchu"); o cruzamento com alças reais deixa 3-4,5 dB,
 *    como as referências;
 *  - **emendas dentro de fala**: o nível NA emenda (±15 ms) é de fala, não de pausa.
 *
 * Limites (reprova, mas não bloqueia a exportação: registra no log e avisa na Revisão): queda ≤ 6 dB, trecho ≥ 1,2 s, emendas por
 * minuto ≤ 6 (YouTube) ou 12 (vertical), nenhuma emenda dentro de fala.
 */

export const SEAM_LIMITS = {
  /** Queda de nível máxima na emenda (dB) em relação à média dos 100 ms em volta. */
  maxDropDb: 6,
  /** Menor trecho entre duas emendas (ms). A ponta do vídeo (antes da 1ª e depois da última emenda) não é "entre emendas": vale o mínimo de lasca. */
  minSegmentMs: 1200,
  /** Menor ponta do vídeo (ms): uma sobra menor que isto, colada numa emenda, é lasca. */
  minEdgeMs: 400,
  /** Teto de emendas por minuto do vídeo final. */
  maxSeamsPerMin: { horizontal: 6, vertical: 12 },
  /** Emendas dentro de fala aceitas. */
  maxInSpeech: 0
} as const

/** Janela de 10 ms para o nível, passo de 5 ms. */
const FRAME_MS = 10
const HOP_MS = 5
/** A queda é procurada nesta distância da emenda (ms) e comparada com as laterais, de `FLANK_FROM_MS` a `FLANK_TO_MS` de cada lado. */
const DIP_SEARCH_MS = 25
const FLANK_FROM_MS = 35
const FLANK_TO_MS = 50
/** Janela do nível NA emenda (ms, centrada). */
const AT_MS = 30
/** Uma emenda está em fala quando o nível dela passa de (voz − isto) dB. */
const SPEECH_BELOW_VOICE_DB = 12
const SPEECH_ABOVE_FLOOR_DB = 10

export type SeamMeasure = {
  index: number
  outMs: number
  /** Nível (dBFS, mediana dos quadros de 10 ms) das laterais dos 100 ms em volta. */
  aroundDb: number
  /** O quadro de 10 ms mais baixo em ±25 ms. */
  dipDb: number
  /** `aroundDb − dipDb`, nunca negativo. */
  dropDb: number
  /** Nível (dBFS) dos 30 ms em volta da emenda. */
  atDb: number
  inSpeech: boolean
}

export type SeamReport = {
  durationMs: number
  seams: number
  seamsPerMin: number
  /** Menor trecho do vídeo, pontas incluídas (a conta do "antes", comparável), em ms; `null` sem emendas. */
  shortestMs: number | null
  /** Menor trecho ENTRE duas emendas (sem as pontas), em ms; `null` com menos de duas emendas. É o que o limite de 1,2 s olha. */
  shortestBetweenMs: number | null
  under1500: number
  maxDropDb: number | null
  /** Instante de saída (ms) da maior queda. */
  worstDropAtMs: number | null
  inSpeech: number
  /** Referência de voz e chão do arquivo (dBFS). */
  voiceDb: number | null
  floorDb: number | null
  measures: SeamMeasure[]
  /** O que reprovou, em português (vazio = passou). */
  failures: string[]
  ok: boolean
}

const dbOfPower = (p: number): number => (p > 1e-14 ? 10 * Math.log10(p) : -140)

/** Potência média (amplitude²) de `[a, b)` em amostras. */
function meanPower(x: Float32Array, a: number, b: number): number {
  const from = Math.max(0, Math.floor(a))
  const to = Math.min(x.length, Math.ceil(b))
  if (to <= from) return 0
  let sum = 0
  for (let i = from; i < to; i++) sum += x[i]! * x[i]!
  return sum / (to - from)
}

/** A referência de voz (mediana dos quadros de 10 ms acima do chão + 10 dB) e o chão (percentil 10), em dBFS. */
export function voiceReference(x: Float32Array, sampleRate: number): { voiceDb: number | null; floorDb: number | null } {
  const per = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000))
  const levels: number[] = []
  for (let i = 0; i + per <= x.length; i += per) levels.push(dbOfPower(meanPower(x, i, i + per)))
  if (levels.length < 20) return { voiceDb: null, floorDb: null }
  const sorted = [...levels].sort((a, b) => a - b)
  const floorDb = sorted[Math.floor(sorted.length * 0.1)]!
  const active = sorted.filter((v) => v > floorDb + SPEECH_ABOVE_FLOOR_DB)
  const voiceDb = active.length >= 5 ? active[active.length >> 1]! : null
  return { voiceDb, floorDb }
}

export type SeamMeasureOptions = {
  format?: 'horizontal' | 'vertical'
  limits?: Partial<{ maxDropDb: number; minSegmentMs: number; minEdgeMs: number; maxSeamsPerMin: number; maxInSpeech: number }>
}

/**
 * Mede as emendas. `seamMs` são os instantes de SAÍDA (ms) das emendas (as do projeto: `planSeams(keptRanges(...)).outMs`);
 * `durationMs` a duração do vídeo exportado.
 */
export function measureSeams(samples: Float32Array, sampleRate: number, seamMs: readonly number[], durationMs: number, options: SeamMeasureOptions = {}): SeamReport {
  const lim = {
    maxDropDb: options.limits?.maxDropDb ?? SEAM_LIMITS.maxDropDb,
    minSegmentMs: options.limits?.minSegmentMs ?? SEAM_LIMITS.minSegmentMs,
    minEdgeMs: options.limits?.minEdgeMs ?? SEAM_LIMITS.minEdgeMs,
    maxSeamsPerMin: options.limits?.maxSeamsPerMin ?? SEAM_LIMITS.maxSeamsPerMin[options.format ?? 'horizontal'],
    maxInSpeech: options.limits?.maxInSpeech ?? SEAM_LIMITS.maxInSpeech
  }
  const perMs = sampleRate / 1000
  const { voiceDb, floorDb } = voiceReference(samples, sampleRate)
  const speechCeiling = voiceDb === null || floorDb === null ? null : Math.max(voiceDb - SPEECH_BELOW_VOICE_DB, floorDb + SPEECH_ABOVE_FLOOR_DB)

  const measures: SeamMeasure[] = seamMs.map((t, index) => {
    const c = t * perMs
    const frameAt = (off: number): number => {
      const mid = c + off * perMs
      return dbOfPower(meanPower(samples, mid - (FRAME_MS / 2) * perMs, mid + (FRAME_MS / 2) * perMs))
    }
    let dipDb = Infinity
    for (let off = -DIP_SEARCH_MS; off <= DIP_SEARCH_MS; off += HOP_MS) dipDb = Math.min(dipDb, frameAt(off))
    const flanks: number[] = []
    for (let off = FLANK_FROM_MS; off <= FLANK_TO_MS; off += HOP_MS) flanks.push(frameAt(-off), frameAt(off))
    flanks.sort((a, b) => a - b)
    const aroundDb = (flanks[(flanks.length >> 1) - 1]! + flanks[flanks.length >> 1]!) / 2
    const atDb = dbOfPower(meanPower(samples, c - (AT_MS / 2) * perMs, c + (AT_MS / 2) * perMs))
    return {
      index,
      outMs: t,
      aroundDb,
      dipDb,
      dropDb: Math.max(0, aroundDb - dipDb),
      atDb,
      inSpeech: speechCeiling !== null && atDb >= speechCeiling
    }
  })

  const edges = [0, ...seamMs, durationMs]
  const segments = edges.slice(1).map((e, i) => e - edges[i]!)
  const shortestMs = seamMs.length > 0 ? Math.min(...segments) : null
  const between = segments.slice(1, -1)
  const shortestBetweenMs = between.length > 0 ? Math.min(...between) : null
  const edgeMs = seamMs.length > 0 ? Math.min(segments[0]!, segments[segments.length - 1]!) : null
  const under1500 = segments.filter((s) => s < 1500).length
  const worst = measures.reduce<SeamMeasure | null>((w, m) => (w === null || m.dropDb > w.dropDb ? m : w), null)
  const inSpeech = measures.filter((m) => m.inSpeech).length
  const seamsPerMin = durationMs > 0 ? (seamMs.length / durationMs) * 60_000 : 0

  const failures: string[] = []
  if (worst && worst.dropDb > lim.maxDropDb) {
    const n = measures.filter((m) => m.dropDb > lim.maxDropDb).length
    failures.push(`${n} emenda(s) com buraco no som acima de ${lim.maxDropDb} dB (a pior, aos ${(worst.outMs / 1000).toFixed(1).replace('.', ',')} s, cai ${worst.dropDb.toFixed(1).replace('.', ',')} dB)`)
  }
  if (shortestBetweenMs !== null && shortestBetweenMs < lim.minSegmentMs) failures.push(`trecho de ${Math.round(shortestBetweenMs)} ms entre duas emendas (o mínimo é ${lim.minSegmentMs} ms)`)
  if (edgeMs !== null && edgeMs < lim.minEdgeMs) failures.push(`sobra de ${Math.round(edgeMs)} ms na ponta do vídeo, colada numa emenda (o mínimo é ${lim.minEdgeMs} ms)`)
  if (seamsPerMin > lim.maxSeamsPerMin + 1e-9) failures.push(`${seamsPerMin.toFixed(1).replace('.', ',')} emendas por minuto (o teto é ${lim.maxSeamsPerMin})`)
  if (inSpeech > lim.maxInSpeech) failures.push(`${inSpeech} emenda(s) caem dentro da fala`)

  return {
    durationMs,
    seams: seamMs.length,
    seamsPerMin,
    shortestMs,
    shortestBetweenMs,
    under1500,
    maxDropDb: worst ? worst.dropDb : null,
    worstDropAtMs: worst ? worst.outMs : null,
    inSpeech,
    voiceDb,
    floorDb,
    measures,
    failures,
    ok: failures.length === 0
  }
}

/** Uma linha para o log e para a Revisão (o que foi medido e, se reprovou, por quê). */
export function seamSummary(r: SeamReport): string {
  const f = (v: number | null, d = 1): string => (v === null ? '—' : v.toFixed(d).replace('.', ','))
  const head = `${r.seams} emenda(s), ${f(r.seamsPerMin)} por minuto, menor trecho entre emendas ${r.shortestBetweenMs === null ? '—' : `${f(r.shortestBetweenMs / 1000)} s`}, maior queda de som ${f(r.maxDropDb)} dB, ${r.inSpeech} em fala`
  return r.ok ? `Prova de emenda: passou (${head}).` : `Prova de emenda: reprovou (${head}). ${r.failures.join('; ')}.`
}
