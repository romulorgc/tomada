/**
 * Janelas auxiliares da gravação (barra flutuante, contagem 3-2-1, bolha da câmera) e
 * atalhos globais. Depende do Electron. As três janelas são EXCLUÍDAS da captura
 * (`setContentProtection(true)` = `WDA_EXCLUDEFROMCAPTURE`), ficam sempre no topo e não
 * roubam o foco do programa que está sendo gravado.
 */
import { BrowserWindow, globalShortcut, screen } from 'electron'
import type { BarState, BubbleConfig, CountdownConfig } from '@shared/ipc'
import type { Rect } from '@shared/types'
import type { Logger } from './logger'
import type { RecordingWindows } from './recording-service'
import type { TeleprompterAction, TeleprompterState } from '@shared/script'
import { DEFAULT_RECORDING_SHORTCUTS, type RecordingShortcuts } from '@shared/shortcuts-config'
import { e2eWindowOptions, isE2eHidden, keepE2ePainting, revealWindow } from './window-visibility'

export type AuxWindowsDeps = {
  /** Caminho do preload compilado. */
  preload: string
  /** URL do servidor de desenvolvimento (vazio em produção). */
  rendererUrl: string | undefined
  /** Caminho do index.html compilado. */
  rendererFile: string
  getMain(): BrowserWindow | null
  logger: Logger
  icon?: string
  shortcuts?(): RecordingShortcuts
}

export type AuxWindows = RecordingWindows & {
  /** A janela de contagem avisa que terminou (ou foi cancelada). */
  finishCountdown(completed: boolean): void
  /** HWNDs de todas as janelas do Tomada. */
  ownHwnds(): Set<number>
  /** A janela da barra, se estiver aberta (para testes e para repassar o nível). */
  barWindow(): BrowserWindow | null
  closeAll(): void
}

const BAR_SIZE = { w: 600, h: 64 }
const BUBBLE_SIZE = { w: 248, h: 248 }
const MARGIN = 28

const hwndOf = (win: BrowserWindow): number => {
  const b = win.getNativeWindowHandle()
  return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0)
}

export function createAuxWindows(deps: AuxWindowsDeps): AuxWindows {
  const { logger } = deps
  let bar: BrowserWindow | null = null
  let bubble: BrowserWindow | null = null
  let countdownWin: BrowserWindow | null = null
  let countdownDone: ((completed: boolean) => void) | null = null
  let prompter: BrowserWindow | null = null
  let retakeKey: string | null = null
  let recordingKeys: string[] = []
  const prompterKeys = ['Control+Alt+Space', 'Control+Alt+Right', 'Control+Alt+Left']

  const webPreferences = {
    preload: deps.preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    backgroundThrottling: false
  }

  const load = (win: BrowserWindow, hash: string): void => {
    if (deps.rendererUrl) void win.loadURL(`${deps.rendererUrl}#${hash}`)
    else void win.loadFile(deps.rendererFile, { hash })
  }

  const overlayDefaults = e2eWindowOptions({
    ...(deps.icon ? { icon: deps.icon } : {}),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences
  })

  /** Fora da captura e acima de tudo (inclusive de jogos em tela cheia). */
  const hardenOverlay = (win: BrowserWindow): void => {
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setContentProtection(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }

  const placeBottomCenter = (win: BrowserWindow, display: Rect | null): void => {
    const d = display ?? (() => {
      const b = screen.getPrimaryDisplay().workArea
      return { x: b.x, y: b.y, w: b.width, h: b.height }
    })()
    const [w, h] = win.getSize() as [number, number]
    win.setPosition(Math.round(d.x + (d.w - w) / 2), Math.round(d.y + d.h - h - MARGIN * 2))
  }

  const destroy = (win: BrowserWindow | null): void => {
    if (win && !win.isDestroyed()) win.destroy()
  }

  const api: AuxWindows = {
    setMainMinimized(minimized) {
      if (isE2eHidden()) return
      const main = deps.getMain()
      if (!main || main.isDestroyed()) return
      if (minimized) main.minimize()
      else {
        revealWindow(main, { restore: true, focus: true })
      }
    },

    countdown(display: Rect, _config: CountdownConfig) {
      return new Promise<boolean>((resolve) => {
        destroy(countdownWin)
        const win = new BrowserWindow({
          ...overlayDefaults,
          x: display.x,
          y: display.y,
          width: display.w,
          height: display.h
        })
        countdownWin = win
        keepE2ePainting(win)
        hardenOverlay(win)
        win.setIgnoreMouseEvents(true)
        win.setBounds({ x: display.x, y: display.y, width: display.w, height: display.h })
        let finished = false
        const done = (completed: boolean): void => {
          if (finished) return
          finished = true
          countdownDone = null
          try {
            globalShortcut.unregister('Escape')
          } catch {
            // nada a fazer
          }
          // dá um respiro para a janela sumir antes do primeiro quadro gravado
          setTimeout(() => destroy(win), 60)
          countdownWin = null
          resolve(completed)
        }
        countdownDone = done
        // Esc cancela sem precisar de foco (a contagem não pode roubar o foco do que será gravado).
        if (!globalShortcut.register('Escape', () => done(false))) logger.warn('Não consegui registrar o Esc para cancelar a contagem.')
        win.on('closed', () => done(false))
        win.webContents.once('did-finish-load', () => revealWindow(win, { inactive: true }))
        win.webContents.on('did-fail-load', (_e, code, description) => {
          logger.error(`A contagem não carregou (${code}: ${description}).`)
          done(false)
        })
        load(win, 'countdown')
      })
    },

    showBar(state: BarState, display: Rect | null) {
      destroy(bar)
      const win = new BrowserWindow({ ...overlayDefaults, width: BAR_SIZE.w, height: BAR_SIZE.h })
      bar = win
      keepE2ePainting(win)
      hardenOverlay(win)
      placeBottomCenter(win, display)
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('bar:state', state)
        revealWindow(win, { inactive: true })
      })
      win.on('closed', () => {
        if (bar === win) bar = null
      })
      load(win, 'bar')
    },

    updateBar(state: BarState) {
      if (bar && !bar.isDestroyed()) bar.webContents.send('bar:state', state)
    },

    barLevel(level: number) {
      if (bar && !bar.isDestroyed()) bar.webContents.send('bar:level', { level })
    },

    hideBar() {
      destroy(bar)
      bar = null
    },

    showBubble(_config: BubbleConfig, display: Rect | null) {
      destroy(bubble)
      const win = new BrowserWindow({ ...overlayDefaults, width: BUBBLE_SIZE.w, height: BUBBLE_SIZE.h })
      bubble = win
      keepE2ePainting(win)
      hardenOverlay(win)
      const d = display ?? (() => {
        const b = screen.getPrimaryDisplay().workArea
        return { x: b.x, y: b.y, w: b.width, h: b.height }
      })()
      win.setPosition(Math.round(d.x + MARGIN), Math.round(d.y + d.h - BUBBLE_SIZE.h - MARGIN * 2))
      win.webContents.once('did-finish-load', () => revealWindow(win, { inactive: true }))
      win.on('closed', () => {
        if (bubble === win) bubble = null
      })
      load(win, 'bubble')
    },

    hideBubble() {
      destroy(bubble)
      bubble = null
    },

    showTeleprompter(state: TeleprompterState, display: Rect | null) {
      api.hideTeleprompter?.()
      const d = display ?? (() => { const b = screen.getPrimaryDisplay().workArea; return { x: b.x, y: b.y, w: b.width, h: b.height } })()
      const width = Math.min(760, d.w - 32)
      const win = new BrowserWindow({ ...overlayDefaults, width, height: 300 })
      prompter = win
      keepE2ePainting(win)
      hardenOverlay(win)
      win.setPosition(Math.round(d.x + (d.w - width) / 2), Math.round(d.y + 16))
      win.webContents.once('did-finish-load', () => { win.webContents.send('teleprompter:state', state); revealWindow(win, { inactive: true }) })
      win.on('closed', () => {
        if (prompter === win) {
          prompter = null
          for (const key of prompterKeys) globalShortcut.unregister(key)
        }
      })
      const actions: TeleprompterAction[] = ['pause', 'next', 'previous']
      prompterKeys.forEach((key, i) => {
        if (!globalShortcut.register(key, () => { if (!win.isDestroyed()) win.webContents.send('teleprompter:command', actions[i]) })) logger.warn(`Atalho do teleprompter não disponível: ${key}. Use os botões na janela.`)
      })
      load(win, 'teleprompter')
    },

    updateTeleprompter(state: TeleprompterState) {
      if (prompter && !prompter.isDestroyed()) prompter.webContents.send('teleprompter:state', state)
    },

    hideTeleprompter() {
      destroy(prompter)
      prompter = null
      for (const key of prompterKeys) globalShortcut.unregister(key)
    },

    registerHotkeys(handlers) {
      const prefs = deps.shortcuts?.() ?? DEFAULT_RECORDING_SHORTCUTS
      const stop = prefs.recordStop
      const pause = prefs.pause
      recordingKeys = [stop, pause]
      let ok = true
      try {
        ok = globalShortcut.register(stop, handlers.stop) && ok
        ok = globalShortcut.register(pause, handlers.pause) && ok
        if (handlers.retake) {
          retakeKey = (handlers.retakeShortcut ?? 'Ctrl+Alt+Z').replace('Ctrl+', 'Control+')
          ok = globalShortcut.register(retakeKey, handlers.retake) && ok
        }
      } catch (err) {
        logger.error('Falha ao registrar os atalhos globais.', err)
        ok = false
      }
      if (!ok) logger.warn('Algum atalho global não foi registrado (já em uso por outro programa?).')
      return { stop, pause, ok }
    },

    unregisterHotkeys() {
      for (const key of [...recordingKeys, ...(retakeKey ? [retakeKey] : [])]) {
        try {
          globalShortcut.unregister(key)
        } catch {
          // já estava solto
        }
      }
      retakeKey = null
      recordingKeys = []
    },

    finishCountdown(completed) {
      countdownDone?.(completed)
    },

    ownHwnds() {
      const out = new Set<number>()
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) out.add(hwndOf(w))
      return out
    },

    barWindow: () => (bar && !bar.isDestroyed() ? bar : null),

    closeAll() {
      destroy(bar)
      destroy(bubble)
      destroy(countdownWin)
      api.hideTeleprompter?.()
      bar = bubble = countdownWin = null
      api.unregisterHotkeys()
    }
  }
  return api
}
