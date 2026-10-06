/** Qualidade do PCM original. Sem DOM/Node; tempos em milissegundos e medidas em dBFS. */
import { z } from 'zod'
import type { Range } from './types'

const BLOCK_MS = 20
const CLIPPING_AMPLITUDE = 10 ** (-0.5 / 20)
const MIN_ACTIVE_DBFS = -60
/** Voz bruta abaixo disto (LUFS integrado) é baixa demais: o `loudnorm` do pós subiria ~26 dB ou mais e o chiado junto. */
export const VERY_LOW_LUFS = -40

export const audioQualitySchema = z.object({
  version: z.literal(1),
  sampleRate: z.number().int().positive(),
  durationMs: z.number().finite().nonnegative(),
  peakDbfs: z.number().finite().nullable(),
  clippingMs: z.number().finite().nonnegative(),
  activeMs: z.number().finite().nonnegative(),
  activeRmsDbfs: z.number().finite().nullable(),
  noiseFloorDbfs: z.number().finite().nullable(),
  /** Volume integrado da voz BRUTA (antes do pós); ausente em projetos medidos antes deste campo. */
  integratedLufs: z.number().finite().nullable().optional(),
  warnings: z.array(z.enum(['clipping', 'low-voice', 'very-low-level'])).max(3)
})
export type AudioQualityReport = z.infer<typeof audioQualitySchema>
export type AudioQualityOptions = {
  /** Fala já confirmada por VAD/transcrição, em tempo do ARQUIVO. [] = ausência de fala conhecida.
   * Sem esta opção, usa energia sobre o piso e periodicidade vocal; não reconhece palavras. */
  activeRanges?: readonly Range[]
  /** LUFS integrado da voz bruta (ver `IntegratedLoudness`); `null` = silêncio ou curta demais. */
  integratedLufs?: number | null
}
export type AudioQualityBlock = { sampleCount: number; sumSquares: number; peak: number; clippedSamples: number; periodicity: number }

const dbfs = (amplitude: number): number | null => amplitude > 0 ? 20 * Math.log10(amplitude) : null

function assertSampleRate(sampleRate: number): void {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error('Taxa de amostragem inválida para analisar a qualidade do áudio.')
}

/** Autocorrelação local entre 80 e 400 Hz. A média por grupo reduz para ~4 kHz e elimina DC.
 * Sinais periódicos como vogais mantêm evidência mesmo quando não há pausa para medir o fundo.
 * Ruído branco e zumbido de rede fora dessa faixa não bastam para declarar atividade vocal. */
function voicePeriodicity(samples: Float32Array, from: number, end: number, sampleRate: number): number {
  const stride = Math.max(1, Math.round(sampleRate / 4000))
  const count = Math.floor((end - from) / stride)
  if (count < 40) return 0
  const reduced = new Float64Array(count)
  let mean = 0
  for (let i = 0; i < count; i++) {
    let sum = 0
    for (let j = 0; j < stride; j++) sum += samples[from + i * stride + j]!
    reduced[i] = sum / stride
    mean += reduced[i]!
  }
  mean /= count
  for (let i = 0; i < count; i++) reduced[i] = reduced[i]! - mean
  const minLag = Math.max(1, Math.ceil(sampleRate / stride / 400))
  const maxLag = Math.min(count - 24, Math.floor(sampleRate / stride / 80))
  let strongest = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let product = 0, left = 0, right = 0
    for (let i = 0; i < count - lag; i++) {
      const a = reduced[i]!, b = reduced[i + lag]!
      product += a * b; left += a * a; right += b * b
    }
    if (left > 0 && right > 0) strongest = Math.max(strongest, product / Math.sqrt(left * right))
  }
  return strongest
}

/** Estatísticas por 20 ms. Permite analisar um WAV em pedaços sem guardar toda a voz na memória.
 * Pedaços intermediários devem terminar em múltiplo de round(sampleRate × 0,02) amostras. */
export function measureAudioQualityBlocks(samples: Float32Array, sampleRate: number): AudioQualityBlock[] {
  assertSampleRate(sampleRate)
  const perBlock = Math.max(1, Math.round(sampleRate * BLOCK_MS / 1000))
  const blocks: AudioQualityBlock[] = []
  for (let from = 0; from < samples.length; from += perBlock) {
    const end = Math.min(samples.length, from + perBlock)
    let sumSquares = 0, peak = 0, clippedSamples = 0
    for (let i = from; i < end; i++) {
      const value = samples[i]!
      if (!Number.isFinite(value)) throw new Error('O áudio contém uma amostra inválida; não consegui medir sua qualidade.')
      const magnitude = Math.abs(value)
      sumSquares += value * value
      peak = Math.max(peak, magnitude)
      if (magnitude >= CLIPPING_AMPLITUDE) clippedSamples++
    }
    blocks.push({ sampleCount: end - from, sumSquares, peak, clippedSamples, periodicity: voicePeriodicity(samples, from, end, sampleRate) })
  }
  return blocks
}

export function analyzeAudioQualityBlocks(blocks: readonly AudioQualityBlock[], sampleRate: number, options: AudioQualityOptions = {}): AudioQualityReport {
  assertSampleRate(sampleRate)
  const levels = blocks.map((b) => dbfs(Math.sqrt(b.sumSquares / b.sampleCount)) ?? -100)
  const sorted = [...levels].sort((a, b) => a - b)
  // P20 estima o fundo. Margem de 10 dB ou periodicidade vocal, com um piso absoluto,
  // evitam chamar silêncio/ruído estacionário de voz. VAD continua recusando ausência de sinal.
  const noiseFloorDbfs = sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.2)]! : null
  const activeThreshold = options.activeRanges === undefined ? Math.max(MIN_ACTIVE_DBFS, (noiseFloorDbfs ?? -100) + 10) : MIN_ACTIVE_DBFS
  let sampleCount = 0, peak = 0, clippedSamples = 0, activeSamples = 0, activeSquares = 0
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    const start = sampleCount * 1000 / sampleRate
    const end = (sampleCount + b.sampleCount) * 1000 / sampleRate
    const confirmed = options.activeRanges === undefined || options.activeRanges.some((r) => r.start < end && r.end > start)
    const energetic = levels[i]! > activeThreshold
    const periodic = options.activeRanges === undefined && b.periodicity >= 0.75 && levels[i]! > MIN_ACTIVE_DBFS
    if (confirmed && (energetic || periodic)) { activeSamples += b.sampleCount; activeSquares += b.sumSquares }
    sampleCount += b.sampleCount
    peak = Math.max(peak, b.peak)
    clippedSamples += b.clippedSamples
  }
  const clippingMs = clippedSamples * 1000 / sampleRate
  const activeMs = activeSamples * 1000 / sampleRate
  const activeRmsDbfs = activeSamples ? dbfs(Math.sqrt(activeSquares / activeSamples)) : null
  const warnings: AudioQualityReport['warnings'] = []
  if (clippingMs >= 100) warnings.push('clipping')
  // 300 ms evita converter um clique/estalo num diagnóstico de voz. A tolerância é só o
  // arredondamento Float32 no limiar exato; não altera o limiar acústico de -35 dBFS.
  if (activeMs >= 300 && activeRmsDbfs !== null && activeRmsDbfs < -35 - 1e-6) warnings.push('low-voice')
  const integratedLufs = options.integratedLufs ?? null
  if (integratedLufs !== null && integratedLufs < VERY_LOW_LUFS) warnings.push('very-low-level')
  return { version: 1, sampleRate, durationMs: sampleCount * 1000 / sampleRate, peakDbfs: dbfs(peak), clippingMs, activeMs, activeRmsDbfs, noiseFloorDbfs, ...(options.integratedLufs !== undefined ? { integratedLufs } : {}), warnings }
}

export function analyzeAudioQuality(samples: Float32Array, sampleRate: number, options: AudioQualityOptions = {}): AudioQualityReport {
  return analyzeAudioQualityBlocks(measureAudioQualityBlocks(samples, sampleRate), sampleRate, options)
}
