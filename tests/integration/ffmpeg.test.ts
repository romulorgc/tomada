import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFfmpeg, FfmpegError, locateFfmpeg, runBinary, type FfmpegProgress } from '../../src/main/ffmpeg'
import { FIX, requireFfmpeg, useTmpDir } from '../helpers/env'

const tmp = useTmpDir()

describe('locateFfmpeg', () => {
  it('acha ffmpeg e ffprobe no PATH', () => {
    const paths = locateFfmpeg()
    expect(paths).not.toBeNull()
    expect(paths?.source).toBe('path')
    expect(paths?.ffmpeg.toLowerCase()).toMatch(/ffmpeg(\.exe)?$/)
    expect(paths?.ffprobe.toLowerCase()).toMatch(/ffprobe(\.exe)?$/)
  })

  it('o ajuste do usuário (pasta) vem antes do PATH', () => {
    const real = locateFfmpeg()!
    const dir = join(real.ffmpeg, '..')
    const viaDir = locateFfmpeg({ custom: dir })
    expect(viaDir).toMatchObject({ ffmpeg: real.ffmpeg, ffprobe: real.ffprobe, source: 'settings' })
  })

  it('o ajuste do usuário também pode ser o caminho do próprio ffmpeg', () => {
    const real = locateFfmpeg()!
    const viaFile = locateFfmpeg({ custom: real.ffmpeg })
    expect(viaFile).toMatchObject({ ffmpeg: real.ffmpeg, ffprobe: real.ffprobe, source: 'settings' })
  })

  it('ajuste apontando para lugar nenhum NÃO cai no PATH em silêncio', () => {
    expect(locateFfmpeg({ custom: join(tmp(), 'nao-existe') })).toBeNull()
  })

  it('pasta sem os dois executáveis não serve', () => {
    expect(locateFfmpeg({ custom: tmp() })).toBeNull()
  })

  it('sem PATH e sem ajuste: null', () => {
    expect(locateFfmpeg({ env: { PATH: '' } })).toBeNull()
    expect(locateFfmpeg({ env: {} })).toBeNull()
  })
})

describe('ffmpeg.run', () => {
  const ff = requireFfmpeg()

  it('sucesso: gera o arquivo', async () => {
    const out = join(tmp(), 'cor.mp4')
    await ff.run(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out])
    const probe = await ff.probe(out)
    expect(probe.video).toMatchObject({ codec: 'h264', width: 320, height: 240 })
    expect(probe.durationMs).toBeGreaterThan(900)
  })

  it('código de saída ≠ 0 REJEITA, com o código e as últimas linhas do stderr', async () => {
    const missing = join(tmp(), 'nao-existe.mp4')
    const error = await ff.run(['-i', missing, '-f', 'null', '-']).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FfmpegError)
    const err = error as FfmpegError
    expect(err.exitCode).not.toBe(0)
    expect(err.exitCode).not.toBeNull()
    expect(err.stderrTail.toLowerCase()).toMatch(/no such file|does not exist|nao-existe/)
    expect(err.message).toContain(`código ${err.exitCode}`)
    expect(err.stderrTail.split('\n').length).toBeLessThanOrEqual(10)
  })

  it('o rabo do stderr nunca passa de 10 linhas, mesmo com muita saída', async () => {
    const error = await ff
      .run(['-loglevel', 'debug', '-f', 'lavfi', '-i', 'color=c=red:d=0.2', '-c:v', 'libx264', '-pix_fmt', 'bogus_fmt', '-f', 'null', '-'])
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FfmpegError)
    expect((error as FfmpegError).stderrTail.split('\n').length).toBeLessThanOrEqual(10)
  })

  it('arquivo corrompido (texto fingindo ser vídeo) também rejeita', async () => {
    const bad = join(tmp(), 'falso.mp4')
    writeFileSync(bad, 'isto não é um vídeo\n'.repeat(50))
    await expect(ff.run(['-i', bad, '-f', 'null', '-'])).rejects.toBeInstanceOf(FfmpegError)
  })

  it('executável inexistente rejeita com mensagem clara (não trava)', async () => {
    const broken = createFfmpeg({ ffmpeg: join(tmp(), 'nao-tem-ffmpeg.exe'), ffprobe: 'x', source: 'settings' })
    const error = (await broken.run(['-version']).catch((e: unknown) => e)) as FfmpegError
    expect(error).toBeInstanceOf(FfmpegError)
    expect(error.exitCode).toBeNull()
    expect(error.message).toMatch(/não consegui abrir o ffmpeg/i)
  })

  it('timeout interrompe e rejeita', async () => {
    const started = Date.now()
    const error = (await ff
      .run(['-re', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=60', '-f', 'null', '-'], { timeoutMs: 700 })
      .catch((e: unknown) => e)) as FfmpegError
    expect(error).toBeInstanceOf(FfmpegError)
    expect(error.message).toMatch(/tempo limite/)
    expect(error.exitCode).toBeNull()
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('AbortSignal cancela', async () => {
    const controller = new AbortController()
    const promise = ff.run(['-re', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=60', '-f', 'null', '-'], { signal: controller.signal })
    setTimeout(() => controller.abort(), 400)
    await expect(promise).rejects.toThrow(/cancelada/)
  })

  it('já cancelado antes de começar: rejeita sem abrir processo', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(ff.run(['-version'], { signal: controller.signal })).rejects.toThrow(/cancelada/)
  })

  it('onProgress recebe o tempo da saída crescendo até o fim', async () => {
    const out = join(tmp(), 'progresso.mp4')
    const seen: FfmpegProgress[] = []
    await ff.run(
      ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out],
      { onProgress: (p) => seen.push(p) }
    )
    expect(seen.length).toBeGreaterThan(0)
    const times = seen.map((p) => p.timeMs)
    expect([...times].sort((a, b) => a - b)).toEqual(times) // nunca anda para trás
    expect(times[times.length - 1]).toBeGreaterThanOrEqual(2800)
    expect(times[times.length - 1]).toBeLessThanOrEqual(3200)
    expect(seen[seen.length - 1]?.frame).toBeGreaterThanOrEqual(85)
  })
})

describe('ffmpeg.probe', () => {
  const ff = requireFfmpeg()

  it('tela VFR em WebM', async () => {
    const p = await ff.probe(FIX.telaVfr)
    expect(p.video).toMatchObject({ codec: 'vp9', width: 1920, height: 1080 })
    expect(p.audio).toBeUndefined()
    expect(p.durationMs).toBeGreaterThan(22_000)
  })

  it('clipe flash + bipe: H.264 e AAC, 10 s', async () => {
    const p = await ff.probe(FIX.flashBipe)
    expect(p.video).toMatchObject({ codec: 'h264', width: 640, height: 360 })
    expect(p.video?.fps).toBeCloseTo(30, 1)
    expect(p.audio).toMatchObject({ codec: 'aac', sampleRate: 48_000 })
    expect(Math.abs(p.durationMs - 10_000)).toBeLessThan(150)
  })

  it('voz.wav: 48 kHz mono, duração igual à do gabarito', async () => {
    const p = await ff.probe(FIX.voz)
    expect(p.audio).toMatchObject({ codec: 'pcm_s16le', sampleRate: 48_000, channels: 1 })
    expect(p.video).toBeUndefined()
    const gabarito = JSON.parse((await import('node:fs')).readFileSync(FIX.vozJson, 'utf8')) as { durationMs: number }
    expect(Math.abs(p.durationMs - gabarito.durationMs)).toBeLessThan(5)
  })

  it('caminho com acento e espaço funciona', async () => {
    const dir = join(tmp(), 'Pasta com acentuação ôç')
    mkdirSync(dir)
    const file = join(dir, 'vídeo ã.mp4')
    await ff.run(['-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file])
    expect((await ff.probe(file)).video?.width).toBe(160)
  })

  it('arquivo inexistente ou que não é mídia rejeita com FfmpegError', async () => {
    await expect(ff.probe(join(tmp(), 'nada.mp4'))).rejects.toBeInstanceOf(FfmpegError)
    const txt = join(tmp(), 'texto.mp4')
    writeFileSync(txt, 'nada de vídeo aqui')
    await expect(ff.probe(txt)).rejects.toBeInstanceOf(FfmpegError)
  })
})

describe('versões', () => {
  const ff = requireFfmpeg()
  it('lê a versão do ffmpeg e do ffprobe', async () => {
    expect(await ff.version()).toMatch(/^\S+$/)
    expect(await ff.ffprobeVersion()).toMatch(/^\S+$/)
  })
  it('runBinary de comando inexistente rejeita', async () => {
    await expect(runBinary(join(tmp(), 'nao-existe'), ['-version'])).rejects.toBeInstanceOf(FfmpegError)
  })
})
