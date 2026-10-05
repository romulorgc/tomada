/**
 * O serviço de transcrição do processo principal: a PREPARAÇÃO de primeira vez do motor (com progresso real,
 * cancelável e retomável), a FILA de trabalhos (uma transcrição por vez: a placa é uma só) e a leitura do
 * `transcript.json` de um projeto.
 *
 * Segurança: tudo que vem da interface é um id de projeto. O áudio é o `sources.voice` do documento, resolvido por
 * `resolveProjectFile` (relativo, dentro da pasta do projeto, conferido com `realpath`), e o `transcript.json` também.
 * Quem executa o motor é o processo principal, com caminhos que ele mesmo montou.
 */
import { readFile } from 'node:fs/promises'
import { parseTranscript, serializeTranscript, TRANSCRIPT_FILE } from '@shared/transcript'
import type { IpcEvents } from '@shared/ipc'
import type { EngineId, PrepareSnapshot, TranscriptionJob, TranscriptionView } from '@shared/transcription'
import type { Project, Transcript } from '@shared/types'
import { writeFileAtomic } from '../fs-utils'
import type { Logger } from '../logger'
import { resolveProjectFile } from '../project-files'
import { createPrepareTracker, type StepSpec } from './prepare-tracker'
import type { Transcriber } from './types'

export interface TranscriptionService {
  view(): Promise<TranscriptionView>
  /** Começa (ou retoma) a preparação do motor em segundo plano. Devolve assim que ela começou. */
  prepare(): Promise<void>
  cancelPrepare(): void
  /** Põe a transcrição do projeto na fila. Lança (com o motivo) se o motor não está pronto ou o projeto não tem voz. */
  start(projectId: string): Promise<void>
  cancel(projectId: string): void
  /** O `transcript.json` do projeto (null se ainda não existe). Lança se o arquivo está inválido ou fora da pasta. */
  getTranscript(projectId: string): Promise<Transcript | null>
  /** Espera a preparação e a fila terminarem (testes). */
  idle(): Promise<void>
  shutdown(): void
}

export type TranscriptionServiceDeps = {
  logger: Logger
  engine: Transcriber
  read(id: string): Promise<{ project: Project; dir: string }>
  vocabulary(): readonly string[]
  emit<K extends 'transcription:prepare' | 'transcription:job'>(channel: K, payload: IpcEvents[K]): void
  /** Chamado quando uma transcrição termina bem (o `index.ts` aplica a limpeza automática por aqui). */
  onDone?(projectId: string, transcript: Transcript): void
  now?: () => number
}

const SPECS: Record<EngineId, StepSpec[]> = {
  'faster-whisper': [
    { id: 'python', weight: 2 },
    { id: 'packages', weight: 38 },
    { id: 'model', weight: 55 },
    { id: 'check', weight: 5 }
  ],
  'whisper-cpp': [
    { id: 'binary', weight: 40 },
    { id: 'model', weight: 55 },
    { id: 'check', weight: 5 }
  ],
  mock: [
    { id: 'python', weight: 1 },
    { id: 'packages', weight: 1 },
    { id: 'model', weight: 1 },
    { id: 'check', weight: 1 }
  ]
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const MAX_JOBS_KEPT = 50

export function createTranscriptionService(deps: TranscriptionServiceDeps): TranscriptionService {
  const { logger, engine } = deps
  const now = deps.now ?? ((): number => Date.now())

  // --- preparação -------------------------------------------------------------------------------------------
  let snapshot: PrepareSnapshot | null = null
  let preparing: { promise: Promise<void>; ctl: AbortController } | null = null

  const prepareNow = async (): Promise<void> => {
    const ctl = new AbortController()
    const tracker = createPrepareTracker(
      engine.id,
      SPECS[engine.id],
      (s) => {
        snapshot = s
        deps.emit('transcription:prepare', s)
      },
      now
    )
    snapshot = tracker.snapshot()
    deps.emit('transcription:prepare', snapshot)
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
        logger.warn(`Preparação da transcrição terminou sem sucesso: ${messageOf(err)}`)
      } finally {
        preparing = null
      }
    })()
    preparing = { promise, ctl }
  }

  // --- fila de transcrições ---------------------------------------------------------------------------------
  const jobs = new Map<string, TranscriptionJob>()
  const queue: string[] = []
  let running: { projectId: string; ctl: AbortController; promise: Promise<void> } | null = null

  const setJob = (job: TranscriptionJob): void => {
    jobs.delete(job.projectId) // reinsere no fim (o mais recente por último)
    jobs.set(job.projectId, job)
    if (jobs.size > MAX_JOBS_KEPT) {
      for (const [id, j] of jobs) {
        if (j.state !== 'queued' && j.state !== 'running') {
          jobs.delete(id)
          if (jobs.size <= MAX_JOBS_KEPT) break
        }
      }
    }
    deps.emit('transcription:job', job)
  }

  async function runJob(projectId: string, ctl: AbortController): Promise<void> {
    setJob({ projectId, state: 'running', fraction: 0 })
    try {
      const { project, dir } = await deps.read(projectId)
      const voice = project.sources.voice
      if (!voice) throw new Error('Esta gravação não tem a voz do microfone, então não há o que transcrever.')
      const wav = await resolveProjectFile(dir, voice.path, 'sources.voice.path')
      let last = -1
      const transcript = await engine.transcribe(wav, {
        language: 'pt',
        vocabulary: deps.vocabulary(),
        offsetMs: project.sync.cameraOffsetMs,
        audioMs: voice.durationMs,
        signal: ctl.signal,
        onProgress: (f) => {
          const pct = Math.round(f * 100)
          if (pct !== last) {
            last = pct
            setJob({ projectId, state: 'running', fraction: f })
          }
        }
      })
      if (ctl.signal.aborted) throw new Error('Cancelado.')
      const file = await resolveProjectFile(dir, TRANSCRIPT_FILE)
      await writeFileAtomic(file, serializeTranscript(transcript))
      setJob({ projectId, state: 'done', fraction: 1, words: transcript.words.length })
      logger.info(`Transcrição do projeto ${projectId}: ${transcript.words.length} itens (${transcript.engine}).`)
      deps.onDone?.(projectId, transcript)
    } catch (err) {
      if (ctl.signal.aborted) {
        setJob({ projectId, state: 'cancelled', fraction: 0, error: 'Transcrição cancelada.' })
        return
      }
      logger.error(`Transcrição do projeto ${projectId} falhou.`, err)
      setJob({ projectId, state: 'error', fraction: 0, error: messageOf(err) })
    }
  }

  function pump(): void {
    if (running) return
    const projectId = queue.shift()
    if (!projectId) return
    const ctl = new AbortController()
    const promise = runJob(projectId, ctl).finally(() => {
      running = null
      pump()
    })
    running = { projectId, ctl, promise }
  }

  return {
    async view() {
      const check = await engine.check()
      const failed = snapshot?.status === 'error' ? snapshot : null
      let state: TranscriptionView['state'] = check.state
      let detail = check.detail
      if (preparing) {
        state = 'preparing'
        detail = null
      } else if (check.state === 'missing' && failed) {
        state = 'error'
        detail = failed.error?.message ?? detail
      }
      return { engine: engine.id, state, detail, device: check.device, prepare: snapshot, jobs: [...jobs.values()] }
    },

    async prepare() {
      if (preparing) return
      await prepareNow()
    },

    cancelPrepare() {
      preparing?.ctl.abort()
    },

    async start(projectId) {
      const existing = jobs.get(projectId)
      if (existing && (existing.state === 'queued' || existing.state === 'running')) return
      const check = await engine.check()
      if (check.state !== 'ready') throw new Error(check.detail ?? 'A transcrição ainda não está preparada.')
      const { project } = await deps.read(projectId)
      if (!project.sources.voice) throw new Error('Esta gravação não tem a voz do microfone, então não há o que transcrever.')
      setJob({ projectId, state: 'queued', fraction: 0 })
      queue.push(projectId)
      pump()
    },

    cancel(projectId) {
      const at = queue.indexOf(projectId)
      if (at >= 0) {
        queue.splice(at, 1)
        setJob({ projectId, state: 'cancelled', fraction: 0, error: 'Transcrição cancelada.' })
        return
      }
      if (running?.projectId === projectId) running.ctl.abort()
    },

    async getTranscript(projectId) {
      const { dir } = await deps.read(projectId)
      const file = await resolveProjectFile(dir, TRANSCRIPT_FILE)
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
      return parseTranscript(text)
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
