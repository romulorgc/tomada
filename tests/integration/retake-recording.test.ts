import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as files from '../../src/main/fs-utils'
import { createFakeWorld } from '../helpers/recording'
import { requireFfmpeg, useTmpDir } from '../helpers/env'
import type { StartedInfo } from '../../src/shared/ipc'

const tmp = useTmpDir()
const info: StartedInfo = { t0: 1_000_000, screenStartAt: null, cameraStartAt: 1_000_000, startEventLagMs: { screen: null, camera: 10 }, frame: null, clockOffsetMs: 0, clockRttMs: 1, screenMime: null, cameraMime: 'video/webm', screenHasAudio: false, cursorHidden: false, cameraHasVideo: true, cameraHasAudio: true, cameraSize: { w: 640, h: 360 } }

describe('marca errei no serviço de gravação', () => {
  it.each(['pause', 'abort', 'stop'] as const)('marca aceita antes de %s não ressuscita barra gravando após escrita atrasada', async (action) => {
    const deps = { root: tmp(), ffmpeg: requireFfmpeg() as ReturnType<typeof requireFfmpeg> | null }
    const w = createFakeWorld(deps)
    await w.service.prepare({ mode: 'camera', sourceId: null, cameraId: 'cam', micId: 'mic', fps: 30, systemAudio: false, showBubble: false, hideCursor: true })
    await w.service.countdown(); await w.service.go(); await w.service.started(info)
    let release!: () => void, arrived!: () => void
    const waiting = new Promise<void>((r) => { release = r })
    const reached = new Promise<void>((r) => { arrived = r })
    const realWrite = files.writeFileAtomic
    const spy = vi.spyOn(files, 'writeFileAtomic').mockImplementation(async (path, data) => {
      if (String(path).endsWith('retakes.jsonl')) { arrived(); await waiting }
      await realWrite(path, data)
    })
    try {
      const marker = w.service.markRetake()
      await reached
      if (action === 'pause') {
        await w.service.pause(1_000_020)
        release(); await marker
        expect(w.service.barState()?.status).toBe('paused')
        await w.service.abort('fim do teste')
      } else if (action === 'abort') {
        const aborted = w.service.abort('descartar enquanto marca é salva')
        release(); await marker; await aborted
        expect(w.service.barState()).toBeNull()
      } else {
        deps.ffmpeg = null
        const stopped = w.service.stop({ endedAt: 1_000_020, reason: 'user', frame: null, notes: [] })
        release(); await marker; await stopped
        await vi.waitFor(() => expect(w.service.status().processing?.status).toBe('failed'))
        expect(w.service.barState()).toBeNull()
      }
    } finally { release(); spy.mockRestore(); await w.service.abort('limpeza do teste') }
  })
  it('teleprompter pausa, avança, volta e ajusta a velocidade sem perder o roteiro', () => {
    const w = createFakeWorld({ root: tmp(), ffmpeg: requireFfmpeg() })
    const script = { title: 'Agenda', hook: 'Organize.', topics: ['Cadastro', 'Agenda', 'Relatório'], closing: 'Experimente.' }
    w.service.showTeleprompter({ script, mode: 'topics', speed: 35 })
    w.service.teleprompterAction('pause')
    w.service.teleprompterAction('next')
    w.service.teleprompterAction('faster')
    expect(w.service.teleprompterState()).toEqual({ script, mode: 'topics', speed: 45, paused: true, topicIndex: 1 })
    w.service.teleprompterAction('previous')
    w.service.teleprompterAction('slower')
    expect(w.service.teleprompterState()?.topicIndex).toBe(0)
    expect(w.service.teleprompterState()?.speed).toBe(35)
    w.service.hideTeleprompter()
    expect(w.service.teleprompterState()).toBeNull()
  })
  it('persiste imediatamente roteiro e marcas e ignora comando durante pausa', async () => {
    const root = tmp()
    const w = createFakeWorld({ root, ffmpeg: requireFfmpeg() })
    const script = { title: 'Agenda sintética', hook: 'Organize seu dia.', topics: ['Cadastro', 'Agenda', 'Relatório'], closing: 'Experimente.' }
    const prepared = await w.service.prepare({ mode: 'camera', sourceId: null, cameraId: 'cam', micId: 'mic', fps: 30, systemAudio: false, showBubble: false, hideCursor: true, script, retakeShortcut: 'Ctrl+Alt+X' })
    await w.service.countdown()
    await w.service.go()
    await w.service.started(info)
    const first = await w.service.markRetake()
    expect(first?.t).toBeGreaterThan(0)
    const manifest = JSON.parse(await readFile(join(root, prepared.folder, 'raw/recording.json'), 'utf8')) as { script: unknown; retakeMarks: unknown[]; title: string }
    expect(manifest.script).toEqual(script)
    expect(manifest.title).toBe('Agenda sintética')
    expect(manifest.retakeMarks).toEqual([first])
    const lines = await readFile(join(root, prepared.folder, 'events/retakes.jsonl'), 'utf8')
    expect(JSON.parse(lines.trim())).toEqual(first)
    await w.service.pause(1_000_015)
    expect(await w.service.markRetake()).toBeNull()
    expect(w.service.barState()?.retakeCount).toBe(1)
    await w.service.abort('fim do teste')
  })
})
