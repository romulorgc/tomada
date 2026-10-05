/**
 * O serviço da análise da câmera (M4c): a PREPARAÇÃO de primeira vez (com progresso real, cancelável e retomável), a FILA de
 * trabalhos (uma análise por vez: a placa e o processador são uns só) e o CACHE do resultado na pasta do projeto.
 *
 *  - `face`: onde está o rosto ao longo da gravação (`media/camera-face.json`), uma vez por gravação, em segundo plano. O editor
 *    e a exportação enquadram a câmera por ele.
 *
 * Segurança: tudo que vem da interface é um id de projeto e o tipo. O vídeo é o `sources.camera` do documento, resolvido por
 * `resolveProjectFile` (relativo, dentro da pasta do projeto, conferido com `realpath`), e o resultado também. Quem executa o
 * motor é o processo principal, com caminhos que ele mesmo montou.
 */
import { readFile, stat } from 'node:fs/promises'
import { CAMERA_KINDS, type CameraJob, type CameraKind, type CameraView } from '@shared/camera-analysis'
import { FACE_FILE, FACE_TRACK_VERSION, faceCoverage, parseFaceTrack, type FaceTrack } from '@shared/face'
import type { IpcEvents } from '@shared/ipc'
import { mediaUrl } from '@shared/media-url'
import type { PrepareSnapshot } from '@shared/transcription'
import type { Project } from '@shared/types'
import { writeFileAtomic } from '../fs-utils'
import type { Logger } from '../logger'
import { resolveProjectFile } from '../project-files'
import { createPrepareTracker } from '../transcription/prepare-tracker'
import type { CameraEngine } from './types'

export interface CameraService {
  view(): Promise<CameraView>
  /** Começa (ou retoma) a preparação em segundo plano. Devolve assim que ela começou. */
  prepare(): Promise<void>
  cancelPrepare(): void
  /**
   * Põe a análise do projeto na fila. Se o resultado guardado ainda vale para a câmera de agora (e `force` não foi pedido),
   * devolve na hora um trabalho "pronto". Lança (com o motivo) se o motor não está preparado ou o projeto não tem câmera.
   */
  analyze(projectId: string, kind: CameraKind, opts?: { force?: boolean }): Promise<CameraJob>
  cancel(projectId: string, kind: CameraKind): void
  /** A URL do resultado guardado, se existe e vale para a câmera de agora (senão `null`). */
  result(projectId: string, kind: CameraKind): Promise<string | null>
  /** Espera a preparação e a fila terminarem (testes). */
  idle(): Promise<void>
  shutdown(): void
}

export type CameraServiceDeps = {
  logger: Logger
  engine: CameraEngine
  read(id: string): Promise<{ project: Project; dir: string }>
  emit<K extends 'camera:prepare' | 'camera:job'>(channel: K, payload: IpcEvents[K]): void
  now?: () => number
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const MAX_JOBS_KEPT = 50

/** O que o arquivo da análise guarda para saber se ainda vale: a câmera de onde saiu (caminho e data do arquivo). */
type FaceFileHead = { version?: number; source?: string; sourceMtimeMs?: number }

export function createCameraService(deps: CameraServiceDeps): CameraService {
  const { logger, engine } = deps
  const now = deps.now ?? ((): number => Date.now())

  // --- preparação -------------------------------------------------------------------------------------------
  let snapshot: PrepareSnapshot | null = null
  let preparing: { promise: Promise<void>; ctl: AbortController } | null = null

  const prepareNow = async (): Promise<void> => {
    const ctl = new AbortController()
    const tracker = createPrepareTracker(
      'camera',
      engine.prepareSteps,
      (s) => {
        snapshot = s
        deps.emit('camera:prepare', s)
      },
      now
    )
    snapshot = tracker.snapshot()
    deps.emit('camera:prepare', snapshot)
    const promise = (async () => {
      try {
        await engine.prepare(tracker, ctl.signal)
        tracker.finish()
      } catch (err) {
        // o motor já avisou o rastreador (`fail` ou `cancelled`); aqui só garante que o estado final não fica "running"
        if (snapshot?.status === 'running') {
          if (ctl.signal.aborted) tracker.cancelled()
          else tracker.fail(snapshot.steps.find((s) => s.status === 'running')?.id ?? snapshot.steps[0]!.id, messageOf(err))
        }
        logger.warn(`Preparação da análise da câmera terminou sem sucesso: ${messageOf(err)}`)
      } finally {
        preparing = null
      }
    })()
    preparing = { promise, ctl }
  }

  // --- fila de trabalhos ---------------------------------------------------------------------------------------
  const jobs = new Map<string, CameraJob>()
  const queue: { projectId: string; kind: CameraKind }[] = []
  let running: { projectId: string; kind: CameraKind; ctl: AbortController; promise: Promise<void> } | null = null
  const keyOf = (projectId: string, kind: CameraKind): string => `${kind}:${projectId}`

  const setJob = (job: CameraJob): void => {
    const key = keyOf(job.projectId, job.kind)
    jobs.delete(key) // reinsere no fim (o mais recente por último)
    jobs.set(key, job)
    if (jobs.size > MAX_JOBS_KEPT) {
      for (const [k, j] of jobs) {
        if (j.state !== 'queued' && j.state !== 'running') {
          jobs.delete(k)
          if (jobs.size <= MAX_JOBS_KEPT) break
        }
      }
    }
    deps.emit('camera:job', job)
  }

  /** O arquivo da câmera do documento: caminho absoluto (resolvido) e a data dele; ou `null` se o projeto não tem câmera. */
  async function cameraFile(projectId: string): Promise<{ project: Project; dir: string; video: string; mtimeMs: number; relPath: string } | null> {
    const { project, dir } = await deps.read(projectId)
    const cam = project.sources.camera
    if (!cam) return null
    const video = await resolveProjectFile(dir, cam.path, 'sources.camera.path')
    const info = await stat(video).catch(() => null)
    if (!info?.isFile()) return null
    return { project, dir, video, mtimeMs: Math.trunc(info.mtimeMs), relPath: cam.path }
  }

  async function readFaceFile(dir: string): Promise<{ head: FaceFileHead; track: FaceTrack; mtimeMs: number } | null> {
    try {
      const file = await resolveProjectFile(dir, FACE_FILE)
      const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
      return { head: JSON.parse(text) as FaceFileHead, track: parseFaceTrack(text), mtimeMs: Math.trunc(info.mtimeMs) }
    } catch {
      return null
    }
  }

  /** O resultado guardado de `face` ainda vale para esta câmera? Devolve a URL (com a versão) e o resumo. */
  async function freshFace(projectId: string, dir: string, relPath: string, cameraMtimeMs: number): Promise<{ url: string; faces: number; coverage: number } | null> {
    const have = await readFaceFile(dir)
    if (!have) return null
    const { head, track } = have
    if (head.version !== FACE_TRACK_VERSION || head.source !== relPath || head.sourceMtimeMs !== cameraMtimeMs) return null
    return { url: mediaUrl(projectId, FACE_FILE, have.mtimeMs), faces: track.boxes.length, coverage: faceCoverage(track) }
  }

  async function runJob(projectId: string, kind: CameraKind, ctl: AbortController): Promise<void> {
    setJob({ projectId, kind, state: 'running', fraction: 0 })
    try {
      const cam = await cameraFile(projectId)
      if (!cam) throw new Error('Esta gravação não tem o vídeo da câmera, então não há o que analisar.')
      let last = -1
      const onProgress = (f: number): void => {
        const pct = Math.round(f * 100)
        if (pct !== last) {
          last = pct
          setJob({ projectId, kind, state: 'running', fraction: f })
        }
      }
      if (kind === 'face') {
        const track = await engine.detectFaces({ video: cam.video, durationMs: cam.project.sources.camera?.durationMs ?? 0, signal: ctl.signal, onProgress })
        if (ctl.signal.aborted) throw new Error('Cancelado.')
        const file = await resolveProjectFile(cam.dir, FACE_FILE)
        await writeFileAtomic(file, JSON.stringify({ ...track, source: cam.relPath, sourceMtimeMs: cam.mtimeMs }))
        const info = await stat(file)
        const coverage = faceCoverage(track)
        setJob({ projectId, kind, state: 'done', fraction: 1, url: mediaUrl(projectId, FACE_FILE, Math.trunc(info.mtimeMs)), faces: track.boxes.length, coverage })
        logger.info(`Análise do rosto do projeto ${projectId}: ${track.boxes.length} rostos em ${Math.round(coverage * 100)}% da gravação (${track.engine}).`)
        return
      }
      throw new Error(`Análise desconhecida: ${String(kind)}.`)
    } catch (err) {
      if (ctl.signal.aborted) {
        setJob({ projectId, kind, state: 'cancelled', fraction: 0, error: 'Análise cancelada.' })
        return
      }
      logger.error(`Análise da câmera (${kind}) do projeto ${projectId} falhou.`, err)
      setJob({ projectId, kind, state: 'error', fraction: 0, error: messageOf(err) })
    }
  }

  function pump(): void {
    if (running) return
    const next = queue.shift()
    if (!next) return
    const ctl = new AbortController()
    const promise = runJob(next.projectId, next.kind, ctl).finally(() => {
      running = null
      pump()
    })
    running = { ...next, ctl, promise }
  }

  return {
    async view() {
      const check = await engine.check()
      const failed = snapshot?.status === 'error' ? snapshot : null
      const resolveState = (f: CameraView['face']): CameraView['face'] => {
        if (preparing) return { state: 'preparing', detail: null }
        if (f.state === 'missing' && failed) return { state: 'error', detail: failed.error?.message ?? f.detail }
        return f
      }
      return { engine: engine.id, face: resolveState(check.face), matte: resolveState(check.matte), device: check.device, prepare: snapshot, jobs: [...jobs.values()] }
    },

    async prepare() {
      if (preparing) return
      await prepareNow()
    },

    cancelPrepare() {
      preparing?.ctl.abort()
    },

    async analyze(projectId, kind, opts = {}) {
      if (!CAMERA_KINDS.includes(kind)) throw new Error('Tipo de análise desconhecido.')
      const existing = jobs.get(keyOf(projectId, kind))
      if (existing && (existing.state === 'queued' || existing.state === 'running')) return existing
      const check = await engine.check()
      const feature = kind === 'face' ? check.face : check.matte
      if (feature.state !== 'ready') throw new Error(feature.detail ?? 'A análise da câmera ainda não está preparada.')
      const cam = await cameraFile(projectId)
      if (!cam) throw new Error('Esta gravação não tem o vídeo da câmera, então não há o que analisar.')
      if (kind === 'face' && !opts.force) {
        const fresh = await freshFace(projectId, cam.dir, cam.relPath, cam.mtimeMs)
        if (fresh) {
          const job: CameraJob = { projectId, kind, state: 'done', fraction: 1, url: fresh.url, faces: fresh.faces, coverage: fresh.coverage }
          setJob(job)
          return job
        }
      }
      const job: CameraJob = { projectId, kind, state: 'queued', fraction: 0 }
      setJob(job)
      queue.push({ projectId, kind })
      pump()
      return job
    },

    cancel(projectId, kind) {
      const at = queue.findIndex((q) => q.projectId === projectId && q.kind === kind)
      if (at >= 0) {
        queue.splice(at, 1)
        setJob({ projectId, kind, state: 'cancelled', fraction: 0, error: 'Análise cancelada.' })
        return
      }
      if (running?.projectId === projectId && running.kind === kind) running.ctl.abort()
    },

    async result(projectId, kind) {
      const cam = await cameraFile(projectId)
      if (!cam) return null
      if (kind === 'face') return (await freshFace(projectId, cam.dir, cam.relPath, cam.mtimeMs))?.url ?? null
      return null
    },

    async idle() {
      for (;;) {
        const waits: Promise<unknown>[] = []
        if (preparing) waits.push(preparing.promise)
        if (running) waits.push(running.promise)
        if (waits.length === 0 && queue.length === 0) return
        await Promise.allSettled(waits)
        await new Promise((r) => setTimeout(r, 0))
      }
    },

    shutdown() {
      preparing?.ctl.abort()
      running?.ctl.abort()
      queue.length = 0
    }
  }
}
