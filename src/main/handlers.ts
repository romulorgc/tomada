/**
 * Implementação de todos os canais do contrato de IPC. Sem Electron: o que depende
 * dele (diálogos de escolher pasta/arquivo) entra por parâmetro.
 */
import { exportRequestSchema } from '@shared/export'
import { createCaptionsExporter } from './captions-export'
import { heuristicClips } from '@shared/clips'
import type { AppInfo, BarAction, ChunkKind, IpcHandlers } from '@shared/ipc'
import { migrate, projectDurationMs } from '@shared/project'
import { projectForFormat } from '@shared/vertical'
import { readActivity } from './activity'
import { suggestClips } from './llm/clips'
import { proposeEdit } from './llm/edit'
import { generatePublish } from './llm/publish'
import { recordRequestSchema } from '@shared/recording'
import { isAbsolute, resolve } from 'node:path'
import type { DerivedMedia } from './derived-media'
import type { ExportService } from './export-service'
import { locateFfmpeg } from './ffmpeg'
import { getFfmpegStatus, runFfmpegSelfTest } from './ffmpeg-status'
import { LlmError } from '@shared/llm-json'
import type { Word } from '@shared/types'
import type { LlmManager } from './llm/manager'
import { detectRetakes } from './llm/retakes'
import type { Logger } from './logger'
import { checkOpenable, checkRevealable, type OutputDirs } from './path-guard'
import { assertDocumentPaths } from './project-files'
import type { ProjectStore } from './projects'
import type { RecordingService } from './recording-service'
import type { TranscriptionService } from './transcription/service'
import type { AppState } from './state'
import type { CameraCalibrationService } from './camera-calibration'

export type HandlerDeps = {
  calibration?: CameraCalibrationService
  info: AppInfo
  state: AppState
  store: ProjectStore
  logger: Logger
  pickFolder(defaultPath?: string): Promise<string | null>
  pickFfmpeg(): Promise<string | null>
  recording: RecordingService
  exporter: ExportService
  derived: DerivedMedia
  transcription: TranscriptionService
  llm: LlmManager
  /** Diálogo de escolher a pasta da exportação (em teste, `TOMADA_TEST_PICK_DIR`). */
  pickExportDir(defaultPath?: string): Promise<string | null>
  /** Pastas de exportação aprovadas nesta sessão: o que `export:pick-dir` devolve entra aqui (e a exportação só grava nelas). */
  outputDirs: OutputDirs
  /** Diálogo de escolher uma imagem de fundo (em teste, `TOMADA_TEST_PICK_IMAGE`). */
  pickImage(): Promise<string | null>
  openPath(path: string): Promise<void>
  revealPath(path: string): Promise<void>
  copyText(text: string): void
  /** A janela de contagem avisa que terminou (true) ou foi cancelada (false). */
  finishCountdown(completed: boolean): void
  /** Relógio do processo principal (`performance.timeOrigin + performance.now()`). */
  clock(): number
}

/** Como ligar a IA, para toda mensagem de "a IA não está disponível" (a interface nunca nomeia o fornecedor). */
export const HOW_TO_ENABLE_AI = 'Para ligar a IA, instale o programa da IA neste computador ou cole uma chave em Ajustes → IA.'

/** O motivo de a IA estar indisponível, mais o jeito de ligá-la (sem repetir o que o motivo já diz). */
function unavailableText(detail: string | null): string {
  const why = (detail ?? 'A IA não está configurada.').trim()
  return /Ajustes/.test(why) ? why : `${why} ${HOW_TO_ENABLE_AI}`
}

function noAiNotice(detail: string | null): string {
  return `Sem IA: usei a heurística, que escolhe pelas pausas, pelo ritmo da fala e pela atividade da tela. ${unavailableText(detail)}`
}

function finiteNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Valor inválido (${what}).`)
  return value
}

const CHUNK_KINDS: readonly ChunkKind[] = ['screen', 'camera', 'mic']
const BAR_ACTIONS: readonly BarAction[] = ['pause', 'resume', 'stop', 'discard', 'restart']
/** Maior posição aceita em `exporter:write` (128 GiB): nada de mandar o arquivo de vídeo para o infinito. */
const MAX_WRITE_POSITION = 128 * 1024 ** 3

/** O mesmo caminho, comparado como o Windows compara (sem diferença de maiúsculas, sem barra no fim). */
const sameKey = (a: string): string => resolve(a).toLowerCase()

export function createHandlers(deps: HandlerDeps): IpcHandlers {
  const { state, store, logger, recording, exporter, derived, transcription, llm } = deps
  /** O que o usuário escolheu nesta sessão pelos diálogos nativos: só isso entra em ajustes que viram caminho. */
  const pickedSettings = { projectsDir: new Set<string>(), ffmpegPath: new Set<string>() }
  const captionsExporter = createCaptionsExporter({ read: (id) => store.read(id), words: async (id) => (await transcription.getTranscript(id))?.words ?? null })
  const guard = () => ({
    root: state.projectsRoot(),
    isExportOutput: (real: string) => exporter.isOutput(real),
    isApprovedDir: (real: string) => deps.outputDirs.has(real)
  })
  /** Ajuste que vira caminho (pasta dos projetos, ffmpeg) só vale se veio do diálogo nativo desta sessão (ou se limpa o ajuste). */
  const assertPicked = (key: 'projectsDir' | 'ffmpegPath', value: string | undefined): void => {
    if (value === undefined) return
    if (typeof value !== 'string') throw new Error('Valor inválido para o ajuste.')
    if (value.trim() === '') return
    if (!isAbsolute(value.trim()) || !pickedSettings[key].has(sameKey(value.trim()))) {
      throw new Error('Esse caminho não foi escolhido por você nesta sessão. Use o botão "Escolher" para trocar este ajuste.')
    }
  }
  /** As palavras da transcrição do projeto, ou o erro que diz o que fazer. */
  const requireWords = async (projectId: string): Promise<Word[]> => {
    const transcript = await transcription.getTranscript(projectId)
    if (!transcript || transcript.words.length === 0) throw new Error('Este projeto ainda não tem transcrição. Transcreva primeiro (aba Texto).')
    return transcript.words
  }
  const requireProvider = (): NonNullable<ReturnType<LlmManager['provider']>> => {
    const provider = llm.provider()
    if (!provider) throw new LlmError(unavailableText(llm.status().detail), false)
    return provider
  }
  return {
    'app:info': async () => deps.info,

    'projects:list': () => store.list(),
    'projects:get': (id) => store.detail(id),
    'projects:rename': (id, title) => store.rename(id, title),
    'projects:save': async (id, project) => {
      // o que vai para o disco passa pelo mesmo esquema de quem lê; campos desconhecidos são preservados
      const checked = migrate(project)
      // caminhos do documento: relativos e dentro da pasta do projeto (o processo principal não confia no que a interface manda)
      await assertDocumentPaths(store.dirOf(id), checked)
      await store.write(id, checked)
      return checked
    },
    'projects:trash': (id) => store.trash(id),
    'projects:reveal': (id) => store.reveal(id),
    'projects:pick-background': async (id) => {
      store.dirOf(id) // id inválido falha ANTES de abrir o diálogo
      const picked = await deps.pickImage()
      return picked ? store.importBackground(id, picked) : null
    },

    'settings:get': async () => state.view(),
    'camera:calibrate': async (capture) => {
      if (recording.status().status !== 'idle' || recording.status().processing?.status === 'running') throw new Error('Espere a gravação e o processamento terminarem antes de calibrar.')
      if (!deps.calibration) throw new Error('A calibração de sincronia não está disponível neste computador.')
      return deps.calibration.run(capture)
    },
    'settings:update': async (patch) => {
      assertPicked('projectsDir', patch?.projectsDir)
      assertPicked('ffmpegPath', patch?.ffmpegPath)
      return state.update(patch)
    },
    'settings:pick-projects-dir': async () => {
      const picked = await deps.pickFolder(state.projectsRoot())
      if (picked) pickedSettings.projectsDir.add(sameKey(picked))
      return picked
    },
    'settings:pick-ffmpeg': async () => {
      const picked = await deps.pickFfmpeg()
      if (picked) pickedSettings.ffmpegPath.add(sameKey(picked))
      return picked
    },

    'ffmpeg:status': () => getFfmpegStatus(state.ffmpegLocateOptions(), logger),
    'ffmpeg:test': () => runFfmpegSelfTest(locateFfmpeg(state.ffmpegLocateOptions()), logger),

    'record:sources': () => recording.sources(),
    'record:prefs-get': async () => state.recordPrefs(),
    'record:prefs-set': (patch) => state.updateRecordPrefs(patch),
    'record:clock': async () => deps.clock(),
    'record:prepare': (request) => recording.prepare(recordRequestSchema.parse(request)),
    'record:countdown': () => recording.countdown(),
    'record:go': () => recording.go(),
    'record:started': (info) => recording.started(info),
    'record:chunk': (kind, data) => {
      if (!CHUNK_KINDS.includes(kind)) throw new Error(`Tipo de pedaço desconhecido: ${String(kind)}`)
      return recording.chunk(kind, data)
    },
    'record:pause': (at) => recording.pause(finiteNumber(at, 'instante')),
    'record:resume': (at) => recording.resume(finiteNumber(at, 'instante')),
    'record:stop': (info) => recording.stop(info),
    'record:abort': (reason) => recording.abort(reason),
    'record:status': async () => recording.status(),
    'process:retry': (sessionId) => recording.retry(sessionId),

    'export:start': (request) => exporter.start(exportRequestSchema.parse(request)),
    'export:cancel': (exportId) => exporter.cancel(exportId),
    'export:status': async () => exporter.status(),
    'export:pick-dir': async (defaultPath) => {
      const picked = await deps.pickExportDir(defaultPath)
      // só a pasta devolvida pelo diálogo nativo é destino válido da exportação
      if (picked) await deps.outputDirs.approve(picked)
      return picked
    },
    'captions:export': (projectId, kind) => captionsExporter.export(projectId, kind),
    'files:open': async (path) => deps.openPath(await checkOpenable(path, guard())),
    'files:reveal': async (path) => deps.revealPath(await checkRevealable(path, guard())),
    'clipboard:write': async (text) => {
      if (typeof text !== 'string' || text.length > 10_000) throw new Error('Texto inválido para a área de transferência.')
      deps.copyText(text)
    },
    'derived:peaks': (id) => derived.peaks(id),
    'derived:preview-audio': (id) => derived.previewAudio(id),
    'derived:thumbs': (id) => derived.thumbs(id),
    'derived:levels': (id) => derived.levels(id),

    'transcription:status': () => transcription.view(),
    'transcription:prepare': () => transcription.prepare(),
    'transcription:cancel-prepare': async () => transcription.cancelPrepare(),
    'transcription:start': (projectId) => transcription.start(projectId),
    'transcription:cancel': async (projectId) => {
      store.dirOf(projectId) // id inválido falha aqui
      transcription.cancel(projectId)
    },
    'transcription:get-prefs': async () => state.transcriptionPrefs(),
    'transcription:set-prefs': (patch) => state.updateTranscriptionPrefs(patch ?? {}),
    'transcript:get': (projectId) => transcription.getTranscript(projectId),
    'dictionary:get': async () => state.dictionary(),
    'dictionary:set': (terms) => state.setDictionary(terms),

    'llm:status': async () => llm.status(),
    'llm:set-prefs': async (patch) => {
      const provider = patch?.provider
      if (provider !== undefined && provider !== 'auto' && provider !== 'cli' && provider !== 'api') throw new Error('Escolha de IA inválida.')
      if (patch?.model !== undefined && typeof patch.model !== 'string') throw new Error('Modelo inválido.')
      await state.updateLlmPrefs({ ...(provider !== undefined ? { provider } : {}), ...(patch?.model !== undefined ? { model: patch.model } : {}) })
      return llm.status()
    },
    'llm:set-key': (key) => llm.setKey(key),
    'llm:clear-key': () => llm.clearKey(),
    'llm:test': async () => llm.test(),
    'ai:retakes': async (projectId) => {
      const transcript = await transcription.getTranscript(projectId)
      if (!transcript || transcript.words.length === 0) throw new Error('Este projeto ainda não tem transcrição. Transcreva primeiro.')
      const provider = llm.provider()
      if (!provider) throw new LlmError(llm.status().detail ?? 'A IA não está configurada.', false)
      // só o TEXTO da transcrição (com o número de cada palavra) vai para a IA
      return detectRetakes({ provider, words: transcript.words })
    },
    'ai:clips': async (projectId, mode) => {
      if (mode !== 'auto' && mode !== 'heuristic') throw new Error('Modo de sugestão inválido.')
      const { project, dir } = await store.read(projectId)
      const words = await requireWords(projectId)
      const durationMs = projectDurationMs(project)
      const activity = await readActivity(dir)
      const common = { words, durationMs, cuts: project.cuts, clicks: activity.clicks, keys: activity.keys, existing: project.clips }
      const provider = mode === 'auto' ? llm.provider() : null
      if (provider) {
        logger.info(`IA: sugerindo cortes de ${projectId} (${words.length} palavras).`)
        const r = await suggestClips({ provider, ...common })
        return { clips: r.clips, dropped: r.dropped, source: 'ai', notice: activity.warning }
      }
      const r = heuristicClips(common)
      const why = mode === 'heuristic' ? null : noAiNotice(llm.status().detail)
      return { clips: r.clips, dropped: r.dropped, source: 'heuristic', notice: [why, activity.warning].filter(Boolean).join(' ') || null }
    },
    'ai:edit': async (projectId, instruction, format) => {
      const text = typeof instruction === 'string' ? instruction.replace(/\s+/g, ' ').trim() : ''
      if (text === '') throw new Error('Escreva o que você quer mudar no vídeo.')
      if (text.length > 2000) throw new Error('O pedido é longo demais (no máximo 2.000 caracteres).')
      if (format !== 'horizontal' && format !== 'vertical') throw new Error('Formato inválido.')
      const { project, dir } = await store.read(projectId)
      const words = await requireWords(projectId)
      const provider = requireProvider()
      const activity = await readActivity(dir)
      logger.info(`IA: pedido de edição em ${projectId} (${text.length} caracteres).`)
      return proposeEdit({ provider, instruction: text, words, project: projectForFormat(project, format), format, durationMs: projectDurationMs(project), clicks: activity.clicks, keys: activity.keys })
    },
    'ai:publish': async (projectId) => {
      const { project } = await store.read(projectId)
      const words = await requireWords(projectId)
      const provider = requireProvider()
      logger.info(`IA: textos de publicação de ${projectId}.`)
      return generatePublish({ provider, project, words, durationMs: projectDurationMs(project), clips: project.clips })
    },
    'exporter:job': async (exportId) => exporter.job(exportId),
    'exporter:write': (exportId, position, data) => {
      if (!Number.isSafeInteger(position) || position < 0 || position > MAX_WRITE_POSITION) throw new Error('Posição de escrita inválida.')
      if (!(data instanceof Uint8Array)) throw new Error('Dados de escrita inválidos.')
      return exporter.write(exportId, position, data)
    },
    'exporter:progress': async (exportId, frame, renderFps) => exporter.progress(exportId, frame, renderFps),
    'exporter:finish': async (exportId, result) => exporter.finish(exportId, result),

    'bar:state': async () => recording.barState(),
    'bar:action': async (action) => {
      if (!BAR_ACTIONS.includes(action)) throw new Error(`Ação da barra desconhecida: ${String(action)}`)
      recording.command(action, 'bar')
    },
    'countdown:begin': async () => recording.countdownConfig(),
    'countdown:finish': async (completed) => {
      deps.finishCountdown(Boolean(completed))
    },
    'bubble:config': async () => recording.bubbleConfig()
  }
}
