/**
 * Processo principal do Tomada: janela, protocolo de mídia, IPC, gravação.
 * A lógica mora nos módulos ao lado (testáveis sem Electron); aqui só se liga tudo.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session, shell } from 'electron'
import { LEVEL_CHANNEL, type AppInfo, type IpcEvents } from '@shared/ipc'
import { createSourceProvider } from './capture-sources'
import { createExporterWindowFactory } from './export-window'
import { createExportService } from './export-service'
import { createFfmpeg, locateFfmpeg } from './ffmpeg'
import { createHandlers } from './handlers'
import { registerIpc } from './ipc'
import { createLogger } from './logger'
import { handleMediaRequest, MEDIA_SCHEME } from './media-protocol'
import { ENV_PROJECTS_DIR, ENV_USER_DATA_DIR, logsDir, settingsFile } from './paths'
import { createProjectStore } from './projects'
import { createRecordingService } from './recording-service'
import { createAppState } from './state'
import { createTracker } from './tracker'
import { createAuxWindows } from './windows'

// Testes isolam ajustes e logs do app real. Precisa vir antes de qualquer uso de userData.
if (process.env[ENV_USER_DATA_DIR]) app.setPath('userData', process.env[ENV_USER_DATA_DIR])

// Registrar o esquema ANTES de `ready`. `stream` é o que deixa <video> usar o protocolo.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
  }
])

const BACKGROUND = '#0e0f12'
const rendererUrl = process.env.ELECTRON_RENDERER_URL // só existe no `npm run dev`

function isAppUrl(url: string): boolean {
  return url.startsWith('file://') || (rendererUrl !== undefined && url.startsWith(rendererUrl))
}

/** Em modo de teste (pasta de projetos definida por variável), apagar remove direto do disco. */
const testMode = Boolean(process.env[ENV_PROJECTS_DIR])

/**
 * Em notebook com duas placas (a integrada da Intel e uma NVIDIA/AMD), o Chromium usa a integrada. Medido
 * aqui (RTX 3050 + Intel UHD, 3 min de vídeo 1080p30 com cortes e zooms): 41 qps na integrada, 144 qps na
 * dedicada, na MESMA exportação. Pedimos a placa de alto desempenho; em máquina de uma placa só não muda
 * nada. `TOMADA_GPU=auto` deixa o sistema escolher (para comparar ou se a dedicada der problema).
 */
if (process.env.TOMADA_GPU !== 'auto') app.commandLine.appendSwitch('force_high_performance_gpu')

async function main(): Promise<void> {
  await app.whenReady()
  nativeTheme.themeSource = 'dark'
  Menu.setApplicationMenu(null)

  const userData = app.getPath('userData')
  const logger = createLogger(logsDir(userData), { echo: !app.isPackaged })
  logger.info(`Tomada ${app.getVersion()} iniciando (Electron ${process.versions.electron}, userData ${userData})`)

  process.on('unhandledRejection', (reason) => logger.error('Promessa rejeitada sem tratamento', reason))
  app.on('render-process-gone', (_e, _wc, details) => logger.error(`Processo da interface caiu: ${details.reason}`, details))
  app.on('child-process-gone', (_e, details) => logger.error(`Processo filho caiu: ${details.type} (${details.reason})`, details))

  const state = await createAppState({ file: settingsFile(userData), logger })

  // Lixeira do Windows para o usuário; em teste, direto do disco (os testes não podem encher a Lixeira real).
  const trash = (path: string): Promise<void> =>
    testMode ? rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) : shell.trashItem(path)

  const store = createProjectStore({
    root: () => state.projectsRoot(),
    logger,
    trash,
    openFolder: async (path) => {
      const error = await shell.openPath(path)
      if (error) throw new Error(`Não consegui abrir a pasta: ${error}`)
    }
  })

  // Protocolo de mídia (com Range), restrito à raiz dos projetos.
  protocol.handle(MEDIA_SCHEME, (request) => handleMediaRequest(request, state.projectsRoot()))

  // Câmera, microfone e captura de tela: só para as páginas do próprio app.
  const allowed = (permission: string): boolean => permission === 'media' || permission === 'display-capture'
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(allowed(permission) && isAppUrl(details.requestingUrl || wc.getURL()))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => allowed(permission) && isAppUrl(origin))

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (!isAppUrl(url)) event.preventDefault()
    })
  })

  const info: AppInfo = {
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    userDataDir: userData,
    logsDir: logger.dir
  }

  let mainWindow: BrowserWindow | null = null
  const emit = <K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }

  // --- Gravação -----------------------------------------------------------------
  const windows = createAuxWindows({
    preload: join(__dirname, '../preload/index.js'),
    rendererUrl,
    rendererFile: join(__dirname, '../renderer/index.html'),
    getMain: () => mainWindow,
    logger
  })
  const sources = createSourceProvider({ logger, ownHwnds: () => windows.ownHwnds(), env: process.env })
  sources.installDisplayMediaHandler(session.defaultSession)

  const clock = (): number => performance.timeOrigin + performance.now()
  const recording = createRecordingService({
    logger,
    projectsRoot: () => state.projectsRoot(),
    ffmpeg: () => {
      const paths = locateFfmpeg(state.ffmpegLocateOptions())
      return paths ? createFfmpeg(paths) : null
    },
    sources,
    windows,
    createTracker: (config) =>
      createTracker(config, {
        workerPath: join(__dirname, 'tracker-worker.js'),
        logger,
        onWindowGone: () => {
          emit('record:notice', { kind: 'info', text: 'A janela que estava sendo gravada foi fechada. A gravação foi salva até esse ponto.' })
          recording.command('stop', 'window')
        }
      }),
    emit,
    trash,
    clock,
    now: () => new Date(),
    env: process.env
  })
  // --- Exportação: áudio no ffmpeg, vídeo numa janela escondida, mux e conferência ------------------
  const exporter = createExportService({
    logger,
    read: (id) => store.read(id),
    ffmpeg: () => {
      const paths = locateFfmpeg(state.ffmpegLocateOptions())
      return paths ? createFfmpeg(paths) : null
    },
    openExporterWindow: createExporterWindowFactory({
      preload: join(__dirname, '../preload/index.js'),
      rendererUrl,
      rendererFile: join(__dirname, '../renderer/index.html'),
      logger
    }),
    emit: (progress) => emit('export:progress', progress),
    now: () => performance.now()
  })

  // Nível do microfone (só de ida) → mini medidor da barra.
  ipcMain.on(LEVEL_CHANNEL, (_event, level: unknown) => {
    if (typeof level === 'number' && Number.isFinite(level)) recording.level(level)
  })
  let quitting = false
  app.on('before-quit', () => {
    quitting = true
    void recording.shutdown()
    void exporter.shutdown()
    windows.closeAll()
  })

  registerIpc(
    createHandlers({
      info,
      state,
      store,
      logger,
      recording,
      exporter,
      finishCountdown: (completed) => windows.finishCountdown(completed),
      clock,
      pickFolder: async (defaultPath) => {
        const options = {
          title: 'Escolha a pasta dos projetos',
          properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
          ...(defaultPath ? { defaultPath } : {})
        }
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : (result.filePaths[0] ?? null)
      },
      pickFfmpeg: async () => {
        const options = {
          title: 'Escolha o ffmpeg.exe (ou a pasta que tem o ffmpeg e o ffprobe)',
          properties: ['openFile', 'openDirectory'] as ('openFile' | 'openDirectory')[]
        }
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : (result.filePaths[0] ?? null)
      }
    }),
    logger
  )

  const createWindow = (): BrowserWindow => {
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      show: false,
      title: 'Tomada',
      backgroundColor: BACKGROUND,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        autoplayPolicy: 'no-user-gesture-required',
        // A janela fica minimizada durante a gravação e é ELA que roda os MediaRecorder:
        // sem isto o Chromium freia timers e rAF de página oculta.
        backgroundThrottling: false
      }
    })
    win.once('ready-to-show', () => win.show())
    win.webContents.on('did-fail-load', (_e, code, description, url) =>
      logger.error(`A interface não carregou (${code}: ${description}) em ${url}`)
    )
    // Fechar a janela no meio de uma gravação não pode perdê-la: vira "parar e salvar".
    win.on('close', (event) => {
      if (recording.recording && !quitting) {
        event.preventDefault()
        logger.warn('Janela fechada durante a gravação; parando e salvando.')
        recording.command('stop', 'window')
      }
    })
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null
    })
    if (rendererUrl) void win.loadURL(rendererUrl)
    else void win.loadFile(join(__dirname, '../renderer/index.html'))
    if (process.env.TOMADA_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' })
    return win
  }

  mainWindow = createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
  app.on('window-all-closed', () => app.quit())
}

main().catch((err) => {
  // Falha na partida: aparece para o usuário, não fica só no console.
  console.error(err)
  dialog.showErrorBox('O Tomada não conseguiu iniciar', err instanceof Error ? (err.stack ?? err.message) : String(err))
  app.exit(1)
})
