/**
 * Implementação de todos os canais do contrato de IPC. Sem Electron: o que depende
 * dele (diálogos de escolher pasta/arquivo) entra por parâmetro.
 */
import type { AppInfo, IpcHandlers } from '@shared/ipc'
import { locateFfmpeg } from './ffmpeg'
import { getFfmpegStatus, runFfmpegSelfTest } from './ffmpeg-status'
import type { Logger } from './logger'
import type { ProjectStore } from './projects'
import type { AppState } from './state'

export type HandlerDeps = {
  info: AppInfo
  state: AppState
  store: ProjectStore
  logger: Logger
  pickFolder(defaultPath?: string): Promise<string | null>
  pickFfmpeg(): Promise<string | null>
}

export function createHandlers(deps: HandlerDeps): IpcHandlers {
  const { state, store, logger } = deps
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
    'ffmpeg:test': () => runFfmpegSelfTest(locateFfmpeg(state.ffmpegLocateOptions()), logger)
  }
}
