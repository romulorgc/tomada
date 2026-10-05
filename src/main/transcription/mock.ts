/**
 * Motor de TESTE (`TOMADA_TRANSCRIBER=mock`): devolve uma transcrição determinística sem tocar na placa, no
 * Python nem na rede. Os testes e2e de gravação e de edição pelo texto usam este motor; o motor de verdade tem os
 * próprios testes de integração. `mock-unprepared` começa "sem preparar" e simula a preparação (com falha opcional
 * em um passo, uma vez, por `TOMADA_TEST_PREPARE_FAIL`) para provar a tela de preparação.
 */
import { buildTranscript } from '@shared/transcript'
import type { Transcript } from '@shared/types'
import type { PrepareTracker } from './prepare-tracker'
import type { EngineCheck, Transcriber, TranscribeOptions } from './types'

/** Frase sintética que o motor de teste "ouve", espalhada pela duração do áudio. */
export const MOCK_SENTENCE = 'Olá pessoal hoje eu vou mostrar como gravar a tela. Pronto, era isso por hoje.'

export type MockTranscriberOptions = {
  /** Começa preparado? */
  ready: boolean
  delayMs?: number
  /** Passo da preparação que falha uma vez ("packages", "model"…). */
  failStep?: string
  /** Quanto cada passo da preparação simulada demora (ms). */
  stepMs?: number
}

export function createMockTranscriber(opts: MockTranscriberOptions): Transcriber {
  let ready = opts.ready
  let failed = false
  return {
    id: 'mock',
    async check(): Promise<EngineCheck> {
      return ready ? { state: 'ready', detail: null, device: 'Placa de teste' } : { state: 'missing', detail: 'A transcrição ainda não foi preparada neste computador.', device: null }
    },
    async prepare(tracker: PrepareTracker, signal: AbortSignal): Promise<void> {
      const steps = ['python', 'packages', 'model', 'check'] as const
      for (const id of steps) {
        tracker.begin(id, 'Simulando…')
        const ticks = 4
        for (let t = 1; t <= ticks; t++) {
          if (signal.aborted) {
            tracker.cancelled()
            throw new Error('Cancelado.')
          }
          await new Promise((r) => setTimeout(r, (opts.stepMs ?? 120) / ticks))
          tracker.progress(id, t / ticks, `Passo ${id} (${t}/${ticks})`)
        }
        if (opts.failStep === id && !failed) {
          failed = true
          const message = `Falha simulada no passo "${id}" (TOMADA_TEST_PREPARE_FAIL).`
          tracker.fail(id, message)
          throw new Error(message)
        }
        tracker.done(id, 'ok')
      }
      ready = true
    },
    async transcribe(_wav: string, o: TranscribeOptions = {}): Promise<Transcript> {
      const audioMs = o.audioMs ?? 10_000
      if (opts.delayMs) {
        const steps = 5
        for (let i = 1; i <= steps; i++) {
          if (o.signal?.aborted) throw new Error('Cancelado.')
          await new Promise((r) => setTimeout(r, opts.delayMs! / steps))
          o.onProgress?.(i / steps)
        }
      }
      const tokens = MOCK_SENTENCE.split(' ')
      const slot = Math.max(80, Math.floor((audioMs - 400) / tokens.length))
      const words = tokens.map((text, i) => ({ text, start: 200 + i * slot, end: 200 + i * slot + Math.round(slot * 0.8), prob: 0.99 }))
      return buildTranscript({
        engine: 'teste',
        model: 'mock',
        language: o.language ?? 'pt',
        durationMs: audioMs,
        words,
        segments: [{ start: 200, end: 200 + tokens.length * slot, text: MOCK_SENTENCE }],
        vad: [],
        offsetMs: o.offsetMs ?? 0,
        createdAt: new Date().toISOString()
      })
    }
  }
}
