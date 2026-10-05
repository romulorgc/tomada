/**
 * Ajustes do usuário: um JSON validado em `<userData>/settings.json`.
 * Arquivo ausente = padrões. Arquivo quebrado = padrões + aviso no log (o app abre
 * do mesmo jeito) e o arquivo ruim é guardado como `settings.json.invalido`.
 */
import { readFile, rename } from 'node:fs/promises'
import { z } from 'zod'
import type { Settings } from '@shared/ipc'
import { writeFileAtomic } from './fs-utils'
import type { Logger } from './logger'

// "loose": campos que este código não conhece (de uma versão futura, ou da M1b) sobrevivem.
export const settingsSchema = z.looseObject({
  projectsDir: z.string().min(1).optional(),
  ffmpegPath: z.string().min(1).optional(),
  // Preferências da tela Gravar: validadas na leitura (`normalizeRecordPrefs`), aqui só passam.
  record: z.looseObject({}).optional()
})

export async function loadSettings(file: string, logger: Logger): Promise<Settings> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    logger.error('Não consegui ler os ajustes; usando os padrões.', err)
    return {}
  }
  try {
    return settingsSchema.parse(JSON.parse(text))
  } catch (err) {
    logger.warn(`Ajustes inválidos em ${file}; usando os padrões e guardando o arquivo ruim.`, err)
    await rename(file, `${file}.invalido`).catch(() => undefined)
    return {}
  }
}

export async function saveSettings(file: string, settings: Settings): Promise<void> {
  const clean = settingsSchema.parse(settings)
  await writeFileAtomic(file, `${JSON.stringify(clean, null, 2)}\n`)
}

/**
 * Aplica um patch: `undefined` não mexe; string vazia APAGA o ajuste (volta ao padrão).
 */
export function applySettingsPatch(current: Settings, patch: Partial<Settings>): Settings {
  const next: Settings = { ...current }
  for (const key of ['projectsDir', 'ffmpegPath'] as const) {
    const value = patch[key]
    if (value === undefined) continue
    if (value.trim() === '') delete next[key]
    else next[key] = value.trim()
  }
  return next
}
