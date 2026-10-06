import { link, mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pcmWavHeader } from '../../src/shared/pcm'
import { readManifest } from '../../src/main/manifest'
import { createFakeWorld } from '../helpers/recording'
import { requireFfmpeg, useTmpDir } from '../helpers/env'
import { parseProject } from '../../src/shared/project'

const ff = requireFfmpeg(), tmp = useTmpDir()
const t0 = 1_000_000
const start = { t0, screenStartAt: null, cameraStartAt: t0, micPcm: true, frame: null, clockOffsetMs: 0, clockRttMs: 1, screenMime: null, cameraMime: null, screenHasAudio: false, cursorHidden: false, cameraHasVideo: false, cameraHasAudio: true, cameraSize: null, startEventLagMs: { screen: null, camera: null } }
const request = { mode: 'camera' as const, sourceId: null, fps: 30 as const, cameraId: 'cam-1', micId: 'mic-1', systemAudio: false, showBubble: false, hideCursor: true }
const samples = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i * 2 * Math.PI * 1234 / 48000) * 0.1234567)

describe('PCM em disco e recuperação', () => {
  it('um link físico plantado não é truncado nem alterado pelo primeiro pedaço', async () => {
    const root = tmp(), world = createFakeWorld({ root, ffmpeg: ff })
    const prepared = await world.service.prepare(request)
    await world.service.countdown(); await world.service.go(); await world.service.started(start)
    const outside = join(tmp(), 'fora.wav')
    await writeFile(outside, 'arquivo intacto')
    await link(outside, join(root, prepared.folder, 'raw/mic.wav'))
    await expect(world.service.chunk('mic', pcmWavHeader())).rejects.toThrow(/disco/)
    expect(await readFile(outside, 'utf8')).toBe('arquivo intacto')
    await world.service.shutdown()
  })
  it('faz checkpoint WAV real, recupera pausa e preserva todas as amostras float32 na voz', async () => {
    const root = tmp(), world = createFakeWorld({ root, ffmpeg: ff, clock: () => t0 + 1500 })
    const prepared = await world.service.prepare(request)
    await world.service.countdown(); await world.service.go(); await world.service.started(start)
    await world.service.chunk('mic', pcmWavHeader())
    await world.service.chunk('mic', new Uint8Array(samples.buffer))
    await world.service.pause(t0 + 1000)
    await world.service.shutdown()
    const dir = join(root, prepared.folder), pcm = join(dir, 'raw/mic.wav')
    const bytes = await readFile(pcm)
    expect(bytes.readUInt32LE(40)).toBe(samples.byteLength)
    expect(bytes.subarray(44)).toEqual(Buffer.from(samples.buffer))
    const old = new Date(Date.now() - 20000); await utimes(pcm, old, old)
    const next = createFakeWorld({ root, ffmpeg: ff })
    expect(await next.service.listInterrupted()).toHaveLength(1)
    await next.service.recoverInterrupted(prepared.folder)
    expect(next.service.status().processing?.status).toBe('done')
    const manifest = await readManifest(dir)
    expect(manifest.recordedMs).toBe(1000)
    expect(manifest.openPauseAt).toBeNull()
    const project = parseProject(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(project.sync.cameraOffsetMs).toBe(0)
    expect(project.sources.voice!.durationMs).toBe(1000)
    const output = join(tmp(), 'voice.f32')
    await ff.run(['-i', join(dir, 'media/voice.wav'), '-f', 'f32le', output])
    expect(await readFile(output)).toEqual(Buffer.from(samples.buffer))
    await next.service.shutdown()
  })
  it('conserta cabeçalho antigo após queda no meio do pedaço; nunca incorpora meia amostra', async () => {
    const root = tmp(), world = createFakeWorld({ root, ffmpeg: ff, clock: () => t0 + 1000 })
    const prepared = await world.service.prepare(request)
    await world.service.countdown(); await world.service.go(); await world.service.started(start)
    await world.service.chunk('mic', pcmWavHeader()); await world.service.shutdown()
    const dir = join(root, prepared.folder), path = join(dir, 'raw/mic.wav')
    await writeFile(path, Buffer.concat([Buffer.from(pcmWavHeader()), Buffer.from(samples.buffer), Buffer.from([1, 2])]))
    await mkdir(join(dir, 'events'), { recursive: true })
    const old = new Date(Date.now() - 20000); await utimes(path, old, old)
    const next = createFakeWorld({ root, ffmpeg: ff })
    await next.service.recoverInterrupted(prepared.folder)
    expect(next.service.status().processing?.status).toBe('done')
    const out = await readFile(path)
    expect(out.length).toBe(44 + samples.byteLength)
    expect(out.readUInt32LE(40)).toBe(samples.byteLength)
    await next.service.shutdown()
  })
})
