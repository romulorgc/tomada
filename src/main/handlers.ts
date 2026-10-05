/**
 * Implementação de todos os canais do contrato de IPC. Sem Electron: o que depende
 * dele (diálogos de escolher pasta/arquivo) entra por parâmetro.
 */
import { exportRequestSchema } from '@shared/export'
import type { AppInfo, ChunkKind, IpcHandlers } from '@shared/ipc'
import { migrate } from '@shared/project'
import { recordRequestSchema } from '@shared/recording'
import { isAbsolute } from 'node:path'
import type { DerivedMedia } from './derived-media'
import type { ExportService } from './export-service'
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
  exporter: ExportService
  derived: DerivedMedia
  /** Diálogo de escolher a pasta da exportação (em teste, `TOMADA_TEST_PICK_DIR`). */
  pickExportDir(defaultPath?: string): Promise<string | null>
  /** Diálogo de escolher uma imagem de fundo (em teste, `TOMADA_TEST_PICK_IMAGE`). */
  pickImage(): Promise<string | null>
  openPath(path: string): Promise<void>
  revealPath(path: string): Promise<void>
  copyText(text: string): void
  /** A janela de contagem avisa que terminou (true) ou foi cancelada (false). */
  finishCountdown(completed: boolean): void
  /** Relógio do processo principal (`performance.timeOrigin + performance.now()`). */
  clock(): number
}

const CHUNK_KINDS: readonly ChunkKind[] = ['screen', 'camera', 'mic']

export function createHandlers(deps: HandlerDeps): IpcHandlers {
  const { state, store, logger, recording, exporter, derived } = deps
  /** Só caminhos completos: nada de abrir "./coisa" relativo ao processo. */
  const absolute = (path: unknown): string => {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Caminho inválido: precisa ser um caminho completo.')
    return path
  }
  return {
    'app:info': async () => deps.info,

    'projects:list': () => store.list(),
    'projects:get': (id) => store.detail(id),
    'projects:rename': (id, title) => store.rename(id, title),
    'projects:save': async (id, project) => {
      // o que vai para o disco passa pelo mesmo esquema de quem lê; campos desconhecidos são preservados
      const checked = migrate(project)
      await store.write(id, checked)
      return checked
    },
    'projects:trash': (id) => store.trash(id),
    'projects:reveal': (id) => store.reveal(id),
    'projects:pick-background': async (id) => {
      const picked = await deps.pickImage()
      return picked ? store.importBackground(id, picked) : null
    },

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

    'export:start': (request) => exporter.start(exportRequestSchema.parse(request)),
    'export:cancel': (exportId) => exporter.cancel(exportId),
    'export:status': async () => exporter.status(),
    'export:pick-dir': (defaultPath) => deps.pickExportDir(defaultPath),
    'files:open': (path) => deps.openPath(absolute(path)),
    'files:reveal': (path) => deps.revealPath(absolute(path)),
    'clipboard:write': async (text) => {
      if (typeof text !== 'string' || text.length > 10_000) throw new Error('Texto inválido para a área de transferência.')
      deps.copyText(text)
    },
    'derived:peaks': (id) => derived.peaks(id),
    'derived:preview-audio': (id) => derived.previewAudio(id),
    'derived:thumbs': (id) => derived.thumbs(id),
    'exporter:job': async (exportId) => exporter.job(exportId),
    'exporter:write': (exportId, position, data) => exporter.write(exportId, position, data),
    'exporter:progress': async (exportId, frame, renderFps) => exporter.progress(exportId, frame, renderFps),
    'exporter:finish': async (exportId, result) => exporter.finish(exportId, result),

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
