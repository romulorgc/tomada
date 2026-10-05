/**
 * Ponte tipada: a ÚNICA superfície que o renderer enxerga (`window.tomada`).
 * contextIsolation ligado, sem nodeIntegration. Cada método chama um canal do
 * contrato em `@shared/ipc`; erro do main chega como `Error` com a mensagem limpa.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { LOG_CHANNEL, type IpcChannel, type IpcContract, type IpcEnvelope, type TomadaApi } from '@shared/ipc'
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
    trash: (id) => invoke('projects:trash', id),
    reveal: (id) => invoke('projects:reveal', id)
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
  mediaUrl: (projectId, relPath, version) => mediaUrl(projectId, relPath, version),
  log: (entry) => ipcRenderer.send(LOG_CHANNEL, entry)
}

contextBridge.exposeInMainWorld('tomada', api)
