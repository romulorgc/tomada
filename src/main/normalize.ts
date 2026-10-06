/**
 * Operações de mídia sobre arquivos: normalizar vídeo, extrair áudio, miniatura.
 * Sem Electron. A M1b usa estas funções ao parar uma gravação.
 */
import { rename, rm, stat } from 'node:fs/promises'
import { FfmpegError, type Ffmpeg, type FfmpegProgress, type ProbeResult } from './ffmpeg'
import {
  buildEncoderProbeArgs,
  buildExtractAudioArgs,
  buildNormalizeVideoArgs,
  buildThumbnailArgs,
  type VideoEncoder
} from './ffmpeg-args'

// ---------------------------------------------------------------------------
// Escolha do encoder

const encoderCache = new Map<string, Promise<boolean>>()

/** O encoder realmente codifica aqui? (compilado no ffmpeg ≠ funcionando: NVENC precisa de GPU NVIDIA). */
export function encoderWorks(ff: Ffmpeg, encoder: VideoEncoder): Promise<boolean> {
  const key = `${ff.paths.ffmpeg}::${encoder}`
  let cached = encoderCache.get(key)
  if (!cached) {
    cached = ff
      .run(buildEncoderProbeArgs(encoder), { timeoutMs: 30_000 })
      .then(() => true)
      .catch(() => false)
    encoderCache.set(key, cached)
  }
  return cached
}

/** NVENC se funcionar, senão libx264. `prefer` força um (se ele não funcionar, cai no outro). */
export async function pickVideoEncoder(ff: Ffmpeg, prefer: 'auto' | VideoEncoder = 'auto'): Promise<VideoEncoder> {
  if (prefer === 'libx264') return 'libx264'
  return (await encoderWorks(ff, 'h264_nvenc')) ? 'h264_nvenc' : 'libx264'
}

// ---------------------------------------------------------------------------
// Normalizar vídeo

export type NormalizeOptions = {
  input: string
  output: string
  /** Taxa de quadros constante de saída (fps de captura: 30 ou 60). */
  fps: number
  encoder?: 'auto' | VideoEncoder
  keepAudio?: boolean
  /** Duração esperada (ms), só para calcular a fração do progresso. */
  durationMs?: number
  /** Completa o rabo estático repetindo o último quadro até esta duração (ver `NormalizeVideoArgs.padToMs`). */
  padToMs?: number
  /**
   * Gravação de tela/janela: o tamanho do quadro pode mudar no meio (janela redimensionada). Trava no tamanho do primeiro quadro
   * (lido da entrada) para o ffmpeg não perder tempo na troca (ver `NormalizeVideoArgs.lockSize`).
   */
  lockSize?: boolean
  /** Progresso 0..1 (só chamado quando `durationMs` é informado). */
  onProgress?: (fraction: number, raw: FfmpegProgress) => void
  /** Aviso de bastidor (ex.: NVENC falhou e caiu para libx264). */
  onNote?: (message: string) => void
  timeoutMs?: number
  signal?: AbortSignal
}

export type NormalizeResult = {
  encoder: VideoEncoder
  probe: ProbeResult
}

/**
 * Entrada (qualquer container/VFR) → MP4 H.264 de fps CONSTANTE e GOP = 1 s.
 * Escreve num arquivo parcial e só renomeia ao final: nunca deixa MP4 pela metade
 * com o nome definitivo. Se o NVENC falhar no meio, refaz com libx264.
 */
export async function normalizeVideo(ff: Ffmpeg, o: NormalizeOptions): Promise<NormalizeResult> {
  const partial = `${o.output}.parcial`
  let encoder = await pickVideoEncoder(ff, o.encoder ?? 'auto')
  let lockSize: { w: number; h: number } | undefined
  if (o.lockSize) {
    const input = await ff.probe(o.input)
    const w = input.video?.width
    const h = input.video?.height
    if (w && h) lockSize = { w, h }
  }

  const attempt = async (enc: VideoEncoder): Promise<void> => {
    const args = buildNormalizeVideoArgs({
      input: o.input,
      output: partial,
      fps: o.fps,
      encoder: enc,
      ...(o.keepAudio ? { keepAudio: true } : {}),
      ...(o.padToMs ? { padToMs: o.padToMs } : {}),
      ...(lockSize ? { lockSize } : {})
    })
    await ff.run(args, {
      ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.onProgress && o.durationMs
        ? {
            onProgress: (p: FfmpegProgress) =>
              o.onProgress?.(Math.min(1, Math.max(0, p.timeMs / o.durationMs!)), p)
          }
        : {})
    })
  }

  try {
    try {
      await attempt(encoder)
    } catch (err) {
      if (encoder === 'h264_nvenc' && err instanceof FfmpegError && err.exitCode !== null) {
        o.onNote?.(`NVENC falhou (${err.stderrTail.split('\n').pop() ?? 'sem detalhe'}); refazendo com libx264.`)
        await rm(partial, { force: true })
        encoder = 'libx264'
        await attempt(encoder)
      } else {
        throw err
      }
    }
    const probe = await ff.probe(partial)
    if (!probe.video) throw new FfmpegError('A normalização terminou mas o arquivo não tem vídeo.', 0, '')
    await rm(o.output, { force: true })
    await rename(partial, o.output)
    return { encoder, probe }
  } catch (err) {
    await rm(partial, { force: true }).catch(() => undefined)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Áudio e miniatura

export type ExtractAudioOptions = {
  input: string
  output: string
  channels: 1 | 2
  sampleRate?: number
  track?: number
  timeoutMs?: number
}

/** WAV PCM 16 bits. Falha (com o motivo) se a entrada não tiver a trilha pedida. */
export async function extractAudio(ff: Ffmpeg, o: ExtractAudioOptions): Promise<ProbeResult> {
  await ff.run(
    buildExtractAudioArgs({
      input: o.input,
      output: o.output,
      channels: o.channels,
      ...(o.sampleRate ? { sampleRate: o.sampleRate } : {}),
      ...(o.track !== undefined ? { track: o.track } : {})
    }),
    o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}
  )
  return ff.probe(o.output)
}

export type ThumbnailOptions = { input: string; output: string; atMs: number; width?: number }

/** Uma miniatura JPEG. Se o ffmpeg "funcionar" mas não escrever o arquivo, é erro. */
export async function makeThumbnail(ff: Ffmpeg, o: ThumbnailOptions): Promise<void> {
  await ff.run(
    buildThumbnailArgs({ input: o.input, output: o.output, atMs: o.atMs, ...(o.width ? { width: o.width } : {}) }),
    { timeoutMs: 60_000 }
  )
  const info = await stat(o.output).catch(() => null)
  if (!info || info.size === 0) {
    throw new FfmpegError(`A miniatura não foi gerada (${o.output}). O instante pedido pode passar do fim do vídeo.`, 0, '')
  }
}
