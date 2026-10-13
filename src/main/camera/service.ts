/**
 * O serviço da análise da câmera (M4c): a PREPARAÇÃO de primeira vez (com progresso real, cancelável e retomável), a FILA de
 * trabalhos (uma análise por vez: a placa e o processador são uns só) e o CACHE do resultado na pasta do projeto.
 *
 *  - `face`: onde está o rosto ao longo da gravação (`media/camera-face.json`), uma vez por gravação, em segundo plano. O editor
 *    e a exportação enquadram a câmera por ele.
 *  - `matte`: o recorte do fundo (`media/camera-matte.mp4`, a pessoa em branco, mais `camera-matte.json` com a origem para o cache).
 *    O apresentador recortado desenha a câmera por ele. Desde a etapa R1 roda SEMPRE, em segundo plano, logo depois de gravar (qualquer que seja
 *    o estilo da câmera), em PEDAÇOS de 10 s com o andamento guardado no projeto (`media/camera-matte.progress.json`): fechar o app no meio
 *    não perde o trabalho, e a rodada seguinte continua do último pedaço inteiro. Dá lugar à exportação, à transcrição e à prévia (a placa
 *    é uma só): para no fim do pedaço em curso e retoma quando a placa fica livre.
 *
 * Segurança: tudo que vem da interface é um id de projeto e o tipo. O vídeo é o `sources.camera` do documento, resolvido por
 * `resolveProjectFile` (relativo, dentro da pasta do projeto, conferido com `realpath`), e o resultado também. Quem executa o
 * motor é o processo principal, com caminhos que ele mesmo montou.
 */
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CAMERA_KINDS, type CameraJob, type CameraKind, type CameraView } from '@shared/camera-analysis'
import { FACE_FILE, FACE_TRACK_VERSION, faceCoverage, parseFaceTrack, type FaceTrack } from '@shared/face'
import type { IpcEvents } from '@shared/ipc'
import { MATTE_FILE, MATTE_META_FILE, MATTE_PARTIAL_FILE, MATTE_VERSION, type MatteMeta } from '@shared/matte'
import { chunksFraction, MATTE_CHUNK_SECONDS, MATTE_PARTS_DIR, MATTE_PROGRESS_FILE, MATTE_PROGRESS_VERSION, MATTE_WARMUP_SECONDS, progressMatchesCamera, type MatteChunk, type MatteProgress } from '@shared/matte-parts'
import { mediaUrl } from '@shared/media-url'
import { documentFilePaths } from '@shared/safe-path'
import type { PrepareSnapshot } from '@shared/transcription'
import type { Project } from '@shared/types'
import { writeFileAtomic } from '../fs-utils'
import type { GpuGate } from '../gpu-queue'
import type { Logger } from '../logger'
import { resolveProjectFile } from '../project-files'
import { createPrepareTracker } from '../transcription/prepare-tracker'
import { freshMatte } from './matte-file'
import { MatteJoinError } from './matte-join'
import { loadResume, readProgress, removeProgress, removePartsDir, writeProgress } from './matte-resume'
import type { CameraEngine, MatteResult } from './types'

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
  /**
   * Ao abrir o app: olha o projeto e, se o recorte do fundo ficou pela metade (o app fechou, caiu, ou sobrou o `.partial` de antes dos
   * pedaços), RETOMA sozinho e deixa no log o que encontrou. Devolve o que fez. Nunca lança.
   */
  recoverMatte(projectId: string): Promise<'resumed' | 'regenerated' | 'failed' | 'idle'>
  /**
   * Espera a preparação e a fila terminarem. `kinds` limita a espera a esses tipos de análise: o piloto automático espera só o ROSTO antes
   * de transcrever e exportar (o recorte, que leva minutos, dá lugar a eles na placa) e só espera o recorte quando o vídeo o usa.
   */
  idle(opts?: { kinds?: readonly CameraKind[] }): Promise<void>
  /** Para tudo. O recorte em curso fica ANOTADO como interrompido (log + andamento no projeto) e continua ao reabrir; a promessa só resolve depois disso. */
  shutdown(): Promise<void>
}

export type CameraServiceDeps = {
  logger: Logger
  engine: CameraEngine
  read(id: string): Promise<{ project: Project; dir: string }>
  emit<K extends 'camera:prepare' | 'camera:job'>(channel: K, payload: IpcEvents[K]): void
  now?: () => number
  /** A placa é uma só: o recorte de fundo espera (e dá lugar a) exportação, transcrição e prévia. Sem isso, roda sempre. */
  gpu?: GpuGate
  /** Duração de cada pedaço do recorte (s). Padrão `MATTE_CHUNK_SECONDS`; os testes usam pedaços curtos. */
  chunkSeconds?: number
  /** Quanto esperar o motor parar sozinho no fim do pedaço antes de matá-lo, quando a placa precisa ser liberada (ms). */
  stopGraceMs?: number
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const MAX_JOBS_KEPT = 50

/** Os arquivos que cada análise grava na pasta do projeto (todos em `media/`). */
const DERIVED_FILES: Record<CameraKind, readonly string[]> = {
  face: [FACE_FILE],
  matte: [MATTE_FILE, MATTE_META_FILE, MATTE_PARTIAL_FILE, MATTE_PROGRESS_FILE]
}

/** A limpeza do arquivo parcial falhou: o motivo precisa chegar à pessoa (um parcial aberto no Windows não se apaga). */
class CleanupError extends Error {
  override readonly name = 'CleanupError'
}

const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/** Os dois caminhos são o MESMO arquivo no disco (atalho rígido, nome em outra caixa)? */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })])
    return x.ino !== 0n && x.ino === y.ino && x.dev === y.dev
  } catch {
    return false
  }
}

/**
 * Antes de apagar ou substituir qualquer arquivo derivado (a máscara, o parcial, o JSON do rosto), confere que NENHUMA fonte do
 * documento (tela, câmera, voz, som do sistema, imagem de fundo) ocupa o lugar dele: um projeto cuja câmera se chama
 * `media/camera-matte.partial.mp4` perderia a própria gravação na limpeza. Compara os caminhos RESOLVIDOS (`realpath`).
 */
async function assertDerivedClear(project: Project, dir: string, kind: CameraKind): Promise<void> {
  const derived = await Promise.all(DERIVED_FILES[kind].map(async (rel) => ({ rel, real: await resolveProjectFile(dir, rel) })))
  for (const source of documentFilePaths(project)) {
    const real = await resolveProjectFile(dir, source.path, source.field)
    for (const d of derived) {
      if (samePath(real, d.real) || (await sameFile(real, d.real))) {
        throw new Error(
          `${source.field} do projeto ("${source.path}") ocupa o lugar de um arquivo que esta análise grava ("${d.rel}"). Por segurança nada foi apagado nem substituído: troque o nome desse arquivo no projeto e tente de novo.`
        )
      }
    }
  }
}

/** Apaga o arquivo parcial (com novas tentativas: o Windows demora a soltar um arquivo que acabou de fechar); se não conseguir, AVISA. */
async function removePartial(path: string, rel: string): Promise<void> {
  try {
    await rm(path, { force: true, maxRetries: 8, retryDelay: 250 })
  } catch (err) {
    throw new CleanupError(`Não consegui apagar o arquivo parcial do recorte (${rel}): ${messageOf(err)}. Feche o que estiver usando esse arquivo e tente de novo.`)
  }
}

/** O que o arquivo da análise guarda para saber se ainda vale: a câmera de onde saiu (caminho e data do arquivo). */
type FaceFileHead = { version?: number; source?: string; sourceMtimeMs?: number }

export function createCameraService(deps: CameraServiceDeps): CameraService {
  const { logger, engine } = deps
  const now = deps.now ?? ((): number => Date.now())
  const chunkSeconds = deps.chunkSeconds ?? MATTE_CHUNK_SECONDS
  const stopGraceMs = deps.stopGraceMs ?? 20_000
  /** O app está fechando: o que for interrompido agora fica anotado como "interrompido" (continua ao reabrir), não como cancelado. */
  let closing = false

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
  const queue: { projectId: string; kind: CameraKind; force: boolean }[] = []
  let running: { projectId: string; kind: CameraKind; ctl: AbortController; promise: Promise<void> } | null = null
  /**
   * Pedidos que já começaram (consulta ao motor, leitura do projeto, cache) mas ainda não chegaram à fila. A CHAVE é reservada aqui,
   * de forma síncrona, antes de qualquer `await`: duas chamadas simultâneas não passam as duas pela consulta inicial. `cancelled`
   * é o aviso de que a pessoa cancelou enquanto o pedido ainda se preparava.
   */
  const starting = new Map<string, { promise: Promise<CameraJob>; cancelled: boolean }>()
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

  type CameraFile = { project: Project; dir: string; video: string; mtimeMs: number; relPath: string }
  /** O arquivo da câmera do documento: caminho absoluto (resolvido) e a data dele; ou `null` se o projeto não tem câmera. */
  async function cameraFile(projectId: string): Promise<CameraFile | null> {
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

  /** Anota no projeto que o recorte foi PEDIDO (a fila pode demorar, e o app pode fechar antes de ele começar): ao reabrir, `recoverMatte` o encontra. */
  async function markMatteRequested(projectId: string, cam: CameraFile): Promise<MatteProgress> {
    const progressFile = await resolveProjectFile(cam.dir, MATTE_PROGRESS_FILE)
    const existing = await readProgress(progressFile)
    if (existing && progressMatchesCamera(existing, cam.relPath, cam.mtimeMs, chunkSeconds)) return existing
    if (existing) {
      // o andamento é de OUTRA câmera (o arquivo foi trocado): os pedaços não servem
      logger.warn(`Recorte do fundo do projeto ${projectId}: a câmera do projeto mudou desde o último recorte; os pedaços guardados foram descartados.`)
      await removePartsDir(await resolveProjectFile(cam.dir, MATTE_PARTS_DIR))
    }
    const stamp = new Date(now()).toISOString()
    const marker: MatteProgress = {
      version: MATTE_PROGRESS_VERSION,
      source: cam.relPath,
      sourceMtimeMs: cam.mtimeMs,
      chunkSeconds,
      chunks: [],
      status: 'running',
      fraction: 0,
      attempts: 0,
      startedAt: stamp,
      updatedAt: stamp
    }
    await writeProgress(progressFile, marker)
    return marker
  }

  async function runMatteJob(projectId: string, cam: CameraFile, ctl: AbortController, force: boolean): Promise<void> {
    const kind: CameraKind = 'matte'
    await assertDerivedClear(cam.project, cam.dir, kind)
    const partial = await resolveProjectFile(cam.dir, MATTE_PARTIAL_FILE)
    const partsDir = await resolveProjectFile(cam.dir, MATTE_PARTS_DIR)
    const progressFile = await resolveProjectFile(cam.dir, MATTE_PROGRESS_FILE)
    const stopFile = join(partsDir, 'parar')
    const durationMs = cam.project.sources.camera?.durationMs ?? 0
    const label = `Recorte do fundo do projeto ${projectId}`
    const startedAt = now()

    // um `.partial.mp4` (de antes dos pedaços, ou de uma junção interrompida) não abre e não se retoma: sai, com aviso no log
    const oldPartialBytes = await stat(partial).then((i) => i.size, () => 0)
    await removePartial(partial, MATTE_PARTIAL_FILE)
    const resume = await loadResume({ partsDir, progressFile, cameraPath: cam.relPath, cameraMtimeMs: cam.mtimeMs, chunkSeconds, force })
    if (resume.discarded) {
      logger.warn(
        resume.restart
          ? `${label}: ${resume.discarded}; os pedaços guardados foram descartados e o recorte recomeça do zero.`
          : `${label}: ${resume.discarded}; continuo dos ${resume.chunks.length} pedaço(s) inteiros.`
      )
    }
    if (oldPartialBytes > 0) {
      logger.warn(`${label}: sobrou um recorte parcial de antes dos pedaços (${(oldPartialBytes / 1024 / 1024).toFixed(1)} MB, sem índice: não abre). Descartado; ${resume.chunks.length > 0 ? `continuo dos ${resume.chunks.length} pedaços prontos` : 'refaço em pedaços'}.`)
    }

    const stamp = (): string => new Date(now()).toISOString()
    let progress: MatteProgress = {
      version: MATTE_PROGRESS_VERSION,
      source: cam.relPath,
      sourceMtimeMs: cam.mtimeMs,
      chunkSeconds,
      chunks: resume.chunks,
      status: 'running',
      fraction: chunksFraction(resume.chunks.length, chunkSeconds, durationMs),
      attempts: (resume.progress?.attempts ?? 0) + 1,
      startedAt: resume.progress?.startedAt || stamp(),
      updatedAt: stamp()
    }
    let writes: Promise<void> = Promise.resolve()
    /** Guarda o andamento no projeto, uma gravação por vez e em ordem. Falhar ao guardar é aviso no log, não derruba o recorte. */
    const save = (patch: Partial<MatteProgress>): Promise<void> => {
      progress = { ...progress, ...patch, updatedAt: stamp() }
      const snapshot = progress
      writes = writes.then(() => writeProgress(progressFile, snapshot)).catch((err) => logger.warn(`${label}: não consegui guardar o andamento no projeto: ${messageOf(err)}`))
      return writes
    }
    const resumed = (): boolean => progress.chunks.length > 0
    const pct = (f: number): number => Math.round(f * 100)

    let best = progress.fraction
    let lastPct = -1
    const report = (f: number): void => {
      best = Math.max(best, Math.min(0.999, f))
      if (pct(best) === lastPct) return
      lastPct = pct(best)
      setJob({ projectId, kind, state: 'running', fraction: best, ...(resumed() ? { resumed: true } : {}) })
    }
    const onChunk = (chunk: MatteChunk): void => {
      if (progress.chunks.some((c) => c.index === chunk.index)) return
      const chunks = [...progress.chunks, chunk]
      void save({ chunks, fraction: Math.min(0.99, Math.max(best, chunksFraction(chunks.length, chunkSeconds, durationMs))) })
      logger.info(`${label}: pedaço ${chunk.index + 1} pronto (${chunk.frames} quadros, ${Math.round(chunk.bytes / 1024)} KB).`)
    }

    await save({})
    if (resumed()) {
      logger.info(`${label}: retomando do pedaço ${progress.chunks.length + 1} (${pct(best)}% já pronto; rodada ${progress.attempts}).`)
    } else {
      logger.info(`${label}: começando, em pedaços de ${chunkSeconds} s${progress.attempts > 1 ? ` (rodada ${progress.attempts})` : ''}.`)
    }
    lastPct = -1
    report(best)

    try {
      let result: MatteResult | undefined
      for (;;) {
        // a placa tem dono mais importante agora (exportação, transcrição, prévia)? espera a vez, sem perder nada do que está pronto
        let announced = false
        while (deps.gpu?.busy()) {
          if (!announced) {
            announced = true
            const why = deps.gpu.busy()
            logger.info(`${label}: em espera, a placa está com ${why === 'preview' ? 'a prévia do editor' : 'uma exportação ou transcrição'}; continua do pedaço ${progress.chunks.length + 1} quando ela ficar livre.`)
            setJob({ projectId, kind, state: 'queued', fraction: best, waiting: 'gpu', ...(resumed() ? { resumed: true } : {}) })
          }
          await deps.gpu.whenIdle(ctl.signal)
        }
        if (announced) {
          logger.info(`${label}: a placa ficou livre; continuando do pedaço ${progress.chunks.length + 1}.`)
          lastPct = -1
          report(best)
        }
        if (ctl.signal.aborted) throw new Error('Cancelado.')

        const run = new AbortController()
        const relay = (): void => run.abort()
        ctl.signal.addEventListener('abort', relay, { once: true })
        let yielded = false
        let grace: NodeJS.Timeout | undefined
        const offBusy = deps.gpu?.onBusy(() => {
          if (yielded) return
          yielded = true
          // pede ao motor para parar no fim do pedaço em curso; passado o prazo, ele é encerrado à força (perde só esse pedaço)
          void writeFile(stopFile, '').catch(() => undefined)
          grace = setTimeout(() => run.abort(), stopGraceMs)
        })
        try {
          result = await engine.makeMatte({
            video: cam.video,
            out: partial,
            durationMs,
            signal: run.signal,
            onProgress: report,
            lowPriority: true,
            parts: { dir: partsDir, chunkSeconds, done: progress.chunks, onChunk, stopFile }
          })
        } catch (err) {
          if (!(yielded && run.signal.aborted && !ctl.signal.aborted)) throw err
          result = undefined // encerrado à força depois do prazo: o pedaço em curso se perdeu, os prontos ficam
        } finally {
          offBusy?.()
          if (grace) clearTimeout(grace)
          ctl.signal.removeEventListener('abort', relay)
          await rm(stopFile, { force: true }).catch(() => undefined)
        }
        if (result?.resume) {
          logger.info(
            result.resume === 'checkpoint'
              ? `${label}: retomada exata (o estado do RVM voltou do ponto guardado: a máscara é a mesma da rodada contínua).`
              : `${label}: retomada com aquecimento de ${MATTE_WARMUP_SECONDS} s (o ponto de retomada não existia: a máscara fica visualmente igual, não idêntica).`
          )
        }
        if (result && !result.stopped) break
        await writes
        const again = await loadResume({ partsDir, progressFile, cameraPath: cam.relPath, cameraMtimeMs: cam.mtimeMs, chunkSeconds })
        progress = { ...progress, chunks: again.chunks }
        if (yielded) logger.info(`${label}: parou no pedaço ${again.chunks.length} para dar lugar a outro trabalho na placa.`)
      }

      if (ctl.signal.aborted) throw new Error('Cancelado.')
      const final = await resolveProjectFile(cam.dir, MATTE_FILE)
      try {
        await rename(partial, final)
      } catch {
        // o Windows não troca um arquivo que está aberto (a prévia lendo o recorte antigo): apaga o antigo e tenta de novo
        await rm(final, { force: true })
        await rename(partial, final)
      }
      const meta: MatteMeta = {
        version: MATTE_VERSION,
        engine: result!.engine,
        source: cam.relPath,
        sourceMtimeMs: cam.mtimeMs,
        frames: result!.frames,
        fps: result!.fps,
        frame: result!.frame,
        createdAt: new Date(now()).toISOString()
      }
      await writeFileAtomic(await resolveProjectFile(cam.dir, MATTE_META_FILE), `${JSON.stringify(meta, null, 2)}\n`)
      const info = await stat(final)
      // pronto: os pedaços e o andamento não servem mais
      await writes
      await removePartsDir(partsDir).catch((err) => logger.warn(`${label}: não consegui apagar os pedaços já juntados: ${messageOf(err)}`))
      await removeProgress(progressFile).catch((err) => logger.warn(`${label}: não consegui apagar o andamento já concluído: ${messageOf(err)}`))
      setJob({ projectId, kind, state: 'done', fraction: 1, url: mediaUrl(projectId, MATTE_FILE, Math.trunc(info.mtimeMs)), ...(progress.attempts > 1 || resume.chunks.length > 0 ? { resumed: true } : {}) })
      const elapsed = (now() - startedAt) / 1000
      logger.info(
        `Recorte do fundo do projeto ${projectId}: ${result!.frames} quadros em ${result!.seconds.toFixed(1)} s no motor, ${elapsed.toFixed(1)} s no total (${result!.msPerFrame.toFixed(1)} ms por quadro, ${result!.device}, ${result!.engine})${progress.attempts > 1 ? `, em ${progress.attempts} rodadas` : ''}.`
      )
    } catch (err) {
      await writes
      if (ctl.signal.aborted) {
        const done = progress.chunks.length
        if (closing) {
          await save({ status: 'interrupted', error: 'O app foi fechado no meio do recorte.' })
          logger.warn(`${label}: interrompido pelo fechamento do app em ${pct(best)}% (${done} pedaço(s) prontos); continua do pedaço ${done + 1} quando o app abrir de novo.`)
        } else {
          await save({ status: 'cancelled', error: 'Cancelado pela pessoa.' })
          logger.warn(`${label}: cancelado em ${pct(best)}%; os ${done} pedaço(s) prontos ficam guardados para continuar.`)
        }
      } else if (err instanceof MatteJoinError) {
        // a junção não bateu: os pedaços não servem, o próximo "tentar de novo" começa do zero
        logger.error(`${label}: ${messageOf(err)} Os pedaços foram descartados.`, err)
        await removePartsDir(partsDir).catch(() => undefined)
        await removeProgress(progressFile).catch(() => undefined)
      } else {
        await save({ status: 'failed', error: messageOf(err) })
      }
      // o que falhou (ou o cancelamento) vem primeiro; se a limpeza também falhar, a limpeza é o que a pessoa precisa ver
      await removePartial(partial, MATTE_PARTIAL_FILE).catch((cleanup) => {
        logger.error(`${label}: ${messageOf(err)}`, err)
        throw cleanup
      })
      throw err
    }
  }

  async function runJob(projectId: string, kind: CameraKind, ctl: AbortController, force = false): Promise<void> {
    // o recorte anuncia o próprio andamento (com o "retomando"); o rosto começa em 0
    if (kind !== 'matte') setJob({ projectId, kind, state: 'running', fraction: 0 })
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
      if (kind === 'matte') {
        await runMatteJob(projectId, cam, ctl, force)
        return
      }
      if (kind === 'face') {
        await assertDerivedClear(cam.project, cam.dir, kind)
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
      if (ctl.signal.aborted && !(err instanceof CleanupError)) {
        setJob({ projectId, kind, state: 'cancelled', fraction: 0, error: closing ? 'O app foi fechado no meio; a análise continua quando ele abrir de novo.' : 'Análise cancelada.' })
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
    const promise = runJob(next.projectId, next.kind, ctl, next.force).finally(() => {
      running = null
      pump()
    })
    running = { ...next, ctl, promise }
  }

  /** A pessoa cancelou o recorte na fila: o pedido anotado no projeto passa a "cancelado" (não recomeça sozinho ao reabrir). */
  async function markCancelledWhileQueued(projectId: string): Promise<void> {
    try {
      const cam = await cameraFile(projectId)
      if (!cam) return
      const file = await resolveProjectFile(cam.dir, MATTE_PROGRESS_FILE)
      const progress = await readProgress(file)
      if (progress) await writeProgress(file, { ...progress, status: 'cancelled', error: 'Cancelado pela pessoa.', updatedAt: new Date(now()).toISOString() })
      logger.info(`Recorte do fundo do projeto ${projectId}: cancelado na fila.`)
    } catch (err) {
      logger.warn(`Recorte do fundo do projeto ${projectId}: não consegui anotar o cancelamento no projeto: ${messageOf(err)}`)
    }
  }

  async function startAnalysis(projectId: string, kind: CameraKind, opts: { force?: boolean }, entry: { cancelled: boolean }): Promise<CameraJob> {
    const cancelledJob = (): CameraJob => {
      const job: CameraJob = { projectId, kind, state: 'cancelled', fraction: 0, error: 'Análise cancelada.' }
      setJob(job)
      return job
    }
    const check = await engine.check()
    const feature = kind === 'face' ? check.face : check.matte
    if (feature.state !== 'ready') throw new Error(feature.detail ?? 'A análise da câmera ainda não está preparada.')
    const cam = await cameraFile(projectId)
    if (!cam) throw new Error('Esta gravação não tem o vídeo da câmera, então não há o que analisar.')
    await assertDerivedClear(cam.project, cam.dir, kind)
    if (kind === 'face' && !opts.force) {
      const fresh = await freshFace(projectId, cam.dir, cam.relPath, cam.mtimeMs)
      if (fresh) {
        const job: CameraJob = { projectId, kind, state: 'done', fraction: 1, url: fresh.url, faces: fresh.faces, coverage: fresh.coverage }
        setJob(job)
        return job
      }
    }
    if (kind === 'matte' && !opts.force) {
      const fresh = await freshMatte(projectId, cam.dir, cam.relPath, cam.mtimeMs)
      if (fresh) {
        const job: CameraJob = { projectId, kind, state: 'done', fraction: 1, url: fresh.url }
        setJob(job)
        return job
      }
    }
    if (entry.cancelled) return cancelledJob()
    // anota no projeto que o recorte foi pedido: se o app fechar antes de ele começar (ou no meio), ao reabrir ele continua
    let prior: MatteProgress | null = null
    if (kind === 'matte') prior = await markMatteRequested(projectId, cam).catch((err) => { logger.warn(`Recorte do fundo do projeto ${projectId}: não consegui anotar o pedido no projeto: ${messageOf(err)}`); return null })
    // com pedaços prontos de uma rodada anterior (e sem "recortar de novo"), o aviso já nasce "continuando" com a porcentagem de onde parou
    const keeps = kind === 'matte' && !opts.force && (prior?.chunks.length ?? 0) > 0
    const job: CameraJob = { projectId, kind, state: 'queued', fraction: keeps ? chunksFraction(prior!.chunks.length, chunkSeconds, cam.project.sources.camera?.durationMs ?? 0) : 0, ...(keeps ? { resumed: true } : {}) }
    setJob(job)
    queue.push({ projectId, kind, force: opts.force === true })
    pump()
    return job
  }

  const api: CameraService = {
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

    analyze(projectId, kind, opts = {}) {
      // tudo daqui até o `starting.set` é SÍNCRONO: é o que impede duas chamadas simultâneas de duplicar a análise
      if (!CAMERA_KINDS.includes(kind)) return Promise.reject(new Error('Tipo de análise desconhecido.'))
      const key = keyOf(projectId, kind)
      const existing = jobs.get(key)
      if (existing && (existing.state === 'queued' || existing.state === 'running')) return Promise.resolve(existing)
      const pending = starting.get(key)
      if (pending) {
        // quem pede "refazer" enquanto outro pedido ainda se prepara espera esse terminar e então decide em cima do resultado dele
        return opts.force ? pending.promise.then(() => api.analyze(projectId, kind, opts)) : pending.promise
      }
      const entry = { promise: undefined as unknown as Promise<CameraJob>, cancelled: false }
      entry.promise = startAnalysis(projectId, kind, opts, entry).finally(() => {
        if (starting.get(key) === entry) starting.delete(key)
      })
      starting.set(key, entry)
      return entry.promise
    },

    cancel(projectId, kind) {
      const key = keyOf(projectId, kind)
      const pending = starting.get(key)
      if (pending) pending.cancelled = true
      // TODAS as entradas da fila (não só a primeira) e também a que está rodando agora
      let removed = false
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i]!.projectId === projectId && queue[i]!.kind === kind) {
          queue.splice(i, 1)
          removed = true
        }
      }
      if (removed) {
        setJob({ projectId, kind, state: 'cancelled', fraction: 0, error: 'Análise cancelada.' })
        // cancelou na fila: o pedido anotado no projeto não pode fazer o recorte começar sozinho ao reabrir
        if (kind === 'matte') void markCancelledWhileQueued(projectId)
      }
      if (running?.projectId === projectId && running.kind === kind) running.ctl.abort()
    },

    async result(projectId, kind) {
      const cam = await cameraFile(projectId)
      if (!cam) return null
      if (kind === 'face') return (await freshFace(projectId, cam.dir, cam.relPath, cam.mtimeMs))?.url ?? null
      if (kind === 'matte') return (await freshMatte(projectId, cam.dir, cam.relPath, cam.mtimeMs))?.url ?? null
      return null
    },

    async idle(opts) {
      const only = opts?.kinds
      const counts = (kind: CameraKind): boolean => !only || only.includes(kind)
      for (;;) {
        // só há o que esperar se o que está rodando OU o que está na fila é de um dos tipos pedidos (ou se o motor está se preparando)
        const interesting = (running !== null && counts(running.kind)) || queue.some((q) => counts(q.kind))
        if (!preparing && !interesting) return
        const waits: Promise<unknown>[] = []
        if (preparing) waits.push(preparing.promise)
        // a fila só anda quando o que roda agora termina (seja do tipo que for)
        if (running) waits.push(running.promise)
        await Promise.allSettled(waits)
        await new Promise((r) => setTimeout(r, 0))
      }
    },

    async recoverMatte(projectId) {
      try {
        const check = await engine.check()
        if (check.matte.state !== 'ready') return 'idle'
        const cam = await cameraFile(projectId)
        if (!cam) return 'idle'
        const label = `Recorte do fundo do projeto ${projectId}`
        const progressFile = await resolveProjectFile(cam.dir, MATTE_PROGRESS_FILE)
        const partsDir = await resolveProjectFile(cam.dir, MATTE_PARTS_DIR)
        const partial = await resolveProjectFile(cam.dir, MATTE_PARTIAL_FILE)
        const progress = await readProgress(progressFile)
        const partialBytes = await stat(partial).then((i) => i.size, () => 0)
        if (await freshMatte(projectId, cam.dir, cam.relPath, cam.mtimeMs)) {
          if (progress || partialBytes > 0) {
            // sobras de um recorte que já terminou (o app fechou entre juntar e limpar)
            await rm(partial, { force: true }).catch(() => undefined)
            await removePartsDir(partsDir).catch(() => undefined)
            await removeProgress(progressFile).catch(() => undefined)
            logger.info(`${label}: o recorte já estava pronto; limpei as sobras do andamento.`)
          }
          return 'idle'
        }
        const active = jobs.get(keyOf(projectId, 'matte'))
        if (active && (active.state === 'queued' || active.state === 'running')) return 'idle'
        const durationMs = cam.project.sources.camera?.durationMs ?? 0
        if (progress && progressMatchesCamera(progress, cam.relPath, cam.mtimeMs, chunkSeconds)) {
          if (progress.status === 'cancelled') return 'idle'
          if (progress.status === 'failed') {
            logger.warn(`${label}: a última tentativa falhou (${progress.error ?? 'sem motivo anotado'}); o editor mostra o aviso com "Tentar de novo".`)
            setJob({ projectId, kind: 'matte', state: 'error', fraction: 0, error: progress.error ?? 'O recorte do fundo falhou da última vez.' })
            return 'failed'
          }
          const done = progress.chunks.length
          if (done > 0) {
            logger.warn(
              `${label}: estava em andamento (${Math.round(chunksFraction(done, progress.chunkSeconds, durationMs) * 100)}%, ${done} pedaço(s) prontos) quando o app fechou; vou continuar do pedaço ${done + 1}.`
            )
          } else {
            logger.info(`${label}: estava na fila quando o app fechou; vou começar agora.`)
          }
          await api.analyze(projectId, 'matte')
          return 'resumed'
        }
        if (partialBytes > 0) {
          logger.warn(`${label}: sobrou um recorte parcial antigo (${(partialBytes / 1024 / 1024).toFixed(1)} MB, sem índice, não abre); vou refazer em pedaços.`)
          await api.analyze(projectId, 'matte')
          return 'regenerated'
        }
        return 'idle'
      } catch (err) {
        logger.warn(`Recorte do fundo do projeto ${projectId}: não consegui conferir se ficou pela metade: ${messageOf(err)}`)
        return 'idle'
      }
    },

    shutdown() {
      closing = true
      preparing?.ctl.abort()
      const current = running
      for (const q of queue) logger.info(`Recorte do fundo do projeto ${q.projectId}: estava na fila e fica anotado no projeto; começa quando o app abrir de novo.`)
      queue.length = 0
      current?.ctl.abort()
      return current ? current.promise.then(() => undefined, () => undefined) : Promise.resolve()
    }
  }
  return api
}
