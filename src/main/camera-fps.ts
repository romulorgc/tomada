import type { Ffmpeg } from './ffmpeg'

export type VideoFpsMeasure = { fps: number; frames: number; spanMs: number; width: number; height: number }

/**
 * Quadros por segundo REALMENTE gravados no arquivo bruto da câmera: conta os pacotes de vídeo (só demux, sem
 * decodificar) e divide pelo tempo. O normalizador repete quadros para fazer fps constante e esconderia uma
 * câmera que entregou 15 qps; é aqui que a queda fica visível. `null` = não deu para medir (arquivo vazio/ilegível).
 */
export async function measureVideoFps(ff: Ffmpeg, file: string, timeoutMs = 10 * 60_000): Promise<VideoFpsMeasure | null> {
  const probe = await ff.probe(file)
  const video = probe.video
  if (!video) return null
  let frames = 0
  let spanMs = 0
  await ff.run(['-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'], {
    timeoutMs,
    onProgress: (p) => {
      if (p.frame !== null) frames = Math.max(frames, p.frame)
      spanMs = Math.max(spanMs, p.timeMs)
    }
  })
  if (frames < 2 || spanMs <= 0) return null
  return { fps: (frames * 1000) / spanMs, frames, spanMs, width: video.width ?? 0, height: video.height ?? 0 }
}
