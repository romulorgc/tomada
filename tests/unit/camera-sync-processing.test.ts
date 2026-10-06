import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProcessContext, runProcessing, STEP_ORDER } from '../../src/main/processing'
import { createMemoryLogger } from '../../src/main/logger'
import { createAppState } from '../../src/main/state'
import type { RecordingManifest } from '../../src/main/manifest'
import type { Ffmpeg } from '../../src/main/ffmpeg'
import type { LipSyncDetector, LipSyncResult } from '../../src/main/lip-sync'
import { parseProject } from '@shared/project'
import { pcmWavHeader } from '@shared/pcm'

const calibration = { cameraId: 'cam', micId: 'mic', offsetMs: 110, confidence: 5, calibratedAt: '2026-10-05' }

describe('correção por gravação e persistência do par de dispositivos', () => {
  it('a gravação usa a medição confiável; sem medição usa o par calibrado ou zero com aviso', async () => {
    const cases: { result: LipSyncResult; micId: string; expected: number; method: string }[] = [
      { result: { offsetMs: 80, confidence: 6, accepted: 3 }, micId: 'mic', expected: 80, method: 'syncnet' },
      { result: { offsetMs: null, confidence: 0, accepted: 0, reason: 'Sem rosto falando.' }, micId: 'mic', expected: 110, method: 'calibration' },
      { result: { offsetMs: null, confidence: 0, accepted: 0, reason: 'Detector indisponível.' }, micId: 'outro', expected: 0, method: 'none' }
    ]
    for (const scenario of cases) {
      const dir = await mkdtemp(join(tmpdir(), 'tomada-sync-doc-'))
      await mkdir(join(dir, 'raw'))
      try {
        await mkdir(join(dir, 'media'))
        const samples = new Float32Array(48_000)
        await writeFile(join(dir, 'media/voice.wav'), Buffer.concat([Buffer.from(pcmWavHeader(48_000, samples.byteLength)), Buffer.from(samples.buffer)]))
        const manifest: RecordingManifest = { version: 1, sessionId: 'sync', folder: 'sync', title: 'Teste', createdAt: '2026-10-05', mode: 'camera', cameraId: 'cam', micId: scenario.micId, fps: 30, screen: null, camera: { file: 'raw/camera.webm', mime: null, hasVideo: true, hasAudio: true, size: null }, clock: null, pauses: [], endedAt: 3000, stopReason: 'user', recordedMs: 3000, notes: [], saved: { sync: { screenOffsetMs: 0, cameraOffsetMs: 20 }, capture: { kind: 'screen', boundsPx: { x: 0, y: 0, w: 160, h: 90 }, scale: 1 }, stats: { cursor: 0, clicks: 0, keys: 0 } }, processedAt: null }
        const ctx = createProcessContext({ dir, manifest, rawEvents: null })
        STEP_ORDER.filter((id) => id !== 'project').forEach((id) => ctx.done.add(id))
        ctx.sources = { camera: { path: 'media/camera.mp4', w: 160, h: 90, fps: 30, durationMs: 3000 }, voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs: 3000 } }
        const detector: LipSyncDetector = { detect: async () => scenario.result, clap: async () => { throw new Error('não usado') } }
        // Todos os passos de mídia já foram concluídos: este teste exerce somente a escrita do documento.
        const ff = { run: async () => { throw new Error('não deve rodar mídia') } } as unknown as Ffmpeg
        const snapshot = await runProcessing(ctx, { ff, logger: createMemoryLogger(), onProgress: () => {}, lipSync: detector, calibrations: () => [calibration] })
        expect(snapshot.status, snapshot.error?.message).toBe('done')
        const project = parseProject(await readFile(join(dir, 'project.json'), 'utf8'))
        expect(project.sync.cameraAvOffsetMs).toBe(scenario.expected)
        expect(project.sync.cameraAvDetection?.method).toBe(scenario.method)
        expect(project.sync.cameraOffsetMs).toBe(20)
        if (scenario.result.offsetMs === null) expect(snapshot.notes.join(' ')).toContain(scenario.result.reason)
      } finally { await rm(dir, { recursive: true, force: true }) }
    }
  })
  it('salva pares distintos, substitui somente o par exato e sobrevive à reabertura', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tomada-sync-settings-'))
    try {
      const file = join(dir, 'settings.json')
      const state = await createAppState({ file, env: {}, logger: createMemoryLogger() })
      await state.saveCameraCalibration(calibration)
      await state.saveCameraCalibration({ ...calibration, micId: 'outro', offsetMs: -50 })
      await state.saveCameraCalibration({ ...calibration, offsetMs: 90 })
      const reopened = await createAppState({ file, env: {}, logger: createMemoryLogger() })
      expect(reopened.settings().cameraCalibrations).toEqual([{ ...calibration, micId: 'outro', offsetMs: -50 }, { ...calibration, offsetMs: 90 }])
      await expect(state.saveCameraCalibration({ ...calibration, offsetMs: 1000 })).rejects.toThrow()
      await state.updateRecordPrefs({ noiseSuppression: true })
      expect(state.settings().cameraCalibrations).toBeUndefined()
      await state.saveCameraCalibration(calibration)
      await state.updateRecordPrefs({ echoCancellation: true })
      expect(state.settings().cameraCalibrations).toBeUndefined()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
