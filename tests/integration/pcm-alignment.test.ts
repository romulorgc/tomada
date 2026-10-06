import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { measurePcmAlignment } from '../../src/main/pcm-alignment'
import { extractAudio } from '../../src/main/normalize'
import { correlatePcm } from '../../src/shared/pcm-alignment'
import { createMemoryLogger } from '../../src/main/logger'
import { FIX, requireFfmpeg, useTmpDir } from '../helpers/env'
const ff = requireFfmpeg(), tmp = useTmpDir()
async function floats(path: string): Promise<Float32Array> {
  const b = await readFile(path), out = new Float32Array(b.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4)
  return out
}
it('preserva a referência anterior com PCM 80 ms adiantado ou atrasado, sem alterar a fonte', async () => {
  for (const shift of [-80, 80]) {
    const dir = tmp(); await mkdir(join(dir, 'raw')); await mkdir(join(dir, 'media'))
    const camera = join(dir, 'raw/camera.webm'), pcm = join(dir, 'raw/mic.wav')
    await ff.run(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30:d=6', '-i', FIX.voz, '-t', '6', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', camera])
    const shiftFilter = shift > 0 ? `adelay=${shift}:all=1` : `atrim=start=${-shift / 1000},asetpts=PTS-STARTPTS`
    await ff.run(['-i', FIX.voz, '-t', '6', '-af', shiftFilter, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_f32le', pcm])
    const before = await readFile(pcm)
    const alignment = await measurePcmAlignment(ff, dir, 'raw/camera.webm', createMemoryLogger())
    expect(alignment).not.toBeNull()
    const old = join(dir, 'media/old.wav'), voice = join(dir, 'media/voice.wav')
    await extractAudio(ff, { input: camera, output: old, channels: 1 })
    await extractAudio(ff, { input: pcm, output: voice, channels: 1, losslessFloat: true, alignmentSamples: Math.round(alignment!.offsetMs * 48), durationMs: 6000 })
    const oldPcm = join(dir, 'media/old.f32'), newPcm = join(dir, 'media/new.f32')
    for (const [input, output] of [[old, oldPcm], [voice, newPcm]]) await ff.run(['-i', input!, '-ar', '8000', '-ac', '1', '-f', 'f32le', output!])
    const residual = correlatePcm(await floats(oldPcm), await floats(newPcm))!
    expect(residual.correlation).toBeGreaterThan(0.95)
    expect(Math.abs(residual.offsetMs)).toBeLessThanOrEqual(0.5)
    expect(await readFile(pcm)).toEqual(before)
  }
})
