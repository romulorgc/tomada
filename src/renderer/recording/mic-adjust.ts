import { MIC_PEAK_TARGET_DBFS, planVolumeStep, type MicVolumeInfo } from '@shared/mic-level'

/** "Ajustar sozinho": mede a fala, sobe o volume de entrada do Windows desse aparelho e mede de novo, até a fala chegar a ~-12 dBFS. */
export type AdjustFailure = 'unsupported' | 'no-speech' | 'at-max' | 'at-min' | 'rejected' | 'no-convergence' | 'cancelled'
export type AdjustOutcome =
  | { kind: 'done'; peakDbfs: number; info: MicVolumeInfo; steps: number }
  | { kind: 'failed'; reason: AdjustFailure; peakDbfs: number | null; info: MicVolumeInfo | null }
export type AdjustProgress = { step: number; total: number; phase: 'listening' | 'applying'; peakDbfs: number | null; info: MicVolumeInfo | null }

export type AdjustDeps = {
  label: string
  readVolume(label: string): Promise<MicVolumeInfo | null>
  setVolumeDb(label: string, db: number): Promise<MicVolumeInfo | null>
  /** Espera fala (pico acima do silêncio da sala); `false` se não veio no prazo ou foi cancelado. */
  waitForSpeech(timeoutMs: number): Promise<boolean>
  /** Maior pico (dBFS) dos últimos `ms`. */
  peakSince(ms: number): number | null
  /** Descarta a medida antiga (o volume acabou de mudar). */
  resetMeter(): void
  sleep(ms: number): Promise<void>
  isCancelled(): boolean
  onProgress?(progress: AdjustProgress): void
}

export const ADJUST_MAX_STEPS = 6
/** Quanto tempo de fala entra em cada medida. */
export const ADJUST_WINDOW_MS = 2200
/** Quanto esperar a pessoa começar a falar. */
export const ADJUST_SPEECH_TIMEOUT_MS = 12_000
/** O driver leva um instante para aplicar o novo ganho ao áudio que chega. */
export const ADJUST_SETTLE_MS = 500

export async function adjustMicVolume(deps: AdjustDeps): Promise<AdjustOutcome> {
  let info = await deps.readVolume(deps.label)
  if (!info) return { kind: 'failed', reason: 'unsupported', peakDbfs: null, info: null }
  let peak: number | null = null
  for (let step = 1; step <= ADJUST_MAX_STEPS; step++) {
    deps.onProgress?.({ step, total: ADJUST_MAX_STEPS, phase: 'listening', peakDbfs: peak, info })
    deps.resetMeter()
    if (!(await deps.waitForSpeech(ADJUST_SPEECH_TIMEOUT_MS))) return { kind: 'failed', reason: deps.isCancelled() ? 'cancelled' : 'no-speech', peakDbfs: peak, info }
    await deps.sleep(ADJUST_WINDOW_MS)
    if (deps.isCancelled()) return { kind: 'failed', reason: 'cancelled', peakDbfs: peak, info }
    peak = deps.peakSince(ADJUST_WINDOW_MS + 300)
    const plan = planVolumeStep({ currentDb: info.db, peakDbfs: peak, minDb: info.minDb, maxDb: info.maxDb, stepDb: info.stepDb })
    deps.onProgress?.({ step, total: ADJUST_MAX_STEPS, phase: 'applying', peakDbfs: peak, info })
    if (plan.action === 'done') return { kind: 'done', peakDbfs: peak!, info, steps: step }
    if (plan.action === 'no-speech') return { kind: 'failed', reason: 'no-speech', peakDbfs: peak, info }
    if (plan.action === 'at-limit') return { kind: 'failed', reason: plan.direction === 'up' ? 'at-max' : 'at-min', peakDbfs: peak, info }
    const next = await deps.setVolumeDb(deps.label, plan.nextDb)
    // O Windows pode aceitar só uma parte (passos do aparelho): o que vale é o que ele devolve.
    if (!next || Math.abs(next.db - plan.nextDb) > Math.max(0.5, info.stepDb * 2)) return { kind: 'failed', reason: 'rejected', peakDbfs: peak, info: next ?? info }
    info = next
    await deps.sleep(ADJUST_SETTLE_MS)
  }
  return { kind: 'failed', reason: 'no-convergence', peakDbfs: peak, info }
}

export { MIC_PEAK_TARGET_DBFS }
