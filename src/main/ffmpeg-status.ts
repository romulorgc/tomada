/**
 * Estado e autoteste do ffmpeg para a tela de Ajustes. Sem Electron.
 */
import type { FfmpegStatus, FfmpegTestResult } from '@shared/ipc'
import { createFfmpeg, locateFfmpeg, type Ffmpeg, type FfmpegPaths, type LocateOptions } from './ffmpeg'
import { buildEncoderProbeArgs } from './ffmpeg-args'
import type { Logger } from './logger'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export async function getFfmpegStatus(opts: LocateOptions, logger: Logger): Promise<FfmpegStatus> {
  const paths = locateFfmpeg(opts)
  if (!paths) {
    const error = opts.custom
      ? `Não encontrei o ffmpeg e o ffprobe em "${opts.custom}". Escolha a pasta (ou o ffmpeg.exe) de novo, ou limpe o ajuste para usar o do sistema.`
      : 'Não encontrei o ffmpeg e o ffprobe no PATH. Instale o ffmpeg ou escolha a pasta dele nos Ajustes.'
    return { found: false, source: null, ffmpegPath: null, ffprobePath: null, version: null, ffprobeVersion: null, error }
  }
  const ff = createFfmpeg(paths)
  try {
    const [version, ffprobeVersion] = await Promise.all([ff.version(), ff.ffprobeVersion()])
    return {
      found: true,
      source: paths.source,
      ffmpegPath: paths.ffmpeg,
      ffprobePath: paths.ffprobe,
      version: version ?? 'desconhecida',
      ffprobeVersion: ffprobeVersion ?? 'desconhecida',
      error: null
    }
  } catch (err) {
    logger.error('O ffmpeg foi encontrado mas não executa.', err)
    return {
      found: true,
      source: paths.source,
      ffmpegPath: paths.ffmpeg,
      ffprobePath: paths.ffprobe,
      version: null,
      ffprobeVersion: null,
      error: `O ffmpeg foi encontrado em ${paths.ffmpeg}, mas não executa: ${messageOf(err)}`
    }
  }
}

/** Roda de verdade: versões, uma codificação H.264 por software e outra por NVENC (opcional). */
export async function runFfmpegSelfTest(paths: FfmpegPaths | null, logger: Logger): Promise<FfmpegTestResult> {
  const result: FfmpegTestResult = {
    ok: false,
    ffmpegVersion: null,
    ffprobeVersion: null,
    encoders: { libx264: false, h264Nvenc: false },
    steps: [],
    error: null
  }
  if (!paths) {
    result.error = 'ffmpeg não encontrado.'
    result.steps.push({ label: 'Localizar o ffmpeg', ok: false, detail: result.error })
    return result
  }
  const ff: Ffmpeg = createFfmpeg(paths)
  const step = async (label: string, fn: () => Promise<string>): Promise<boolean> => {
    try {
      const detail = await fn()
      result.steps.push({ label, ok: true, detail })
      return true
    } catch (err) {
      const detail = messageOf(err)
      result.steps.push({ label, ok: false, detail })
      logger.warn(`Autoteste do ffmpeg: "${label}" falhou`, err)
      return false
    }
  }

  const okVersion = await step('Executar o ffmpeg', async () => {
    result.ffmpegVersion = await ff.version()
    return `versão ${result.ffmpegVersion ?? 'desconhecida'}`
  })
  const okProbe = await step('Executar o ffprobe', async () => {
    result.ffprobeVersion = await ff.ffprobeVersion()
    return `versão ${result.ffprobeVersion ?? 'desconhecida'}`
  })
  result.encoders.libx264 = await step('Codificar H.264 (software, libx264)', async () => {
    await ff.run(buildEncoderProbeArgs('libx264'), { timeoutMs: 30_000 })
    return 'ok'
  })
  // NVENC é um bônus: falhar aqui só significa que a normalização usará o libx264.
  result.encoders.h264Nvenc = await step('Codificar H.264 (placa NVIDIA, NVENC)', async () => {
    await ff.run(buildEncoderProbeArgs('h264_nvenc'), { timeoutMs: 30_000 })
    return 'ok'
  })

  result.ok = okVersion && okProbe && result.encoders.libx264
  if (!result.ok) {
    result.error = result.steps.find((s) => !s.ok && !s.label.includes('NVENC'))?.detail ?? 'O ffmpeg não passou no teste.'
  }
  return result
}
