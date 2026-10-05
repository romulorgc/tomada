/**
 * Implementação de todos os canais do contrato de IPC. Sem Electron: o que depende
 * dele (diálogos de escolher pasta/arquivo) entra por parâmetro.
 */
import type { AppInfo, ChunkKind, IpcHandlers } from '@shared/ipc'
import { recordRequestSchema } from '@shared/recording'
import { locateFfmpeg } from './ffmpeg'
import { getFfmpegStatus, runFfmpegSelfTest } from './ffmpeg-status'
import type { Logger } from './logger'
import type { ProjectStore } from './projects'
import type { RecordingService } from './recording-service'
import type { AppState } from './state'

export type HandlerDeps = {
  info: AppInfo
  state: AppState
  store: ProjectStore
  logger: Logger
  pickFolder(defaultPath?: string): Promise<string | null>
  pickFfmpeg(): Promise<string | null>
  recording: RecordingService
  /** A janela de contagem avisa que terminou (true) ou foi cancelada (false). */
  finishCountdown(completed: boolean): void
  /** Relógio do processo principal (`performance.timeOrigin + performance.now()`). */
  clock(): number
}

const CHUNK_KINDS: readonly ChunkKind[] = ['screen', 'camera', 'mic']

export function createHandlers(deps: HandlerDeps): IpcHandlers {
  const { state, store, logger, recording } = deps
  return {
    'app:info': async () => deps.info,

    'projects:list': () => store.list(),
    'projects:get': (id) => store.detail(id),
    'projects:rename': (id, title) => store.rename(id, title),
    'projects:trash': (id) => store.trash(id),
    'projects:reveal': (id) => store.reveal(id),

    'settings:get': async () => state.view(),
    'settings:update': (patch) => state.update(patch),
    'settings:pick-projects-dir': () => deps.pickFolder(state.projectsRoot()),
    'settings:pick-ffmpeg': () => deps.pickFfmpeg(),

    'ffmpeg:status': () => getFfmpegStatus(state.ffmpegLocateOptions(), logger),
    'ffmpeg:test': () => runFfmpegSelfTest(locateFfmpeg(state.ffmpegLocateOptions()), logger),

    'record:sources': () => recording.sources(),
    'record:prefs-get': async () => state.recordPrefs(),
    'record:prefs-set': (patch) => state.updateRecordPrefs(patch),
    'record:clock': async () => deps.clock(),
    'record:prepare': (request) => recording.prepare(recordRequestSchema.parse(request)),
    'record:countdown': () => recording.countdown(),
    'record:go': () => recording.go(),
    'record:started': (info) => recording.started(info),
    'record:chunk': (kind, data) => {
      if (!CHUNK_KINDS.includes(kind)) throw new Error(`Tipo de pedaço desconhecido: ${String(kind)}`)
      return recording.chunk(kind, data)
    },
    'record:pause': (at) => recording.pause(at),
    'record:resume': (at) => recording.resume(at),
    'record:stop': (info) => recording.stop(info),
    'record:abort': (reason) => recording.abort(reason),
    'record:status': async () => recording.status(),
    'process:retry': (sessionId) => recording.retry(sessionId),

    'bar:state': async () => recording.barState(),
    'bar:action': async (action) => {
      recording.command(action, 'bar')
    },
    'countdown:begin': async () => recording.countdownConfig(),
    'countdown:finish': async (completed) => {
      deps.finishCountdown(Boolean(completed))
    },
    'bubble:config': async () => recording.bubbleConfig()
  }
}
