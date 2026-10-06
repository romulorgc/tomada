import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import { createExporterWindowFactory } from '../../src/main/export-window'
import { createAuxWindows } from '../../src/main/windows'
import { createMemoryLogger } from '../../src/main/logger'

const opened = vi.hoisted(() => ({ windows: [] as { options: Record<string, unknown>; events: EventEmitter; contents: EventEmitter; revealed: string[]; protection: boolean[]; invalidations: () => number }[] }))
vi.mock('electron', () => ({
  BrowserWindow: class extends EventEmitter {
    invalidations = 0
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, send() {}, isOffscreen: () => Boolean((this.options.webPreferences as { offscreen?: boolean }).offscreen), invalidate: () => { this.invalidations++ } })
    revealed: string[] = []
    protection: boolean[] = []
    constructor(readonly options: Record<string, unknown>) { super(); opened.windows.push({ options, events: this, contents: this.webContents, revealed: this.revealed, protection: this.protection, invalidations: () => this.invalidations }) }
    show() { this.revealed.push('show') }
    showInactive() { this.revealed.push('showInactive') }
    focus() { this.revealed.push('focus') }
    setAlwaysOnTop() {}
    setContentProtection(value: boolean) { this.protection.push(value) }
    setPosition() {}
    getSize() { return [600, 64] }
    loadFile() { return Promise.resolve() }
    isDestroyed() { return false }
  },
  globalShortcut: { register: () => true, unregister() {} },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }
}))

const originalHidden = process.env.TOMADA_E2E_HIDDEN
const barState = { status: 'recording', elapsedMs: 0, asOf: 0, hasMic: true, hasCamera: true, shortcutStop: 'Control+Shift+R', shortcutPause: 'Control+Shift+P' } as const
afterEach(() => {
  for (const win of opened.windows) win.events.emit('closed')
  opened.windows.length = 0
  vi.useRealTimers()
  if (originalHidden === undefined) delete process.env.TOMADA_E2E_HIDDEN
  else process.env.TOMADA_E2E_HIDDEN = originalHidden
})

test('a exportação oculta nasce pintando sem ícone na barra de tarefas', () => {
  process.env.TOMADA_E2E_HIDDEN = '1'
  createExporterWindowFactory({ preload: 'preload.js', rendererFile: 'index.html', rendererUrl: undefined, logger: createMemoryLogger() })('export-id', { onGone() {} })
  expect(opened.windows[0]!.options).toMatchObject({ show: false, skipTaskbar: true, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false, offscreen: true } })
})

test('a barra oculta continua recebendo o estado sem pedir exibição após carregar', () => {
  process.env.TOMADA_E2E_HIDDEN = '1'
  const aux = createAuxWindows({ preload: 'preload.js', rendererFile: 'index.html', rendererUrl: undefined, getMain: () => null, logger: createMemoryLogger() })
  aux.showBar(barState, null)
  const bar = opened.windows[0]!
  bar.contents.emit('did-finish-load')
  expect(bar.options).toMatchObject({ show: false, skipTaskbar: true, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false, offscreen: true } })
  expect(bar.revealed).toEqual([])
  expect(bar.protection).toEqual([true])
})

test('o relógio de pintura oculto continua ativo com página estática e para ao fechar', () => {
  vi.useFakeTimers()
  process.env.TOMADA_E2E_HIDDEN = '1'
  const aux = createAuxWindows({ preload: 'preload.js', rendererFile: 'index.html', rendererUrl: undefined, getMain: () => null, logger: createMemoryLogger() })
  aux.showBar(barState, null)
  const bar = opened.windows[0]!
  vi.advanceTimersByTime(110)
  expect(bar.invalidations()).toBeGreaterThan(0)
  const painted = bar.invalidations()
  bar.events.emit('closed')
  vi.advanceTimersByTime(300)
  expect(bar.invalidations()).toBe(painted)
})

test('o modo normal conserva a exibição da barra depois de carregar', () => {
  delete process.env.TOMADA_E2E_HIDDEN
  const aux = createAuxWindows({ preload: 'preload.js', rendererFile: 'index.html', rendererUrl: undefined, getMain: () => null, logger: createMemoryLogger() })
  aux.showBar(barState, null)
  opened.windows[0]!.contents.emit('did-finish-load')
  expect(opened.windows[0]!.revealed).toEqual(['showInactive'])
  expect(opened.windows[0]!.protection).toEqual([true])
})
