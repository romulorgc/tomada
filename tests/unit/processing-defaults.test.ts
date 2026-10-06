import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProcessContext, runProcessing, STEP_ORDER } from '../../src/main/processing'
import type { RecordingManifest } from '../../src/main/manifest'
import type { Ffmpeg } from '../../src/main/ffmpeg'
import { createMemoryLogger } from '../../src/main/logger'
import { DEFAULT_AUTOPILOT } from '../../src/shared/autopilot'
import { parseProject } from '../../src/shared/project'
import type { Settings } from '../../src/shared/ipc'
import { useTmpDir } from '../helpers/env'

const tmp = useTmpDir('tomada-m5a-processing-')
it.each([false, true])('o nascimento respeita a etapa de zoom do piloto (%s), mesmo com presets escolhidos', async (enabled) => {
  const dir = tmp()
  await mkdir(join(dir, 'events'))
  await writeFile(join(dir, 'events/cursor.jsonl'), '{"t":0,"x":0.5,"y":0.5}\n{"t":30000,"x":0.5,"y":0.5}\n')
  await writeFile(join(dir, 'events/clicks.jsonl'), '{"t":5000,"x":0.5,"y":0.5,"button":"left"}\n')
  await writeFile(join(dir, 'events/keys.jsonl'), '')
  const manifest: RecordingManifest = {
    version: 1, sessionId: 'defaults', folder: 'defaults', title: 'Projeto sintético', createdAt: '2026-10-05', mode: 'screen', fps: 30,
    screen: { file: 'raw/screen.webm', kind: 'screen', sourceId: 'screen:0:0', sourceName: 'Teste', scale: 1, mime: null, hasSystemAudio: false, cursorHidden: true, frame: { w: 1920, h: 1080 }, frameEnd: null, screenRect: { x: 0, y: 0, w: 1920, h: 1080 } },
    camera: null, clock: { t0: 1000, screenStartAt: 1000, cameraStartAt: null, offsetMs: 0, rttMs: 1 }, pauses: [], endedAt: 31_000, recordedMs: 30_000, stopReason: 'user', notes: [], processedAt: null,
    saved: { sync: { screenOffsetMs: 0, cameraOffsetMs: 0 }, capture: { kind: 'screen', boundsPx: { x: 0, y: 0, w: 1920, h: 1080 }, scale: 1, cursorHidden: true }, stats: { cursor: 2, clicks: 1, keys: 0 } }
  }
  const ctx = createProcessContext({ dir, manifest, rawEvents: null })
  STEP_ORDER.filter((id) => id !== 'project').forEach((id) => ctx.done.add(id))
  ctx.sources = { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: 30_000 } }
  const editingDefaults: Settings = { ownerZoomPreset: 'moderate', ownerVerticalZoomPreset: 'moderate', autopilot: { ...structuredClone(DEFAULT_AUTOPILOT), steps: { zooms: enabled } } }
  const ff = { run: async () => { throw new Error('passos de mídia já concluídos') } } as unknown as Ffmpeg
  const snapshot = await runProcessing(ctx, { ff, logger: createMemoryLogger(), onProgress: () => {}, editingDefaults })
  expect(snapshot.status, snapshot.error?.message).toBe('done')
  const project = parseProject(await readFile(join(dir, 'project.json'), 'utf8'))
  if (enabled) {
    expect(project.zooms.length).toBeGreaterThan(0)
    expect(project.vertical?.zooms.length).toBeGreaterThan(0)
    expect(project.zooms.every((z) => z.origin === 'auto')).toBe(true)
  } else {
    expect(project.zoomPreset).toBe('off')
    expect(project.vertical?.zoomPreset).toBe('off')
    expect(project.zooms).toEqual([])
    expect(project.vertical?.zooms).toEqual([])
  }
})
