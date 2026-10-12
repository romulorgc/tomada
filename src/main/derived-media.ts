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
 *
 * O ffmpeg só escreve numa pasta temporária EXCLUSIVA (`safe-output`: nome sorteado, criada agora, vazia), nunca num nome
 * previsível que um projeto de terceiros possa ter enchido de links; o destino final que já é atalho, junção ou link físico é
 * recusado, com o motivo.
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Levels } from '@shared/clean'
import { suggestPageRect, type CropSuggestion, type GrayFrame } from '@shared/crop-detect'
import type { PeaksData, PreviewAudioData, ThumbsData } from '@shared/ipc'
import { LEVELS_VERSION, LEVEL_FRAME_MS, alignLevels, computeLevels, type LevelsFile } from '@shared/levels'
import { mediaUrl } from '@shared/media-url'
import { PEAKS_PER_SECOND, PEAKS_VERSION, computePeaks, pcmFromBytes, type PeaksFile } from '@shared/peaks'
import { projectDurationMs } from '@shared/project'
import { parseTranscript, TRANSCRIPT_FILE } from '@shared/transcript'
import type { Project } from '@shared/types'
import { buildAudioArgs, buildAudioGraph, buildMeasureArgs, parseLoudnormMeasure } from './audio-graph'
import type { Ffmpeg } from './ffmpeg'
import { buildGrayFramesArgs, buildPeaksPcmArgs, buildThumbStripArgs } from './ffmpeg-args'
import { pathExists } from './fs-utils'
import type { Logger } from './logger'
import { resolveProjectFile } from './project-files'
import { commitToProject, createProjectTmpDir, removeTmpDir, writeProjectFile, type ExclusiveDir } from './safe-output'
import { measureVoiceNoise } from './voice-noise'

export const PEAKS_PATH = 'media/peaks.json'
export const PREVIEW_AUDIO_PATH = 'media/voice-preview.m4a'
export const PREVIEW_AUDIO_INFO = 'media/voice-preview.json'
export const LEVELS_PATH = 'media/levels.json'
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
  /** Nível (dBFS por quadro de 20 ms) do microfone e do som do computador, para a limpeza de silêncio. */
  levels(projectId: string): Promise<Levels | null>
  /** O recorte da tela sugerido por análise de quadros (C1): onde acaba a barra do navegador; `null` se não achou. */
  cropSuggest(projectId: string): Promise<CropSuggestion | null>
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

  /** Roda `job` com uma pasta temporária exclusiva dentro de `media/` e apaga a pasta no fim (erro ao apagar vai para o log). */
  async function withTmp<T>(dir: string, kind: string, job: (tmp: ExclusiveDir) => Promise<T>): Promise<T> {
    const tmp = await createProjectTmpDir(dir, 'media', `.tmp-${kind}-`)
    try {
      return await job(tmp)
    } finally {
      await removeTmpDir(tmp.dir, logger)
    }
  }

  // --- picos -----------------------------------------------------------------------------------------
  async function buildPeaks(id: string): Promise<PeaksData | null> {
    const { project, dir } = await deps.read(id)
    const voice = project.sources.voice
    if (!voice) return null
    // todo caminho do documento passa por aqui: relativo, dentro da pasta do projeto, conferido com realpath
    const voicePath = await resolveProjectFile(dir, voice.path, 'sources.voice.path')
    const peaksFile = await resolveProjectFile(dir, PEAKS_PATH)
    const mtime = await mtimeOf(voicePath)
    if (mtime === null) {
      logger.warn(`Forma de onda: o arquivo de voz do projeto ${id} não existe (${voice.path}).`)
      return null
    }
    const cached = await readJson<PeaksFile>(peaksFile)
    if (cached && cached.version === PEAKS_VERSION && cached.source === voice.path && cached.sourceMtimeMs === mtime && Array.isArray(cached.peaks)) {
      return { perSecond: cached.perSecond, durationMs: cached.durationMs, peaks: cached.peaks }
    }
    const ff = deps.ffmpeg()
    if (!ff) return null
    return withTmp(dir, 'peaks', async (tmp) => {
      const pcmFile = await tmp.file('voz.pcm')
      await ff.run(buildPeaksPcmArgs({ input: voicePath, output: pcmFile, sampleRate: PEAKS_SAMPLE_RATE }), { signal: abort.signal, timeoutMs: 600_000 })
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
      await writeProjectFile(dir, PEAKS_PATH, JSON.stringify(file))
      logger.info(`Forma de onda do projeto ${id}: ${peaks.length} colunas.`)
      return { perSecond: file.perSecond, durationMs: file.durationMs, peaks }
    })
  }

  // --- áudio da prévia -------------------------------------------------------------------------------
  type PreviewInfo = { version: number; transcriptMtimeMs: number | null; voiceMtimeMs: number | null; systemMtimeMs: number | null; voiceOffsetMs: number; systemOffsetMs: number; durationMs: number }

  async function buildPreviewAudio(id: string): Promise<PreviewAudioData | null> {
    const { project, dir } = await deps.read(id)
    const voiceRel = project.sources.voice?.path
    const systemRel = project.sources.system?.path
    const voicePath = voiceRel ? await resolveProjectFile(dir, voiceRel, 'sources.voice.path') : null
    const systemPath = systemRel ? await resolveProjectFile(dir, systemRel, 'sources.system.path') : null
    const voiceMtime = voicePath ? await mtimeOf(voicePath) : null
    const systemMtime = systemPath ? await mtimeOf(systemPath) : null
    if (voiceMtime === null && systemMtime === null) return null

    const durationMs = projectDurationMs(project)
    const transcriptFile = await resolveProjectFile(dir, TRANSCRIPT_FILE)
    const transcriptMtimeMs = await mtimeOf(transcriptFile)
    const want: PreviewInfo = {
      version: 2, // invalida a prévia anterior, feita com piso fixo e compressor forte
      transcriptMtimeMs,
      voiceMtimeMs: voiceMtime,
      systemMtimeMs: systemMtime,
      voiceOffsetMs: project.sync.cameraOffsetMs,
      systemOffsetMs: project.sync.screenOffsetMs,
      durationMs
    }
    const target = await resolveProjectFile(dir, PREVIEW_AUDIO_PATH)
    const infoFile = await resolveProjectFile(dir, PREVIEW_AUDIO_INFO)
    const targetMtime = await mtimeOf(target)
    const have = await readJson<PreviewInfo>(infoFile)
    const fresh = targetMtime !== null && have !== null && JSON.stringify(have) === JSON.stringify(want)
    if (fresh) return { url: mediaUrl(id, PREVIEW_AUDIO_PATH, targetMtime) }

    const ff = deps.ffmpeg()
    if (!ff || !(durationMs > 0)) return null
    return withTmp(dir, 'preview', async (tmp) => {
      const inputs: string[] = []
      const voice = voiceMtime !== null ? { input: inputs.push(voicePath!) - 1, offsetMs: want.voiceOffsetMs, channels: 1 as const } : null
      const system = systemMtime !== null ? { input: inputs.push(systemPath!) - 1, offsetMs: want.systemOffsetMs, channels: 2 as const } : null
      const kept = [{ start: 0, end: durationMs }]
      const opts = { signal: abort.signal, timeoutMs: 900_000 }
      let words: ReturnType<typeof parseTranscript>['words'] | null = null
      if (transcriptMtimeMs !== null) {
        try { words = parseTranscript(await readFile(transcriptFile, 'utf8')).words }
        catch (err) { logger.warn('Áudio da prévia: transcrição indisponível para medir silêncio; usando VAD local.', err) }
      }
      const noise = voice ? await measureVoiceNoise(ff, { voicePath: voicePath!, words, offsetMs: want.voiceOffsetMs, ...opts }) : null
      const noiseFloorDb = noise?.noiseFloorDb ?? null
      if (noise) logger.info(`Áudio da prévia: piso ${noise.measuredDb?.toFixed(2) ?? 'sem medição'} dBFS, ${noise.silenceMs} ms de silêncio (${noise.source}).`)

      const g1 = await tmp.file('medir.txt')
      await writeFile(g1, buildAudioGraph({ kept, voice, system, noiseFloorDb, mode: 'measure' }).graph, 'utf8')
      const measureRun = await ff.run(buildMeasureArgs({ inputs, graphFile: g1 }), opts)
      const measured = parseLoudnormMeasure(measureRun.stderr)

      const g2 = await tmp.file('final.txt')
      await writeFile(g2, buildAudioGraph({ kept, voice, system, noiseFloorDb, mode: 'final', measured }).graph, 'utf8')
      const partial = await tmp.file('voice-preview.m4a')
      await ff.run(buildAudioArgs({ inputs, graphFile: g2, output: partial }), opts)

      await commitToProject(dir, partial, PREVIEW_AUDIO_PATH)
      await writeProjectFile(dir, PREVIEW_AUDIO_INFO, JSON.stringify(want))
      logger.info(`Áudio da prévia do projeto ${id} pronto.`)
      const finalMtime = (await mtimeOf(target)) ?? Date.now()
      return { url: mediaUrl(id, PREVIEW_AUDIO_PATH, finalMtime) }
    })
  }

  // --- miniaturas ------------------------------------------------------------------------------------
  type ThumbsInfo = { version: 1; intervalMs: number; count: number; height: number; source: string; sourceMtimeMs: number }

  async function buildThumbs(id: string): Promise<ThumbsData | null> {
    const { project, dir } = await deps.read(id)
    const src = project.sources.screen ?? project.sources.camera
    if (!src) return null
    const srcPath = await resolveProjectFile(dir, src.path, project.sources.screen ? 'sources.screen.path' : 'sources.camera.path')
    const mtime = await mtimeOf(srcPath)
    if (mtime === null) return null

    const folder = await resolveProjectFile(dir, THUMBS_DIR)
    const infoFile = await resolveProjectFile(dir, THUMBS_INFO)
    const toData = (info: ThumbsInfo): ThumbsData => ({
      intervalMs: info.intervalMs,
      count: info.count,
      height: info.height,
      urls: Array.from({ length: info.count }, (_, i) => mediaUrl(id, `${THUMBS_DIR}/${thumbName(i)}`, info.sourceMtimeMs))
    })
    const cached = await readJson<ThumbsInfo>(infoFile)
    if (cached && cached.version === 1 && cached.source === src.path && cached.sourceMtimeMs === mtime && cached.height === THUMB_HEIGHT && (await pathExists(join(folder, thumbName(cached.count - 1))))) {
      return toData(cached)
    }
    const ff = deps.ffmpeg()
    if (!ff) return null

    const intervalMs = thumbIntervalMs(src.durationMs)
    return withTmp(dir, 'thumbs', async (tmp) => {
      const pattern = await tmp.file('thumb-%04d.jpg')
      await ff.run(buildThumbStripArgs({ input: srcPath, outputPattern: pattern, intervalMs, height: THUMB_HEIGHT }), { signal: abort.signal, timeoutMs: 600_000 })
      const files = (await readdir(tmp.dir)).filter((f) => /^thumb-\d{4}\.jpg$/.test(f)).sort()
      if (files.length === 0) throw new Error('o ffmpeg não gerou nenhuma miniatura')
      // a pasta pronta vira `media/thumbs` (a antiga sai; atalho, junção ou link no lugar dela é recusado)
      await commitToProject(dir, tmp.dir, THUMBS_DIR, { directory: true })
      const info: ThumbsInfo = { version: 1, intervalMs, count: files.length, height: THUMB_HEIGHT, source: src.path, sourceMtimeMs: mtime }
      await writeProjectFile(dir, THUMBS_INFO, JSON.stringify(info))
      logger.info(`Miniaturas do projeto ${id}: ${files.length} (uma a cada ${intervalMs} ms).`)
      return toData(info)
    })
  }

  // --- nível do áudio (limpeza de silêncio) ----------------------------------------------------------------
  /** Taxa de análise do nível (basta para RMS de 10 ms). */
  const LEVEL_SAMPLE_RATE = 8000

  async function pcmOf(ff: Ffmpeg, input: string, tmp: ExclusiveDir, name: string): Promise<Int16Array> {
    const pcmFile = await tmp.file(name)
    await ff.run(buildPeaksPcmArgs({ input, output: pcmFile, sampleRate: LEVEL_SAMPLE_RATE }), { signal: abort.signal, timeoutMs: 600_000 })
    const bytes = await readFile(pcmFile)
    return pcmFromBytes(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  }

  async function buildLevels(id: string): Promise<Levels | null> {
    const { project, dir } = await deps.read(id)
    const voice = project.sources.voice
    const system = project.sources.system
    if (!voice && !system) return null
    const voicePath = voice ? await resolveProjectFile(dir, voice.path, 'sources.voice.path') : null
    const systemPath = system ? await resolveProjectFile(dir, system.path, 'sources.system.path') : null
    const voiceMtime = voicePath ? await mtimeOf(voicePath) : null
    const systemMtime = systemPath ? await mtimeOf(systemPath) : null
    if (voiceMtime === null && systemMtime === null) return null
    const startMs = project.sync.cameraOffsetMs
    const want: LevelsFile['sources'] = {
      ...(voice && voiceMtime !== null ? { voice: { path: voice.path, mtimeMs: voiceMtime } } : {}),
      ...(system && systemMtime !== null ? { system: { path: system.path, mtimeMs: systemMtime } } : {})
    }
    const file = await resolveProjectFile(dir, LEVELS_PATH)
    const toLevels = (f: LevelsFile): Levels => ({ frameMs: f.frameMs, startMs: f.startMs, mic: f.mic, system: f.system })
    const cached = await readJson<LevelsFile>(file)
    if (cached && cached.version === LEVELS_VERSION && cached.startMs === startMs && JSON.stringify(cached.sources) === JSON.stringify(want)) return toLevels(cached)

    const ff = deps.ffmpeg()
    if (!ff) return null
    return withTmp(dir, 'levels', async (tmp) => {
      const mic = voicePath && voiceMtime !== null ? computeLevels(await pcmOf(ff, voicePath, tmp, 'mic.pcm'), LEVEL_SAMPLE_RATE, LEVEL_FRAME_MS) : null
      let sys: number[] | null = null
      if (systemPath && systemMtime !== null) {
        const raw = computeLevels(await pcmOf(ff, systemPath, tmp, 'sys.pcm'), LEVEL_SAMPLE_RATE, LEVEL_FRAME_MS)
        // o som do computador vem do arquivo da tela: alinha ao eixo da voz
        sys = alignLevels(raw, Math.round((project.sync.screenOffsetMs - startMs) / LEVEL_FRAME_MS))
      }
      const out: LevelsFile = { version: LEVELS_VERSION, frameMs: LEVEL_FRAME_MS, startMs, sources: want, mic, system: sys }
      await writeProjectFile(dir, LEVELS_PATH, JSON.stringify(out))
      logger.info(`Níveis de áudio do projeto ${id}: ${mic?.length ?? 0} quadros de microfone, ${sys?.length ?? 0} de som do computador.`)
      return toLevels(out)
    })
  }

  // --- recorte sugerido (C1) -------------------------------------------------------------------------------
  const SUGGEST_FRAMES = 8
  const SUGGEST_WIDTH = 960

  async function buildCropSuggestion(id: string): Promise<CropSuggestion | null> {
    const { project, dir } = await deps.read(id)
    const src = project.sources.screen
    if (!src) return null
    const srcPath = await resolveProjectFile(dir, src.path, 'sources.screen.path')
    const ff = deps.ffmpeg()
    if (!ff) throw new Error('não encontrei o ffmpeg')
    return withTmp(dir, 'crop', async (tmp) => {
      const out = await tmp.file('quadros.gray')
      const w = SUGGEST_WIDTH
      const h = 2 * Math.round(((src.h / src.w) * SUGGEST_WIDTH) / 2)
      await ff.run(buildGrayFramesArgs({ input: srcPath, output: out, count: SUGGEST_FRAMES, durationMs: src.durationMs, width: w, height: h }), { signal: abort.signal, timeoutMs: 120_000 })
      const bytes = await readFile(out)
      const size = w * h
      const frames: GrayFrame[] = []
      for (let at = 0; at + size <= bytes.length; at += size) frames.push({ w, h, data: new Uint8Array(bytes.buffer, bytes.byteOffset + at, size) })
      const found = suggestPageRect(frames)
      logger.info(`Recorte sugerido do projeto ${id}: ${found ? `a página começa em ${(found.rect.y * 100).toFixed(1)}% da altura (confiança ${(found.confidence * 100).toFixed(0)}%)` : 'nenhuma barra de navegador achada'} (${frames.length} quadros).`)
      return found
    })
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
    async previewAudio(id) {
      const key = `audio:${id}`
      const running = inflight.get(key)
      // A transcrição pode chegar enquanto o primeiro áudio ainda usa VAD. Esperar e reler
      // o cache evita devolver essa construção antiga ao pedido da transcrição nova.
      if (running) await running.catch(() => undefined)
      if (abort.signal.aborted) return null
      return once(key, () => safe('o áudio da prévia', id, () => buildPreviewAudio(id)))
    },
    thumbs: (id) => once(`thumbs:${id}`, () => safe('as miniaturas', id, () => buildThumbs(id))),
    levels: (id) => once(`levels:${id}`, () => safe('o nível do áudio', id, () => buildLevels(id))),
    cropSuggest: (id) => once(`crop:${id}`, () => safe('a sugestão de recorte', id, () => buildCropSuggestion(id))),
    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight.values()])
    },
    shutdown() {
      abort.abort()
    }
  }
}

const thumbName = (i: number): string => `thumb-${String(i).padStart(4, '0')}.jpg`
