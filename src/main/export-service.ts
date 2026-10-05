/**
 * Exportação 16:9 no processo principal. Orquestra três coisas e confere o resultado:
 *
 *  1. ÁUDIO (ffmpeg): trechos mantidos com `atrim` + fade de 30 ms → cadeia de voz → mistura com o
 *     som do sistema → `loudnorm` em dois passes → AAC. O grafo vai em arquivo (centenas de trechos
 *     estouram a linha de comando do Windows).
 *  2. VÍDEO (janela escondida, processo à parte da interface): mediabunny lê as mídias por
 *     `tomada-media://`, `evaluateScene` + `renderFrame` desenham cada quadro e o VideoEncoder
 *     codifica H.264 por hardware; os pedaços chegam aqui (posição + bytes) e vão direto ao disco.
 *  3. MUX + CONFERÊNCIA: `-c copy -movflags +faststart`; ffprobe confere duração, taxa constante,
 *     trilhas e a diferença áudio × vídeo (> 50 ms = erro visível).
 *
 * Áudio e vídeo rodam ao mesmo tempo. Cancelar derruba a janela e o ffmpeg e apaga o parcial.
 * Sem Electron: a janela entra por interface, então roda em teste com uma janela falsa.
 */
import { randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { copyFile, link, mkdir, open, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { clipDocument, normalizeRanges } from '@shared/clips'
import {
  EXPORT_RESOLUTION_LABEL,
  etaMs,
  exportBitrate,
  exportFileName,
  exportFormat,
  outputFrameCount,
  sanitizeFileName
} from '@shared/export'
import { EVENT_FILES } from '@shared/events'
import { FACE_FILE } from '@shared/face'
import type { ExportJob, ExportProgress, ExportReport, ExportRequest, ExporterResult } from '@shared/ipc'
import { mediaUrl } from '@shared/media-url'
import { projectDurationMs } from '@shared/project'
import { buildClipText, buildYoutubeText, fallbackClipMeta, heuristicChapters, resolveClipMeta } from '@shared/publish'
import { uniqueName } from '@shared/recording'
import { keptRanges, outputDuration } from '@shared/timeline'
import { projectForFormat } from '@shared/vertical'
import type { Clip, Project, Word } from '@shared/types'
import {
  VERTICAL_AUDIO_BITRATE,
  buildAudioArgs,
  buildAudioGraph,
  buildMeasureArgs,
  buildMuxArgs,
  buildSilentAudioArgs,
  parseLoudnormMeasure
} from './audio-graph'
import type { Ffmpeg } from './ffmpeg'
import { pathExists } from './fs-utils'
import type { Logger } from './logger'
import type { OutputDirs } from './path-guard'
import { assertDocumentPaths, isInside, resolveProjectFile } from './project-files'

/** Diferença máxima aceita entre a duração do áudio e a do vídeo (ms). */
export const MAX_AV_DIFF_MS = 50
/** Sem sinal de vida da janela de vídeo por tanto tempo, a exportação é dada como travada. */
export const STALL_TIMEOUT_MS = 120_000

export class ExportError extends Error {
  override readonly name = 'ExportError'
}
class CancelledError extends Error {
  override readonly name = 'CancelledError'
}

export type ExporterWindow = { destroy(): void }

export type ExportServiceDeps = {
  logger: Logger
  /** Lê o projeto (documento + pasta). */
  read(id: string): Promise<{ project: Project; dir: string }>
  /** As palavras da transcrição do projeto (legendas), ou `null` se ele não tem. Só texto e tempos. */
  words?(id: string): Promise<Word[] | null>
  ffmpeg(): Ffmpeg | null
  /**
   * Pastas de destino que o usuário escolheu nesta sessão (diálogo nativo do processo principal). O destino da
   * exportação só pode ser a pasta `exports/` do projeto ou uma destas: o caminho que vem da interface não vale por si.
   */
  outputDirs: Pick<OutputDirs, 'resolve'>
  /** Abre a janela escondida que renderiza o vídeo. `onGone` avisa se ela caiu antes de terminar. */
  openExporterWindow(exportId: string, hooks: { onGone(reason: string): void }): ExporterWindow
  emit(progress: ExportProgress): void
  /** Relógio monotônico em ms. */
  now(): number
  /** Troca o tempo limite de "travou" (testes). */
  stallTimeoutMs?: number
}

export interface ExportService {
  start(request: ExportRequest): Promise<{ exportId: string }>
  cancel(exportId: string): Promise<void>
  status(): ExportProgress | null
  /** Canais da janela escondida. */
  job(exportId: string): ExportJob
  write(exportId: string, position: number, data: Uint8Array): Promise<void>
  progress(exportId: string, frame: number, renderFps: number | null): void
  finish(exportId: string, result: ExporterResult): void
  /**
   * O arquivo (caminho já resolvido com `realpath`) é a saída de uma exportação concluída nesta sessão? É o que
   * deixa `files:open` tocar o vídeo exportado numa pasta fora da raiz dos projetos.
   */
  isOutput(realPath: string): boolean
  /** Espera a exportação em andamento terminar (testes). */
  idle(): Promise<void>
  shutdown(): Promise<void>
}

type Run = {
  id: string
  req: ExportRequest
  /** O documento que se exporta: o do projeto, ou (num corte vertical) o do projeto como o corte o enxerga. */
  project: Project
  /** O documento como está no disco (o texto de publicação lê o `meta` dele). */
  stored: Project
  /** O corte que está sendo exportado e o número dele na lista (`01`, `02`…); `null` na exportação do vídeo inteiro. */
  clip: Clip | null
  clipNumber: number
  words: Word[] | null
  dir: string
  startedAt: number
  abort: AbortController
  cancelled: boolean
  win: ExporterWindow | null
  /** Pasta onde o arquivo final (e o temporário, ao lado dele) é gravado. */
  outDir: string
  tmpDir: string
  videoPath: string
  audioPath: string
  /** Nome escolhido (sem extensão) e caminho final; o definitivo só é fixado ao mover, sem sobrescrever. */
  stem: string
  finalPath: string
  partialFinal: string
  /** Arquivos do documento já resolvidos (absolutos, dentro da pasta do projeto). */
  files: { voice: string | null; system: string | null; screen: string | null; camera: string | null }
  handle: FileHandle | null
  progress: ExportProgress
  video: { resolve(r: ExporterResult): void; reject(e: unknown): void } | null
  audioFraction: number
  videoFraction: number
  lastSign: number
  lastEmit: number
  renderStartedAt: number | null
  renderEndedAt: number | null
  timing: string | null
  done: Promise<void>
  job: ExportJob
}

/** URL do arquivo de eventos, ou null se ele não existe (gravação só de câmera): evita um 404 no console. */
async function eventUrl(projectId: string, dir: string, rel: string): Promise<string | null> {
  return (await pathExists(await resolveProjectFile(dir, rel))) ? mediaUrl(projectId, rel) : null
}

/**
 * Põe o arquivo pronto no nome final SEM sobrescrever nada: `link` falha com EEXIST se o nome já existe (e
 * onde o sistema de arquivos não faz link, `copyFile` com COPYFILE_EXCL faz o mesmo). Devolve false se o nome
 * foi tomado no meio do caminho.
 */
async function moveWithoutOverwrite(from: string, to: string): Promise<boolean> {
  try {
    await link(from, to)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
  }
  try {
    await copyFile(from, to, constants.COPYFILE_EXCL)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    await rm(to, { force: true }).catch(() => undefined) // meio arquivo (disco cheio): nunca fica com cara de bom
    throw err
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Grava um texto ao lado do vídeo SEM sobrescrever nada (`wx`; nome tomado ganha " (2)"). Devolve o caminho. */
async function writeTextBeside(dir: string, stem: string, text: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = uniqueName(stem, (n) => existsSync(join(dir, `${n}.txt`)))
    const target = join(dir, `${name}.txt`)
    try {
      await writeFile(target, text, { encoding: 'utf8', flag: 'wx' })
      return target
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new ExportError(`Não achei um nome livre para o texto em ${dir}.`)
}

/** Chave de comparação de um arquivo (caminho real, sem diferença de maiúsculas: o Windows não distingue). */
async function outputKey(path: string): Promise<string> {
  return (await realpath(path)).toLowerCase()
}

export function createExportService(deps: ExportServiceDeps): ExportService {
  const { logger } = deps
  let current: Run | null = null
  let last: ExportProgress | null = null
  /** Saídas de exportações concluídas nesta sessão (chave de `outputKey`). */
  const outputs = new Set<string>()

  /** Escolhe um nome livre e move o parcial para ele; o nome tomado no meio do caminho só faz tentar o próximo. */
  async function placeFinal(run: Run): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const name = uniqueName(run.stem, (n) => existsSync(join(run.outDir, `${n}.mp4`)))
      const target = join(run.outDir, `${name}.mp4`)
      if (await moveWithoutOverwrite(run.partialFinal, target)) return target
    }
    throw new ExportError(`Não consegui achar um nome livre para o arquivo em ${run.outDir}.`)
  }

  const emit = (run: Run, force = false): void => {
    const now = deps.now()
    if (!force && now - run.lastEmit < 100) return
    run.lastEmit = now
    const p = run.progress
    // 90% o vídeo, 5% o áudio, 5% a emenda e a conferência
    const mux = p.phase === 'checking' || p.phase === 'done' ? 0.05 : 0
    p.fraction = Math.min(1, run.videoFraction * 0.9 + run.audioFraction * 0.05 + mux)
    p.audioReady = run.audioFraction >= 1
    last = { ...p }
    deps.emit({ ...p })
  }

  const setPhase = (run: Run, phase: ExportProgress['phase'], extra: Partial<ExportProgress> = {}): void => {
    run.progress = { ...run.progress, phase, ...extra }
    emit(run, true)
  }

  const assertActive = (id: string): Run => {
    if (!current || current.id !== id) throw new ExportError('Essa exportação não está mais em andamento.')
    return current
  }

  // --- texto que acompanha o vídeo ---------------------------------------------------------------
  /**
   * Corte vertical: `<n> - <título>.txt` com título, gancho, legenda e hashtags de TikTok, Reels e Shorts (o que a pessoa
   * guardou na aba Publicar; o que faltar vem do texto sem IA). 16:9: `<título> - YouTube.txt` com 3 títulos, a descrição
   * com os capítulos no tempo de saída e as tags. O vertical do vídeo inteiro não leva texto.
   */
  async function writeCompanionText(run: Run): Promise<Partial<ExportProgress>> {
    try {
      if (run.clip) {
        const meta = run.stored.meta?.perClip?.[run.clip.id]
        const text = buildClipText(run.clip, resolveClipMeta(meta, fallbackClipMeta(run.clip, run.words)))
        const stem = basename(run.finalPath).replace(/\.mp4$/i, '')
        const path = await writeTextBeside(run.outDir, stem, text)
        outputs.add(await outputKey(path))
        return { textPath: path }
      }
      if (run.req.format === 'vertical') return {}
      const youtube = run.stored.meta?.youtube
      const durationMs = projectDurationMs(run.stored)
      let chapters = youtube?.chapters ?? []
      let note: string | undefined
      let why: string | undefined
      if (chapters.length === 0 && run.words && run.words.length > 0) {
        const auto = heuristicChapters(run.words, durationMs, run.stored.cuts)
        chapters = auto.chapters
        if (chapters.length > 0) note = 'Capítulos gerados pelas pausas, sem IA: confira os títulos.'
        else if (auto.why) why = auto.why
      }
      const text = buildYoutubeText({
        title: run.stored.title,
        titles: youtube?.titles ?? [],
        description: youtube?.description ?? '',
        tags: youtube?.tags ?? [],
        chapters,
        kept: keptRanges(durationMs, run.stored.cuts),
        ...(note ? { chaptersNote: note } : {}),
        ...(why ? { chaptersWhy: why } : {})
      })
      const path = await writeTextBeside(run.outDir, `${sanitizeFileName(run.stored.title)} - YouTube`, text)
      outputs.add(await outputKey(path))
      return { textPath: path }
    } catch (err) {
      logger.error(`Exportação ${run.id}: o vídeo ficou pronto, mas não consegui gravar o texto que o acompanha`, err)
      return { message: `O vídeo foi exportado, mas não consegui gravar o texto que o acompanha: ${messageOf(err)}` }
    }
  }

  // --- áudio -----------------------------------------------------------------------------------
  async function renderAudio(run: Run, ff: Ffmpeg): Promise<void> {
    const { project } = run
    const durationMs = projectDurationMs(project)
    const kept = keptRanges(durationMs, project.cuts)
    const outMs = outputDuration(durationMs, project.cuts)
    const signal = run.abort.signal
    const bitrate = run.req.format === 'vertical' ? VERTICAL_AUDIO_BITRATE : undefined

    const voicePath = run.files.voice
    const systemPath = run.files.system
    const hasVoice = voicePath !== null && (await pathExists(voicePath))
    const hasSystem = systemPath !== null && (await pathExists(systemPath))
    if (project.sources.voice && !hasVoice) logger.warn(`Exportação: o arquivo de voz do projeto não existe (${voicePath}); a trilha sai sem voz.`)

    if (!hasVoice && !hasSystem) {
      await ff.run(buildSilentAudioArgs({ durationMs: outMs, output: run.audioPath, ...(bitrate ? { bitrate } : {}) }), { signal })
      run.audioFraction = 1
      emit(run)
      return
    }

    const inputs: string[] = []
    const voice = hasVoice ? { input: inputs.push(voicePath!) - 1, offsetMs: project.sync.cameraOffsetMs, channels: 1 as const } : null
    const system = hasSystem ? { input: inputs.push(systemPath!) - 1, offsetMs: project.sync.screenOffsetMs, channels: 2 as const } : null

    // passe 1: mede (ffmpeg imprime o JSON do loudnorm no stderr)
    const voiceMutes = project.mutes?.filter((m) => m.enabled).map((m) => ({ start: m.start, end: m.end }))
    const graph1 = buildAudioGraph({ kept, voice, system, mode: 'measure', ...(voiceMutes?.length ? { voiceMutes } : {}) })
    const graphFile1 = join(run.tmpDir, 'audio-medir.txt')
    await writeFile(graphFile1, graph1.graph, 'utf8')
    const measureRun = await ff.run(buildMeasureArgs({ inputs, graphFile: graphFile1 }), {
      signal,
      onProgress: (p) => {
        run.audioFraction = Math.min(0.5, (p.timeMs / Math.max(1, outMs)) * 0.5)
        emit(run)
      }
    })
    const measured = parseLoudnormMeasure(measureRun.stderr)
    if (!measured) logger.warn('Exportação: o primeiro passe do loudnorm não deu medição válida (faixa muda?); usando o passe único.')

    // passe 2: aplica
    const graph2 = buildAudioGraph({ kept, voice, system, mode: 'final', measured, ...(voiceMutes?.length ? { voiceMutes } : {}) })
    const graphFile2 = join(run.tmpDir, 'audio-final.txt')
    await writeFile(graphFile2, graph2.graph, 'utf8')
    await ff.run(buildAudioArgs({ inputs, graphFile: graphFile2, output: run.audioPath, ...(bitrate ? { bitrate } : {}) }), {
      signal,
      onProgress: (p) => {
        run.audioFraction = Math.min(0.99, 0.5 + (p.timeMs / Math.max(1, outMs)) * 0.5)
        emit(run)
      }
    })
    run.audioFraction = 1
    emit(run)
  }

  // --- vídeo -----------------------------------------------------------------------------------
  function renderVideo(run: Run): Promise<ExporterResult> {
    return new Promise<ExporterResult>((resolve, reject) => {
      run.video = { resolve, reject }
      run.renderStartedAt = deps.now()
      try {
        run.win = deps.openExporterWindow(run.id, {
          onGone: (reason) => {
            if (run.video) {
              run.video.reject(new ExportError(`A janela que renderiza o vídeo fechou antes de terminar (${reason}).`))
              run.video = null
            }
          }
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  // --- execução --------------------------------------------------------------------------------
  async function execute(run: Run): Promise<void> {
    const ff = deps.ffmpeg()
    let watchdog: NodeJS.Timeout | undefined
    try {
      if (!ff) throw new ExportError('Não encontrei o ffmpeg. Escolha o ffmpeg nos Ajustes e tente de novo.')
      const exportsDir = run.outDir
      await mkdir(run.tmpDir, { recursive: true })
      run.handle = await open(run.videoPath, 'w+')

      const label = run.req.format === 'vertical' ? `vertical 1080×1920 ${run.req.fps}` : `${EXPORT_RESOLUTION_LABEL[run.req.resolution]}${run.req.fps}`
      logger.info(`Exportação ${run.id} (${label}) do projeto ${run.req.projectId}: ${run.progress.totalFrames} quadros.`)
      setPhase(run, 'rendering')

      const stall = deps.stallTimeoutMs ?? STALL_TIMEOUT_MS
      watchdog = setInterval(() => {
        if (deps.now() - run.lastSign > stall && run.video) {
          run.video.reject(new ExportError(`A exportação travou: a janela de vídeo ficou ${Math.round(stall / 1000)} s sem responder.`))
          run.video = null
        }
      }, Math.min(5000, Math.max(50, stall / 4)))

      const guard = <T>(p: Promise<T>): Promise<T> =>
        p.catch((err: unknown) => {
          run.abort.abort()
          run.win?.destroy()
          throw err
        })
      const [videoResult] = await Promise.all([guard(renderVideo(run)), guard(renderAudio(run, ff))])
      if (run.cancelled) throw new CancelledError('cancelada')
      if (!videoResult.ok) throw new ExportError(videoResult.message)
      run.renderEndedAt = deps.now()
      run.win?.destroy()
      run.win = null
      await run.handle.sync()
      await run.handle.close()
      run.handle = null
      run.videoFraction = 1
      run.timing = videoResult.timing ?? null
      logger.info(`Exportação ${run.id}: vídeo pronto (${videoResult.frames} quadros, ${videoResult.encoder}). ${videoResult.timing ?? ''}`)

      // mux (o arquivo parcial mora na pasta temporária: o nome definitivo só nasce no fim, sem sobrescrever nada)
      setPhase(run, 'mux')
      await mkdir(exportsDir, { recursive: true })
      await ff.run(buildMuxArgs({ video: run.videoPath, audio: run.audioPath, output: run.partialFinal }), { signal: run.abort.signal })

      // conferência
      setPhase(run, 'checking')
      const report = await checkOutput(ff, run, videoResult.frames)
      run.finalPath = await placeFinal(run)
      report.outputPath = run.finalPath
      outputs.add(await outputKey(run.finalPath))
      logger.info(`Exportação ${run.id} pronta: ${run.finalPath} (${report.renderFps.toFixed(1)} qps, áudio×vídeo ${report.audioVideoDiffMs} ms).`)
      run.videoFraction = 1
      // o texto que acompanha o vídeo: legenda e hashtags do corte, ou títulos, descrição e capítulos do YouTube.
      // Falhar aqui NÃO joga fora o vídeo (já está pronto), mas também não cala: o aviso vai no resultado.
      const text = await writeCompanionText(run)
      setPhase(run, 'done', { outputPath: run.finalPath, report, etaMs: 0, frame: run.progress.totalFrames, ...text })
    } catch (err) {
      if (run.cancelled || err instanceof CancelledError) {
        logger.info(`Exportação ${run.id} cancelada.`)
        setPhase(run, 'cancelled', { message: 'Exportação cancelada.' })
      } else {
        const message = messageOf(err)
        logger.error(`Exportação ${run.id} falhou`, err)
        setPhase(run, 'error', { message })
      }
    } finally {
      if (watchdog) clearInterval(watchdog)
      run.abort.abort()
      run.win?.destroy()
      run.win = null
      if (run.handle) await run.handle.close().catch(() => undefined)
      run.handle = null
      // parcial nunca fica com cara de bom: some tudo que não é o arquivo final (o parcial mora no tmpDir; o nome
      // definitivo só existe depois de pronto, então nenhum arquivo do usuário é apagado aqui)
      await rm(run.tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
      current = null
    }
  }

  /**
   * Pasta de destino. Só vale (a) a pasta `exports/` do projeto ou (b) uma pasta que o usuário escolheu NESTA sessão
   * pelo diálogo nativo (`export:pick-dir`); o caminho que chega da interface não vale por si.
   */
  async function chooseOutputDir(projectDir: string, asked: string | undefined, subdir?: string): Promise<string> {
    const own = join(projectDir, 'exports', ...(subdir ? [subdir] : []))
    let target = own
    if (asked !== undefined) {
      if (!isAbsolute(asked)) throw new ExportError('A pasta de destino precisa ser um caminho completo (ex.: C:\\Videos).')
      const wanted = resolve(asked)
      if (wanted.toLowerCase() !== resolve(own).toLowerCase()) {
        const approved = await deps.outputDirs.resolve(wanted)
        if (!approved) {
          throw new ExportError('Essa pasta de destino não foi escolhida por você nesta sessão. Use "Escolher pasta" no diálogo de exportar.')
        }
        target = approved
      }
    }
    try {
      await mkdir(target, { recursive: true })
    } catch (err) {
      throw new ExportError(`Não consegui usar a pasta de destino (${target}): ${messageOf(err)}`)
    }
    if (target === own) {
      // `exports/` do projeto é um atalho/junção para fora? Aí o projeto estaria mandando a gravação para onde quiser.
      const [realProject, realTarget] = await Promise.all([realpath(projectDir), realpath(target)])
      if (!isInside(realProject, realTarget)) {
        throw new ExportError('A pasta exports/ deste projeto aponta para fora da pasta dele. Escolha outra pasta de destino.')
      }
    }
    return target
  }

  /** ffprobe do arquivo final: trilhas, duração, taxa constante e diferença áudio × vídeo. */
  async function checkOutput(ff: Ffmpeg, run: Run, frames: number): Promise<ExportReport> {
    const probe = await ff.probe(run.partialFinal)
    const videos = probe.streams.filter((s) => s.type === 'video')
    const audios = probe.streams.filter((s) => s.type === 'audio')
    const fail = (why: string): never => {
      throw new ExportError(`O arquivo exportado não passou na conferência: ${why}`)
    }
    if (videos.length !== 1) fail(`esperava 1 trilha de vídeo e achou ${videos.length}.`)
    if (audios.length !== 1) fail(`esperava 1 trilha de áudio e achou ${audios.length}.`)
    const v = videos[0]!
    const a = audios[0]!
    const fps = run.req.fps
    const frameMs = 1000 / fps
    const expectedMs = outputDuration(projectDurationMs(run.project), run.project.cuts)
    const vMs = v.durationMs ?? probe.durationMs
    const aMs = a.durationMs ?? probe.durationMs
    if (Math.abs(vMs - expectedMs) > frameMs * 1.5) {
      fail(`a duração do vídeo é ${(vMs / 1000).toFixed(2)} s e o esperado era ${(expectedMs / 1000).toFixed(2)} s.`)
    }
    if (!v.fps || !v.rFps || Math.abs(v.fps - v.rFps) > 0.01 || Math.abs(v.fps - fps) > 0.01) {
      fail(`a taxa de quadros não é constante em ${fps} qps (média ${v.fps?.toFixed(3) ?? '?'}, base ${v.rFps?.toFixed(3) ?? '?'}).`)
    }
    if (v.nbFrames !== undefined && Math.abs(v.nbFrames - frames) > 1) {
      fail(`o arquivo tem ${v.nbFrames} quadros e foram renderizados ${frames}.`)
    }
    const diff = Math.abs(aMs - vMs)
    if (diff > MAX_AV_DIFF_MS) {
      fail(`o áudio (${(aMs / 1000).toFixed(3)} s) e o vídeo (${(vMs / 1000).toFixed(3)} s) diferem em ${Math.round(diff)} ms (o limite é ${MAX_AV_DIFF_MS} ms).`)
    }
    const info = await stat(run.partialFinal)
    const renderMs = Math.max(1, (run.renderEndedAt ?? deps.now()) - (run.renderStartedAt ?? run.startedAt))
    return {
      outputPath: run.finalPath,
      bytes: info.size,
      width: v.width ?? 0,
      height: v.height ?? 0,
      durationMs: vMs,
      expectedMs,
      fps: v.fps ?? fps,
      frames: v.nbFrames ?? frames,
      hasAudio: true,
      audioVideoDiffMs: Math.round(diff),
      renderFps: (frames / renderMs) * 1000,
      elapsedMs: deps.now() - run.startedAt,
      profile: v.profile ?? null,
      timing: run.timing
    }
  }

  return {
    async start(asked) {
      // A que acabou de mostrar o resultado ainda está apagando a pasta temporária: espera ela sair em vez de recusar o pedido
      // seguinte (a fila dos cortes pede o próximo no mesmo instante em que recebe o "pronto" do anterior).
      if (current && (current.progress.phase === 'done' || current.progress.phase === 'error' || current.progress.phase === 'cancelled')) {
        await current.done.catch(() => undefined)
      }
      if (current) throw new ExportError('Já há uma exportação em andamento. Espere terminar ou cancele.')
      const { project: stored, dir } = await deps.read(asked.projectId)
      if (!stored.sources.screen && !stored.sources.camera) {
        throw new ExportError('Este projeto não tem vídeo da tela nem da câmera para exportar.')
      }
      // UM corte vertical: o corte vem do documento (no disco), nunca da interface; o formato é sempre o vertical
      let clip: Clip | null = null
      let clipNumber = 0
      let project = stored
      let request: ExportRequest = asked
      if (asked.clipId !== undefined) {
        const at = stored.clips.findIndex((c) => c.id === asked.clipId)
        if (at < 0) throw new ExportError('Esse corte não existe mais neste projeto. Atualize a lista de cortes e tente de novo.')
        clip = stored.clips[at]!
        clipNumber = at + 1
        if (normalizeRanges(clip.ranges, projectDurationMs(stored)).length === 0) {
          throw new ExportError(`O corte «${clip.title}» não tem nenhum trecho dentro da gravação. Ajuste os trechos do corte e tente de novo.`)
        }
        project = clipDocument(stored, clip)
        request = { ...asked, format: 'vertical' }
        delete request.fileName
      }
      // O documento pode vir de terceiros: todo caminho dele é relativo e resolve para DENTRO da pasta do projeto.
      // Erro visível ANTES de começar qualquer coisa ("Este projeto aponta para um arquivo fora da pasta dele").
      await assertDocumentPaths(dir, project)
      const files = {
        screen: project.sources.screen ? await resolveProjectFile(dir, project.sources.screen.path, 'sources.screen.path') : null,
        camera: project.sources.camera ? await resolveProjectFile(dir, project.sources.camera.path, 'sources.camera.path') : null,
        voice: project.sources.voice ? await resolveProjectFile(dir, project.sources.voice.path, 'sources.voice.path') : null,
        system: project.sources.system ? await resolveProjectFile(dir, project.sources.system.path, 'sources.system.path') : null
      }
      const format = exportFormat(request)
      const durationMs = projectDurationMs(project)
      const outMs = outputDuration(durationMs, project.cuts)
      const totalFrames = outputFrameCount(outMs, request.fps)
      if (totalFrames === 0) throw new ExportError('Não há nada para exportar: todos os trechos foram cortados.')

      // As palavras da transcrição (legendas). Ler falhou e a legenda está ligada neste formato: erro visível, nunca legenda sumida.
      let words: Word[] | null = null
      try {
        words = (await deps.words?.(request.projectId)) ?? null
      } catch (err) {
        if (projectForFormat(project, format.kind).captions.enabled) throw new ExportError(`Não consegui ler a transcrição para as legendas: ${messageOf(err)}`)
        logger.warn(`Exportação: não consegui ler a transcrição de ${request.projectId} (${messageOf(err)}); a legenda está desligada, segue sem ela.`)
      }

      const id = randomUUID()
      const exportsDir = await chooseOutputDir(dir, request.dir, clip ? 'cortes' : undefined)
      const stem = clip ? `${String(clipNumber).padStart(2, '0')} - ${sanitizeFileName(clip.title, 'Corte')}` : exportFileName(project.title, request).replace(/\.mp4$/, '')
      const unique = uniqueName(stem, (n) => existsSync(join(exportsDir, `${n}.mp4`)))
      const finalPath = join(exportsDir, `${unique}.mp4`)
      const tmpDir = join(exportsDir, `.tmp-${id.slice(0, 8)}`)
      const job: ExportJob = {
        exportId: id,
        projectId: request.projectId,
        project,
        format: format.kind,
        ...(clip && clip.layoutV !== 'auto' ? { clipLayout: clip.layoutV } : {}),
        width: format.w,
        height: format.h,
        fps: request.fps,
        bitrate: exportBitrate(request.resolution, request.fps, request.format),
        words,
        screenUrl: project.sources.screen ? mediaUrl(request.projectId, project.sources.screen.path) : null,
        cameraUrl: project.sources.camera ? mediaUrl(request.projectId, project.sources.camera.path) : null,
        eventUrls: {
          cursor: await eventUrl(request.projectId, dir, EVENT_FILES.cursor),
          clicks: await eventUrl(request.projectId, dir, EVENT_FILES.clicks),
          keys: await eventUrl(request.projectId, dir, EVENT_FILES.keys)
        },
        // a análise do rosto (enquadramento da câmera): o exportador enquadra como a prévia
        faceUrl: await eventUrl(request.projectId, dir, FACE_FILE)
      }
      const now = deps.now()
      const run: Run = {
        id,
        req: request,
        project,
        stored,
        clip,
        clipNumber,
        words,
        dir,
        startedAt: now,
        abort: new AbortController(),
        cancelled: false,
        win: null,
        outDir: exportsDir,
        tmpDir,
        videoPath: join(tmpDir, 'video.mp4'),
        audioPath: join(tmpDir, 'audio.m4a'),
        stem,
        finalPath,
        partialFinal: join(tmpDir, 'saida.parcial'),
        files,
        handle: null,
        progress: {
          exportId: id,
          projectId: request.projectId,
          ...(clip ? { clipId: clip.id } : {}),
          phase: 'preparing',
          fraction: 0,
          frame: 0,
          totalFrames,
          renderFps: null,
          etaMs: null,
          audioReady: false
        },
        video: null,
        audioFraction: 0,
        videoFraction: 0,
        lastSign: now,
        lastEmit: 0,
        renderStartedAt: null,
        renderEndedAt: null,
        timing: null,
        done: Promise.resolve(),
        job
      }
      current = run
      emit(run, true)
      run.done = execute(run)
      return { exportId: id }
    },

    async cancel(exportId) {
      const run = current
      if (!run || run.id !== exportId) return
      run.cancelled = true
      run.abort.abort()
      run.win?.destroy()
      if (run.video) {
        run.video.reject(new CancelledError('cancelada'))
        run.video = null
      }
      await run.done
    },

    status() {
      return current ? { ...current.progress } : last ? { ...last } : null
    },

    isOutput(realPath) {
      return outputs.has(realPath.toLowerCase())
    },

    job(exportId) {
      const run = assertActive(exportId)
      run.lastSign = deps.now()
      return run.job
    },

    async write(exportId, position, data) {
      const run = assertActive(exportId)
      if (!run.handle) throw new ExportError('O arquivo de vídeo já foi fechado.')
      run.lastSign = deps.now()
      const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      await run.handle.write(buf, 0, buf.byteLength, position)
    },

    progress(exportId, frame, renderFps) {
      const run = current
      if (!run || run.id !== exportId) return
      run.lastSign = deps.now()
      const total = run.progress.totalFrames
      run.videoFraction = total > 0 ? Math.min(1, frame / total) : 0
      const fps = renderFps ?? run.progress.renderFps
      run.progress = { ...run.progress, frame, renderFps: fps, etaMs: fps ? etaMs(frame, total, fps) : null }
      emit(run)
    },

    finish(exportId, result) {
      const run = current
      if (!run || run.id !== exportId || !run.video) return
      run.lastSign = deps.now()
      const video = run.video
      run.video = null
      video.resolve(result)
    },

    async idle() {
      while (current) await current.done
    },

    async shutdown() {
      if (current) await this.cancel(current.id)
    }
  }
}
