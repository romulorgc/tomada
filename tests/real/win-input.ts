/**
 * Entrada REAL do Windows para a captura real: move o mouse com `SendInput` em trajetórias
 * suaves e clica de verdade. Regra de segurança: antes de CADA clique confere que a janela
 * em primeiro plano é a janela de teste e que o ponto está dentro dela; se não for, NÃO clica.
 * Tudo em pixels FÍSICOS (o processo se declara per-monitor DPI aware antes de tudo).
 */
import koffi from 'koffi'

const user32 = koffi.load('user32.dll')

const SetProcessDpiAwarenessContext = user32.func('int __stdcall SetProcessDpiAwarenessContext(intptr_t ctx)')
const dpiOk = SetProcessDpiAwarenessContext(-4) !== 0 // PER_MONITOR_AWARE_V2

koffi.struct('POINT', { x: 'long', y: 'long' })
koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'long',
  dy: 'long',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t'
})
const INPUT = koffi.struct('INPUT', { type: 'uint32', mi: MOUSEINPUT })

const SendInput = user32.func('uint32 __stdcall SendInput(uint32 n, INPUT *inputs, int size)')
const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT *p)')
const SetCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)')
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()')
const WindowFromPoint = user32.func('intptr_t __stdcall WindowFromPoint(POINT pt)')
const GetAncestor = user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32 flags)')
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)')
const GetClientRect = user32.func('int __stdcall GetClientRect(intptr_t hwnd, _Out_ RECT *r)')
const ClientToScreen = user32.func('int __stdcall ClientToScreen(intptr_t hwnd, _Inout_ POINT *p)')
const IsWindow = user32.func('int __stdcall IsWindow(intptr_t hwnd)')
koffi.struct('MONITORINFO', { cbSize: 'uint32', rcMonitor: 'RECT', rcWork: 'RECT', dwFlags: 'uint32' })
const MonitorFromWindow = user32.func('intptr_t __stdcall MonitorFromWindow(intptr_t hwnd, uint32 flags)')
const MonitorFromPoint = user32.func('intptr_t __stdcall MonitorFromPoint(POINT pt, uint32 flags)')
const DwmGetWindowAttribute = koffi.load('dwmapi.dll').func('long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, _Out_ RECT *out, uint32 size)')
const GetMonitorInfoW = user32.func('int __stdcall GetMonitorInfoW(intptr_t hmonitor, _Inout_ MONITORINFO *info)')

const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_ABSOLUTE = 0x8000
const MOUSEEVENTF_VIRTUALDESK = 0x4000
const GA_ROOT = 2

export type Pt = { x: number; y: number }
export type Rect = { x: number; y: number; w: number; h: number }

export const dpiAware = dpiOk
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function cursorPos(): Pt {
  const p = { x: 0, y: 0 }
  GetCursorPos(p)
  return { x: p.x, y: p.y }
}

export function virtualScreen(): Rect {
  return { x: GetSystemMetrics(76), y: GetSystemMetrics(77), w: GetSystemMetrics(78), h: GetSystemMetrics(79) }
}

export const foregroundHwnd = (): number => Number(GetForegroundWindow())
export const windowExists = (hwnd: number): boolean => IsWindow(hwnd) !== 0

/** Janela de nível superior sob o ponto (0 se nenhuma). */
export function topLevelAt(p: Pt): number {
  const h = Number(WindowFromPoint({ x: p.x, y: p.y }))
  return h ? Number(GetAncestor(h, GA_ROOT)) : 0
}

/** Quantos monitores estão ligados (SM_CMONITORS). */
export const monitorCount = (): number => GetSystemMetrics(80)

function rectOfMonitor(mon: number | bigint): Rect {
  const info = { cbSize: 40, rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 }, rcWork: { left: 0, top: 0, right: 0, bottom: 0 }, dwFlags: 0 }
  if (!GetMonitorInfoW(Number(mon), info)) throw new Error('Não consegui ler o retângulo do monitor.')
  const r = info.rcMonitor
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }
}

/** Retângulo físico do monitor que contém (a maior parte de) a janela. */
export function monitorRectOfWindow(hwnd: number): Rect {
  return rectOfMonitor(MonitorFromWindow(hwnd, 2)) // MONITOR_DEFAULTTONEAREST
}

/** Retângulo físico do monitor PRINCIPAL (o que contém a origem 0,0). */
export function primaryMonitorRect(): Rect {
  return rectOfMonitor(MonitorFromPoint({ x: 0, y: 0 }, 1)) // MONITOR_DEFAULTTOPRIMARY
}

/** Moldura visível da janela (DWMWA_EXTENDED_FRAME_BOUNDS), com a barra de título. */
export function frameRect(hwnd: number): Rect {
  const r = { left: 0, top: 0, right: 0, bottom: 0 }
  if (DwmGetWindowAttribute(hwnd, 9, r, 16) !== 0) throw new Error(`Sem moldura DWM para a janela ${hwnd}.`)
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }
}

/** Área de cliente da janela em coordenadas de tela. */
export function clientRect(hwnd: number): Rect {
  const c = { left: 0, top: 0, right: 0, bottom: 0 }
  const o = { x: 0, y: 0 }
  if (!GetClientRect(hwnd, c) || !ClientToScreen(hwnd, o)) throw new Error(`Sem área de cliente para a janela ${hwnd}.`)
  return { x: o.x, y: o.y, w: c.right - c.left, h: c.bottom - c.top }
}

function sendMouse(flags: number, dx = 0, dy = 0, data = 0): void {
  const input = { type: 0, mi: { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } }
  const sent = SendInput(1, [input], koffi.sizeof(INPUT))
  if (sent !== 1) throw new Error('SendInput não aceitou o evento (o Windows barrou a entrada simulada?).')
}

/** Move o cursor para o ponto físico (absoluto na mesa virtual) e confere onde caiu. */
export function moveTo(p: Pt): void {
  const v = virtualScreen()
  const ax = Math.round(((p.x - v.x) * 65535) / (v.w - 1))
  const ay = Math.round(((p.y - v.y) * 65535) / (v.h - 1))
  sendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay)
  const at = cursorPos()
  // O mapeamento 0..65535 arredonda; corrige o resíduo para cair no pixel pedido.
  if (Math.abs(at.x - p.x) > 1 || Math.abs(at.y - p.y) > 1) SetCursorPos(p.x, p.y)
}

const smooth = (u: number): number => u * u * (3 - 2 * u)

/** Trajetória suave (curva ease-in-out com leve arco), ~125 passos por segundo. */
export async function moveSmooth(to: Pt, durationMs: number): Promise<void> {
  const from = cursorPos()
  const steps = Math.max(2, Math.round(durationMs / 8))
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.hypot(dx, dy) || 1
  const arc = Math.min(40, dist * 0.06) // curva suave, não reta
  const start = performance.now()
  for (let i = 1; i <= steps; i++) {
    const u = smooth(i / steps)
    const bend = Math.sin(Math.PI * (i / steps)) * arc
    moveTo({ x: Math.round(from.x + dx * u + (-dy / dist) * bend), y: Math.round(from.y + dy * u + (dx / dist) * bend) })
    const next = start + (durationMs * i) / steps
    const wait = next - performance.now()
    if (wait > 0) await sleep(wait)
  }
  moveTo(to)
}

export class UnsafeClickError extends Error {
  override readonly name = 'UnsafeClickError'
}

/**
 * Clique esquerdo com a trava de segurança: a janela em primeiro plano TEM que ser `hwnd`
 * e a janela sob o cursor também; senão lança sem clicar.
 */
export async function safeClick(hwnd: number, holdMs = 80): Promise<void> {
  const fg = foregroundHwnd()
  if (fg !== hwnd) throw new UnsafeClickError(`A janela em primeiro plano é ${fg}, não a de teste (${hwnd}); não cliquei.`)
  const at = cursorPos()
  const under = topLevelAt(at)
  if (under !== hwnd) throw new UnsafeClickError(`O cursor (${at.x}, ${at.y}) está sobre a janela ${under}, não sobre a de teste (${hwnd}); não cliquei.`)
  sendMouse(MOUSEEVENTF_LEFTDOWN)
  await sleep(holdMs)
  sendMouse(MOUSEEVENTF_LEFTUP)
}

/**
 * Traz a janela de teste para o primeiro plano clicando num ponto neutro DENTRO dela
 * (clicar numa janela a ativa sem precisar de permissão do Windows). Só clica se o ponto
 * estiver sobre a janela de teste.
 */
export async function activateByClick(hwnd: number, neutral: Pt): Promise<boolean> {
  if (foregroundHwnd() === hwnd) return false
  await moveSmooth(neutral, 300)
  const under = topLevelAt(neutral)
  if (under !== hwnd) throw new UnsafeClickError(`O ponto neutro está sobre a janela ${under}, não sobre a de teste (${hwnd}); não cliquei.`)
  sendMouse(MOUSEEVENTF_LEFTDOWN)
  await sleep(60)
  sendMouse(MOUSEEVENTF_LEFTUP)
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (foregroundHwnd() === hwnd) return true
    await sleep(50)
  }
  throw new UnsafeClickError(`Não consegui trazer a janela de teste (${hwnd}) ao primeiro plano; primeiro plano = ${foregroundHwnd()}.`)
}

/** Devolve o cursor ao centro da tela principal (a tela que contém (0,0)). */
export function parkCursorAtPrimaryCenter(primary: Rect): void {
  moveTo({ x: Math.round(primary.x + primary.w / 2), y: Math.round(primary.y + primary.h / 2) })
}

// ---------------------------------------------------------------------------------------
// C1: navegador de teste (instância SEPARADA, aberta pelo teste). Nada aqui toca em janela que o teste não abriu.

const EnumProc = koffi.proto('int __stdcall EnumTopProc(intptr_t hwnd, intptr_t lparam)')
const EnumWindows = user32.func('int __stdcall EnumWindows(EnumTopProc *cb, intptr_t lparam)')
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32 *pid)')
const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(intptr_t hwnd)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint16_t *buf, int n)')
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint16_t *buf, int n)')
const SetWindowPos = user32.func('int __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32 flags)')
const keybdEvent = user32.func('void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr_t extra)')

/** Janelas de nível superior VISÍVEIS de um processo (só as do processo `pid`, que o teste abriu). */
export function topLevelWindowsOfPid(pid: number): { hwnd: number; className: string; title: string; frame: Rect }[] {
  const found: number[] = []
  const cb = koffi.register((h: number) => {
    const p = [0]
    GetWindowThreadProcessId(h, p)
    if (p[0] === pid && IsWindowVisible(h)) found.push(Number(h))
    return 1
  }, koffi.pointer(EnumProc))
  try {
    EnumWindows(cb, 0)
  } finally {
    koffi.unregister(cb)
  }
  return found.map((hwnd) => ({ hwnd, className: classNameOf(hwnd), title: windowTitle(hwnd), frame: frameRect(hwnd) }))
}

export function classNameOf(hwnd: number): string {
  const b = Buffer.alloc(512)
  const n = GetClassNameW(hwnd, b, 256)
  return b.toString('utf16le', 0, n * 2)
}

/** O título da janela (para a página de teste: "Aba A clique 2"). */
export function windowTitle(hwnd: number): string {
  const b = Buffer.alloc(2048)
  const n = GetWindowTextW(hwnd, b, 1024)
  return b.toString('utf16le', 0, n * 2)
}

/** Deixa a janela (do teste) por cima de todas, sem ativar: o clique de teste só vale se ela estiver à vista. */
export function keepOnTop(hwnd: number): void {
  // HWND_TOPMOST = -1; SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW
  SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x1 | 0x2 | 0x10 | 0x40)
}

/** Move e redimensiona a janela do teste (sem ativar nem mexer na ordem). */
export function setWindowRect(hwnd: number, r: Rect): void {
  // SWP_NOZORDER | SWP_NOACTIVATE
  if (!SetWindowPos(hwnd, 0, r.x, r.y, r.w, r.h, 0x4 | 0x10)) throw new Error(`Não consegui redimensionar a janela ${hwnd}.`)
}

/** Aperta e solta uma tecla, SÓ se a janela do teste for a que está em primeiro plano (senão lança sem apertar). */
export async function pressKeyIn(hwnd: number, vk: number): Promise<void> {
  const fg = foregroundHwnd()
  if (fg !== hwnd) throw new UnsafeClickError(`A janela em primeiro plano é ${fg}, não a de teste (${hwnd}); não apertei a tecla.`)
  keybdEvent(vk, 0, 0, 0)
  await sleep(40)
  keybdEvent(vk, 0, 2, 0) // KEYEVENTF_KEYUP
}

export const VK_F11 = 0x7a
export const VK_F12 = 0x7b

const EnumChildProc = koffi.proto('int __stdcall EnumChildTopProc(intptr_t hwnd, intptr_t lparam)')
const EnumChildWindows = user32.func('int __stdcall EnumChildWindows(intptr_t parent, EnumChildTopProc *cb, intptr_t lparam)')
const GetWindowRectRaw = user32.func('int __stdcall GetWindowRect(intptr_t hwnd, _Out_ RECT *r)')

/** As janelas-filhas de uma janela (classe, visibilidade, retângulo de tela), como o rastreador as vê. */
export function childWindowsOf(hwnd: number): { className: string; visible: boolean; rect: Rect }[] {
  const handles: number[] = []
  const cb = koffi.register((h: number) => {
    handles.push(Number(h))
    return 1
  }, koffi.pointer(EnumChildProc))
  try {
    EnumChildWindows(hwnd, cb, 0)
  } finally {
    koffi.unregister(cb)
  }
  return handles.map((h) => {
    const r = { left: 0, top: 0, right: 0, bottom: 0 }
    GetWindowRectRaw(h, r)
    return { className: classNameOf(h), visible: IsWindowVisible(h) !== 0, rect: { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } }
  })
}

// ---------------------------------------------------------------------------------------
// Prova real (M5b): roda do mouse. Mesma trava de segurança do clique: só gira se a janela de teste for a que está em primeiro plano E a
// que está sob o cursor.

const MOUSEEVENTF_WHEEL = 0x0800

/** Gira a roda do mouse `notches` entalhes (positivo = para cima, como o Windows; negativo = para baixo). */
export async function safeWheel(hwnd: number, notches: number): Promise<void> {
  const fg = foregroundHwnd()
  if (fg !== hwnd) throw new UnsafeClickError(`A janela em primeiro plano é ${fg}, não a de teste (${hwnd}); não girei a roda.`)
  const at = cursorPos()
  const under = topLevelAt(at)
  if (under !== hwnd) throw new UnsafeClickError(`O cursor (${at.x}, ${at.y}) está sobre a janela ${under}, não sobre a de teste (${hwnd}); não girei a roda.`)
  sendMouse(MOUSEEVENTF_WHEEL, 0, 0, (Math.round(notches * 120) >>> 0))
}

const SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(intptr_t hwnd)')

/**
 * Traz a janela de teste ao primeiro plano SEM clicar em nada dela. O Windows só deixa quem recebeu a última entrada trocar o foco: se a
 * troca direta falha, um toque de Alt (que a entrada simulada conta como entrada do usuário) destrava e tenta de novo.
 */
export async function bringToFront(hwnd: number): Promise<boolean> {
  if (foregroundHwnd() === hwnd) return true
  SetForegroundWindow(hwnd)
  await sleep(90)
  if (foregroundHwnd() === hwnd) return true
  keybdEvent(0x12, 0, 0, 0) // VK_MENU
  keybdEvent(0x12, 0, 2, 0)
  await sleep(40)
  SetForegroundWindow(hwnd)
  await sleep(120)
  return foregroundHwnd() === hwnd
}
