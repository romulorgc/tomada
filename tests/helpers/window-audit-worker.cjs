// Roda em worker_thread para continuar auditando durante ffmpeg/execFileSync dos specs.
// Não lê título, imagem, tecla, cursor nem qualquer janela fora da árvore Electron do teste.
const { parentPort, workerData } = require('node:worker_threads')
const { writeFileSync } = require('node:fs')
const koffi = require('koffi')

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const Entry = koffi.struct('TomadaAuditProcessEntry', {
  dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32', th32DefaultHeapID: 'uintptr_t',
  th32ModuleID: 'uint32', cntThreads: 'uint32', th32ParentProcessID: 'uint32', pcPriClassBase: 'int32',
  dwFlags: 'uint32', szExeFile: koffi.array('uint16_t', 260)
})
const Message = koffi.struct('TomadaAuditMessage', {
  hwnd: 'intptr_t', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32',
  x: 'long', y: 'long', lPrivate: 'uint32'
})
const snapshot = kernel32.func('intptr_t __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)')
const firstProcess = kernel32.func('int __stdcall Process32FirstW(intptr_t snapshot, _Inout_ TomadaAuditProcessEntry *entry)')
const nextProcess = kernel32.func('int __stdcall Process32NextW(intptr_t snapshot, _Inout_ TomadaAuditProcessEntry *entry)')
const closeHandle = kernel32.func('int __stdcall CloseHandle(intptr_t handle)')
const WindowProc = koffi.proto('int __stdcall TomadaAuditEnumWindow(intptr_t hwnd, intptr_t data)')
const enumWindows = user32.func('int __stdcall EnumWindows(TomadaAuditEnumWindow *callback, intptr_t data)')
const windowPid = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32 *pid)')
const isVisible = user32.func('int __stdcall IsWindowVisible(intptr_t hwnd)')
const getAncestor = user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32 flags)')
const getClass = user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ char16_t *text, int length)')
const EventProc = koffi.proto('void __stdcall TomadaAuditWinEvent(intptr_t hook, uint32 event, intptr_t hwnd, int32 object, int32 child, uint32 thread, uint32 time)')
const setHook = user32.func('intptr_t __stdcall SetWinEventHook(uint32 min, uint32 max, intptr_t module, TomadaAuditWinEvent *callback, uint32 pid, uint32 thread, uint32 flags)')
const unhook = user32.func('int __stdcall UnhookWinEvent(intptr_t hook)')
const peekMessage = user32.func('int __stdcall PeekMessageW(_Out_ TomadaAuditMessage *message, intptr_t hwnd, uint32 min, uint32 max, uint32 remove)')

const startedAt = Date.now()
const roots = new Set()
const processesSeen = new Set()
const windowsSeen = new Map()
const samples = []
const showEvents = []
const errors = []
let targetPids = new Set()
let lastSampleAt = startedAt
let maxSampleGapMs = 0

function descendants(processes, parents) {
  const found = new Set(parents)
  let changed = true
  while (changed) {
    changed = false
    for (const p of processes) if (found.has(p.parent) && !found.has(p.pid)) { found.add(p.pid); changed = true }
  }
  return found
}

function processTree() {
  const handle = snapshot(2, 0)
  if (handle === -1 || handle === -1n) throw new Error('CreateToolhelp32Snapshot falhou')
  const rows = []
  const entry = { dwSize: koffi.sizeof(Entry), szExeFile: [] }
  try {
    if (!firstProcess(handle, entry)) throw new Error('Process32FirstW falhou')
    do {
      const end = entry.szExeFile.indexOf(0)
      const exe = String.fromCharCode(...entry.szExeFile.slice(0, end < 0 ? undefined : end))
      rows.push({ pid: entry.th32ProcessID, parent: entry.th32ParentProcessID, exe })
    } while (nextProcess(handle, entry))
  } finally { closeHandle(handle) }
  const runnerTree = descendants(rows, [workerData.rootPid])
  const activeRoots = rows.filter(p => runnerTree.has(p.pid) && p.exe.toLowerCase() === 'electron.exe').map(p => p.pid)
  for (const pid of activeRoots) roots.add(pid)
  // PIDs são reutilizados pelo Windows: o histórico serve só ao relatório.
  targetPids = descendants(rows, activeRoots)
  for (const pid of targetPids) processesSeen.add(pid)
}

function readWindow(hwnd) {
  const pid = [0]
  windowPid(hwnd, pid)
  if (!targetPids.has(pid[0])) return null
  const buffer = Buffer.alloc(512)
  const length = getClass(hwnd, buffer, 256)
  return { hwnd: String(hwnd), pid: pid[0], visible: Boolean(isVisible(hwnd)), className: buffer.toString('utf16le', 0, length * 2) }
}

const enumeration = koffi.register(hwnd => {
  const window = readWindow(hwnd)
  if (window) {
    windowsSeen.set(`${window.pid}:${window.hwnd}`, window)
    currentWindows.push(window)
  }
  return 1
}, koffi.pointer(WindowProc))
let currentWindows = []
const eventCallback = koffi.register((_hook, _event, hwnd, object, child, _thread, time) => {
  // OBJID_WINDOW e janela de topo: mostrar um controle interno não mostra a janela.
  if (!hwnd || object !== 0 || child !== 0 || getAncestor(hwnd, 2) !== hwnd) return
  try {
    processTree()
    const window = readWindow(hwnd)
    if (window) showEvents.push({ ...window, atMs: Date.now() - startedAt, win32Time: time })
  } catch (error) { errors.push(String(error)) }
}, koffi.pointer(EventProc))
// EVENT_OBJECT_SHOW, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS.
const hook = setHook(0x8002, 0x8002, 0, eventCallback, 0, 0, 2)
if (!hook) throw new Error('SetWinEventHook falhou')

function sample() {
  processTree()
  const message = {}
  for (let i = 0; i < 100 && peekMessage(message, 0, 0, 0, 1); i++) {}
  currentWindows = []
  if (!enumWindows(enumeration, 0)) throw new Error('EnumWindows falhou')
  const now = Date.now()
  maxSampleGapMs = Math.max(maxSampleGapMs, now - lastSampleAt)
  lastSampleAt = now
  samples.push({ atMs: now - startedAt, processIds: [...targetPids], windows: currentWindows })
}

sample()
const timer = setInterval(() => { try { sample() } catch (error) { errors.push(String(error)) } }, 50)
parentPort.postMessage({ ready: true })
parentPort.once('message', () => {
  clearInterval(timer)
  try { sample() } catch (error) { errors.push(String(error)) }
  unhook(hook)
  koffi.unregister(eventCallback)
  koffi.unregister(enumeration)
  const visibleWindows = samples.flatMap(s => s.windows.filter(w => w.visible).map(w => ({ ...w, atMs: s.atMs })))
  const report = {
    test: workerData.test,
    mechanism: 'EnumWindows + IsWindowVisible + Toolhelp32 + EVENT_OBJECT_SHOW',
    rootPid: workerData.rootPid, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt,
    electronRoots: [...roots], processIds: [...processesSeen], windowCount: windowsSeen.size,
    sampleCount: samples.length, maxSampleGapMs, visibleWindows, showEvents, errors, samples
  }
  writeFileSync(workerData.output, JSON.stringify(report, null, 2))
  parentPort.postMessage({ report })
  parentPort.close()
})
