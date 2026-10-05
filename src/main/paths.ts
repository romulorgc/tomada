/**
 * Onde as coisas moram. Sem Electron (recebe tudo por parâmetro): testável em Node.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Settings, SettingsView } from '@shared/ipc'

/** Variável que testes usam para apontar a raiz dos projetos para uma pasta temporária. */
export const ENV_PROJECTS_DIR = 'TOMADA_PROJECTS_DIR'
/** Variável que testes usam para isolar ajustes e logs (userData) do app real. */
export const ENV_USER_DATA_DIR = 'TOMADA_USER_DATA_DIR'

/** `%USERPROFILE%\Videos\Tomada` */
export function defaultProjectsDir(home: string = homedir()): string {
  return join(home, 'Videos', 'Tomada')
}

export type ProjectsDirResolution = SettingsView['effective']

/** Prioridade: variável de ambiente (testes) > ajuste do usuário > padrão. */
export function resolveProjectsDir(args: {
  env?: NodeJS.ProcessEnv
  settings: Pick<Settings, 'projectsDir'>
  home?: string
}): ProjectsDirResolution {
  const env = args.env ?? process.env
  const fromEnv = env[ENV_PROJECTS_DIR]?.trim()
  if (fromEnv) return { projectsDir: fromEnv, projectsDirSource: 'env' }
  const fromSettings = args.settings.projectsDir?.trim()
  if (fromSettings) return { projectsDir: fromSettings, projectsDirSource: 'settings' }
  return { projectsDir: defaultProjectsDir(args.home), projectsDirSource: 'default' }
}

export const settingsFile = (userData: string): string => join(userData, 'settings.json')
export const logsDir = (userData: string): string => join(userData, 'logs')
