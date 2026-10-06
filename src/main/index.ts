/**
 * Processo principal do Tomada: janela, protocolo de mídia, IPC, gravação.
 * A lógica mora nos módulos ao lado (testáveis sem Electron); aqui só se liga tudo.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeTheme, Notification, protocol, safeStorage, session, shell, systemPreferences } from 'electron'
import { createAutopilot, type AutopilotService } from './autopilot'
import { resolveProjectFile } from './project-files'
import { createGpuQueue } from './gpu-queue'
import { DEFAULT_AUTOPILOT } from '@shared/autopilot'
import { LEVEL_CHANNEL, type AppInfo, type IpcEvents, type ProcessSnapshot } from '@shared/ipc'
import { createSourceProvider } from './capture-sources'
import { chooseCameraEngine } from './camera/engines'
import { createCameraService } from './camera/service'
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
import { createLipSyncDetector } from './lip-sync'
import { createCameraCalibration } from './camera-calibration'
import { ensureToolsDir } from './transcription/tools-dir'
import { createOutputDirs } from './path-guard'
import { createProjectStore } from './projects'
import { createRecordingService } from './recording-service'
import { createAppState } from './state'
import { createTracker } from './tracker'
import { chooseEngine } from './transcription/engines'
import { createTranscriptionService } from './transcription/service'
import { createAuxWindows } from './windows'
import { e2eWindowOptions, isE2eHidden, keepE2ePainting, revealWindow } from './window-visibility'

// O compositor OSR acelerado deste Electron devolve canvas pretos no screenshot
// do Chromium. O modo software preserva a pintura oculta para os testes.
if (isE2eHidden()) {
  // TOMADA_E2E_GPU=1 (só a medição de velocidade da exportação) deixa a GPU ligada: as capturas de tela dos specs não valem nesse modo.
  if (process.env.TOMADA_E2E_GPU !== '1') app.disableHardwareAcceleration()
  // As janelas sintéticas dos specs usam o mesmo relógio central do app.
  const globals = globalThis as { __tomadaE2eKeepPainting?: typeof keepE2ePainting }
  globals.__tomadaE2eKeepPainting = keepE2ePainting
}

// Testes isolam ajustes e logs do app real. Precisa vir antes de qualquer uso de userData.
if (process.env[ENV_USER_DATA_DIR]) app.setPath('userData', process.env[ENV_USER_DATA_DIR])

// A segunda abertura só devolve o foco; nunca inicializa recuperação/serviços sobre o bruto vivo.
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()

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
  if (process.platform === 'win32') app.setAppUserModelId('com.tomada.desktop')
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
  const icon = join(resourcesDir, process.platform === 'win32' ? 'tomada.ico' : 'tomada.png')

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
      if (testMode || isE2eHidden()) {
        testCalls().push({ op: 'open', path })
        return
      }
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
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    revealWindow(mainWindow, { restore: true, focus: true })
  })
  const emit = <K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }

  // --- Gravação -----------------------------------------------------------------
  const windows = createAuxWindows({
    preload: join(__dirname, '../preload/index.js'),
    rendererUrl,
    rendererFile: join(__dirname, '../renderer/index.html'),
    getMain: () => mainWindow,
    logger, icon, shortcuts: () => state.recordingShortcuts()
  })
  const sources = createSourceProvider({ logger, ownHwnds: () => windows.ownHwnds(), env: process.env })
  sources.installDisplayMediaHandler(session.defaultSession)

  // --- Transcrição e IA ----------------------------------------------------------------------------------
  const syncToolsDir = ensureToolsDir(process.env)
  const lipSync = createLipSyncDetector({ toolsDir: syncToolsDir, scriptPath: join(resourcesDir, 'lip_sync.py'), ffmpeg: () => locateFfmpeg(state.ffmpegLocateOptions())?.ffmpeg ?? null, logger })
  const calibration = createCameraCalibration({ scratchDir: join(syncToolsDir, 'lip-sync', 'calibration'), detector: lipSync, save: (value) => state.saveCameraCalibration(value) })
  const { engine } = chooseEngine({ env: process.env, settingsEngine: state.transcriptionEngine(), scriptPath: join(resourcesDir, 'transcribe.py'), logger })
  const gpu = createGpuQueue()
  const rawTranscription = createTranscriptionService({
    logger,
    engine,
    read: (id) => store.read(id),
    vocabulary: () => state.dictionary(),
    emit
  })
  let transcriptionWork: Promise<void> = Promise.resolve()
  const transcription = {...rawTranscription,
    start: (id:string) => { const task = gpu.start(() => rawTranscription.start(id),() => rawTranscription.idle()); transcriptionWork = task.done.catch(() => undefined); return task.started },
    idle: async () => {await transcriptionWork;await rawTranscription.idle()}
  }
  // --- Análise da câmera (M4c): o rosto, para enquadrar a câmera --------------------------------------------------
  const camera = createCameraService({
    logger,
    engine: chooseCameraEngine({
      env: process.env,
      scriptPath: join(resourcesDir, 'camera_tools.py'),
      logger,
      ffmpeg: () => locateFfmpeg(state.ffmpegLocateOptions())?.ffmpeg ?? null
    }),
    read: (id) => store.read(id),
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
  let autopilot: AutopilotService | null = null
  const processingStarted = new Map<string,number>()
  /** Depois de cada gravação com câmera processada, o rosto é analisado em segundo plano (se o motor está pronto; senão o editor oferece preparar). */
  const autoAnalyzeFace = async (folder: string): Promise<void> => {
    try {
      const ready = (await camera.view()).face.state === 'ready'
      if (ready) await camera.analyze(folder, 'face')
    } catch (err) {
      // projeto sem câmera ou outro motivo: o editor tenta de novo ao abrir e mostra o motivo; aqui só fica no log
      logger.warn(`Não comecei a análise do rosto de ${folder}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const emitRecording = <K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void => {
    emit(channel, payload)
    if (channel === 'process:progress') {
      const snap = payload as ProcessSnapshot
      if (!processingStarted.has(snap.sessionId)) processingStarted.set(snap.sessionId,Date.now())
      if (snap.status === 'done' && !autoStarted.has(snap.sessionId)) {
        autoStarted.add(snap.sessionId)
        // o rosto entra na fila da câmera ANTES do piloto: as exportações dele esperam essa fila terminar
        void autoAnalyzeFace(snap.folder)
        void autopilot?.start(snap.folder,processingStarted.get(snap.sessionId))
      }
    }
  }

  const clock = (): number => performance.timeOrigin + performance.now()
  const recording = createRecordingService({
    logger,
    lipSync,
    calibrations: () => state.settings().cameraCalibrations ?? [],
    editingDefaults: () => state.settings(),
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
  const rawExporter = createExportService({
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

  let exportWork: Promise<void> = Promise.resolve()
  const exporter = {...rawExporter,
    start: (request: Parameters<typeof rawExporter.start>[0]) => { const task = gpu.start(() => rawExporter.start(request),() => rawExporter.idle()); exportWork = task.done.catch(() => undefined); return task.started },
    idle: async () => {await exportWork;await rawExporter.idle()}
  }
  // Mídias derivadas do editor (forma de onda, áudio da prévia, miniaturas): ffmpeg, uma vez, em segundo plano.
  const derived = createDerivedMedia({
    logger,
    read: (id) => store.read(id),
    ffmpeg: () => {
      const paths = locateFfmpeg(state.ffmpegLocateOptions())
      return paths ? createFfmpeg(paths) : null
    }
  })

  autopilot = createAutopilot({
    store, transcription, derived, exporter, llm, logger, camera,
    vocabulary: () => state.dictionary(),
    prefs: () => {
      const settings = state.settings()
      return { ...DEFAULT_AUTOPILOT, ...settings.autopilot,
        ...(settings.ownerCaptionsHorizontal ? {captionsHorizontal:settings.ownerCaptionsHorizontal.enabled} : {}),
        ...(settings.ownerCaptionsVertical ? {captionsVertical:settings.ownerCaptionsVertical.enabled} : {}),
        steps:{...(settings.transcription?.auto === undefined ? {} : {transcribe:settings.transcription.auto}),...(settings.transcription?.autoClean === undefined ? {} : {clean:settings.transcription.autoClean}),...settings.autopilot?.steps}
      }
    },
    ownerStyle: () => state.settings().ownerStyle,
    ownerEditingDefaults: () => state.settings(),
    ownerBackground: async () => { const asset = state.settings().ownerStyleAsset; return asset ? resolveProjectFile(userData,asset) : undefined },
    emit: (snapshot) => emit('autopilot:progress',snapshot),
    ready: (id,clips,youtube) => {
      emit('autopilot:ready',{ projectId: id })
      if (Notification.isSupported()) {
        const notification = new Notification({ title: 'Tomada', body: youtube ? `Pronto: 1 vídeo + ${clips} cortes` : `Preparação concluída: ${clips} cortes prontos. Confira a Revisão.` })
        notification.on('click',() => { if (mainWindow) revealWindow(mainWindow, { focus: true }); emit('autopilot:ready',{ projectId: id }) })
        if (!testMode && !isE2eHidden()) notification.show()
      }
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
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    autopilot?.shutdown()
    transcription.shutdown()
    camera.shutdown()
    derived.shutdown()
    windows.closeAll()
    void Promise.allSettled([recording.shutdown(), exporter.shutdown()]).then(results => {
      for (const result of results) if (result.status === 'rejected') logger.warn('Falha ao encerrar e preservar o trabalho no disco.', result.reason)
      app.quit()
    })
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
      camera,
      llm,
      calibration,
      autopilot,
      outputDirs,
      diagnostics: {
        gpuInfo: async () => {
          const info = await app.getGPUInfo('complete') as { gpuDevice?: { deviceString?: string }[] }
          return { devices: info.gpuDevice?.map((d) => d.deviceString ?? '').filter(Boolean) ?? [], hardwareAcceleration: app.getGPUFeatureStatus().video_encode === 'enabled' }
        },
        mediaAccess: () => {
          const status = (kind: 'camera' | 'microphone'): 'granted' | 'denied' | 'unknown' => {
            const value = systemPreferences.getMediaAccessStatus(kind)
            return value === 'granted' ? 'granted' : value === 'denied' || value === 'restricted' ? 'denied' : 'unknown'
          }
          return { camera: status('camera'), microphone: status('microphone') }
        },
        checkShortcuts: async (prefs) => {
          if (recording.recording) throw new Error('Pare a gravação antes de mudar os atalhos.')
          const registered: string[] = []
          try {
            for (const key of Object.values(prefs)) {
              if (globalShortcut.isRegistered(key) || !globalShortcut.register(key, () => undefined)) throw new Error(`O atalho ${key} já está em uso por outro programa. Escolha outra combinação.`)
              registered.push(key)
            }
          } finally { registered.forEach((key) => globalShortcut.unregister(key)) }
        }
      },
      pickExportDir: async (defaultPath) => {
        // TOMADA_TEST_PICK_DIR: nos testes o diálogo do Windows não aparece; vazio = "cancelou"
        const forced = process.env.TOMADA_TEST_PICK_DIR
        if (forced !== undefined) return forced === '' ? null : forced
        if (isE2eHidden()) return null
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
        if (isE2eHidden()) return null
        const options = {
          title: 'Escolha a imagem de fundo',
          properties: ['openFile'] as 'openFile'[],
          filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
        }
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : (result.filePaths[0] ?? null)
      },
      openPath: async (path) => {
        if (testMode || isE2eHidden()) {
          testCalls().push({ op: 'open', path })
          return
        }
        const error = await shell.openPath(path)
        if (error) throw new Error(`Não consegui abrir o arquivo: ${error}`)
      },
      revealPath: async (path) => {
        if (testMode || isE2eHidden()) {
          testCalls().push({ op: 'reveal', path })
          return
        }
        shell.showItemInFolder(path)
      },
      copyText: (text) => clipboard.writeText(text),
      finishCountdown: (completed) => windows.finishCountdown(completed),
      clock,
      pickFolder: async (defaultPath) => {
        if (isE2eHidden()) return null
        const options = {
          title: 'Escolha a pasta dos projetos',
          properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
          ...(defaultPath ? { defaultPath } : {})
        }
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
        return result.canceled ? null : (result.filePaths[0] ?? null)
      },
      pickFfmpeg: async () => {
        if (isE2eHidden()) return null
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
    const win = new BrowserWindow(e2eWindowOptions({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      show: false,
      title: 'Tomada',
      icon,
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
    }))
    keepE2ePainting(win)
    win.once('ready-to-show', () => revealWindow(win))
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
    if (process.env.TOMADA_DEVTOOLS === '1' && !isE2eHidden()) win.webContents.openDevTools({ mode: 'detach' })
    return win
  }

  mainWindow = createWindow()
  mainWindow.webContents.once('did-finish-load',() => {
    void (async () => { await recording.recover(); await autopilot?.resume() })()
      .catch((err) => logger.error('Não consegui retomar o processamento e o piloto automático.',err))
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
  app.on('window-all-closed', () => app.quit())
}

if (primaryInstance) main().catch((err) => {
  // Falha na partida: aparece para o usuário, não fica só no console.
  console.error(err)
  if (!isE2eHidden()) dialog.showErrorBox('O Tomada não conseguiu iniciar', err instanceof Error ? (err.stack ?? err.message) : String(err))
  app.exit(1)
})
