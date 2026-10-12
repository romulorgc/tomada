/**
 * F1 · prova de emenda (R6): o medidor reprova o "buraco" do fade a zero, aprova o cruzamento com alças reais, conta emendas por minuto,
 * menor trecho e emendas dentro de fala. Os sinais são SINTÉTICOS (ruído de fala e pausas), nada do usuário.
 */
import { describe, expect, it } from 'vitest'
import { SEAM_LIMITS, measureSeams, seamSummary, voiceReference } from '@shared/seam-proof'

const SR = 8000

/** Gerador pseudoaleatório fixo (o teste não pode oscilar). */
function noise(n: number, amp: number, seed = 1): Float32Array {
  const out = new Float32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out[i] = ((s / 0x100000000) * 2 - 1) * amp
  }
  return out
}

/** Fala sintética: rajadas de ruído a −20 dBFS de 600 ms separadas por pausas de 250 ms a −55 dBFS. */
function speechLike(seconds: number): Float32Array {
  const n = Math.round(seconds * SR)
  const x = noise(n, 0.001, 7)
  const burst = Math.round(0.6 * SR)
  const pause = Math.round(0.25 * SR)
  for (let start = Math.round(0.3 * SR); start + burst < n; start += burst + pause) {
    const b = noise(burst, 0.2, start)
    for (let i = 0; i < burst; i++) x[start + i] = b[i]!
  }
  return x
}

const dbfs = (amp: number): number => 20 * Math.log10(amp)

describe('referência de voz', () => {
  it('a mediana dos quadros acima do chão fica no nível da fala e o chão no da pausa', () => {
    const { voiceDb, floorDb } = voiceReference(speechLike(20), SR)
    expect(voiceDb).not.toBeNull()
    // ruído uniforme de amplitude 0,2 tem RMS 0,2/√3 = −18,8 dBFS
    expect(voiceDb!).toBeGreaterThan(-22)
    expect(voiceDb!).toBeLessThan(-16)
    expect(floorDb!).toBeLessThan(-50)
    expect(voiceReference(new Float32Array(10), SR)).toEqual({ voiceDb: null, floorDb: null })
  })
})

describe('queda de nível na emenda', () => {
  it('fade a zero de 30 ms + concat no meio da pausa (o de antes): buraco enorme é reprovado', () => {
    // pausa a −55 dBFS com um buraco de silêncio digital de 60 ms na emenda, como o "V" do fade a zero
    const x = speechLike(20)
    const seam = 4.425 // a pausa vai de 4,30 a 4,55 s
    const a = Math.round((seam - 0.03) * SR)
    const b = Math.round((seam + 0.03) * SR)
    for (let i = a; i < b; i++) x[i] = 0
    // coloca a fala ao lado do buraco (a emenda cai colada na fala, como em G2): a média em volta sobe e o buraco aparece
    const loud = noise(Math.round(0.05 * SR), 0.2, 99)
    for (let i = 0; i < loud.length; i++) {
      x[a - loud.length + i] = loud[i]!
      x[b + i] = loud[i]!
    }
    const r = measureSeams(x, SR, [seam * 1000], 20_000)
    expect(r.maxDropDb!).toBeGreaterThan(20)
    expect(r.ok).toBe(false)
    expect(r.failures.join(' ')).toContain('buraco no som')
  })

  it('cruzamento de potência igual em cima de uma pausa: queda pequena, aprovado', () => {
    const x = speechLike(20)
    const r = measureSeams(x, SR, [4425], 20_000, { limits: { minSegmentMs: 1000 } })
    expect(r.maxDropDb!).toBeLessThan(SEAM_LIMITS.maxDropDb)
    expect(r.measures[0]!.inSpeech).toBe(false)
  })

  it('emenda em cima de fala contínua é contada como "dentro da fala"', () => {
    const x = speechLike(20)
    // o meio de uma rajada: 0,3 + 0,6 + 0,25 = 1,15 s por ciclo; a 1ª rajada vai de 0,3 a 0,9 s
    const r = measureSeams(x, SR, [600], 20_000, { limits: { minSegmentMs: 100, maxSeamsPerMin: 100 } })
    expect(r.measures[0]!.inSpeech).toBe(true)
    expect(r.inSpeech).toBe(1)
    expect(r.ok).toBe(false)
    expect(r.failures.join(' ')).toContain('dentro da fala')
  })
})

describe('emendas por minuto, menor trecho e limites', () => {
  const x = speechLike(60)

  it('conta emendas por minuto do vídeo final e o menor trecho (ponta a ponta)', () => {
    const r = measureSeams(x, SR, [10_000, 20_000, 31_000, 45_000], 60_000)
    expect(r.seams).toBe(4)
    expect(r.seamsPerMin).toBeCloseTo(4, 10)
    expect(r.shortestMs).toBe(10_000)
    expect(r.under1500).toBe(0)
    const dense = measureSeams(x, SR, [10_000, 10_700, 20_000], 60_000)
    expect(dense.shortestMs).toBe(700)
    expect(dense.under1500).toBe(1)
    expect(dense.failures.join(' ')).toContain('700 ms')
  })

  it('a ponta do vídeo não é "entre emendas": 1,1 s de sobra no fim passa; sobra de 300 ms colada numa emenda é lasca', () => {
    const r = measureSeams(x, SR, [10_000, 20_000, 58_900], 60_000, { limits: { maxInSpeech: 99, maxDropDb: 99 } })
    expect(r.shortestMs).toBe(1100)
    expect(r.shortestBetweenMs).toBe(10_000)
    expect(r.failures.join(' ')).not.toContain('entre duas emendas')
    expect(r.failures.join(' ')).not.toContain('ponta')
    const lasca = measureSeams(x, SR, [10_000, 20_000, 59_700], 60_000, { limits: { maxInSpeech: 99, maxDropDb: 99 } })
    expect(lasca.shortestBetweenMs).toBe(10_000)
    expect(lasca.failures.join(' ')).toContain('sobra de 300 ms na ponta do vídeo')
    const umaSo = measureSeams(x, SR, [30_000], 60_000, { limits: { maxInSpeech: 99, maxDropDb: 99 } })
    expect(umaSo.shortestBetweenMs).toBeNull()
    expect(SEAM_LIMITS.minEdgeMs).toBe(400)
  })

  it('YouTube aceita 6 por minuto e o vertical 12; passou do teto reprova com o número', () => {
    const times = Array.from({ length: 9 }, (_, i) => 5000 + i * 5500)
    const h = measureSeams(x, SR, times, 60_000, { format: 'horizontal', limits: { maxInSpeech: 99, maxDropDb: 99 } })
    const v = measureSeams(x, SR, times, 60_000, { format: 'vertical', limits: { maxInSpeech: 99, maxDropDb: 99 } })
    expect(h.seamsPerMin).toBe(9)
    expect(h.failures.join(' ')).toContain('9,0 emendas por minuto (o teto é 6)')
    expect(v.failures.join(' ')).not.toContain('por minuto')
    expect(SEAM_LIMITS.maxSeamsPerMin).toEqual({ horizontal: 6, vertical: 12 })
    expect(SEAM_LIMITS.maxDropDb).toBe(6)
    expect(SEAM_LIMITS.minSegmentMs).toBe(1200)
  })

  it('sem emendas: nada a medir, passa', () => {
    const r = measureSeams(x, SR, [], 60_000)
    expect(r).toMatchObject({ seams: 0, shortestMs: null, shortestBetweenMs: null, maxDropDb: null, inSpeech: 0, ok: true })
  })

  it('a linha de resumo diz o que foi medido e, se reprovou, por quê', () => {
    const ok = seamSummary(measureSeams(x, SR, [10_000, 20_000], 60_000, { limits: { maxInSpeech: 99 } }))
    expect(ok).toMatch(/^Prova de emenda: passou \(2 emenda\(s\), 2,0 por minuto, menor trecho entre emendas 10,0 s/)
    const bad = seamSummary(measureSeams(x, SR, [10_000, 10_500], 60_000, { limits: { maxInSpeech: 99, maxDropDb: 99 } }))
    expect(bad).toContain('reprovou')
    expect(bad).toContain('500 ms')
  })

  it('o nível usado na conta é dBFS (um tom de amplitude 0,1 mede −20 dBFS em volta)', () => {
    const tone = new Float32Array(10 * SR)
    for (let i = 0; i < tone.length; i++) tone[i] = 0.1 * Math.sqrt(2) * Math.sin((2 * Math.PI * 440 * i) / SR)
    const r = measureSeams(tone, SR, [5000], 10_000, { limits: { minSegmentMs: 100, maxInSpeech: 99 } })
    expect(r.measures[0]!.aroundDb).toBeCloseTo(dbfs(0.1), 0)
    expect(r.measures[0]!.dropDb).toBeLessThan(1)
  })
})
