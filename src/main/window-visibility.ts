import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'

/** Só o runner e2e define isto; captura/prova reais e o app normal continuam visíveis. */
export const isE2eHidden = (): boolean => process.env.TOMADA_E2E_HIDDEN === '1'

/** Aplicado ANTES do construtor: ocultar depois da criação permitiria um flash na tela. */
export function e2eWindowOptions(options: BrowserWindowConstructorOptions): BrowserWindowConstructorOptions {
  if (!isE2eHidden()) return options
  return {
    ...options,
    show: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    // No Windows, uma janela nativa que nunca foi mostrada suspende BeginFrame
    // mesmo sem throttling. Offscreen mantém o compositor/rAF sem exibir HWND.
    webPreferences: { ...options.webPreferences, backgroundThrottling: false, offscreen: true }
  }
}

/** OSR software para de pedir frames em páginas estáticas; o relógio mantém rAF ativo. */
export function keepE2ePainting(win: BrowserWindow): void {
  if (!isE2eHidden() || !win.webContents.isOffscreen()) return
  const timer = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(timer); return }
    win.webContents.invalidate()
  }, Math.ceil(1000 / 30))
  timer.unref()
  const stop = (): void => clearInterval(timer)
  win.once('closed', stop)
  win.webContents.once('destroyed', stop)
}

/** Todos os caminhos de exibição passam por esta guarda, inclusive depois da gravação. */
export function revealWindow(win: BrowserWindow, options: { inactive?: boolean; focus?: boolean; restore?: boolean } = {}): void {
  if (isE2eHidden()) return
  if (options.restore && win.isMinimized()) win.restore()
  if (options.inactive) win.showInactive()
  else win.show()
  if (options.focus) win.focus()
}
