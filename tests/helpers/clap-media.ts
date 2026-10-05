import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Ffmpeg } from '../../src/main/ffmpeg'

/** Gabarito físico: duas regiões convergem, tocam e recuam; nenhum dado pessoal. */
export async function clapMedia(ff: Ffmpeg, folder: string, name: string, options: { offset?: number; videoStart?: number; audioStart?: number; webm?: boolean; fps?: number; lowFace?: boolean; kind?: 'hands' | 'head' | 'flash' | 'silent' | 'double' }) {
  const kind = options.kind ?? 'hands'
  const contact = 1 + (options.offset ?? 0) / 1000
  const fps = options.fps ?? 100
  const width = 160, height = 90, count = 5 * fps
  const raw = Buffer.alloc(width * height * 3 * count)
  const rect = (frame: number, x: number, y: number, w: number, h: number, color = [220, 170, 140]) => {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const at = ((frame * height + row) * width + col) * 3
      raw[at] = color[0]!; raw[at + 1] = color[1]!; raw[at + 2] = color[2]!
    }
  }
  for (let frame = 0; frame < count; frame++) {
    const time = frame / fps
    rect(frame, kind === 'head' && Math.abs(time - contact) < .1 ? 60 : 65, options.lowFace ? 36 : 4, 30, options.lowFace ? 29 : 25)
    if (kind === 'flash') { if (Math.abs(time - contact) < .02) rect(frame, 0, 0, width, height, [255, 255, 255]); continue }
    if (kind === 'head') continue
    // Em 30 qps o contato físico dura um quadro, em vez de exigir coincidência subquadro.
    const distance = Math.max(0, Math.abs(time - contact) - (fps === 30 ? .5 / fps : 0))
    const spread = Math.round(35 * Math.min(1, distance / .15))
    rect(frame, 62 - spread, options.lowFace ? 69 : 47, 18, options.lowFace ? 16 : 25)
    rect(frame, 80 + spread, options.lowFace ? 69 : 47, 18, options.lowFace ? 16 : 25)
  }
  const source = join(folder, `${name}.rgb`)
  await writeFile(source, raw)
  const output = join(folder, `${name}.${options.webm ? 'webm' : 'mkv'}`)
  const pulse = kind === 'silent' ? '0' : kind === 'double' ? 'if(between(t,1,1.003)+between(t,2,2.003),0.8*sin(2*PI*1800*t),0)' : 'if(between(t,1,1.003),0.8*sin(2*PI*1800*t),0)'
  await ff.run(['-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '160x90', '-framerate', String(fps), '-i', source,
    '-f', 'lavfi', '-i', `aevalsrc='${pulse}':s=48000:d=5`,
    '-vf', `setpts=PTS+${(options.videoStart ?? 0) / 1000}/TB`, '-af', `asetpts=PTS+${(options.audioStart ?? 0) / 1000}/TB`,
    '-copyts', '-avoid_negative_ts', 'disabled',
    ...(options.webm ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '500k', '-c:a', 'libopus'] : ['-c:v', 'ffv1', '-c:a', 'pcm_s16le']), output])
  return output
}
