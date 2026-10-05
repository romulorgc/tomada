/**
 * Estado global da transcrição (Zustand): o motor (pronto, falta preparar, preparando), a preparação de primeira
 * vez com o progresso real e a fila de trabalhos por projeto. Quem assina: Ajustes, a aba Texto do editor, o chip
 * dos cartões da biblioteca. Os eventos chegam do processo principal (`transcription:prepare`, `transcription:job`).
 *
 * Falha nunca é silenciosa: o erro vai para o estado (`error`), a tela o mostra com "Tentar de novo", e o motivo
 * técnico vai para o log.
 */
import { create } from 'zustand'
import type { PrepareSnapshot, TranscriptionJob, TranscriptionView } from '@shared/transcription'
import { useApp } from './store'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

interface TranscriptionStore {
  /** Estado do motor, ou null enquanto a primeira leitura não voltou. */
  view: TranscriptionView | null
  /** Última preparação (em andamento, terminada, com erro ou cancelada). */
  prepare: PrepareSnapshot | null
  /** Um trabalho por projeto (o mais recente de cada). */
  jobs: Record<string, TranscriptionJob>
  /** Falha ao falar com o processo principal (não é falha de transcrição). */
  error: string | null

  refresh(): Promise<void>
  prepareEngine(): Promise<void>
  cancelPrepare(): Promise<void>
  start(projectId: string): Promise<boolean>
  cancel(projectId: string): Promise<void>
  /** Liga os eventos do processo principal. Devolve a função que desliga. */
  attach(): () => void
}

export const useTranscription = create<TranscriptionStore>()((set, get) => ({
  view: null,
  prepare: null,
  jobs: {},
  error: null,

  async refresh() {
    try {
      const view = await window.tomada.transcription.status()
      set((s) => ({
        view,
        error: null,
        // o que já chegou por evento é mais novo que a foto do `status`: só adota a foto se não há nada
        prepare: s.prepare && view.prepare && s.prepare.startedAt > view.prepare.startedAt ? s.prepare : (view.prepare ?? s.prepare),
        jobs: { ...Object.fromEntries(view.jobs.map((j) => [j.projectId, j])), ...s.jobs }
      }))
    } catch (err) {
      window.tomada.log({ level: 'error', message: 'Falha ao ler o estado da transcrição', detail: messageOf(err) })
      set({ error: messageOf(err) })
    }
  },

  async prepareEngine() {
    try {
      await window.tomada.transcription.prepare()
      await get().refresh()
    } catch (err) {
      window.tomada.log({ level: 'error', message: 'Falha ao iniciar a preparação da transcrição', detail: messageOf(err) })
      set({ error: messageOf(err) })
    }
  },

  async cancelPrepare() {
    try {
      await window.tomada.transcription.cancelPrepare()
    } catch (err) {
      window.tomada.log({ level: 'error', message: 'Falha ao cancelar a preparação', detail: messageOf(err) })
    }
  },

  async start(projectId) {
    try {
      await window.tomada.transcription.start(projectId)
      return true
    } catch (err) {
      window.tomada.log({ level: 'error', message: `Falha ao pôr a transcrição na fila (${projectId})`, detail: messageOf(err) })
      // o motivo aparece onde a pessoa está olhando: o estado do trabalho (aba Texto) e um aviso
      set((s) => ({ jobs: { ...s.jobs, [projectId]: { projectId, state: 'error', fraction: 0, error: messageOf(err) } } }))
      useApp.getState().notify({ kind: 'error', text: 'Não consegui começar a transcrição', detail: messageOf(err) })
      return false
    }
  },

  async cancel(projectId) {
    try {
      await window.tomada.transcription.cancel(projectId)
    } catch (err) {
      window.tomada.log({ level: 'error', message: `Falha ao cancelar a transcrição (${projectId})`, detail: messageOf(err) })
    }
  },

  attach() {
    const offPrepare = window.tomada.on('transcription:prepare', (snap) => {
      set({ prepare: snap })
      // terminou: o estado do motor mudou (pronto / com problema)
      if (snap.status !== 'running') void get().refresh()
    })
    const offJob = window.tomada.on('transcription:job', (job) => {
      set((s) => ({ jobs: { ...s.jobs, [job.projectId]: job } }))
    })
    void get().refresh()
    return () => {
      offPrepare()
      offJob()
    }
  }
}))

/** O trabalho de transcrição do projeto está na fila ou rodando? */
export const isJobActive = (job: TranscriptionJob | undefined): boolean => job?.state === 'queued' || job?.state === 'running'
