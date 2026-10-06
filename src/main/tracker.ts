/**
 * Controlador do rastreador: sobe o worker, junta os lotes de amostras e devolve tudo ao
 * parar. Não importa `electron` (testável em Node).
 */
import { Worker } from 'node:worker_threads'
import type { BrowserKind } from '@shared/browser'
import type { RawEvents } from '@shared/recording'
import type { Logger } from './logger'
import type { TrackerMessage, TrackerStats, TrackerWorkerData } from './tracker-worker'

export type TrackerConfig = {
  kind: 'screen' | 'window'
  /** HWND da janela capturada (só para `kind: 'window'`). */
  hwnd: number | null
  hz?: number
  batchMs?: number
}

export type TrackerResult = {
  raw: RawEvents
  stats: TrackerStats | null
  /** A janela capturada deixou de existir durante a gravação. */
  windowGone: boolean
  /** Erro do worker (se houve): a gravação segue, mas os eventos podem estar incompletos. */
  error: string | null
  /** Janela gravada que é um navegador (C1): qual (Chromium mede a página; Firefox só é reconhecido). */
  browser?: BrowserKind | null
}

export interface Tracker {
  /** Volta quando o worker já está amostrando (primeira amostra lida). */
  start(): Promise<void>
  pause(): void
  resume(): void
  /** Fotografia dos lotes já recebidos, sem parar a amostragem. */
  snapshot(): RawEvents
  stop(): Promise<TrackerResult>
  readonly running: boolean
}

export type TrackerDeps = {
  /** Caminho do `tracker-worker.js` compilado. */
  workerPath: string
  logger: Logger
  onWindowGone?: () => void
}

const START_TIMEOUT_MS = 8000
const STOP_TIMEOUT_MS = 4000

export function createTracker(config: TrackerConfig, deps: TrackerDeps): Tracker {
  const { logger } = deps
  const control = new Int32Array(new SharedArrayBuffer(16))
  const raw: RawEvents = { cursor: [], clicks: [], keys: [], windowRects: [], pages: [] }
  let browser: BrowserKind | null = null
  let worker: Worker | null = null
  let stats: TrackerStats | null = null
  let windowGone = false
  let error: string | null = null
  let running = false
  let onStopped: (() => void) | null = null

  const handle = (m: TrackerMessage): void => {
    switch (m.type) {
      case 'batch':
        for (const v of m.cursor) raw.cursor.push(v)
        for (const c of m.clicks) raw.clicks.push(c)
        for (const k of m.keys) raw.keys.push(k)
        for (const r of m.windowRects) raw.windowRects.push(r)
        for (const p of m.pages) raw.pages!.push(p)
        break
      case 'browser':
        browser = m.browser
        break
      case 'window-gone':
        windowGone = true
        logger.warn('A janela capturada deixou de existir.')
        deps.onWindowGone?.()
        break
      case 'stopped':
        stats = m.stats
        onStopped?.()
        break
      case 'error':
        error = m.message
        logger.error('O rastreador do cursor falhou.', m.message)
        onStopped?.()
        break
      case 'ready':
        break
    }
  }

  return {
    get running() {
      return running
    },

    start() {
      return new Promise<void>((resolve, reject) => {
        const data: TrackerWorkerData = {
          kind: config.kind,
          hwnd: config.hwnd,
          hz: config.hz ?? 120,
          control: control.buffer as SharedArrayBuffer,
          batchMs: config.batchMs ?? 250
        }
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          void worker?.terminate()
          reject(new Error(`O rastreador do cursor não respondeu em ${START_TIMEOUT_MS / 1000} s.`))
        }, START_TIMEOUT_MS)
        const w = new Worker(deps.workerPath, { workerData: data })
        worker = w
        w.on('message', (m: TrackerMessage) => {
          handle(m)
          if (!settled && (m.type === 'ready' || m.type === 'error')) {
            settled = true
            clearTimeout(timer)
            if (m.type === 'ready') {
              running = true
              resolve()
            } else {
              reject(new Error(`O rastreador do cursor não iniciou: ${m.message.split('\n')[0]}`))
            }
          }
        })
        w.on('error', (err) => {
          error = err instanceof Error ? err.message : String(err)
          logger.error('O worker do rastreador caiu.', err)
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(new Error(`O rastreador do cursor não iniciou: ${error}`))
          }
          onStopped?.()
        })
        w.on('exit', () => {
          running = false
          onStopped?.()
        })
      })
    },

    pause() {
      Atomics.store(control, 1, 1)
    },

    resume() {
      Atomics.store(control, 1, 0)
    },

    snapshot() {
      return structuredClone(raw)
    },

    async stop() {
      const w = worker
      if (w && running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            logger.warn('O rastreador não confirmou a parada a tempo; encerrando à força.')
            resolve()
          }, STOP_TIMEOUT_MS)
          onStopped = () => {
            clearTimeout(timer)
            resolve()
          }
          Atomics.store(control, 2, 1)
          Atomics.notify(control, 0)
        })
        await w.terminate().catch(() => undefined)
      } else if (w) {
        await w.terminate().catch(() => undefined)
      }
      running = false
      if (stats) {
        logger.info(
          `Rastreador: ${stats.ticks} amostras em ${stats.seconds.toFixed(1)} s (${stats.hz.toFixed(1)} Hz; intervalo mediano ${stats.intervalMedianMs.toFixed(2)} ms, p95 ${stats.intervalP95Ms.toFixed(2)} ms, máx ${stats.intervalMaxMs.toFixed(1)} ms)`
        )
      }
      return { raw, stats, windowGone, error, browser }
    }
  }
}
