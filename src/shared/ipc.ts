/**
 * Contrato único de IPC entre main, preload e renderer.
 * Todo canal novo nasce AQUI: o main é obrigado (pelo tipo) a implementar todos,
 * e o preload e o renderer só enxergam o que está declarado.
 * Código puro: sem DOM, sem Node.
 */
import type { Levels } from './clean'
import type { ExportOptions } from './export'
import type { RecordPrefs, RecordRequest } from './recording'
import type { LlmStatus, PrepareSnapshot, RetakesResult, TranscriptionJob, TranscriptionPrefs, TranscriptionView } from './transcription'
import type { Project, ProjectSummary, Size, Transcript, Word } from './types'

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
  /** Escolhas da tela Gravar (ver `normalizeRecordPrefs`). */
  record?: Partial<RecordPrefs>
  /** Dicionário: nomes próprios e termos que a transcrição deve acertar (vira prompt e `hotwords`). */
  dictionary?: string[]
  /** Preferências da transcrição; `engine` só por arquivo (não há botão: o padrão é o que se mediu melhor). */
  transcription?: Partial<TranscriptionPrefs> & { engine?: 'faster-whisper' | 'whisper-cpp' }
  /** IA de texto: qual usar e o modelo. A chave cifrada NUNCA sai do processo principal. */
  llm?: LlmStoredPrefs
}

/** Como a IA está configurada em disco. `apiKeyEnc` é a chave cifrada pelo cofre do sistema (só o main a vê). */
export type LlmStoredPrefs = { provider?: 'auto' | 'cli' | 'api'; model?: string; apiKeyEnc?: string }

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
  /** URLs dos arquivos de eventos (null = o arquivo não existe, ex.: gravação só de câmera). */
  events: { cursor: string | null; clicks: string | null; keys: string | null }
}

export type MediaFile = {
  /** URL `tomada-media://` pronta para um <video>. */
  url: string
  bytes: number
}

// --- Gravação (M1b) ------------------------------------------------------------

/** Uma tela ou janela que dá para gravar, com miniatura. */
export type SourceInfo = {
  id: string
  kind: 'screen' | 'window'
  name: string
  /** Miniatura como data URL (JPEG). */
  thumbnail: string
  /** Telas: tela principal. */
  primary?: boolean
  /** Telas: tamanho em pixels físicos. */
  sizePx?: Size
}

export type PrepareResult = {
  sessionId: string
  /** Nome da pasta do projeto (o id do projeto na biblioteca). */
  folder: string
  kind: 'screen' | 'window' | null
  sourceName: string | null
  /** Tamanho nativo esperado do quadro, em pixels físicos (para pedir a resolução nativa). */
  nativeSize: Size | null
  scale: number
}

export type ChunkKind = 'screen' | 'camera' | 'mic'

/** O que a interface informa ao main quando os gravadores já dispararam. */
export type StartedInfo = {
  /**
   * Relógio do renderer (`performance.timeOrigin + performance.now()`): o instante em que o
   * PRIMEIRO `MediaRecorder.start()` foi CHAMADO. Medido: o tempo 0 do arquivo é o da chamada;
   * o evento `start` só chega 150-215 ms depois (gravador de tela), então usá-lo como t0
   * atrasa todos os eventos em relação ao vídeo.
   */
  t0: number
  /** Instante da chamada de `start()` de cada gravador (≥ t0; mesma batida, diferença de microssegundos). */
  screenStartAt: number | null
  cameraStartAt: number | null
  /** Quanto o evento `start` demorou depois da chamada (diagnóstico). */
  startEventLagMs: { screen: number | null; camera: number | null }
  /** Tamanho REAL do quadro da tela no início. */
  frame: Size | null
  /** main − renderer, medido por ida e volta. */
  clockOffsetMs: number
  clockRttMs: number
  screenMime: string | null
  cameraMime: string | null
  screenHasAudio: boolean
  /** O cursor do sistema NÃO aparece no vídeo (a trilha informou `cursor: 'never'`). */
  cursorHidden: boolean
  cameraHasVideo: boolean
  cameraHasAudio: boolean
  cameraSize: Size | null
}

export type StopReason = 'user' | 'source-ended' | 'write-error' | 'error'

export type StopInfo = {
  endedAt: number
  reason: StopReason
  /** Tamanho do quadro da tela no fim (a janela pode ter mudado de tamanho). */
  frame: Size | null
  /** Avisos que a interface mostrou (ex.: câmera desconectada). */
  notes: string[]
}

export type RecordStatus = 'idle' | 'preparing' | 'countdown' | 'recording' | 'paused' | 'stopping'

export type ProcessStepId = 'save' | 'screen' | 'camera' | 'voice' | 'system' | 'thumb' | 'project'
export type ProcessStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error'
export type ProcessStepState = {
  id: ProcessStepId
  status: ProcessStepStatus
  /** 0..1 */
  fraction: number
  detail?: string
}

export type ProcessSnapshot = {
  sessionId: string
  /** Nome da pasta do projeto. */
  folder: string
  status: 'running' | 'failed' | 'done'
  steps: ProcessStepState[]
  error?: { step: ProcessStepId; message: string }
  /** Avisos de bastidor (ex.: NVENC falhou e caiu para libx264). */
  notes: string[]
}

export type RecordingStatusView = {
  status: RecordStatus
  sessionId: string | null
  processing: ProcessSnapshot | null
}

export type BarAction = 'pause' | 'resume' | 'stop' | 'discard' | 'restart'

export type BarState = {
  status: 'recording' | 'paused' | 'stopping'
  /** Tempo gravado (ms) no instante `asOf` (Date.now do main). */
  elapsedMs: number
  asOf: number
  hasMic: boolean
  hasCamera: boolean
  shortcutStop: string
  shortcutPause: string
}

export type CountdownConfig = { seconds: number; silent: boolean }
export type BubbleConfig = { cameraId: string; mirror: boolean }

// --- Exportação (M2a) ----------------------------------------------------------

export type ExportRequest = ExportOptions & { projectId: string }

export type ExportPhase = 'preparing' | 'rendering' | 'mux' | 'checking' | 'done' | 'error' | 'cancelled'

/** Resultado da conferência final (ffprobe) e da medição da exportação. */
export type ExportReport = {
  outputPath: string
  bytes: number
  width: number
  height: number
  /** Duração do arquivo (ms) e a esperada pelo documento (`outputDuration`). */
  durationMs: number
  expectedMs: number
  fps: number
  frames: number
  hasAudio: boolean
  /** |duração do vídeo − duração do áudio| (ms): acima de 50 é erro. */
  audioVideoDiffMs: number
  /** Quadros por segundo da renderização (só a fase de vídeo). */
  renderFps: number
  elapsedMs: number
  profile: string | null
  /** Onde o tempo do vídeo foi (decodificar, desenhar, codificar), para depurar a velocidade. */
  timing: string | null
}

export type ExportProgress = {
  exportId: string
  projectId: string
  phase: ExportPhase
  /** 0..1 do trabalho todo. */
  fraction: number
  frame: number
  totalFrames: number
  renderFps: number | null
  etaMs: number | null
  /** O áudio já ficou pronto (ele roda ao lado do vídeo). */
  audioReady: boolean
  /** Motivo, em `error`/`cancelled`; aviso de bastidor nas demais fases. */
  message?: string
  outputPath?: string
  report?: ExportReport
}

/** A legenda gravada em disco (`captions:export`). */
export type CaptionsFile = { path: string; cues: number }

/** O que a janela escondida de exportação recebe do processo principal. */
export type ExportJob = {
  exportId: string
  projectId: string
  /** O documento a exportar (com as edições ainda não salvas, se for o caso). */
  project: Project
  /** 16:9 ou vertical (o vertical é 1080×1920). */
  format: 'horizontal' | 'vertical'
  width: number
  height: number
  fps: number
  bitrate: number
  /** As palavras da transcrição (legendas); `null` = o projeto não tem transcrição. Só texto e tempos. */
  words: Word[] | null
  /** URLs `tomada-media://` das mídias (null = sem essa fonte). */
  screenUrl: string | null
  cameraUrl: string | null
  /** URLs dos eventos. */
  eventUrls: { cursor: string | null; clicks: string | null; keys: string | null }
}

/** O que a janela de exportação informa ao terminar a fase de vídeo. */
export type ExporterResult = { ok: true; frames: number; encoder: string; timing?: string } | { ok: false; message: string }

// --- Mídias derivadas do editor (M2b) -----------------------------------------

/** Picos da voz para a forma de onda: 0..255 por coluna, `perSecond` colunas por segundo. */
export type PeaksData = { perSecond: number; durationMs: number; peaks: number[] }
/** A voz tratada da prévia (sem cortes), pronta para um `<audio>`. */
export type PreviewAudioData = { url: string }
/** Miniaturas da tela: uma a cada `intervalMs` (a de índice `i` mostra o instante `i * intervalMs`). */
export type ThumbsData = { intervalMs: number; count: number; height: number; urls: string[] }

// --- Contrato ------------------------------------------------------------------


export type IpcContract = {
  'app:info': { args: []; result: AppInfo }

  'projects:list': { args: []; result: ProjectSummary[] }
  'projects:get': { args: [id: string]; result: ProjectDetail }
  'projects:rename': { args: [id: string, title: string]; result: ProjectSummary }
  /** Valida e grava o documento (atômico). Devolve o documento como foi gravado. */
  'projects:save': { args: [id: string, project: Project]; result: Project }
  'projects:trash': { args: [id: string]; result: void }
  'projects:reveal': { args: [id: string]; result: void }
  /** Escolhe uma imagem, copia para `media/` do projeto e devolve o caminho RELATIVO (null = cancelou). */
  'projects:pick-background': { args: [id: string]; result: string | null }

  'settings:get': { args: []; result: SettingsView }
  'settings:update': { args: [patch: Partial<Settings>]; result: SettingsView }
  'settings:pick-projects-dir': { args: []; result: string | null }
  'settings:pick-ffmpeg': { args: []; result: string | null }

  'ffmpeg:status': { args: []; result: FfmpegStatus }
  'ffmpeg:test': { args: []; result: FfmpegTestResult }

  // Gravação: quem dirige é a interface (o MediaRecorder mora no renderer); o main guarda
  // os arquivos, rastreia o mouse e processa ao parar.
  'record:sources': { args: []; result: SourceInfo[] }
  'record:prefs-get': { args: []; result: RecordPrefs }
  'record:prefs-set': { args: [patch: Partial<RecordPrefs>]; result: RecordPrefs }
  'record:clock': { args: []; result: number }
  'record:prepare': { args: [request: RecordRequest]; result: PrepareResult }
  'record:countdown': { args: []; result: boolean }
  'record:go': { args: []; result: void }
  'record:started': { args: [info: StartedInfo]; result: void }
  'record:chunk': { args: [kind: ChunkKind, data: ArrayBuffer | Uint8Array]; result: void }
  'record:pause': { args: [at: number]; result: void }
  'record:resume': { args: [at: number]; result: void }
  'record:stop': { args: [info: StopInfo]; result: { sessionId: string } }
  'record:abort': { args: [reason?: string]; result: void }
  'record:status': { args: []; result: RecordingStatusView }
  'process:retry': { args: [sessionId: string]; result: void }

  // Exportação: a interface pede; o main orquestra áudio (ffmpeg), vídeo (janela escondida) e mux.
  'export:start': { args: [request: ExportRequest]; result: { exportId: string } }
  'export:cancel': { args: [exportId: string]; result: void }
  'export:status': { args: []; result: ExportProgress | null }
  'export:pick-dir': { args: [defaultPath?: string]; result: string | null }
  /** Salva a legenda (SRT ou VTT, no tempo do vídeo final) em `exports/` do projeto. O destino nunca vem da interface. */
  'captions:export': { args: [projectId: string, kind: 'srt' | 'vtt']; result: CaptionsFile }
  /** Abre o arquivo no programa padrão (tocar o vídeo exportado). */
  'files:open': { args: [path: string]; result: void }
  /** Mostra o arquivo no Explorer. */
  'files:reveal': { args: [path: string]; result: void }
  'clipboard:write': { args: [text: string]; result: void }
  // Mídias derivadas (geradas uma vez pelo ffmpeg, em segundo plano)
  'derived:peaks': { args: [id: string]; result: PeaksData | null }
  'derived:preview-audio': { args: [id: string]; result: PreviewAudioData | null }
  'derived:thumbs': { args: [id: string]; result: ThumbsData | null }
  /** Nível do áudio por quadro (microfone e som do computador) para a limpeza de silêncio. */
  'derived:levels': { args: [id: string]; result: Levels | null }

  // Transcrição (M3): a interface só diz QUAL projeto; o main resolve a voz, executa o motor e grava o transcript.json.
  'transcription:status': { args: []; result: TranscriptionView }
  'transcription:prepare': { args: []; result: void }
  'transcription:cancel-prepare': { args: []; result: void }
  'transcription:start': { args: [projectId: string]; result: void }
  'transcription:cancel': { args: [projectId: string]; result: void }
  'transcription:get-prefs': { args: []; result: TranscriptionPrefs }
  'transcription:set-prefs': { args: [patch: Partial<TranscriptionPrefs>]; result: TranscriptionPrefs }
  'transcript:get': { args: [projectId: string]; result: Transcript | null }
  'dictionary:get': { args: []; result: string[] }
  'dictionary:set': { args: [terms: string[]]; result: string[] }

  // IA de texto (M3): provedor, chave (guardada cifrada no main) e a tarefa de recomeços.
  'llm:status': { args: []; result: LlmStatus }
  'llm:set-prefs': { args: [patch: { provider?: 'auto' | 'cli' | 'api'; model?: string }]; result: LlmStatus }
  'llm:set-key': { args: [key: string]; result: LlmStatus }
  'llm:clear-key': { args: []; result: LlmStatus }
  'llm:test': { args: []; result: { ok: boolean; message?: string } }
  'ai:retakes': { args: [projectId: string]; result: RetakesResult }

  // Canais da janela escondida de exportação (identificada pelo `exportId` que vai no hash da URL).
  'exporter:job': { args: [exportId: string]; result: ExportJob }
  'exporter:write': { args: [exportId: string, position: number, data: Uint8Array]; result: void }
  'exporter:progress': { args: [exportId: string, frame: number, renderFps: number | null]; result: void }
  'exporter:finish': { args: [exportId: string, result: ExporterResult]; result: void }

  // Janelas auxiliares (barra flutuante, contagem, bolha da câmera)
  'bar:state': { args: []; result: BarState | null }
  'bar:action': { args: [action: BarAction]; result: void }
  'countdown:begin': { args: []; result: CountdownConfig }
  'countdown:finish': { args: [completed: boolean]; result: void }
  'bubble:config': { args: []; result: BubbleConfig | null }
}

/** Eventos que o main empurra para as janelas (canal → carga). */
export type IpcEvents = {
  /** Comando vindo da barra ou do atalho global, para a janela que grava. */
  'record:command': { cmd: BarAction; source: 'bar' | 'hotkey' | 'window' }
  /** Aviso para mostrar na interface (ex.: a janela gravada fechou). */
  'record:notice': { kind: 'info' | 'error'; text: string; detail?: string }
  'record:status': RecordingStatusView
  'process:progress': ProcessSnapshot
  'bar:state': BarState
  'bar:level': { level: number }
  'export:progress': ExportProgress
  /** Preparação da transcrição: cada mudança de passo ou de progresso. */
  'transcription:prepare': PrepareSnapshot
  /** Uma transcrição na fila mudou de estado (ou de progresso). */
  'transcription:job': TranscriptionJob
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

/** Canal só de ida: nível do microfone (0..1) da janela que grava, repassado à barra. */
export const LEVEL_CHANNEL = 'record:level' as const

// --- API exposta em window.tomada ---------------------------------------------

export type TomadaApi = {
  app: { info(): Promise<AppInfo> }
  projects: {
    list(): Promise<ProjectSummary[]>
    get(id: string): Promise<ProjectDetail>
    rename(id: string, title: string): Promise<ProjectSummary>
    save(id: string, project: Project): Promise<Project>
    trash(id: string): Promise<void>
    reveal(id: string): Promise<void>
    pickBackground(id: string): Promise<string | null>
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
  record: {
    sources(): Promise<SourceInfo[]>
    getPrefs(): Promise<RecordPrefs>
    setPrefs(patch: Partial<RecordPrefs>): Promise<RecordPrefs>
    /** Relógio do processo principal (ms, mesma fórmula do renderer), para medir a diferença. */
    clock(): Promise<number>
    prepare(request: RecordRequest): Promise<PrepareResult>
    /** Contagem 3-2-1 sobre a tela. `false` = cancelada (Esc). */
    runCountdown(): Promise<boolean>
    /** Liga o rastreador; volta quando ele já está amostrando. */
    go(): Promise<void>
    started(info: StartedInfo): Promise<void>
    chunk(kind: ChunkKind, data: ArrayBuffer | Uint8Array): Promise<void>
    pause(at: number): Promise<void>
    resume(at: number): Promise<void>
    stop(info: StopInfo): Promise<{ sessionId: string }>
    abort(reason?: string): Promise<void>
    status(): Promise<RecordingStatusView>
    /** Só de ida: nível do microfone para a mini barra. */
    level(level: number): void
  }
  processing: { retry(sessionId: string): Promise<void> }
  exporter: {
    start(request: ExportRequest): Promise<{ exportId: string }>
    cancel(exportId: string): Promise<void>
    status(): Promise<ExportProgress | null>
    pickDir(defaultPath?: string): Promise<string | null>
  }
  captions: { export(projectId: string, kind: 'srt' | 'vtt'): Promise<CaptionsFile> }
  files: {
    open(path: string): Promise<void>
    reveal(path: string): Promise<void>
  }
  clipboard: { write(text: string): Promise<void> }
  derived: {
    peaks(id: string): Promise<PeaksData | null>
    previewAudio(id: string): Promise<PreviewAudioData | null>
    thumbs(id: string): Promise<ThumbsData | null>
    levels(id: string): Promise<Levels | null>
  }
  transcription: {
    status(): Promise<TranscriptionView>
    prepare(): Promise<void>
    cancelPrepare(): Promise<void>
    start(projectId: string): Promise<void>
    cancel(projectId: string): Promise<void>
    getPrefs(): Promise<TranscriptionPrefs>
    setPrefs(patch: Partial<TranscriptionPrefs>): Promise<TranscriptionPrefs>
    /** O transcript.json do projeto (null se ainda não há). */
    get(projectId: string): Promise<Transcript | null>
  }
  dictionary: { get(): Promise<string[]>; set(terms: string[]): Promise<string[]> }
  ai: {
    status(): Promise<LlmStatus>
    setPrefs(patch: { provider?: 'auto' | 'cli' | 'api'; model?: string }): Promise<LlmStatus>
    setKey(key: string): Promise<LlmStatus>
    clearKey(): Promise<LlmStatus>
    test(): Promise<{ ok: boolean; message?: string }>
    /** Pede à IA os recomeços da transcrição do projeto (só o texto vai). */
    retakes(projectId: string): Promise<RetakesResult>
  }
  /** Só para a janela escondida de exportação. */
  exportWorker: {
    job(exportId: string): Promise<ExportJob>
    write(exportId: string, position: number, data: Uint8Array): Promise<void>
    progress(exportId: string, frame: number, renderFps: number | null): Promise<void>
    finish(exportId: string, result: ExporterResult): Promise<void>
  }
  bar: { state(): Promise<BarState | null>; action(action: BarAction): Promise<void> }
  countdown: { begin(): Promise<CountdownConfig>; finish(completed: boolean): Promise<void> }
  bubble: { config(): Promise<BubbleConfig | null> }
  /** Assina um evento empurrado pelo main. Devolve a função que cancela a assinatura. */
  on<K extends keyof IpcEvents>(channel: K, listener: (payload: IpcEvents[K]) => void): () => void
  /** URL `tomada-media://` de um arquivo do projeto (síncrono, sem IPC). */
  mediaUrl(projectId: string, relPath: string, version?: number): string
  log(entry: RendererLogEntry): void
}
