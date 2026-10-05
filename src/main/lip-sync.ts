/** Detector local: mídia validada, JSON por stdin, sem shell e sem downloads durante a análise. */
import { access } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { selectCameraAvOffset } from '@shared/camera-sync'
import type { Project } from '@shared/types'
import { assertFfmpegPath } from './ffmpeg-path'
import { resolveProjectFile } from './project-files'
import { ProcessError, runProcess } from './process-runner'
import type { Logger } from './logger'

class LipSyncRuntimeError extends Error {
  constructor(readonly component: string) { super('O detector local de sincronia ainda não está preparado neste computador.') }
}

/** Nunca registra stdout/stderr nem a mensagem arbitrária do filho: podem conter caminho ou mídia pessoal. */
export function lipSyncFailureDiagnostic(error: unknown) {
  if (error instanceof LipSyncRuntimeError) return { category: 'unavailable-runtime', component: error.component }
  if (error instanceof ProcessError) {
    const component = ['onnxruntime', 'numpy', 'scipy', 'cv2', 'CUDA', 'cudnn', 'cublas', 'ffmpeg'].find((label) => error.stderr.includes(label)) ?? 'processo-python'
    return { category: 'process', reason: error.reason, exitCode: error.exitCode, component }
  }
  if (error instanceof z.ZodError) return { category: 'invalid-result', fields: error.issues.map((issue) => issue.path.join('.')), codes: error.issues.map((issue) => issue.code) }
  if (error instanceof SyntaxError) return { category: 'invalid-json' }
  return { category: 'unavailable-runtime', component: 'python-script-modelo-ou-ffmpeg' }
}

function failureReason(error: unknown): string {
  const detail = lipSyncFailureDiagnostic(error)
  if (detail.category === 'unavailable-runtime') return 'O detector local de sincronia não está preparado. Prepare a sincronia neste computador ou use a calibração/controle manual.'
  if ('reason' in detail && detail.reason === 'timeout') return 'A medição de sincronia passou do tempo limite. Tente novamente quando a máquina estiver livre ou use o ajuste manual.'
  if ('reason' in detail && detail.reason === 'cancelled') return 'A medição de sincronia foi cancelada. Aplique a calibração ou tente novamente.'
  if (detail.category === 'invalid-result' || detail.category === 'invalid-json') return 'O detector devolveu uma resposta inválida. Prepare a sincronia novamente ou use o controle manual.'
  return `O detector local falhou${'component' in detail ? ` (${detail.component})` : ''}. Prepare a sincronia novamente ou use o controle manual.`
}

const segmentSchema = z.object({ startMs: z.number().finite().min(0), durationMs: z.number().finite().min(0), offsetMs: z.number().finite(), confidence: z.number().finite() })
const resultSchema = z.object({ detector: z.literal('syncnet'), segments: z.array(segmentSchema).max(4), offsetMs: z.number().finite().nullable(), confidence: z.number().finite(), reason: z.string().max(1000).optional() })
export type LipSyncResult = { offsetMs: number | null; confidence: number; accepted: number; reason?: string }
export interface LipSyncDetector {
  detect(dir: string, project: Pick<Project, 'sources'>): Promise<LipSyncResult>
  clap(video: string): Promise<{ offsetMs: number; confidence: number }>
}

export function parseLipSyncResult(text: string): LipSyncResult {
  const raw = resultSchema.parse(JSON.parse(text))
  const selected = selectCameraAvOffset(raw.segments)
  return selected ?? { offsetMs: null, confidence: raw.confidence, accepted: 0, reason: raw.reason ?? 'Não encontrei dois trechos de fala com sincronia confiável.' }
}

export function createLipSyncDetector(args: { toolsDir: string; scriptPath: string; ffmpeg: () => string | null; logger?: Logger }): LipSyncDetector {
  const python = join(args.toolsDir, 'python', 'Scripts', 'python.exe')
  const model = join(args.toolsDir, 'lip-sync', 'syncnet_v2.model')
  const call = async (request: Record<string, unknown>, needsModel: boolean): Promise<string> => {
    const ffmpeg = args.ffmpeg()
    if (!ffmpeg) throw new LipSyncRuntimeError('ffmpeg')
    for (const file of [python, args.scriptPath, ...(needsModel ? [model, model.replace(/\.model$/, '.lip.onnx'), model.replace(/\.model$/, '.aud.onnx'), join(args.toolsDir, 'lip-sync', 'yunet.onnx')] : [])]) {
      if (!isAbsolute(file)) throw new Error('Caminho interno inválido para o detector de sincronia.')
      await access(file).catch(() => { throw new LipSyncRuntimeError(file === python ? 'python' : file === args.scriptPath ? 'script' : 'modelo-local') })
    }
    const result = await runProcess(python, ['-I', args.scriptPath], {
      stdin: JSON.stringify({ ...request, ffmpeg: assertFfmpegPath(ffmpeg, 'ffmpeg'), ...(needsModel ? { model } : {}) }),
      timeoutMs: 180_000,
      maxOutput: 256 * 1024,
      env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TORCH_HOME: join(args.toolsDir, 'lip-sync'), PYTHONUTF8: '1' }
    })
    return result.stdout
  }
  return {
    async detect(dir, project) {
      if (!project.sources.camera || !project.sources.voice) return { offsetMs: null, confidence: 0, accepted: 0, reason: 'Esta gravação não tem câmera e voz para medir.' }
      const video = await resolveProjectFile(dir, project.sources.camera.path, 'sources.camera.path')
      const audio = await resolveProjectFile(dir, project.sources.voice.path, 'sources.voice.path')
      try { return parseLipSyncResult(await call({ video, audio }, true)) }
      catch (error) {
        args.logger?.warn('Detector de sincronia indisponível: falha técnica local.', lipSyncFailureDiagnostic(error))
        return { offsetMs: null, confidence: 0, accepted: 0, reason: failureReason(error) }
      }
    },
    async clap(video) {
      let raw: { offsetMs: number | null; confidence: number; reason?: string }
      try {
        raw = z.object({ offsetMs: z.number().finite().min(-300).max(300).nullable(), confidence: z.number().finite(), reason: z.string().optional() }).parse(JSON.parse(await call({ mode: 'clap', video: assertFfmpegPath(video, 'vídeo da calibração') }, false)))
      } catch (error) {
        args.logger?.warn('Calibração de sincronia indisponível: falha técnica local.', lipSyncFailureDiagnostic(error))
        throw new Error(failureReason(error))
      }
      if (raw.offsetMs === null || raw.confidence < 3) throw new Error(raw.reason ?? 'Não consegui identificar uma palma confiável. Grave novamente com as mãos visíveis e uma única palma.')
      return { offsetMs: raw.offsetMs, confidence: raw.confidence }
    }
  }
}
