/**
 * Contrato único de IPC entre main, preload e renderer.
 * Todo canal novo nasce AQUI: o main é obrigado (pelo tipo) a implementar todos,
 * e o preload e o renderer só enxergam o que está declarado.
 * Código puro: sem DOM, sem Node.
 */
import type { Project, ProjectSummary } from './types'

// --- Tipos que atravessam a ponte ---------------------------------------------

export type AppInfo = {
  name: string
  version: string
  platform: string
  electron: string
  userDataDir: string
  logsDir: string
}

/** Ajustes gravados em disco (todos opcionais; ausente = padrão). */
export type Settings = {
  projectsDir?: string
  /** Pasta com ffmpeg/ffprobe, ou o caminho do próprio ffmpeg. */
  ffmpegPath?: string
}

export type SettingsView = {
  settings: Settings
  effective: {
    projectsDir: string
    /** De onde veio a pasta efetiva: variável de teste, ajuste ou padrão. */
    projectsDirSource: 'env' | 'settings' | 'default'
  }
}

export type FfmpegStatus = {
  found: boolean
  source: 'settings' | 'bundled' | 'path' | null
  ffmpegPath: string | null
  ffprobePath: string | null
  /** Ex.: "8.1.1-full_build-www.gyan.dev" */
  version: string | null
  ffprobeVersion: string | null
  /** Motivo, quando não achou ou não conseguiu executar. */
  error: string | null
}

export type FfmpegTestResult = {
  ok: boolean
  ffmpegVersion: string | null
  ffprobeVersion: string | null
  encoders: { libx264: boolean; h264Nvenc: boolean }
  /** Detalhe de cada etapa do teste, na ordem em que rodaram. */
  steps: { label: string; ok: boolean; detail: string }[]
  error: string | null
}

export type ProjectDetail = {
  id: string
  /** Pasta absoluta do projeto (para exibir). */
  dir: string
  project: Project
  media: {
    screen: MediaFile | null
    camera: MediaFile | null
  }
}

export type MediaFile = {
  /** URL `tomada-media://` pronta para um <video>. */
  url: string
  bytes: number
}

// --- Contrato ------------------------------------------------------------------

export type IpcContract = {
  'app:info': { args: []; result: AppInfo }

  'projects:list': { args: []; result: ProjectSummary[] }
  'projects:get': { args: [id: string]; result: ProjectDetail }
  'projects:rename': { args: [id: string, title: string]; result: ProjectSummary }
  'projects:trash': { args: [id: string]; result: void }
  'projects:reveal': { args: [id: string]; result: void }

  'settings:get': { args: []; result: SettingsView }
  'settings:update': { args: [patch: Partial<Settings>]; result: SettingsView }
  'settings:pick-projects-dir': { args: []; result: string | null }
  'settings:pick-ffmpeg': { args: []; result: string | null }

  'ffmpeg:status': { args: []; result: FfmpegStatus }
  'ffmpeg:test': { args: []; result: FfmpegTestResult }
}

export type IpcChannel = keyof IpcContract

/** O que o main implementa: uma função por canal, tipada pelo contrato. */
export type IpcHandlers = {
  [K in IpcChannel]: (...args: IpcContract[K]['args']) => Promise<IpcContract[K]['result']>
}

/** Resposta que cruza a ponte: erro vira dado, sem o prefixo feio do Electron. */
export type IpcEnvelope<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string } }

/** Canal só de ida, sem resposta: erros da interface vão para o log do main. */
export const LOG_CHANNEL = 'log:renderer' as const
export type RendererLogEntry = { level: 'info' | 'warn' | 'error'; message: string; detail?: string }

// --- API exposta em window.tomada ---------------------------------------------

export type TomadaApi = {
  app: { info(): Promise<AppInfo> }
  projects: {
    list(): Promise<ProjectSummary[]>
    get(id: string): Promise<ProjectDetail>
    rename(id: string, title: string): Promise<ProjectSummary>
    trash(id: string): Promise<void>
    reveal(id: string): Promise<void>
  }
  settings: {
    get(): Promise<SettingsView>
    update(patch: Partial<Settings>): Promise<SettingsView>
    pickProjectsDir(): Promise<string | null>
    pickFfmpeg(): Promise<string | null>
  }
  ffmpeg: {
    status(): Promise<FfmpegStatus>
    test(): Promise<FfmpegTestResult>
  }
  /** URL `tomada-media://` de um arquivo do projeto (síncrono, sem IPC). */
  mediaUrl(projectId: string, relPath: string, version?: number): string
  log(entry: RendererLogEntry): void
}
