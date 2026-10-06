/**
 * Dublês para testar o serviço de gravação sem Electron: fontes, janelas auxiliares e
 * rastreador falsos, e um serviço pronto para os testes de handlers.
 */
import { rm } from 'node:fs/promises'
import { createExportService, type ExportService } from '../../src/main/export-service'
import { createOutputDirs } from '../../src/main/path-guard'
import type { IpcEvents } from '../../src/shared/ipc'
import type { RawEvents } from '../../src/shared/recording'
import type { Ffmpeg } from '../../src/main/ffmpeg'
import { createMemoryLogger } from '../../src/main/logger'
import {
  createRecordingService,
  type RecordingDeps,
  type RecordingService,
  type RecordingWindows,
  type ResolvedSource,
  type SourceProvider
} from '../../src/main/recording-service'
import type { BrowserKind } from '../../src/shared/browser'
import type { Tracker, TrackerResult } from '../../src/main/tracker'

export type Emitted = { [K in keyof IpcEvents]: { channel: K; payload: IpcEvents[K] } }[keyof IpcEvents]

export const SCREEN_SOURCE: ResolvedSource = {
  id: 'screen:0:0',
  kind: 'screen',
  name: 'Tela 1',
  hwnd: null,
  rectPx: { x: 0, y: 0, w: 1920, h: 1080 },
  nativeSize: { w: 1920, h: 1080 },
  scale: 1.25,
  displayBoundsDip: { x: 0, y: 0, w: 1536, h: 864 }
}

export const WINDOW_SOURCE: ResolvedSource = {
  id: 'window:4242:0',
  kind: 'window',
  name: 'Janela de teste',
  hwnd: 4242,
  rectPx: { x: 400, y: 200, w: 984, h: 742 },
  nativeSize: { w: 982, h: 702 },
  scale: 1,
  displayBoundsDip: { x: 0, y: 0, w: 1920, h: 1080 }
}

export function fakeTracker(result: Partial<TrackerResult> & { raw?: RawEvents } = {}): Tracker & { calls: string[] } {
  const calls: string[] = []
  let running = false
  return {
    calls,
    get running() {
      return running
    },
    async start() {
      calls.push('start')
      running = true
    },
    pause() {
      calls.push('pause')
    },
    resume() {
      calls.push('resume')
    },
    async stop() {
      calls.push('stop')
      running = false
      return {
        raw: result.raw ?? { cursor: [], clicks: [], keys: [], windowRects: [] },
        stats: result.stats ?? null,
        windowGone: result.windowGone ?? false,
        error: result.error ?? null,
        browser: result.browser ?? null
      }
    }
  }
}

export type FakeWorld = {
  service: RecordingService
  emitted: Emitted[]
  calls: string[]
  trackers: ReturnType<typeof fakeTracker>[]
  trashed: string[]
  setSource(source: ResolvedSource): void
  /** O que o próximo rastreador entrega ao parar. */
  trackerResult: { raw?: RawEvents; windowGone?: boolean; error?: string | null; browser?: BrowserKind | null }
  countdownResult: { value: boolean }
  logger: ReturnType<typeof createMemoryLogger>
}

export function createFakeWorld(args: {
  root: string
  ffmpeg: Ffmpeg | null
  env?: NodeJS.ProcessEnv
  source?: ResolvedSource
  failTracker?: boolean
  now?: () => Date
  /** Quanto a "Lixeira" demora (ms): prova a ORDEM entre apagar a gravação e devolver a janela. */
  trashDelayMs?: number
}): FakeWorld {
  const emitted: Emitted[] = []
  const calls: string[] = []
  const trackers: ReturnType<typeof fakeTracker>[] = []
  const trashed: string[] = []
  const logger = createMemoryLogger()
  let source = args.source ?? SCREEN_SOURCE
  const trackerResult: FakeWorld['trackerResult'] = {}
  const countdownResult = { value: true }
  let clockBase = 1_000_000

  const sources: SourceProvider = {
    list: async () => [],
    resolve: async (id) => {
      if (id !== source.id) throw new Error('A tela ou janela escolhida não existe mais. Escolha de novo.')
      return source
    },
    arm: (id, audio) => void calls.push(`arm ${id} audio=${audio}`),
    disarm: () => void calls.push('disarm')
  }

  const windows: RecordingWindows = {
    setMainMinimized: (m) => void calls.push(`main ${m ? 'minimizada' : 'restaurada'}`),
    countdown: async () => {
      calls.push('countdown')
      return countdownResult.value
    },
    showBar: () => void calls.push('bar:show'),
    updateBar: (s) => void calls.push(`bar:${s.status}`),
    barLevel: () => undefined,
    hideBar: () => void calls.push('bar:hide'),
    showBubble: () => void calls.push('bubble:show'),
    hideBubble: () => void calls.push('bubble:hide'),
    registerHotkeys: () => {
      calls.push('hotkeys:on')
      return { stop: 'Ctrl+Shift+R', pause: 'Ctrl+Shift+P', ok: true }
    },
    unregisterHotkeys: () => void calls.push('hotkeys:off')
  }

  const deps: RecordingDeps = {
    logger,
    projectsRoot: () => args.root,
    ffmpeg: () => args.ffmpeg,
    sources,
    windows,
    createTracker: () => {
      const t = args.failTracker
        ? ({
            calls: [],
            running: false,
            start: async () => {
              throw new Error('koffi indisponível (simulado)')
            },
            pause: () => undefined,
            resume: () => undefined,
            stop: async () => ({ raw: { cursor: [], clicks: [], keys: [], windowRects: [] }, stats: null, windowGone: false, error: null })
          } satisfies ReturnType<typeof fakeTracker>)
        : fakeTracker({ ...trackerResult })
      trackers.push(t)
      return t
    },
    emit: (channel, payload) => void emitted.push({ channel, payload } as Emitted),
    trash: async (path) => {
      trashed.push(path)
      if (args.trashDelayMs) await new Promise((r) => setTimeout(r, args.trashDelayMs))
      await rm(path, { recursive: true, force: true })
      calls.push('trash:feito')
    },
    clock: () => (clockBase += 5),
    now: args.now ?? (() => new Date(2026, 9, 4, 15, 0, 0)),
    env: args.env ?? {},
    minFreeBytes: 1
  }

  return {
    service: createRecordingService(deps),
    emitted,
    calls,
    trackers,
    trashed,
    setSource: (s) => {
      source = s
    },
    trackerResult,
    countdownResult,
    logger
  }
}

/** Um serviço de exportação ocioso, só para quem precisa montar `createHandlers`. */
export function createIdleExportService(): ExportService {
  return createExportService({
    logger: createMemoryLogger(),
    outputDirs: createOutputDirs(),
    read: async () => {
      throw new Error('sem projetos neste teste')
    },
    ffmpeg: () => null,
    openExporterWindow: () => ({ destroy: () => undefined }),
    emit: () => undefined,
    now: () => performance.now()
  })
}

/** Um serviço qualquer, só para quem precisa montar `createHandlers` e não grava nada. */
export function createIdleRecordingService(): RecordingService {
  return createFakeWorld({ root: process.cwd(), ffmpeg: null }).service
}
