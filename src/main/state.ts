/**
 * Estado do app no processo principal: ajustes em memória + disco, raiz dos
 * projetos efetiva e como achar o ffmpeg. Sem Electron.
 */
import { mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { autopilotPrefsSchema } from '@shared/autopilot'
import { projectSchema } from '@shared/project'
import { normalizeDictionary } from '@shared/dictionary'
import type { LlmStoredPrefs, Settings, SettingsView } from '@shared/ipc'
import { normalizeRecordPrefs, type RecordPrefs } from '@shared/recording'
import { DEFAULT_TRANSCRIPTION_PREFS, type TranscriptionPrefs } from '@shared/transcription'
import { locateFfmpeg, type LocateOptions } from './ffmpeg'
import type { Logger } from './logger'
import { resolveProjectsDir } from './paths'
import { applySettingsPatch, loadSettings, saveSettings, settingsSchema } from './settings'

export interface AppState {
  settings(): Settings
  view(): SettingsView
  projectsRoot(): string
  ffmpegLocateOptions(): LocateOptions
  update(patch: Partial<Settings>): Promise<SettingsView>
  /** Escolhas da tela Gravar (sempre válidas: o que faltar ou estiver ruim volta ao padrão). */
  recordPrefs(): RecordPrefs
  updateRecordPrefs(patch: Partial<RecordPrefs>): Promise<RecordPrefs>
  /** Dicionário (nomes próprios) da transcrição. */
  dictionary(): string[]
  setDictionary(terms: unknown): Promise<string[]>
  transcriptionPrefs(): TranscriptionPrefs
  updateTranscriptionPrefs(patch: Partial<TranscriptionPrefs>): Promise<TranscriptionPrefs>
  /** Qual motor transcreve (padrão: faster-whisper; o outro só por arquivo de ajustes ou `TOMADA_TRANSCRIBER`). */
  transcriptionEngine(): 'faster-whisper' | 'whisper-cpp'
  /** Ajustes da IA, COM a chave cifrada: só o processo principal usa; `view()` nunca a devolve. */
  llmPrefs(): LlmStoredPrefs
  updateLlmPrefs(patch: LlmStoredPrefs): Promise<void>
}

const patchSchema = z.object({
  projectsDir: z.string().max(1000).optional(),
  ffmpegPath: z.string().max(1000).optional(),
  autopilot: autopilotPrefsSchema.optional(),
  ownerStyle: projectSchema.shape.style.optional(),
  ownerStyleAsset: settingsSchema.shape.ownerStyleAsset
})

export async function createAppState(args: {
  file: string
  env?: NodeJS.ProcessEnv
  logger: Logger
  bundledFfmpegDir?: string
}): Promise<AppState> {
  const env = args.env ?? process.env
  let current = await loadSettings(args.file, args.logger)

  // Toda gravação de ajustes entra numa FILA: cada uma parte do estado que a anterior deixou. Sem isso,
  // dois pedidos quase juntos (a tela Gravar manda um por controle que muda) liam o mesmo `current`,
  // e o que terminava por último apagava a mudança do outro.
  let queue: Promise<unknown> = Promise.resolve()
  const serialized = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job, job)
    queue = run.catch(() => undefined)
    return run
  }

  /** O que a interface pode ver: nunca a chave da IA (nem cifrada). */
  const publicSettings = (): Settings => {
    const { llm, ...rest } = current
    if (!llm) return { ...rest }
    const { apiKeyEnc: _secret, ...safe } = llm
    void _secret
    return { ...rest, llm: safe }
  }
  const view = (): SettingsView => ({
    settings: publicSettings(),
    effective: resolveProjectsDir({ env, settings: current })
  })

  return {
    settings: () => ({ ...current }),
    view,
    projectsRoot: () => resolveProjectsDir({ env, settings: current }).projectsDir,
    ffmpegLocateOptions: () => ({
      ...(current.ffmpegPath ? { custom: current.ffmpegPath } : {}),
      ...(args.bundledFfmpegDir ? { bundledDir: args.bundledFfmpegDir } : {}),
      env
    }),

    async update(rawPatch) {
      const patch = patchSchema.parse(rawPatch)
      return serialized(async () => {
        const next = applySettingsPatch(current, patch)

        // Valida ANTES de gravar: ajuste ruim não pode ficar guardado.
        if (next.projectsDir && next.projectsDir !== current.projectsDir) {
          if (!isAbsolute(next.projectsDir)) {
            throw new Error(`A pasta dos projetos precisa ser um caminho completo (ex.: C:\\Videos\\Tomada). Recebi "${next.projectsDir}".`)
          }
          try {
            await mkdir(next.projectsDir, { recursive: true })
          } catch (err) {
            throw new Error(`Não consegui usar a pasta "${next.projectsDir}": ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (next.ffmpegPath && next.ffmpegPath !== current.ffmpegPath) {
          if (!locateFfmpeg({ custom: next.ffmpegPath, env })) {
            throw new Error(`Não encontrei o ffmpeg e o ffprobe em "${next.ffmpegPath}". Escolha a pasta que tem os dois, ou o ffmpeg.exe.`)
          }
        }

        await saveSettings(args.file, next)
        current = next
        args.logger.info('Ajustes atualizados', { projectsDir: next.projectsDir, ffmpegPath: next.ffmpegPath })
        return view()
      })
    },

    recordPrefs: () => normalizeRecordPrefs(current.record),

    dictionary: () => normalizeDictionary(current.dictionary),

    setDictionary: (terms) =>
      serialized(async () => {
        const dictionary = normalizeDictionary(terms)
        const next: Settings = { ...current, dictionary }
        await saveSettings(args.file, next)
        current = next
        return dictionary
      }),

    transcriptionPrefs: () => ({ ...DEFAULT_TRANSCRIPTION_PREFS, ...(current.transcription?.auto !== undefined ? { auto: current.transcription.auto } : {}), ...(current.transcription?.autoClean !== undefined ? { autoClean: current.transcription.autoClean } : {}), ...(current.autopilot?.steps.transcribe !== undefined ? {auto:current.autopilot.steps.transcribe} : {}), ...(current.autopilot?.steps.clean !== undefined ? {autoClean:current.autopilot.steps.clean} : {}) }),

    updateTranscriptionPrefs: (patch) =>
      serialized(async () => {
        const clean: Partial<TranscriptionPrefs> = {}
        if (typeof patch.auto === 'boolean') clean.auto = patch.auto
        if (typeof patch.autoClean === 'boolean') clean.autoClean = patch.autoClean
        const next: Settings = { ...current, transcription: { ...current.transcription, ...clean }, ...(current.autopilot ? {autopilot:{...current.autopilot,steps:{...current.autopilot.steps,...(clean.auto === undefined ? {} : {transcribe:clean.auto}),...(clean.autoClean === undefined ? {} : {clean:clean.autoClean})}}} : {}) }
        await saveSettings(args.file, next)
        current = next
        return { ...DEFAULT_TRANSCRIPTION_PREFS, ...(next.transcription?.auto !== undefined ? { auto: next.transcription.auto } : {}), ...(next.transcription?.autoClean !== undefined ? { autoClean: next.transcription.autoClean } : {}) }
      }),

    transcriptionEngine: () => current.transcription?.engine ?? 'faster-whisper',

    llmPrefs: () => ({ ...current.llm }),

    updateLlmPrefs: (patch) =>
      serialized(async () => {
        const merged: LlmStoredPrefs = { ...current.llm }
        if (patch.provider !== undefined) merged.provider = patch.provider
        if (patch.model !== undefined) {
          if (patch.model.trim() === '') delete merged.model
          else merged.model = patch.model.trim().slice(0, 100)
        }
        if (patch.apiKeyEnc !== undefined) {
          if (patch.apiKeyEnc === '') delete merged.apiKeyEnc
          else merged.apiKeyEnc = patch.apiKeyEnc
        }
        const next: Settings = { ...current, llm: merged }
        await saveSettings(args.file, next)
        current = next
      }),

    updateRecordPrefs: (patch) =>
      serialized(async () => {
        const merged = normalizeRecordPrefs({ ...normalizeRecordPrefs(current.record), ...patch })
        const next: Settings = { ...current, record: merged }
        await saveSettings(args.file, next)
        current = next
        return merged
      })
  }
}
