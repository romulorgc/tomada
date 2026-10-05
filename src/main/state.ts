/**
 * Estado do app no processo principal: ajustes em memória + disco, raiz dos
 * projetos efetiva e como achar o ffmpeg. Sem Electron.
 */
import { mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { Settings, SettingsView } from '@shared/ipc'
import { locateFfmpeg, type LocateOptions } from './ffmpeg'
import type { Logger } from './logger'
import { resolveProjectsDir } from './paths'
import { applySettingsPatch, loadSettings, saveSettings } from './settings'

export interface AppState {
  settings(): Settings
  view(): SettingsView
  projectsRoot(): string
  ffmpegLocateOptions(): LocateOptions
  update(patch: Partial<Settings>): Promise<SettingsView>
}

const patchSchema = z.object({
  projectsDir: z.string().max(1000).optional(),
  ffmpegPath: z.string().max(1000).optional()
})

export async function createAppState(args: {
  file: string
  env?: NodeJS.ProcessEnv
  logger: Logger
  bundledFfmpegDir?: string
}): Promise<AppState> {
  const env = args.env ?? process.env
  let current = await loadSettings(args.file, args.logger)

  const view = (): SettingsView => ({
    settings: { ...current },
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
    }
  }
}
