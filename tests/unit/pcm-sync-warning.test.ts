import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pcmWavHeader } from '@shared/pcm'
import { parseProject } from '@shared/project'
import { audioQualityWarningMessages } from '@shared/audio-quality-messages'
import { createProcessContext, runProcessing, STEP_ORDER } from '../../src/main/processing'
import { createMemoryLogger } from '../../src/main/logger'
import type { RecordingManifest } from '../../src/main/manifest'
import type { Ffmpeg, ProbeResult } from '../../src/main/ffmpeg'

/** Só a fronteira do ffmpeg é substituída; medida, caminhos e escrita do projeto são reais. */
async function scenario(mode: 'silence' | 'aligned' | 'probe-failure', job: (s: {
  dir: string; manifest: RecordingManifest; ctx: ReturnType<typeof createProcessContext>; ff: Ffmpeg; voiceFilters: string[]
}) => Promise<void>, notes: string[] = []): Promise<void> {
  const root = resolve('test-results/tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'audio-sync-'))
  try {
    await mkdir(join(dir, 'raw')); await mkdir(join(dir, 'media'))
    const samples = new Float32Array(144_000)
    const wav = Buffer.concat([Buffer.from(pcmWavHeader(48_000, samples.byteLength)), Buffer.from(samples.buffer)])
    await writeFile(join(dir, 'raw/mic.wav'), wav)
    await writeFile(join(dir, 'raw/camera.webm'), 'referência sintética do teste')
    const manifest: RecordingManifest = {
      version: 1, sessionId: 'pcm-sync', folder: 'pcm-sync', title: 'Gravação sintética', createdAt: '2026-10-06',
      mode: 'camera', fps: 30, screen: null,
      camera: { file: 'raw/camera.webm', mime: null, hasVideo: true, hasAudio: true, size: null },
      micPcm: true, pcmAlignment: { offsetMs: 180, correlation: 0.98 },
      clock: null, pauses: [], endedAt: 3000, stopReason: 'user', recordedMs: 3000, notes: [...notes], processedAt: null,
      saved: { sync: { screenOffsetMs: 0, cameraOffsetMs: 12 }, capture: { kind: 'screen', boundsPx: { x: 0, y: 0, w: 160, h: 90 }, scale: 1 }, stats: { cursor: 0, clicks: 0, keys: 0 } }
    }
    const ctx = createProcessContext({ dir, manifest, rawEvents: null })
    STEP_ORDER.filter(id => id !== 'voice' && id !== 'project').forEach(id => ctx.done.add(id))
    ctx.sources.camera = { path: 'media/camera.mp4', w: 160, h: 90, fps: 30, durationMs: 3000 }
    const video = { index: 0, type: 'video' as const, codec: 'vp9', startTimeMs: 0 }
    const audio = { index: 1, type: 'audio' as const, codec: 'opus', startTimeMs: 0, sampleRate: 48_000, channels: 1 }
    const probe: ProbeResult = { durationMs: 3000, formatName: 'webm', sizeBytes: 1, video, audio, streams: [video, audio] }
    let seed = 17
    const observed = Float32Array.from({ length: 24_000 }, () => {
      seed = Math.imul(seed, 1664525) + 1013904223 | 0
      return mode === 'aligned' ? seed / 0x80000000 * 0.1 : 0
    })
    const reference = Float32Array.from(observed, (_, i) => (observed[i - 160] ?? 0) * 0.8)
    const voiceFilters: string[] = []
    const ff = {
      probe: async (file: string) => {
        if (file.endsWith('camera.webm')) {
          if (mode === 'probe-failure') throw new Error('Referência indisponível no teste.')
          return probe
        }
        return { ...probe, video: undefined, audio: { ...audio, index: 0, codec: 'pcm_f32le' }, streams: [{ ...audio, index: 0, codec: 'pcm_f32le' }] }
      },
      run: async (args: string[]) => {
        const output = args.at(-1)!
        if (args[args.indexOf('-f') + 1] === 'f32le') {
          const decoded = args[args.indexOf('-i') + 1]!.endsWith('camera.webm') ? reference : observed
          await writeFile(output, Buffer.from(decoded.buffer))
        } else if (args[args.indexOf('-f') + 1] === 'wav') {
          voiceFilters.push(args[args.indexOf('-af') + 1]!)
          await writeFile(output, wav)
        } else throw new Error('Operação de mídia inesperada no teste.')
        return { stderr: '', code: 0 }
      }
    } as unknown as Ffmpeg
    await job({ dir, manifest, ctx, ff, voiceFilters })
  } finally { await rm(dir, { recursive: true, force: true }) }
}

describe('fallback de sincronia PCM', () => {
  it('descarta deslocamento anterior sem sinal e salva aviso na reabertura do projeto', async () => scenario('silence', async ({ dir, manifest, ctx, ff, voiceFilters }) => {
    const snapshot = await runProcessing(ctx, { ff, logger: createMemoryLogger(), onProgress: () => {} })
    expect(snapshot.status, snapshot.error?.message).toBe('done')
    expect(manifest.pcmAlignment).toBeUndefined()
    expect(voiceFilters[0]).not.toMatch(/adelay|start_sample/)
    const savedManifest = JSON.parse(await readFile(join(dir, 'raw/recording.json'), 'utf8'))
    expect(savedManifest.pcmAlignment).toBeUndefined()
    const reopened = parseProject(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(reopened.pcmSyncWarning).toBe(true)
    expect(reopened.sync.cameraOffsetMs).toBe(12)
    expect(audioQualityWarningMessages(reopened.audioQuality, reopened.pcmSyncWarning).join(' ')).toMatch(/confira.*imagem/i)
  }))

  it('limpa deslocamento anterior antes de uma medição que lança erro', async () => scenario('probe-failure', async ({ manifest, ctx, ff }) => {
    const snapshot = await runProcessing(ctx, { ff, logger: createMemoryLogger(), onProgress: () => {} })
    expect(snapshot.status).toBe('failed')
    expect(snapshot.error?.step).toBe('voice')
    expect(manifest.pcmAlignment).toBeUndefined()
  }))

  it('usa uma nova medida confiável sem deixar aviso de fallback no projeto', async () => scenario('aligned', async ({ dir, manifest, ctx, ff, voiceFilters }) => {
    const snapshot = await runProcessing(ctx, { ff, logger: createMemoryLogger(), onProgress: () => {} })
    expect(snapshot.status, snapshot.error?.message).toBe('done')
    expect(manifest.pcmAlignment?.offsetMs).toBe(20)
    expect(voiceFilters[0]).toContain('adelay=delays=960S')
    const reopened = parseProject(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(reopened.pcmSyncWarning).toBeUndefined()
    expect(audioQualityWarningMessages(reopened.audioQuality, reopened.pcmSyncWarning)).toEqual([])
  }))

  it('preserva aviso de perda de áudio mesmo quando a nova medida alinha a voz', async () => scenario('aligned', async ({ dir, manifest, ctx, ff, voiceFilters }) => {
    const snapshot = await runProcessing(ctx, { ff, logger: createMemoryLogger(), onProgress: () => {} })
    expect(snapshot.status, snapshot.error?.message).toBe('done')
    expect(manifest.pcmAlignment?.offsetMs).toBe(20)
    expect(voiceFilters[0]).toContain('adelay=delays=960S')
    const savedManifest = JSON.parse(await readFile(join(dir, 'raw/recording.json'), 'utf8'))
    expect(savedManifest.pcmAlignment.offsetMs).toBe(20)
    expect(savedManifest.notes.join(' ')).toContain('O áudio do microfone perdeu 100 ms')
    const reopened = parseProject(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(reopened.pcmSyncWarning).toBe(true)
    expect(audioQualityWarningMessages(reopened.audioQuality, reopened.pcmSyncWarning).join(' ')).toMatch(/confira.*imagem/i)
  }, ['O áudio do microfone perdeu 100 ms. Confira a voz antes de publicar.']))
})
