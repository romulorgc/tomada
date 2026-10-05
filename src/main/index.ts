/**
 * Processo principal do Tomada: janela, protocolo de mídia, IPC.
 * A lógica mora nos módulos ao lado (testáveis sem Electron); aqui só se liga tudo.
 */
import { join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, nativeTheme, protocol, session, shell } from 'electron'
import type { AppInfo } from '@shared/ipc'
import { createHandlers } from './handlers'
import { registerIpc } from './ipc'
import { createLogger } from './logger'
import { handleMediaRequest, MEDIA_SCHEME } from './media-protocol'
import { ENV_USER_DATA_DIR, logsDir, settingsFile } from './paths'
import { createProjectStore } from './projects'
import { createAppState } from './state'

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
  const store = createProjectStore({
    root: () => state.projectsRoot(),
    logger,
    trash: (path) => shell.trashItem(path),
    openFolder: async (path) => {
      const error = await shell.openPath(path)
      if (error) throw new Error(`Não consegui abrir a pasta: ${error}`)
    }
  })

  // Protocolo de mídia (com Range), restrito à raiz dos projetos.
  protocol.handle(MEDIA_SCHEME, (request) => handleMediaRequest(request, state.projectsRoot()))

  // Nada de câmera/microfone/etc. até a M1b pedir (e então só o que ela precisar).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

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
  registerIpc(
    createHandlers({
      info,
      state,
      store,
      logger,
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
        autoplayPolicy: 'no-user-gesture-required'
      }
    })
    win.once('ready-to-show', () => win.show())
    win.webContents.on('did-fail-load', (_e, code, description, url) =>
      logger.error(`A interface não carregou (${code}: ${description}) em ${url}`)
    )
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
