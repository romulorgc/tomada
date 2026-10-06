import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { measureVideoFps } from '../../src/main/camera-fps'
import { requireFfmpeg, useTmpDir } from '../helpers/env'

const tmp = useTmpDir()

describe('quadros por segundo REALMENTE gravados no bruto da câmera', () => {
  const ff = requireFfmpeg()
  const make = async (name: string, fps: number, seconds: number, size = '320x180'): Promise<string> => {
    const out = join(tmp(), name)
    await ff.run(['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${fps}`, '-t', String(seconds), '-c:v', 'libvpx', '-b:v', '1M', '-an', out])
    return out
  }

  it('mede 15 qps como 15 (câmera que reduziu sozinha) e 30 como 30, no tamanho do arquivo', async () => {
    const slow = await measureVideoFps(ff, await make('lento.webm', 15, 6))
    expect(slow).not.toBeNull()
    expect(slow!.fps).toBeGreaterThan(14)
    expect(slow!.fps).toBeLessThan(16)
    expect(slow).toMatchObject({ width: 320, height: 180 })
    const fast = await measureVideoFps(ff, await make('cheio.webm', 30, 6))
    expect(fast!.fps).toBeGreaterThan(29)
    expect(fast!.fps).toBeLessThan(31)
  }, 60_000)

  it('quadros repetidos pelo normalizador NÃO escondem a queda: o bruto é que se mede', async () => {
    const slow = await make('lento2.webm', 15, 4)
    const doubled = join(tmp(), 'dobrado.mp4')
    await ff.run(['-i', slow, '-vf', 'fps=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', doubled])
    expect((await measureVideoFps(ff, doubled))!.fps).toBeGreaterThan(29)
    expect((await measureVideoFps(ff, slow))!.fps).toBeLessThan(16)
  }, 60_000)

  it('arquivo sem vídeo devolve null, não um número inventado', async () => {
    const audio = join(tmp(), 'so-audio.wav')
    await ff.run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', audio])
    await expect(measureVideoFps(ff, audio)).resolves.toBeNull()
  }, 30_000)
})
