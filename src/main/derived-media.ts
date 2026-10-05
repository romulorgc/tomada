/**
 * Mídias DERIVADAS que o editor pede ao abrir um projeto, todas geradas UMA vez pelo ffmpeg e guardadas na
 * pasta do projeto (em segundo plano, uma de cada vez, para não disputar o processador com a edição):
 *
 *  - `media/peaks.json`: picos da voz para a forma de onda da linha do tempo;
 *  - `media/voice-preview.m4a`: a voz TRATADA (a mesma cadeia da exportação: limpeza, mistura com o som do
 *    computador e normalização em dois passes), SEM cortes, para a prévia soar como o vídeo final;
 *  - `media/thumbs/`: miniaturas da tela para a trilha de vídeo.
 *
 * Cada uma só é refeita quando a fonte mudou (data do arquivo). O arquivo novo é escrito ao lado e
 * renomeado por cima: quem lê nunca vê um meio-termo. Sem Electron: roda igual nos testes.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PeaksData, PreviewAudioData, ThumbsData } from '@shared/ipc'
import { mediaUrl } from '@shared/media-url'
import { PEAKS_PER_SECOND, PEAKS_VERSION, computePeaks, pcmFromBytes, type PeaksFile } from '@shared/peaks'
import { projectDurationMs } from '@shared/project'
import type { Project } from '@shared/types'
import { buildAudioArgs, buildAudioGraph, buildMeasureArgs, parseLoudnormMeasure } from './audio-graph'
import type { Ffmpeg } from './ffmpeg'
import { pathExists, writeFileAtomic } from './fs-utils'
import type { Logger } from './logger'

export const PEAKS_PATH = 'media/peaks.json'
export const PREVIEW_AUDIO_PATH = 'media/voice-preview.m4a'
export const PREVIEW_AUDIO_INFO = 'media/voice-preview.json'
export const THUMBS_DIR = 'media/thumbs'
export const THUMBS_INFO = 'media/thumbs/info.json'

/** Taxa de amostragem da análise dos picos (basta para a forma de onda). */
const PEAKS_SAMPLE_RATE = 8000
/** Altura das miniaturas (px): o dobro do que a trilha mostra, para telas de alta densidade. */
export const THUMB_HEIGHT = 120
export const THUMB_MIN_INTERVAL_MS = 1500
export const THUMB_MAX_INTERVAL_MS = 10_000
export const THUMB_TARGET_COUNT = 40

/** Intervalo entre miniaturas: ~40 por vídeo, entre 1,5 s e 10 s. */
export function thumbIntervalMs(durationMs: number): number {
  const raw = Math.round(durationMs / THUMB_TARGET_COUNT / 100) * 100
  return Math.min(THUMB_MAX_INTERVAL_MS, Math.max(THUMB_MIN_INTERVAL_MS, raw))
}

export type DerivedDeps = {
  logger: Logger
  ffmpeg(): Ffmpeg | null
  /** Lê o projeto (documento + pasta). */
  read(id: string): Promise<{ project: Project; dir: string }>
}

export interface DerivedMedia {
  peaks(projectId: string): Promise<PeaksData | null>
  previewAudio(projectId: string): Promise<PreviewAudioData | null>
  thumbs(projectId: string): Promise<ThumbsData | null>
  /** Espera tudo que está na fila (testes). */
  idle(): Promise<void>
  /** Interrompe o que está rodando e esvazia a fila (fechar o app). */
  shutdown(): void
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function mtimeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path)
    return info.isFile() ? Math.trunc(info.mtimeMs) : null
  } catch {
    return null
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function createDerivedMedia(deps: DerivedDeps): DerivedMedia {
  const { logger } = deps
  let tail: Promise<unknown> = Promise.resolve()
  const inflight = new Map<string, Promise<unknown>>()
  const abort = new AbortController()

  /** Uma tarefa por vez, e a mesma tarefa pedida duas vezes roda uma vez só. */
  function once<T>(key: string, task: () => Promise<T>): Promise<T> {
    const running = inflight.get(key)
    if (running) return running as Promise<T>
    const job = tail.then(task, task).finally(() => inflight.delete(key))
    inflight.set(key, job)
    tail = job.catch(() => undefined)
    return job
  }

  // --- picos -----------------------------------------------------------------------------------------
  async function buildPeaks(id: string): Promise<PeaksData | null> {
    const { project, dir } = await deps.read(id)
    const voice = project.sources.voice
    if (!voice) return null
    const voicePath = join(dir, voice.path)
    const mtime = await mtimeOf(voicePath)
    if (mtime === null) {
      logger.warn(`Forma de onda: o arquivo de voz do projeto ${id} não existe (${voice.path}).`)
      return null
    }
    const cached = await readJson<PeaksFile>(join(dir, PEAKS_PATH))
    if (cached && cached.version === PEAKS_VERSION && cached.source === voice.path && cached.sourceMtimeMs === mtime && Array.isArray(cached.peaks)) {
      return { perSecond: cached.perSecond, durationMs: cached.durationMs, peaks: cached.peaks }
    }
    const ff = deps.ffmpeg()
    if (!ff) return null
    const tmpDir = join(dir, 'media', `.tmp-peaks-${process.pid}`)
    await mkdir(tmpDir, { recursive: true })
    try {
      const pcmFile = join(tmpDir, 'voz.pcm')
      await ff.run(['-i', voicePath, '-vn', '-ac', '1', '-ar', String(PEAKS_SAMPLE_RATE), '-f', 's16le', pcmFile], { signal: abort.signal, timeoutMs: 600_000 })
      const bytes = await readFile(pcmFile)
      const pcm = pcmFromBytes(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      const peaks = computePeaks(pcm, PEAKS_SAMPLE_RATE, PEAKS_PER_SECOND)
      const file: PeaksFile = {
        version: PEAKS_VERSION,
        perSecond: PEAKS_PER_SECOND,
        durationMs: Math.round((pcm.length / PEAKS_SAMPLE_RATE) * 1000),
        source: voice.path,
        sourceMtimeMs: mtime,
        peaks
      }
      await writeFileAtomic(join(dir, PEAKS_PATH), JSON.stringify(file))
      logger.info(`Forma de onda do projeto ${id}: ${peaks.length} colunas.`)
      return { perSecond: file.perSecond, durationMs: file.durationMs, peaks }
    } finally {
      await rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
    }
  }

  // --- áudio da prévia -------------------------------------------------------------------------------
  type PreviewInfo = { voiceMtimeMs: number | null; systemMtimeMs: number | null; voiceOffsetMs: number; systemOffsetMs: number; durationMs: number }

  async function buildPreviewAudio(id: string): Promise<PreviewAudioData | null> {
    const { project, dir } = await deps.read(id)
    const voiceRel = project.sources.voice?.path
    const systemRel = project.sources.system?.path
    const voiceMtime = voiceRel ? await mtimeOf(join(dir, voiceRel)) : null
    const systemMtime = systemRel ? await mtimeOf(join(dir, systemRel)) : null
    if (voiceMtime === null && systemMtime === null) return null

    const durationMs = projectDurationMs(project)
    const want: PreviewInfo = {
      voiceMtimeMs: voiceMtime,
      systemMtimeMs: systemMtime,
      voiceOffsetMs: project.sync.cameraOffsetMs,
      systemOffsetMs: project.sync.screenOffsetMs,
      durationMs
    }
    const target = join(dir, PREVIEW_AUDIO_PATH)
    const targetMtime = await mtimeOf(target)
    const have = await readJson<PreviewInfo>(join(dir, PREVIEW_AUDIO_INFO))
    const fresh = targetMtime !== null && have !== null && JSON.stringify(have) === JSON.stringify(want)
    if (fresh) return { url: mediaUrl(id, PREVIEW_AUDIO_PATH, targetMtime) }

    const ff = deps.ffmpeg()
    if (!ff || !(durationMs > 0)) return null
    const tmpDir = join(dir, 'media', `.tmp-preview-${process.pid}`)
    await mkdir(tmpDir, { recursive: true })
    try {
      const inputs: string[] = []
      const voice = voiceMtime !== null ? { input: inputs.push(join(dir, voiceRel!)) - 1, offsetMs: want.voiceOffsetMs, channels: 1 as const } : null
      const system = systemMtime !== null ? { input: inputs.push(join(dir, systemRel!)) - 1, offsetMs: want.systemOffsetMs, channels: 2 as const } : null
      const kept = [{ start: 0, end: durationMs }]
      const opts = { signal: abort.signal, timeoutMs: 900_000 }

      const g1 = join(tmpDir, 'medir.txt')
      await writeFile(g1, buildAudioGraph({ kept, voice, system, mode: 'measure' }).graph, 'utf8')
      const measureRun = await ff.run(buildMeasureArgs({ inputs, graphFile: g1 }), opts)
      const measured = parseLoudnormMeasure(measureRun.stderr)

      const g2 = join(tmpDir, 'final.txt')
      await writeFile(g2, buildAudioGraph({ kept, voice, system, mode: 'final', measured }).graph, 'utf8')
      const partial = join(tmpDir, 'voice-preview.m4a')
      await ff.run(buildAudioArgs({ inputs, graphFile: g2, output: partial }), opts)

      await rm(target, { force: true })
      await rename(partial, target)
      await writeFileAtomic(join(dir, PREVIEW_AUDIO_INFO), JSON.stringify(want))
      logger.info(`Áudio da prévia do projeto ${id} pronto.`)
      const finalMtime = (await mtimeOf(target)) ?? Date.now()
      return { url: mediaUrl(id, PREVIEW_AUDIO_PATH, finalMtime) }
    } finally {
      await rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
    }
  }

  // --- miniaturas ------------------------------------------------------------------------------------
  type ThumbsInfo = { version: 1; intervalMs: number; count: number; height: number; source: string; sourceMtimeMs: number }

  async function buildThumbs(id: string): Promise<ThumbsData | null> {
    const { project, dir } = await deps.read(id)
    const src = project.sources.screen ?? project.sources.camera
    if (!src) return null
    const srcPath = join(dir, src.path)
    const mtime = await mtimeOf(srcPath)
    if (mtime === null) return null

    const folder = join(dir, THUMBS_DIR)
    const toData = (info: ThumbsInfo): ThumbsData => ({
      intervalMs: info.intervalMs,
      count: info.count,
      height: info.height,
      urls: Array.from({ length: info.count }, (_, i) => mediaUrl(id, `${THUMBS_DIR}/${thumbName(i)}`, info.sourceMtimeMs))
    })
    const cached = await readJson<ThumbsInfo>(join(dir, THUMBS_INFO))
    if (cached && cached.version === 1 && cached.source === src.path && cached.sourceMtimeMs === mtime && cached.height === THUMB_HEIGHT && (await pathExists(join(folder, thumbName(cached.count - 1))))) {
      return toData(cached)
    }
    const ff = deps.ffmpeg()
    if (!ff) return null

    const intervalMs = thumbIntervalMs(src.durationMs)
    const tmpDir = join(dir, 'media', `.tmp-thumbs-${process.pid}`)
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    await mkdir(tmpDir, { recursive: true })
    try {
      await ff.run(
        [
          '-i',
          srcPath,
          '-an',
          '-vf',
          `fps=1000/${intervalMs},scale=-2:${THUMB_HEIGHT}:flags=lanczos`,
          '-q:v',
          '5',
          '-start_number',
          '0',
          join(tmpDir, 'thumb-%04d.jpg')
        ],
        { signal: abort.signal, timeoutMs: 600_000 }
      )
      const files = (await readdir(tmpDir)).filter((f) => /^thumb-\d{4}\.jpg$/.test(f)).sort()
      if (files.length === 0) throw new Error('o ffmpeg não gerou nenhuma miniatura')
      await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      await mkdir(join(dir, 'media'), { recursive: true })
      await rename(tmpDir, folder)
      const info: ThumbsInfo = { version: 1, intervalMs, count: files.length, height: THUMB_HEIGHT, source: src.path, sourceMtimeMs: mtime }
      await writeFileAtomic(join(dir, THUMBS_INFO), JSON.stringify(info))
      logger.info(`Miniaturas do projeto ${id}: ${files.length} (uma a cada ${intervalMs} ms).`)
      return toData(info)
    } finally {
      await rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
    }
  }

  /** Falha vira aviso no log e `null` (o editor funciona sem a forma de onda ou as miniaturas). */
  const safe = <T>(label: string, id: string, job: () => Promise<T | null>): Promise<T | null> =>
    job().catch((err: unknown) => {
      if (abort.signal.aborted) return null
      logger.warn(`Não consegui preparar ${label} do projeto ${id}: ${messageOf(err)}`, err)
      throw new Error(`Não consegui preparar ${label}: ${messageOf(err)}`)
    })

  return {
    peaks: (id) => once(`peaks:${id}`, () => safe('a forma de onda', id, () => buildPeaks(id))),
    previewAudio: (id) => once(`audio:${id}`, () => safe('o áudio da prévia', id, () => buildPreviewAudio(id))),
    thumbs: (id) => once(`thumbs:${id}`, () => safe('as miniaturas', id, () => buildThumbs(id))),
    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight.values()])
    },
    shutdown() {
      abort.abort()
    }
  }
}

const thumbName = (i: number): string => `thumb-${String(i).padStart(4, '0')}.jpg`
