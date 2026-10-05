/**
 * Controlador da gravação no renderer (Zustand): dirige o `CaptureEngine`, reage aos
 * comandos da barra/atalhos e acompanha o processamento. Toda falha vira aviso visível
 * com o motivo; nada se perde em silêncio.
 */
import { create } from 'zustand'
import type { BarAction, ProcessSnapshot, StopReason } from '@shared/ipc'
import type { RecordPrefs, RecordRequest } from '@shared/recording'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'
import { CaptureEngine } from './capture'

export type Phase = 'idle' | 'preparing' | 'countdown' | 'recording' | 'paused' | 'stopping' | 'processing'

interface RecorderStore {
  phase: Phase
  /** Erro da última tentativa (some quando a pessoa tenta de novo). */
  error: string | null
  processing: ProcessSnapshot | null
  /** Nível do microfone durante a gravação (0..1), para a tela que estiver visível. */
  level: number
  start(request: RecordRequest, prefs: Pick<RecordPrefs, 'noiseSuppression' | 'echoCancellation'>): Promise<void>
  command(cmd: BarAction, source?: string): Promise<void>
  retryProcessing(): Promise<void>
  clearError(): void
  /** Chamado pelo App ao montar: assina os eventos do main. Devolve o cancelamento. */
  attach(): () => void
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

let engine: CaptureEngine | null = null
let lastRequest: { request: RecordRequest; prefs: Pick<RecordPrefs, 'noiseSuppression' | 'echoCancellation'> } | null = null
/** Evita parar duas vezes (barra + atalho + fonte que fechou chegam quase juntos). */
let stopping = false

export const useRecorder = create<RecorderStore>()((set, get) => ({
  phase: 'idle',
  error: null,
  processing: null,
  level: 0,

  async start(request, prefs) {
    if (get().phase !== 'idle') return
    lastRequest = { request, prefs }
    stopping = false
    set({ phase: 'preparing', error: null })
    const notify = useApp.getState().notify
    let opened: CaptureEngine | null = null
    let preparedOnMain = false
    try {
      const prepared = await window.tomada.record.prepare(request)
      preparedOnMain = true
      opened = await CaptureEngine.open({
        request,
        prepared,
        prefs,
        callbacks: {
          onSourceEnded: () => {
            const phase = get().phase
            if (phase === 'recording' || phase === 'paused') {
              notify({ kind: 'info', text: t.record.notices.sourceEnded })
              void stopWith('source-ended')
            } else if (phase === 'countdown' || phase === 'preparing') {
              void failStart(t.record.errors.sourceEndedEarly)
            }
          },
          onCameraLost: (message) => notify({ kind: 'error', text: message }),
          onWriteError: (error) => {
            notify({ kind: 'error', text: t.record.errors.writeFailed, detail: error.message })
            void stopWith('write-error')
          },
          onRecorderError: (error) => {
            notify({ kind: 'error', text: t.record.errors.recorderFailed, detail: error.message })
            void stopWith('error')
          },
          onLevel: (level) => set({ level })
        }
      })
      engine = opened
      set({ phase: 'countdown' })
      const completed = await window.tomada.record.runCountdown()
      if (!completed) {
        opened.abort()
        engine = null
        set({ phase: 'idle' })
        return
      }
      await window.tomada.record.go()
      const info = await opened.start()
      await window.tomada.record.started(info)
      set({ phase: 'recording' })
    } catch (err) {
      opened?.abort()
      engine = null
      if (preparedOnMain) await window.tomada.record.abort('falha ao começar').catch(() => undefined)
      const message = messageOf(err)
      window.tomada.log({ level: 'error', message: 'Falha ao começar a gravar', detail: message })
      set({ phase: 'idle', error: message })
      notify({ kind: 'error', text: t.record.errors.startFailed, detail: message })
    }
  },

  async command(cmd, source) {
    const phase = get().phase
    const notify = useApp.getState().notify
    try {
      switch (cmd) {
        case 'pause': {
          if (phase !== 'recording' || !engine) return
          const at = engine.pause()
          await window.tomada.record.pause(at)
          set({ phase: 'paused' })
          return
        }
        case 'resume': {
          if (phase !== 'paused' || !engine) return
          const at = engine.resume()
          await window.tomada.record.resume(at)
          set({ phase: 'recording' })
          return
        }
        case 'stop':
          if (phase === 'countdown' || phase === 'preparing') return
          await stopWith('user', source)
          return
        case 'discard':
        case 'restart': {
          if (phase !== 'recording' && phase !== 'paused') return
          stopping = true
          engine?.abort()
          engine = null
          await window.tomada.record.abort(cmd === 'restart' ? 'recomeçar' : 'descartada pelo usuário')
          set({ phase: 'idle', level: 0 })
          if (cmd === 'restart' && lastRequest) {
            await get().start(lastRequest.request, lastRequest.prefs)
          } else {
            notify({ kind: 'info', text: t.record.notices.discarded })
          }
          return
        }
      }
    } catch (err) {
      window.tomada.log({ level: 'error', message: `Falha no comando de gravação "${cmd}"`, detail: messageOf(err) })
      notify({ kind: 'error', text: t.record.errors.commandFailed, detail: messageOf(err) })
    }
  },

  async retryProcessing() {
    const snap = get().processing
    if (!snap) return
    try {
      await window.tomada.processing.retry(snap.sessionId)
    } catch (err) {
      useApp.getState().notify({ kind: 'error', text: t.processing.retryFailed, detail: messageOf(err) })
    }
  },

  clearError: () => set({ error: null }),

  attach() {
    const off: (() => void)[] = []
    off.push(window.tomada.on('record:command', ({ cmd, source }) => void get().command(cmd, source)))
    off.push(
      window.tomada.on('record:notice', ({ kind, text, detail }) =>
        useApp.getState().notify({ kind, text, ...(detail ? { detail } : {}) })
      )
    )
    off.push(
      window.tomada.on('process:progress', (snapshot) => {
        const wasDone = get().processing?.status === 'done' && get().processing?.sessionId === snapshot.sessionId
        set({ processing: snapshot })
        const app = useApp.getState()
        if (snapshot.status === 'running' || snapshot.status === 'failed') {
          if (app.view.name !== 'processing') app.go({ name: 'processing' })
          // Falhou: a tela Gravar fica livre (o bruto está preservado e o "tentar de novo" segue na tela de processamento).
          if (get().phase === 'idle' || get().phase === 'processing') set({ phase: snapshot.status === 'running' ? 'processing' : 'idle' })
        } else if (snapshot.status === 'done' && !wasDone) {
          void app.loadProjects()
          if (app.view.name === 'processing') app.go({ name: 'project', id: snapshot.folder })
          app.notify({ kind: 'info', text: t.processing.saved })
          if (get().phase === 'processing') set({ phase: 'idle' })
        }
      })
    )
    // Reabriu a janela no meio de um processamento: recupera o estado.
    void window.tomada.record
      .status()
      .then((view) => {
        if (view.processing) set({ processing: view.processing })
      })
      .catch(() => undefined)
    return () => off.forEach((fn) => fn())
  }
}))

async function failStart(message: string): Promise<void> {
  engine?.abort()
  engine = null
  await window.tomada.record.abort('falha ao começar').catch(() => undefined)
  useRecorder.setState({ phase: 'idle', error: message })
  useApp.getState().notify({ kind: 'error', text: message })
}

/** Para o motor, entrega o último pedaço e manda o main processar. */
async function stopWith(reason: StopReason, source?: string): Promise<void> {
  const state = useRecorder.getState()
  if (stopping || !engine || (state.phase !== 'recording' && state.phase !== 'paused')) return
  stopping = true
  const current = engine
  useRecorder.setState({ phase: 'stopping' })
  try {
    const info = await current.stop(reason)
    engine = null
    await window.tomada.record.stop(info)
    useRecorder.setState({ phase: 'processing', level: 0 })
    window.tomada.log({ level: 'info', message: `Gravação parada (${reason}${source ? `, via ${source}` : ''})` })
  } catch (err) {
    engine = null
    const message = messageOf(err)
    window.tomada.log({ level: 'error', message: 'Falha ao parar a gravação', detail: message })
    useRecorder.setState({ phase: 'idle', error: message, level: 0 })
    useApp.getState().notify({ kind: 'error', text: t.record.errors.stopFailed, detail: message })
  }
}
