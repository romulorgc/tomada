/**
 * Acesso ao Win32 por FFI (koffi, sem compilar nada): cursor, botões, teclado, janelas e
 * monitores. Tudo em PIXELS FÍSICOS (o processo precisa ser "per-monitor DPI aware": o
 * Electron já é; um Node comum, nos testes, chama `ensureDpiAware`).
 *
 * Roda no worker do rastreador e também na thread principal (testes, leitura de monitores).
 * Não importa `electron`.
 */
import koffi from 'koffi'
import type { MonitorRect } from '@shared/recording'
import type { Point, Rect } from '@shared/types'

const DWMWA_EXTENDED_FRAME_BOUNDS = 9
const VK_LBUTTON = 0x01
const VK_RBUTTON = 0x02
const VK_MBUTTON = 0x04
const SM_SWAPBUTTON = 23
const MONITORINFOF_PRIMARY = 1

/**
 * Teclas que contam como "houve digitação": 0x08..0xFE menos mouse, modificadores
 * (Shift/Ctrl/Alt/Win, CapsLock, NumLock, ScrollLock): atalhos como Ctrl+Shift+R não
 * podem virar "digitação".
 */
export const TYPING_VKS: readonly number[] = (() => {
  const skip = new Set<number>([0x10, 0x11, 0x12, 0x14, 0x5b, 0x5c, 0x90, 0x91, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5])
  const out: number[] = []
  for (let vk = 0x08; vk <= 0xfe; vk++) if (!skip.has(vk)) out.push(vk)
  return out
})()

export interface Win32 {
  getCursorPos(): Point
  /** Botão físico apertado agora? (`swapped`: o usuário trocou os botões do mouse.) */
  mouseButtons(): { left: boolean; right: boolean; middle: boolean }
  keyDown(vk: number): boolean
  isWindow(hwnd: number): boolean
  isIconic(hwnd: number): boolean
  /** `DWMWA_EXTENDED_FRAME_BOUNDS`: a moldura visível da janela (com barra de título). */
  frameRect(hwnd: number): Rect | null
  /** Área de cliente em coordenadas de tela. */
  clientRect(hwnd: number): Rect | null
  foregroundWindow(): number
  /** Lista de monitores (retângulo físico + se é o principal). */
  monitors(): MonitorRect[]
  /** SM_SWAPBUTTON: a interface trocou esquerdo e direito. */
  swappedButtons(): boolean
  /** Pede resolução de timer de 1 ms (sem isso o `Atomics.wait` dorme 15,6 ms). */
  beginHighResTimer(): void
  endHighResTimer(): void
  ensureDpiAware(): boolean
  setCursorPos(x: number, y: number): boolean
  virtualScreen(): Rect
}

let cached: Win32 | null = null

export function loadWin32(): Win32 {
  if (cached) return cached
  if (process.platform !== 'win32') throw new Error('O rastreador do cursor só existe no Windows (por enquanto).')

  const user32 = koffi.load('user32.dll')
  const dwmapi = koffi.load('dwmapi.dll')
  const winmm = koffi.load('winmm.dll')

  koffi.struct('POINT', { x: 'long', y: 'long' })
  const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const MONITORINFO = koffi.struct('MONITORINFO', {
    cbSize: 'uint32',
    rcMonitor: RECT,
    rcWork: RECT,
    dwFlags: 'uint32'
  })

  const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT *p)')
  const SetCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)')
  const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vk)')
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)')
  const IsWindow = user32.func('int __stdcall IsWindow(intptr_t hwnd)')
  const IsIconic = user32.func('int __stdcall IsIconic(intptr_t hwnd)')
  const GetClientRect = user32.func('int __stdcall GetClientRect(intptr_t hwnd, _Out_ RECT *r)')
  const ClientToScreen = user32.func('int __stdcall ClientToScreen(intptr_t hwnd, _Inout_ POINT *p)')
  const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()')
  const DwmGetWindowAttribute = dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, _Out_ RECT *out, uint32 size)')
  const timeBeginPeriod = winmm.func('uint32 __stdcall timeBeginPeriod(uint32 ms)')
  const timeEndPeriod = winmm.func('uint32 __stdcall timeEndPeriod(uint32 ms)')
  const GetMonitorInfoW = user32.func('int __stdcall GetMonitorInfoW(intptr_t hmonitor, _Inout_ MONITORINFO *info)')
  const MonitorEnumProc = koffi.proto('int __stdcall MonitorEnumProc(intptr_t hmonitor, intptr_t hdc, void *rc, intptr_t lparam)')
  const EnumDisplayMonitors = user32.func('int __stdcall EnumDisplayMonitors(intptr_t hdc, void *clip, MonitorEnumProc *cb, intptr_t lparam)')

  let dpiAware: boolean | null = null
  const ensureDpiAware = (): boolean => {
    if (dpiAware !== null) return dpiAware
    if (process.versions.electron) {
      dpiAware = true // o Electron já declara per-monitor v2 no manifesto
      return true
    }
    try {
      const SetProcessDpiAwarenessContext = user32.func('int __stdcall SetProcessDpiAwarenessContext(intptr_t ctx)')
      dpiAware = SetProcessDpiAwarenessContext(-4) !== 0 // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    } catch {
      dpiAware = false
    }
    return dpiAware
  }

  const toRect = (r: { left: number; top: number; right: number; bottom: number }): Rect => ({
    x: r.left,
    y: r.top,
    w: r.right - r.left,
    h: r.bottom - r.top
  })

  const swapped = (): boolean => GetSystemMetrics(SM_SWAPBUTTON) !== 0

  cached = {
    getCursorPos(): Point {
      const p = { x: 0, y: 0 }
      GetCursorPos(p)
      return { x: p.x, y: p.y }
    },
    mouseButtons() {
      // GetAsyncKeyState lê os botões FÍSICOS; com os botões trocados, o "esquerdo" lógico é o físico direito.
      const physicalLeft = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0
      const physicalRight = (GetAsyncKeyState(VK_RBUTTON) & 0x8000) !== 0
      const middle = (GetAsyncKeyState(VK_MBUTTON) & 0x8000) !== 0
      return swapped() ? { left: physicalRight, right: physicalLeft, middle } : { left: physicalLeft, right: physicalRight, middle }
    },
    keyDown: (vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0,
    isWindow: (hwnd) => IsWindow(hwnd) !== 0,
    isIconic: (hwnd) => IsIconic(hwnd) !== 0,
    frameRect(hwnd) {
      const r = { left: 0, top: 0, right: 0, bottom: 0 }
      return DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) === 0 ? toRect(r) : null
    },
    clientRect(hwnd) {
      const c = { left: 0, top: 0, right: 0, bottom: 0 }
      if (!GetClientRect(hwnd, c)) return null
      const origin = { x: 0, y: 0 }
      if (!ClientToScreen(hwnd, origin)) return null
      return { x: origin.x, y: origin.y, w: c.right - c.left, h: c.bottom - c.top }
    },
    foregroundWindow: () => Number(GetForegroundWindow()),
    monitors() {
      const out: MonitorRect[] = []
      const handles: number[] = []
      const cb = koffi.register((hmonitor: number) => {
        handles.push(Number(hmonitor))
        return 1
      }, koffi.pointer(MonitorEnumProc))
      try {
        EnumDisplayMonitors(0, null, cb, 0)
      } finally {
        koffi.unregister(cb)
      }
      for (const h of handles) {
        const info = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 }, rcWork: { left: 0, top: 0, right: 0, bottom: 0 }, dwFlags: 0 }
        if (GetMonitorInfoW(h, info)) out.push({ rect: toRect(info.rcMonitor), primary: (info.dwFlags & MONITORINFOF_PRIMARY) !== 0 })
      }
      return out
    },
    swappedButtons: swapped,
    beginHighResTimer() {
      timeBeginPeriod(1)
    },
    endHighResTimer() {
      timeEndPeriod(1)
    },
    ensureDpiAware,
    setCursorPos: (x, y) => SetCursorPos(x, y) !== 0,
    virtualScreen() {
      // SM_XVIRTUALSCREEN=76, SM_YVIRTUALSCREEN=77, SM_CXVIRTUALSCREEN=78, SM_CYVIRTUALSCREEN=79
      return { x: GetSystemMetrics(76), y: GetSystemMetrics(77), w: GetSystemMetrics(78), h: GetSystemMetrics(79) }
    }
  }
  return cached
}
