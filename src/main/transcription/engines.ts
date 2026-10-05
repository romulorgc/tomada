/**
 * Escolhe o motor de transcrição deste processo. Prioridade: `TOMADA_TRANSCRIBER` (só teste ou diagnóstico:
 * `mock`, `mock-unprepared`, `faster-whisper`, `whisper-cpp`) > ajuste `transcription.engine` > faster-whisper
 * (o que a medição da M3 mostrou melhor; ver README).
 */
import type { EngineId } from '@shared/transcription'
import type { Logger } from '../logger'
import { createFasterWhisper } from './faster-whisper'
import { createMockTranscriber } from './mock'
import { ensureToolsDir, ToolsDirError, toolPaths } from './tools-dir'
import type { Transcriber } from './types'
import { createWhisperCpp } from './whisper-cpp'

export type EngineChoice = { engine: Transcriber; id: EngineId }

/** Motor que só conta o que está errado (não achou uma pasta sem acentos para as ferramentas). */
function unavailable(id: EngineId, message: string): Transcriber {
  return {
    id,
    async check() {
      return { state: 'missing', detail: message, device: null }
    },
    async prepare() {
      throw new Error(message)
    },
    async transcribe() {
      throw new Error(message)
    }
  }
}

export function chooseEngine(args: { env: NodeJS.ProcessEnv; settingsEngine: 'faster-whisper' | 'whisper-cpp'; scriptPath: string; logger: Logger }): EngineChoice {
  const { env, logger } = args
  const forced = env.TOMADA_TRANSCRIBER?.trim()
  if (forced === 'mock' || forced === 'mock-unprepared') {
    return {
      id: 'mock',
      engine: createMockTranscriber({
        ready: forced === 'mock',
        ...(env.TOMADA_TEST_TRANSCRIBE_DELAY_MS ? { delayMs: Number(env.TOMADA_TEST_TRANSCRIBE_DELAY_MS) } : {}),
        ...(env.TOMADA_TEST_PREPARE_FAIL ? { failStep: env.TOMADA_TEST_PREPARE_FAIL } : {}),
        ...(env.TOMADA_TEST_PREPARE_STEP_MS ? { stepMs: Number(env.TOMADA_TEST_PREPARE_STEP_MS) } : {})
      })
    }
  }
  const id: 'faster-whisper' | 'whisper-cpp' = forced === 'whisper-cpp' || forced === 'faster-whisper' ? forced : args.settingsEngine
  let base: string
  try {
    base = ensureToolsDir(env)
  } catch (err) {
    const message = err instanceof ToolsDirError ? err.message : `Não consegui preparar a pasta das ferramentas: ${err instanceof Error ? err.message : String(err)}`
    logger.error(message, err)
    return { id, engine: unavailable(id, message) }
  }
  const tools = toolPaths(base)
  logger.info(`Transcrição: motor ${id}, ferramentas em ${base}`)
  return { id, engine: id === 'whisper-cpp' ? createWhisperCpp({ tools, logger, env }) : createFasterWhisper({ tools, scriptPath: args.scriptPath, logger }) }
}
