/**
 * Escolhe o motor da análise da câmera deste processo. `TOMADA_CAMERA` (só teste ou diagnóstico): `mock` (rosto sintético, pronto),
 * `mock-unprepared` (começa "sem preparar" e simula a preparação), `off` (não preparado, e nada o prepara). Sem a variável: o motor
 * de verdade, no venv do Python do app.
 */
import type { Logger } from '../logger'
import { ensureToolsDir, ToolsDirError, toolPaths } from '../transcription/tools-dir'
import { createMockCamera } from './mock-engine'
import { createPythonCamera, CAMERA_STEPS } from './python-engine'
import type { CameraEngine } from './types'

/** Motor que só conta o que está errado (a análise está desligada, ou não achou uma pasta sem acentos para as ferramentas). */
function unavailable(message: string): CameraEngine {
  const state = { state: 'missing', detail: message } as const
  return {
    id: 'python',
    prepareSteps: CAMERA_STEPS,
    async check() {
      return { face: state, matte: state, device: null }
    },
    async prepare() {
      throw new Error(message)
    },
    async detectFaces() {
      throw new Error(message)
    },
    async makeMatte() {
      throw new Error(message)
    }
  }
}

export function chooseCameraEngine(args: { env: NodeJS.ProcessEnv; scriptPath: string; logger: Logger; ffmpeg?: () => string | null }): CameraEngine {
  const { env, logger } = args
  const forced = env.TOMADA_CAMERA?.trim()
  if (forced === 'off') return unavailable('A análise da câmera está desligada (TOMADA_CAMERA=off).')
  if (forced === 'mock' || forced === 'mock-unprepared') {
    const num = (v: string | undefined): number | undefined => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined)
    return createMockCamera({
      ready: forced === 'mock',
      ...(num(env.TOMADA_TEST_CAMERA_DELAY_MS) !== undefined ? { delayMs: num(env.TOMADA_TEST_CAMERA_DELAY_MS)! } : {}),
      ...(num(env.TOMADA_TEST_MATTE_DELAY_MS) !== undefined ? { matteDelayMs: num(env.TOMADA_TEST_MATTE_DELAY_MS)! } : {}),
      ...(num(env.TOMADA_TEST_CAMERA_FROM) !== undefined ? { from: num(env.TOMADA_TEST_CAMERA_FROM)! } : {}),
      ...(num(env.TOMADA_TEST_CAMERA_TO) !== undefined ? { to: num(env.TOMADA_TEST_CAMERA_TO)! } : {}),
      ...(env.TOMADA_TEST_CAMERA_NOFACE === '1' ? { noFace: true } : {}),
      ...(args.ffmpeg ? { ffmpeg: args.ffmpeg } : {}),
      ...(env.TOMADA_TEST_MATTE_FAIL === '1' ? { failMatte: true } : {}),
      ...(env.TOMADA_TEST_PREPARE_FAIL ? { failStep: env.TOMADA_TEST_PREPARE_FAIL } : {}),
      ...(env.TOMADA_TEST_PREPARE_STEP_MS ? { stepMs: Number(env.TOMADA_TEST_PREPARE_STEP_MS) } : {})
    })
  }
  let base: string
  try {
    base = ensureToolsDir(env)
  } catch (err) {
    const message = err instanceof ToolsDirError ? err.message : `Não consegui preparar a pasta das ferramentas: ${err instanceof Error ? err.message : String(err)}`
    logger.error(message, err)
    return unavailable(message)
  }
  return createPythonCamera({ tools: toolPaths(base), scriptPath: args.scriptPath, logger, ...(args.ffmpeg ? { ffmpeg: args.ffmpeg } : {}) })
}
