import { readFile } from 'node:fs/promises'
import { correlatePcm } from '@shared/pcm-alignment'
import type { Ffmpeg } from './ffmpeg'
import type { Logger } from './logger'
import { RAW_MIC_PCM } from './manifest'
import { resolveProjectFile } from './project-files'
import { createProjectTmpDir, removeTmpDir } from './safe-output'

export async function measurePcmAlignment(ff: Ffmpeg, dir: string, cameraFile: string, logger: Logger, beforePauseMs = 8000): Promise<ReturnType<typeof correlatePcm>> {
  const camera = await resolveProjectFile(dir, cameraFile), pcm = await resolveProjectFile(dir, RAW_MIC_PCM)
  const source = await ff.probe(camera)
  const audioStart = source.streams.find(s => s.type === 'audio')?.startTimeMs ?? 0
  const lead = Math.max(0, audioStart - Math.min(source.video?.startTimeMs ?? audioStart, audioStart))
  const tmp = await createProjectTmpDir(dir, 'media', '.tmp-pcm-sync-')
  try {
    const reference = await tmp.file('referencia.f32'), observed = await tmp.file('pcm.f32')
    for (const [input, output, leadingMs] of [[camera, reference, lead], [pcm, observed, 0]] as const) {
      await ff.run(['-i', input, '-t', String(Math.max(0.1, Math.min(8000, beforePauseMs) / 1000)), '-map', '0:a:0', '-vn', '-af', `asetpts=PTS-STARTPTS+${leadingMs / 1000}/TB,aresample=async=1:first_pts=0,highpass=f=80`, '-ac', '1', '-ar', '8000', '-f', 'f32le', output], { timeoutMs: 60000 })
    }
    const floats = async (file: string): Promise<Float32Array> => {
      const b = await readFile(file), samples = new Float32Array(Math.floor(b.length / 4))
      for (let i = 0; i < samples.length; i++) samples[i] = b.readFloatLE(i * 4)
      return samples
    }
    return correlatePcm(await floats(reference), await floats(observed))
  } finally { await removeTmpDir(tmp.dir, logger) }
}
