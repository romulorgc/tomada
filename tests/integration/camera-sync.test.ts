import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeVideo, extractAudio } from '../../src/main/normalize'
import { createDerivedMedia, PREVIEW_AUDIO_PATH } from '../../src/main/derived-media'
import { createProject } from '@shared/project'
import { makeCameraSyncRaw } from '../helpers/camera-sync-media'
import { audioPcm, lumaSeries, onsets } from '../helpers/media'
import { requireFfmpeg, useTmpDir } from '../helpers/env'

const ff = requireFfmpeg()
const tmp = useTmpDir('tomada-sync-')
const logger = { dir: '', info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

describe('cadeia câmera × voz: eixo comum até áudio tratado da prévia e mux', () => {
  for (const webm of [false, true]) {
  for (const scenario of [{ offset: 0, unequal: false }, { offset: 80, unequal: false }, { offset: -80, unequal: false }, { offset: 0, unequal: true }]) {
    it(`${webm ? 'WebM VP9/Opus' : 'Matroska sem perdas'}: preserva ${scenario.offset} ms${scenario.unequal ? ' com start_time desigual (áudio +80 ms)' : ''} com erro ≤5 ms`, async () => {
      const dir = tmp()
      await mkdir(join(dir, 'media'))
      let raw = makeCameraSyncRaw(dir, scenario.offset, scenario.unequal)
      if (webm) {
        const compressed = join(dir, 'camera-bruta.webm')
        await ff.run(['-copyts', '-i', raw, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-avoid_negative_ts', 'disabled', compressed])
        raw = compressed
      }
      const input = await ff.probe(raw)
      if (scenario.unequal && !webm) expect(input.audio!.startTimeMs! - input.video!.startTimeMs!).toBe(80)
      const camera = join(dir, 'media/camera.mp4')
      const voice = join(dir, 'media/voice.wav')
      const norm = await normalizeVideo(ff, { input: raw, output: camera, fps: 250, encoder: 'libx264', keepAudio: true })
      const audio = await extractAudio(ff, { input: raw, output: voice, channels: 1 })
      const project = createProject({ title: 'Sintético de sincronia', sources: { camera: { path: 'media/camera.mp4', w: 160, h: 90, fps: 250, durationMs: norm.probe.durationMs }, voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs: audio.durationMs } } })
      const videoMs = lumaSeries(camera, { x: 60, y: 30, w: 40, h: 30 }).findIndex((v) => v > 128) * 4
      const expected = scenario.offset - (scenario.unequal ? 80 : 0)
      const compare = (file: string): void => {
        const onset = onsets(audioPcm(file), 48_000, { relative: 0.2 })[0]!
        expect(Math.abs(videoMs - onset - expected), `${file}: imagem ${videoMs}, som ${onset}, esperado ${expected}`).toBeLessThanOrEqual(5)
      }
      compare(voice)
      compare(camera)
      const derived = createDerivedMedia({ logger, read: async () => ({ project, dir }), ffmpeg: () => ff })
      expect(await derived.previewAudio('sintetico')).not.toBeNull()
      compare(join(dir, PREVIEW_AUDIO_PATH))
      const final = join(dir, 'mux.mp4')
      await ff.run(['-i', camera, '-i', join(dir, PREVIEW_AUDIO_PATH), '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', final])
      compare(final)
      console.log(`[sincronia] entrada ${scenario.offset} ms, start_time desigual=${scenario.unequal}, vídeo normalizado ${videoMs} ms, esperado câmera×voz ${expected} ms; WAV/prévia/mux dentro de 5 ms`)
      derived.shutdown()
    })
  }
  }
})
