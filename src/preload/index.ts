/**
 * Ponte tipada: a ÚNICA superfície que o renderer enxerga (`window.tomada`).
 * contextIsolation ligado, sem nodeIntegration. Cada método chama um canal do
 * contrato em `@shared/ipc`; erro do main chega como `Error` com a mensagem limpa.
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  LEVEL_CHANNEL,
  LOG_CHANNEL,
  type IpcChannel,
  type IpcContract,
  type IpcEnvelope,
  type IpcEvents,
  type TomadaApi
} from '@shared/ipc'
import { mediaUrl } from '@shared/media-url'

async function invoke<K extends IpcChannel>(channel: K, ...args: IpcContract[K]['args']): Promise<IpcContract[K]['result']> {
  const response = (await ipcRenderer.invoke(channel, ...args)) as IpcEnvelope<IpcContract[K]['result']>
  if (response.ok) return response.value
  throw new Error(response.error.message)
}

const api: TomadaApi = {
  app: { info: () => invoke('app:info') },
  projects: {
    list: () => invoke('projects:list'),
    get: (id) => invoke('projects:get', id),
    rename: (id, title) => invoke('projects:rename', id, title),
    save: (id, project) => invoke('projects:save', id, project),
    trash: (id) => invoke('projects:trash', id),
    reveal: (id) => invoke('projects:reveal', id),
    pickBackground: (id) => invoke('projects:pick-background', id)
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
    pickProjectsDir: () => invoke('settings:pick-projects-dir'),
    pickFfmpeg: () => invoke('settings:pick-ffmpeg')
  },
  ffmpeg: {
    status: () => invoke('ffmpeg:status'),
    test: () => invoke('ffmpeg:test')
  },
  record: {
    sources: () => invoke('record:sources'),
    getPrefs: () => invoke('record:prefs-get'),
    setPrefs: (patch) => invoke('record:prefs-set', patch),
    clock: () => invoke('record:clock'),
    prepare: (request) => invoke('record:prepare', request),
    runCountdown: () => invoke('record:countdown'),
    go: () => invoke('record:go'),
    started: (info) => invoke('record:started', info),
    chunk: (kind, data) => invoke('record:chunk', kind, data),
    pause: (at) => invoke('record:pause', at),
    resume: (at) => invoke('record:resume', at),
    stop: (info) => invoke('record:stop', info),
    abort: (reason) => invoke('record:abort', reason),
    status: () => invoke('record:status'),
    level: (level) => ipcRenderer.send(LEVEL_CHANNEL, level)
  },
  processing: { retry: (sessionId) => invoke('process:retry', sessionId) },
  exporter: {
    start: (request) => invoke('export:start', request),
    cancel: (exportId) => invoke('export:cancel', exportId),
    status: () => invoke('export:status'),
    pickDir: (defaultPath) => invoke('export:pick-dir', defaultPath)
  },
  captions: { export: (projectId, kind) => invoke('captions:export', projectId, kind) },
  files: { open: (path) => invoke('files:open', path), reveal: (path) => invoke('files:reveal', path) },
  clipboard: { write: (text) => invoke('clipboard:write', text) },
  derived: {
    peaks: (id) => invoke('derived:peaks', id),
    previewAudio: (id) => invoke('derived:preview-audio', id),
    thumbs: (id) => invoke('derived:thumbs', id),
    levels: (id) => invoke('derived:levels', id)
  },
  transcription: {
    status: () => invoke('transcription:status'),
    prepare: () => invoke('transcription:prepare'),
    cancelPrepare: () => invoke('transcription:cancel-prepare'),
    start: (projectId) => invoke('transcription:start', projectId),
    cancel: (projectId) => invoke('transcription:cancel', projectId),
    getPrefs: () => invoke('transcription:get-prefs'),
    setPrefs: (patch) => invoke('transcription:set-prefs', patch),
    get: (projectId) => invoke('transcript:get', projectId)
  },
  dictionary: { get: () => invoke('dictionary:get'), set: (terms) => invoke('dictionary:set', terms) },
  ai: {
    status: () => invoke('llm:status'),
    setPrefs: (patch) => invoke('llm:set-prefs', patch),
    setKey: (key) => invoke('llm:set-key', key),
    clearKey: () => invoke('llm:clear-key'),
    test: () => invoke('llm:test'),
    retakes: (projectId) => invoke('ai:retakes', projectId)
  },
  exportWorker: {
    job: (exportId) => invoke('exporter:job', exportId),
    write: (exportId, position, data) => invoke('exporter:write', exportId, position, data),
    progress: (exportId, frame, renderFps) => invoke('exporter:progress', exportId, frame, renderFps),
    finish: (exportId, result) => invoke('exporter:finish', exportId, result)
  },
  bar: { state: () => invoke('bar:state'), action: (action) => invoke('bar:action', action) },
  countdown: { begin: () => invoke('countdown:begin'), finish: (completed) => invoke('countdown:finish', completed) },
  bubble: { config: () => invoke('bubble:config') },
  on: <K extends keyof IpcEvents>(channel: K, listener: (payload: IpcEvents[K]) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: IpcEvents[K]): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
  mediaUrl: (projectId, relPath, version) => mediaUrl(projectId, relPath, version),
  log: (entry) => ipcRenderer.send(LOG_CHANNEL, entry)
}

contextBridge.exposeInMainWorld('tomada', api)
