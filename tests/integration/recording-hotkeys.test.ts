import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createRecordingService, type RecordingDeps, type RecordingWindows } from '../../src/main/recording-service'
import { createMemoryLogger } from '../../src/main/logger'
import type { Ffmpeg } from '../../src/main/ffmpeg'
import type { StartedInfo } from '../../src/shared/ipc'
import { useTmpDir } from '../helpers/env'

const tmp = useTmpDir('tomada-m5a-hotkeys-')
it('a barra mantém os atalhos registrados ao começar, pausar e retomar', async () => {
  const root = tmp()
  const windows: RecordingWindows = {
    setMainMinimized: vi.fn(), countdown: async () => true,
    showBar: vi.fn(), updateBar: vi.fn(), barLevel: vi.fn(), hideBar: vi.fn(),
    showBubble: vi.fn(), hideBubble: vi.fn(), unregisterHotkeys: vi.fn(),
    registerHotkeys: vi.fn(() => ({ stop: 'Ctrl+Alt+R', pause: 'Ctrl+Alt+P', ok: true }))
  }
  const deps: RecordingDeps = {
    logger: createMemoryLogger(), projectsRoot: () => root,
    // Não há processamento: o teste descarta sem pedaços, depois dos gestos da barra.
    ffmpeg: () => ({}) as Ffmpeg, windows,
    sources: { list: async () => [], resolve: async () => { throw new Error('sem tela') }, arm: vi.fn(), disarm: vi.fn() },
    createTracker: () => { throw new Error('só áudio não abre rastreador') },
    emit: vi.fn(), trash: async (path) => { expect(dirname(path)).toBe(root); await rm(path, { recursive: true, force: true }) },
    clock: () => 1500, now: () => new Date('2026-10-05T12:00:00Z'), env: {}
  }
  const service = createRecordingService(deps)
  await service.prepare({ mode: 'camera', sourceId: null, cameraId: 'cam', micId: 'mic', fps: 30, systemAudio: false, hideCursor: true, showBubble: false, retakeShortcut: 'Ctrl+Alt+Q' })
  await service.countdown(); await service.go()
  const info: StartedInfo = { t0: 1000, screenStartAt: null, cameraStartAt: 1000, frame: null, clockOffsetMs: 0, clockRttMs: 1, screenMime: null, cameraMime: 'audio/webm', screenHasAudio: false, cursorHidden: false, cameraHasVideo: false, cameraHasAudio: true, cameraSize: null, startEventLagMs: { screen: 0, camera: 0 } }
  await service.started(info)
  const shortcuts = { shortcutStop: 'Ctrl+Alt+R', shortcutPause: 'Ctrl+Alt+P', shortcutRetake: 'Ctrl+Alt+Q' }
  try {
    expect(service.barState()).toMatchObject({ status: 'recording', ...shortcuts })
    expect(windows.showBar).toHaveBeenCalledWith(expect.objectContaining(shortcuts), null)
    await service.pause(1200)
    expect(service.barState()).toMatchObject({ status: 'paused', ...shortcuts })
    expect(windows.updateBar).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'paused', ...shortcuts }))
    await service.resume(1400)
    expect(service.barState()).toMatchObject({ status: 'recording', ...shortcuts })
    expect(windows.updateBar).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'recording', ...shortcuts }))
  } finally { await service.abort('teste') }
})
