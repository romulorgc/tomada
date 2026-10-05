import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runBinary, FfmpegError } from '../../src/main/ffmpeg'
import { encoderWorks, extractAudio, makeThumbnail, normalizeVideo, pickVideoEncoder } from '../../src/main/normalize'
import { FIX, requireFfmpeg, useTmpDir } from '../helpers/env'

const tmp = useTmpDir()
const ff = requireFfmpeg()

/** Tempos de apresentação (s) e flags de cada pacote de vídeo, via ffprobe. */
async function packets(file: string): Promise<{ pts: number; key: boolean }[]> {
  const { stdout } = await runBinary(
    ff.paths.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file],
    { timeoutMs: 60_000 }
  )
  return stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [pts, flags = ''] = line.split(',')
      return { pts: Number(pts), key: flags.includes('K') }
    })
    .sort((a, b) => a.pts - b.pts)
}

const MEAN_VOLUME = /mean_volume:\s*(-?[\d.]+|-inf) dB/

async function meanVolume(file: string): Promise<number> {
  const { stderr } = await ff.run(['-loglevel', 'info', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'])
  const m = MEAN_VOLUME.exec(stderr)
  if (!m) throw new Error(`volumedetect não respondeu:\n${stderr}`)
  return m[1] === '-inf' ? -Infinity : Number(m[1])
}

describe('a gravação de tela de entrada é mesmo VFR (o teste só vale se for)', () => {
  it('os intervalos entre quadros da tela-vfr.webm NÃO são constantes', async () => {
    const p = await packets(FIX.telaVfr)
    const deltas = new Set(p.slice(1).map((x, i) => Math.round((x.pts - p[i]!.pts) * 1000)))
    expect(deltas.size).toBeGreaterThan(3)
    expect(Math.max(...deltas)).toBeGreaterThanOrEqual(150) // buracos de ~200 ms
  })
})

describe('normalizeVideo: tela VFR → MP4 de fps constante', () => {
  const cases = [
    { fps: 30, encoder: 'libx264' as const },
    { fps: 60, encoder: 'libx264' as const }
  ]

  for (const { fps, encoder } of cases) {
    it(`${fps} qps (${encoder}): CFR, GOP de 1 s, duração preservada (±1 quadro)`, async () => {
      const input = FIX.telaVfr
      const output = join(tmp(), `tela-${fps}.mp4`)
      const inputProbe = await ff.probe(input)

      const progress: number[] = []
      const result = await normalizeVideo(ff, {
        input,
        output,
        fps,
        encoder,
        durationMs: inputProbe.durationMs,
        onProgress: (f) => progress.push(f)
      })
      expect(result.encoder).toBe(encoder)
      expect(existsSync(output)).toBe(true)
      expect(existsSync(`${output}.parcial`)).toBe(false)

      const probe = await ff.probe(output)
      expect(probe.video).toMatchObject({ codec: 'h264', width: 1920, height: 1080 })
      expect(probe.video?.fps).toBeCloseTo(fps, 3)
      const frameMs = 1000 / fps
      expect(Math.abs(probe.durationMs - inputProbe.durationMs)).toBeLessThanOrEqual(frameMs + 1)

      // Constante de verdade: todos os intervalos iguais a 1/fps.
      const p = await packets(output)
      const deltas = p.slice(1).map((x, i) => x.pts - p[i]!.pts)
      for (const d of deltas) expect(Math.abs(d - 1 / fps)).toBeLessThan(0.0015)
      // Quantidade de quadros = duração × fps (±1).
      expect(Math.abs(p.length - (inputProbe.durationMs / 1000) * fps)).toBeLessThanOrEqual(1)

      // GOP = 1 s: quadro-chave a cada `fps` quadros.
      const keyIdx = p.map((x, i) => (x.key ? i : -1)).filter((i) => i >= 0)
      expect(keyIdx[0]).toBe(0)
      for (let i = 1; i < keyIdx.length; i++) expect(keyIdx[i]! - keyIdx[i - 1]!).toBe(fps)

      expect(progress.length).toBeGreaterThan(0)
      expect(Math.max(...progress)).toBeGreaterThan(0.9)
      expect(Math.max(...progress)).toBeLessThanOrEqual(1)
    })
  }

  it('rabo estático: padToMs repete o último quadro até a duração da gravação (e corta o que passar)', async () => {
    const inputProbe = await ff.probe(FIX.telaVfr)
    const longer = Math.round(inputProbe.durationMs + 2500)
    const padded = join(tmp(), 'tela-pad.mp4')
    await normalizeVideo(ff, { input: FIX.telaVfr, output: padded, fps: 30, encoder: 'libx264', padToMs: longer })
    const probe = await ff.probe(padded)
    expect(Math.abs(probe.durationMs - longer)).toBeLessThanOrEqual(1000 / 30 + 1)
    const p = await packets(padded)
    expect(Math.abs(p.length - (longer / 1000) * 30)).toBeLessThanOrEqual(1)
    for (let i = 1; i < p.length; i++) expect(Math.abs(p[i]!.pts - p[i - 1]!.pts - 1 / 30)).toBeLessThan(0.0015) // continua CFR

    // Mais curto que a entrada: corta (a gravação terminou ali).
    const shorter = Math.round(inputProbe.durationMs - 1000)
    const cut = join(tmp(), 'tela-corte.mp4')
    await normalizeVideo(ff, { input: FIX.telaVfr, output: cut, fps: 30, encoder: 'libx264', padToMs: shorter })
    expect(Math.abs((await ff.probe(cut)).durationMs - shorter)).toBeLessThanOrEqual(1000 / 30 + 1)

    // Sem padToMs nada muda: a duração é a da entrada.
    const plain = join(tmp(), 'tela-sem-pad.mp4')
    await normalizeVideo(ff, { input: FIX.telaVfr, output: plain, fps: 30, encoder: 'libx264' })
    expect(Math.abs((await ff.probe(plain)).durationMs - inputProbe.durationMs)).toBeLessThanOrEqual(1000 / 30 + 1)
  })

  it('"auto" escolhe NVENC quando ele funciona aqui, senão libx264, e a saída é igualmente válida', async () => {
    const expected = (await encoderWorks(ff, 'h264_nvenc')) ? 'h264_nvenc' : 'libx264'
    expect(await pickVideoEncoder(ff, 'auto')).toBe(expected)

    const output = join(tmp(), 'tela-auto.mp4')
    const result = await normalizeVideo(ff, { input: FIX.telaVfr, output, fps: 30 })
    expect(result.encoder).toBe(expected)
    const probe = await ff.probe(output)
    expect(probe.video).toMatchObject({ codec: 'h264', width: 1920, height: 1080 })
    const p = await packets(output)
    const keyIdx = p.map((x, i) => (x.key ? i : -1)).filter((i) => i >= 0)
    for (let i = 1; i < keyIdx.length; i++) expect(keyIdx[i]! - keyIdx[i - 1]!).toBe(30)
  })

  it('pedir libx264 sempre dá libx264, mesmo com NVENC disponível', async () => {
    expect(await pickVideoEncoder(ff, 'libx264')).toBe('libx264')
  })

  it('câmera com áudio: mantém a trilha AAC e o vídeo a 30 qps', async () => {
    const output = join(tmp(), 'camera.mp4')
    const inputProbe = await ff.probe(FIX.camera)
    const { probe } = await normalizeVideo(ff, { input: FIX.camera, output, fps: 30, encoder: 'libx264', keepAudio: true })
    expect(probe.video).toMatchObject({ codec: 'h264', width: 640, height: 360 })
    expect(probe.video?.fps).toBeCloseTo(30, 3)
    expect(probe.audio).toMatchObject({ codec: 'aac', sampleRate: 48_000 })
    expect(Math.abs(probe.durationMs - inputProbe.durationMs)).toBeLessThanOrEqual(1000 / 30 + 1)
  })

  it('sem keepAudio o MP4 sai sem áudio', async () => {
    const output = join(tmp(), 'camera-muda.mp4')
    const { probe } = await normalizeVideo(ff, { input: FIX.camera, output, fps: 30, encoder: 'libx264' })
    expect(probe.audio).toBeUndefined()
  })

  it('dimensões ímpares viram pares (exigência do yuv420p)', async () => {
    const dir = tmp()
    const odd = join(dir, 'impar.mkv')
    await ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=641x361:r=25:d=1', '-c:v', 'ffv1', odd])
    const output = join(dir, 'par.mp4')
    const { probe } = await normalizeVideo(ff, { input: odd, output, fps: 30, encoder: 'libx264' })
    expect(probe.video?.width).toBe(640)
    expect(probe.video?.height).toBe(360)
  })

  it('entrada inexistente rejeita e não deixa NADA para trás (nem parcial, nem final)', async () => {
    const dir = tmp()
    const output = join(dir, 'saida.mp4')
    await expect(normalizeVideo(ff, { input: join(dir, 'nao-existe.webm'), output, fps: 30, encoder: 'libx264' })).rejects.toBeInstanceOf(
      FfmpegError
    )
    expect(readdirSync(dir)).toEqual([])
  })

  it('entrada corrompida rejeita e preserva o arquivo de saída antigo', async () => {
    const dir = tmp()
    const bad = join(dir, 'ruim.webm')
    writeFileSync(bad, 'lixo'.repeat(5000))
    const output = join(dir, 'saida.mp4')
    writeFileSync(output, 'versao antiga')
    await expect(normalizeVideo(ff, { input: bad, output, fps: 30, encoder: 'libx264' })).rejects.toBeInstanceOf(FfmpegError)
    expect(readFileSync(output, 'utf8')).toBe('versao antiga')
    expect(existsSync(`${output}.parcial`)).toBe(false)
  })

  it('sobrescreve a saída antiga quando dá certo', async () => {
    const dir = tmp()
    const output = join(dir, 'saida.mp4')
    writeFileSync(output, 'versao antiga')
    await normalizeVideo(ff, { input: FIX.flashBipe, output, fps: 30, encoder: 'libx264' })
    expect((await ff.probe(output)).video?.codec).toBe('h264')
  })
})

describe('extractAudio', () => {
  it('voice.wav da câmera: 48 kHz mono, duração igual à do vídeo e NÃO está mudo', async () => {
    const out = join(tmp(), 'voice.wav')
    const cam = await ff.probe(FIX.camera)
    const probe = await extractAudio(ff, { input: FIX.camera, output: out, channels: 1 })
    expect(probe.audio).toMatchObject({ codec: 'pcm_s16le', sampleRate: 48_000, channels: 1 })
    expect(Math.abs(probe.durationMs - cam.durationMs)).toBeLessThan(100)
    expect(await meanVolume(out)).toBeGreaterThan(-40)
  })

  it('system.wav estéreo', async () => {
    const out = join(tmp(), 'system.wav')
    const probe = await extractAudio(ff, { input: FIX.flashBipe, output: out, channels: 2 })
    expect(probe.audio).toMatchObject({ sampleRate: 48_000, channels: 2 })
  })

  it('entrada sem trilha de áudio rejeita com o motivo (sem arquivo mudo disfarçado)', async () => {
    const out = join(tmp(), 'sem-audio.wav')
    const error = (await extractAudio(ff, { input: FIX.telaVfr, output: out, channels: 1 }).catch((e: unknown) => e)) as FfmpegError
    expect(error).toBeInstanceOf(FfmpegError)
    expect(error.stderrTail.toLowerCase()).toMatch(/stream map|matches no streams|no audio/)
  })
})

describe('makeThumbnail', () => {
  it('gera um JPEG de verdade (assinatura FFD8) com a largura pedida', async () => {
    const out = join(tmp(), 'thumb.jpg')
    await makeThumbnail(ff, { input: join(FIX.exemplo, 'media', 'screen.mp4'), output: out, atMs: 3000, width: 480 })
    const bytes = readFileSync(out)
    expect(bytes.length).toBeGreaterThan(1000)
    expect(bytes[0]).toBe(0xff)
    expect(bytes[1]).toBe(0xd8)
    const probe = await ff.probe(out)
    expect(probe.video).toMatchObject({ width: 480, height: 270 })
  })

  it('instante além do fim do vídeo: erro visível, não arquivo vazio', async () => {
    const out = join(tmp(), 'nada.jpg')
    await expect(makeThumbnail(ff, { input: FIX.flashBipe, output: out, atMs: 60_000 })).rejects.toBeInstanceOf(FfmpegError)
  })
})
