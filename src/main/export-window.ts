/**
 * A janela ESCONDIDA da exportação (depende do Electron). Roda num processo de renderização
 * próprio, separado da interface: o vídeo é decodificado, desenhado e codificado ali, e a
 * interface continua fluida. Carrega o mesmo bundle da interface com `#export:<exportId>`.
 */
import { BrowserWindow } from 'electron'
import type { ExporterWindow } from './export-service'
import type { Logger } from './logger'

export type ExporterWindowDeps = {
  preload: string
  rendererUrl: string | undefined
  rendererFile: string
  logger: Logger
}

export function createExporterWindowFactory(deps: ExporterWindowDeps) {
  return (exportId: string, hooks: { onGone(reason: string): void }): ExporterWindow => {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      skipTaskbar: true,
      webPreferences: {
        preload: deps.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        // sem isto o Chromium freia timers de página oculta e a exportação rasteja
        backgroundThrottling: false
      }
    })
    const hash = `export:${exportId}`
    let intentional = false
    win.webContents.on('render-process-gone', (_e, details) => hooks.onGone(`o processo caiu: ${details.reason}`))
    win.webContents.on('did-fail-load', (_e, code, description) => hooks.onGone(`não carregou: ${code} ${description}`))
    win.webContents.on('console-message', (event) => {
      const e = event as unknown as { level?: string | number; message?: string }
      if (e.level === 'error' || e.level === 3) deps.logger.error(`[exportação] ${e.message ?? ''}`)
    })
    win.on('closed', () => {
      if (!intentional) hooks.onGone('a janela foi fechada')
    })
    if (deps.rendererUrl) void win.loadURL(`${deps.rendererUrl}#${hash}`)
    else void win.loadFile(deps.rendererFile, { hash })
    return {
      destroy() {
        intentional = true
        if (!win.isDestroyed()) win.destroy()
      }
    }
  }
}
