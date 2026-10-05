/**
 * Worker do rastreador (roda em `worker_thread`, fora do laço de eventos do app).
 *
 * A 120 Hz lê o cursor (`GetCursorPos`), os botões do mouse (`GetAsyncKeyState`, com
 * detecção de borda) e "houve tecla" (NUNCA qual), e a cada 100 ms o retângulo da janela
 * capturada. Dorme com `Atomics.wait` (setInterval de 8 ms oscila demais) depois de pedir
 * 1 ms de resolução de timer ao Windows (sem isso o sono mínimo é 15,6 ms e a taxa cai
 * para ~64 Hz; medido).
 *
 * Tempo: `performance.timeOrigin + performance.now()` (ms, relógio de parede estável e
 * monotônico). Pixels FÍSICOS. Nada é normalizado aqui: quem converte é `buildEvents`.
 *
 * Comandos pelo `SharedArrayBuffer` (o laço é síncrono, não escuta mensagens):
 *   control[0] célula de sono · control[1] pausado · control[2] parar.
 */
import { parentPort, workerData } from 'node:worker_threads'
import type { MouseButton, Rect } from '@shared/types'
import { loadWin32, TYPING_VKS } from './win32'

export type TrackerWorkerData = {
  kind: 'screen' | 'window'
  hwnd: number | null
  hz: number
  control: SharedArrayBuffer
  /** A cada quantos ms o worker manda um lote ao processo principal. */
  batchMs: number
}

export type TrackerBatch = {
  type: 'batch'
  /** [t, x, y, t, x, y, …] */
  cursor: number[]
  clicks: { t: number; upT?: number; x: number; y: number; button: MouseButton }[]
  keys: number[]
  windowRects: { t: number; frame: Rect; client: Rect }[]
}

export type TrackerStats = {
  ticks: number
  hz: number
  intervalMedianMs: number
  intervalP95Ms: number
  intervalMaxMs: number
  seconds: number
}

export type TrackerMessage =
  | { type: 'ready'; t: number }
  | TrackerBatch
  | { type: 'window-gone'; t: number }
  | { type: 'stopped'; stats: TrackerStats }
  | { type: 'error'; message: string }

const cfg = workerData as TrackerWorkerData
const port = parentPort
if (!port) throw new Error('tracker-worker precisa rodar como worker_thread')
const post = (m: TrackerMessage): void => port.postMessage(m)

const nowMs = (): number => performance.timeOrigin + performance.now()
const rectEqual = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!
}

function run(): void {
  const w32 = loadWin32()
  const control = new Int32Array(cfg.control)
  const periodMs = 1000 / cfg.hz
  const hwnd = cfg.hwnd
  w32.beginHighResTimer()

  let batch: TrackerBatch = emptyBatch()
  function emptyBatch(): TrackerBatch {
    return { type: 'batch', cursor: [], clicks: [], keys: [], windowRects: [] }
  }

  const buttonNames: MouseButton[] = ['left', 'right', 'middle']
  const wasDown: Record<MouseButton, boolean> = { left: false, right: false, middle: false }
  const pending: Record<MouseButton, { t: number; x: number; y: number } | null> = { left: null, right: null, middle: null }
  const keyWasDown = new Uint8Array(256)

  let lastRect: { frame: Rect; client: Rect } | null = null
  let lastRectAt = Number.NEGATIVE_INFINITY
  let goneReads = 0
  let goneReported = false
  let lastFlush = performance.now()
  const intervals: number[] = []
  let ticks = 0
  let prevTick = 0
  let started = 0
  let readySent = false

  const readWindowRect = (t: number): void => {
    if (hwnd === null) return
    if (!w32.isWindow(hwnd)) {
      goneReads++
      if (goneReads >= 3 && !goneReported) {
        goneReported = true
        post({ type: 'window-gone', t })
      }
      return
    }
    goneReads = 0
    if (w32.isIconic(hwnd)) return // minimizada: o retângulo é lixo (−32000); mantém o último
    const frame = w32.frameRect(hwnd)
    const client = w32.clientRect(hwnd)
    if (!frame || !client) return
    if (!lastRect || !rectEqual(lastRect.frame, frame) || !rectEqual(lastRect.client, client)) {
      lastRect = { frame, client }
      batch.windowRects.push({ t, frame, client })
    }
  }

  let nextTick = performance.now()
  started = nowMs()
  while (Atomics.load(control, 2) === 0) {
    const t = nowMs()
    const paused = Atomics.load(control, 1) === 1
    const pos = w32.getCursorPos()
    const buttons = w32.mouseButtons()

    // Botões: borda de descida abre o clique; borda de subida fecha com `upT`.
    for (const name of buttonNames) {
      const isDown = buttons[name]
      if (isDown && !wasDown[name]) {
        if (!paused) pending[name] = { t, x: pos.x, y: pos.y }
      } else if (!isDown && wasDown[name]) {
        const p = pending[name]
        if (p) {
          batch.clicks.push({ t: p.t, upT: t, x: p.x, y: p.y, button: name })
          pending[name] = null
        }
      }
      wasDown[name] = isDown
    }

    // Teclado: só "houve tecla", a ~60 Hz (cada 2 ticks); o código da tecla nunca sai daqui.
    if ((ticks & 1) === 0) {
      let any = false
      for (const vk of TYPING_VKS) {
        const down = w32.keyDown(vk)
        if (down && keyWasDown[vk] === 0) any = true
        keyWasDown[vk] = down ? 1 : 0
      }
      if (any && !paused) batch.keys.push(t)
    }

    if (t - lastRectAt >= 100) {
      lastRectAt = t
      readWindowRect(t)
    }

    if (!paused) batch.cursor.push(t, pos.x, pos.y)

    if (!readySent) {
      readySent = true
      post({ type: 'ready', t })
    }

    if (ticks > 0) intervals.push(t - prevTick)
    prevTick = t
    ticks++

    if (performance.now() - lastFlush >= cfg.batchMs) {
      lastFlush = performance.now()
      if (batch.cursor.length || batch.clicks.length || batch.keys.length || batch.windowRects.length) {
        post(batch)
        batch = emptyBatch()
      }
    }

    // Sono até o próximo tique. Se atrasou muito (máquina travou), recomeça a contar daqui.
    nextTick += periodMs
    const wait = nextTick - performance.now()
    if (wait > 0) Atomics.wait(control, 0, 0, wait)
    else if (wait < -periodMs * 4) nextTick = performance.now()
  }

  // Clique ainda apertado ao parar: sai sem `upT`.
  for (const name of buttonNames) {
    const p = pending[name]
    if (p) batch.clicks.push({ t: p.t, x: p.x, y: p.y, button: name })
  }
  if (batch.cursor.length || batch.clicks.length || batch.keys.length || batch.windowRects.length) post(batch)

  w32.endHighResTimer()
  const sorted = [...intervals].sort((a, b) => a - b)
  const seconds = (nowMs() - started) / 1000
  post({
    type: 'stopped',
    stats: {
      ticks,
      hz: seconds > 0 ? ticks / seconds : 0,
      intervalMedianMs: percentile(sorted, 0.5),
      intervalP95Ms: percentile(sorted, 0.95),
      intervalMaxMs: sorted[sorted.length - 1] ?? 0,
      seconds
    }
  })
}

try {
  run()
} catch (err) {
  post({ type: 'error', message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) })
}
