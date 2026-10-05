/**
 * Processo principal do Tomada: janela, protocolo de mídia, IPC, gravação.
 * A lógica mora nos módulos ao lado (testáveis sem Electron); aqui só se liga tudo.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, protocol, safeStorage, session, shell } from 'electron'
import { LEVEL_CHANNEL, type AppInfo, type IpcEvents, type ProcessSnapshot } from '@shared/ipc'
import { createSourceProvider } from './capture-sources'
import { createDerivedMedia } from './derived-media'
import { createExporterWindowFactory } from './export-window'
import { createExportService } from './export-service'
import { createFfmpeg, locateFfmpeg } from './ffmpeg'
import { createHandlers } from './handlers'
import { registerIpc } from './ipc'
import { createLlmManager, type KeyVault } from './llm/manager'
import { createLogger } from './logger'
import { handleMediaRequest, MEDIA_SCHEME } from './media-protocol'
import { isAppOrigin, isAppUrl, isExternalRequest, type AppUrlContext } from './navigation'
import { ENV_PROJECTS_DIR, ENV_USER_DATA_DIR, logsDir, settingsFile } from './paths'
import { createOutputDirs } from './path-guard'
import { createProjectStore } from './projects'
import { createRecordingService } from './recording-service'
import { createAppState } from './state'
import { createTracker } from './tracker'
import { chooseEngine } from './transcription/engines'
import { createTranscriptionService } from './transcription/service'
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

/** Páginas do app: SÓ o `index.html` empacotado (ou o servidor de desenvolvimento), comparado exatamente. */
const appUrls: AppUrlContext = { rendererUrl, rendererFile: join(__dirname, '../renderer/index.html') }

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
    callback(allowed(permission) && isAppUrl(details.requestingUrl || wc.getURL(), appUrls))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => allowed(permission) && isAppOrigin(origin, appUrls))

  // Nada do app usa a rede: o que sairia da máquina é cortado na camada de rede (além da CSP, que só existe no build).
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (details, callback) => {
    const external = isExternalRequest(details.url, appUrls)
    if (external) logger.warn(`Requisição para fora barrada: ${details.url}`)
    callback({ cancel: external })
  })

  // Nenhuma janela navega para fora do app nem abre outra (nem por redirecionamento, nem por quadro interno).
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const keepInside = (event: { preventDefault(): void }, url: string): void => {
      if (!isAppUrl(url, appUrls)) {
        event.preventDefault()
        logger.warn(`Navegação barrada: ${url}`)
      }
    }
    contents.on('will-navigate', keepInside)
    contents.on('will-redirect', keepInside)
    contents.on('will-frame-navigate', (details) => keepInside(details, details.url))
    contents.on('will-attach-webview', (event) => event.preventDefault())
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

  // --- Transcrição e IA ----------------------------------------------------------------------------------
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
  const { engine } = chooseEngine({ env: process.env, settingsEngine: state.transcriptionEngine(), scriptPath: join(resourcesDir, 'transcribe.py'), logger })
  const transcription = createTranscriptionService({
    logger,
    engine,
    read: (id) => store.read(id),
    vocabulary: () => state.dictionary(),
    emit
  })
  const vault: KeyVault = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (enc) => safeStorage.decryptString(Buffer.from(enc, 'base64'))
  }
  const llm = createLlmManager({
    env: process.env,
    getPrefs: () => state.llmPrefs(),
    savePrefs: (patch) => state.updateLlmPrefs(patch),
    vault,
    scratchDir: join(app.getPath('temp'), 'tomada-ia'),
    logger
  })

  /** Depois de cada gravação processada, a transcrição começa sozinha (se estiver ligada e o motor, pronto). */
  const autoStarted = new Set<string>()
  const autoTranscribe = async (folder: string): Promise<void> => {
    if (!state.transcriptionPrefs().auto) return
    try {
      const check = await engine.check()
      if (check.state !== 'ready') {
        emit('record:notice', { kind: 'info', text: 'Gravação salva. A transcrição ainda não foi preparada: prepare nos Ajustes para editar pelo texto.' })
        return
      }
      await transcription.start(folder)
    } catch (err) {
      logger.error(`Não consegui começar a transcrição automática de ${folder}.`, err)
      emit('record:notice', { kind: 'error', text: 'Não consegui começar a transcrição desta gravação', detail: err instanceof Error ? err.message : String(err) })
    }
  }
  const emitRecording = <K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void => {
    emit(channel, payload)
    if (channel === 'process:progress') {
      const snap = payload as ProcessSnapshot
      if (snap.status === 'done' && !autoStarted.has(snap.sessionId)) {
        autoStarted.add(snap.sessionId)
        void autoTranscribe(snap.folder)
      }
    }
  }

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
    emit: emitRecording,
    trash,
    clock,
    now: () => new Date(),
    env: process.env
  })
  // --- Exportação: áudio no ffmpeg, vídeo numa janela escondida, mux e conferência ------------------
  /** Pastas de destino que o usuário escolheu NESTA sessão (diálogo nativo): fora delas e de `exports/`, ninguém grava. */
  const outputDirs = createOutputDirs()
  const exporter = createExportService({
    logger,
    outputDirs,
    read: (id) => store.read(id),
    words: async (id) => (await transcription.getTranscript(id))?.words ?? null,
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

  // Mídias derivadas do editor (forma de onda, áudio da prévia, miniaturas): ffmpeg, uma vez, em segundo plano.
  const derived = createDerivedMedia({
    logger,
    read: (id) => store.read(id),
    ffmpeg: () => {
      const paths = locateFfmpeg(state.ffmpegLocateOptions())
      return paths ? createFfmpeg(paths) : null
    }
  })

  /** Em teste, abrir programa e Explorer de verdade atrapalha a máquina: só anota o pedido. */
  const testCalls = (): { op: string; path: string }[] => {
    const g = globalThis as { __tomadaTestCalls?: { op: string; path: string }[] }
    return (g.__tomadaTestCalls ??= [])
  }

  // Nível do microfone (só de ida) → mini medidor da barra.
  ipcMain.on(LEVEL_CHANNEL, (event, level: unknown) => {
    if (!isAppUrl(event.senderFrame?.url, appUrls)) return
    if (typeof level === 'number' && Number.isFinite(level)) recording.level(level)
  })
  let quitting = false
  app.on('before-quit', () => {
    quitting = true
    void recording.shutdown()
    void exporter.shutdown()
    transcription.shutdown()
    derived.shutdown()
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
      derived,
      transcription,
      llm,
      outputDirs,
      pickExportDir: async (defaultPath) => {
        // TOMADA_TEST_PICK_DIR: nos testes o diálogo do Windows não aparece; vazio = "cancelou"
        const forced = process.env.TOMADA_TEST_PICK_DIR
        if (forced !== undefined) return forced === '' ? null : forced
        const options = {
          title: 'Escolha a pasta da exportação',
          properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
          ...(defaultPath ? { defaultPath } : {})
        }
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : (result.filePaths[0] ?? null)
      },
      pickImage: async () => {
        const forced = process.env.TOMADA_TEST_PICK_IMAGE
        if (forced !== undefined) return forced === '' ? null : forced
        const options = {
          title: 'Escolha a imagem de fundo',
          properties: ['openFile'] as 'openFile'[],
          filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
        }
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : (result.filePaths[0] ?? null)
      },
      openPath: async (path) => {
        if (testMode) {
          testCalls().push({ op: 'open', path })
          return
        }
        const error = await shell.openPath(path)
        if (error) throw new Error(`Não consegui abrir o arquivo: ${error}`)
      },
      revealPath: async (path) => {
        if (testMode) {
          testCalls().push({ op: 'reveal', path })
          return
        }
        shell.showItemInFolder(path)
      },
      copyText: (text) => clipboard.writeText(text),
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
    logger,
    (url) => isAppUrl(url, appUrls)
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
