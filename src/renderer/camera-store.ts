/**
 * Estado global da análise da câmera (Zustand): o motor (pronto, falta preparar, preparando), a preparação de primeira vez com o
 * progresso real e a fila de trabalhos por projeto e tipo. Quem assina: a aba Câmera do editor. Os eventos chegam do processo
 * principal (`camera:prepare`, `camera:job`).
 *
 * Falha nunca é silenciosa: o erro vai para o estado, a tela o mostra com "Tentar de novo", e o motivo técnico vai para o log.
 */
import { create } from 'zustand'
import type { CameraJob, CameraKind, CameraView } from '@shared/camera-analysis'
import type { PrepareSnapshot } from '@shared/transcription'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export const cameraJobKey = (projectId: string, kind: CameraKind): string => `${kind}:${projectId}`

interface CameraStore {
  /** Estado do motor, ou null enquanto a primeira leitura não voltou. */
  view: CameraView | null
  prepare: PrepareSnapshot | null
  /** Um trabalho por projeto e tipo (o mais recente de cada), pela chave `cameraJobKey`. */
  jobs: Record<string, CameraJob>
  /** Falha ao falar com o processo principal (não é falha da análise). */
  error: string | null

  refresh(): Promise<void>
  prepareEngine(): Promise<void>
  cancelPrepare(): Promise<void>
  /**
   * Põe a análise na fila (ou devolve a que já vale; `force` = refaz de qualquer jeito, o que "Recortar de novo" quer).
   * `false` = não deu (o motivo vai para o estado do trabalho).
   */
  analyze(projectId: string, kind: CameraKind, force?: boolean): Promise<boolean>
  cancel(projectId: string, kind: CameraKind): Promise<void>
  attach(): () => void
}

export const useCamera = create<CameraStore>()((set, get) => ({
  view: null,
  prepare: null,
  jobs: {},
  error: null,

  async refresh() {
    try {
      const view = await window.tomada.camera.status()
      set((s) => ({
        view,
        error: null,
        prepare: s.prepare && view.prepare && s.prepare.startedAt > view.prepare.startedAt ? s.prepare : (view.prepare ?? s.prepare),
        jobs: { ...Object.fromEntries(view.jobs.map((j) => [cameraJobKey(j.projectId, j.kind), j])), ...s.jobs }
      }))
    } catch (err) {
      window.tomada.log({ level: 'error', message: 'Falha ao ler o estado da análise da câmera', detail: messageOf(err) })
      set({ error: messageOf(err) })
    }
  },

  async prepareEngine() {
    try {
      await window.tomada.camera.prepare()
      await get().refresh()
    } catch (err) {
      window.tomada.log({ level: 'error', message: 'Falha ao iniciar a preparação da análise da câmera', detail: messageOf(err) })
      set({ error: messageOf(err) })
    }
  },

  async cancelPrepare() {
    try {
      await window.tomada.camera.cancelPrepare()
    } catch (err) {
      window.tomada.log({ level: 'error', message: 'Falha ao cancelar a preparação da câmera', detail: messageOf(err) })
    }
  },

  async analyze(projectId, kind, force) {
    try {
      const job = await window.tomada.camera.analyze(projectId, kind, force)
      set((s) => ({ jobs: { ...s.jobs, [cameraJobKey(projectId, kind)]: job } }))
      return true
    } catch (err) {
      window.tomada.log({ level: 'error', message: `Falha ao pôr a análise da câmera na fila (${kind}, ${projectId})`, detail: messageOf(err) })
      set((s) => ({ jobs: { ...s.jobs, [cameraJobKey(projectId, kind)]: { projectId, kind, state: 'error', fraction: 0, error: messageOf(err) } } }))
      return false
    }
  },

  async cancel(projectId, kind) {
    try {
      await window.tomada.camera.cancel(projectId, kind)
    } catch (err) {
      window.tomada.log({ level: 'error', message: `Falha ao cancelar a análise da câmera (${kind}, ${projectId})`, detail: messageOf(err) })
    }
  },

  attach() {
    const offPrepare = window.tomada.on('camera:prepare', (snap) => {
      set({ prepare: snap })
      if (snap.status !== 'running') void get().refresh()
    })
    const offJob = window.tomada.on('camera:job', (job) => {
      set((s) => ({ jobs: { ...s.jobs, [cameraJobKey(job.projectId, job.kind)]: job } }))
    })
    void get().refresh()
    return () => {
      offPrepare()
      offJob()
    }
  }
}))

/** O trabalho está na fila ou rodando? */
export const isCameraJobActive = (job: CameraJob | undefined): boolean => job?.state === 'queued' || job?.state === 'running'
