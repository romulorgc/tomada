/**
 * A atividade de tela de uma gravação (cliques e "houve digitação"), lida de `events/` para os cortes e para o
 * "editar pedindo" saberem onde a pessoa está MOSTRANDO algo. Só os instantes saem daqui (nunca qual tecla, nunca
 * posição do cursor). O caminho passa por `resolveProjectFile`. Arquivo ausente (gravação só de câmera) é "sem atividade";
 * arquivo ilegível NÃO é calado: vem em `warning` e a interface o mostra.
 *
 * Sem Electron.
 */
import { readFile } from 'node:fs/promises'
import { EVENT_FILES, eventsFromText } from '@shared/events'
import { pathExists } from './fs-utils'
import { resolveProjectFile } from './project-files'

export type Activity = { clicks: number[]; keys: number[]; warning: string | null }

async function readIfThere(dir: string, rel: string): Promise<string | undefined> {
  const file = await resolveProjectFile(dir, rel)
  return (await pathExists(file)) ? readFile(file, 'utf8') : undefined
}

export async function readActivity(dir: string): Promise<Activity> {
  try {
    const [clicks, keys] = await Promise.all([readIfThere(dir, EVENT_FILES.clicks), readIfThere(dir, EVENT_FILES.keys)])
    const events = eventsFromText({ ...(clicks !== undefined ? { clicks } : {}), ...(keys !== undefined ? { keys } : {}) })
    return { clicks: events.clicks.filter((c) => !c.out).map((c) => c.t), keys: events.keys.map((k) => k.t), warning: null }
  } catch (err) {
    return { clicks: [], keys: [], warning: `Não consegui ler os cliques e as teclas da gravação (${err instanceof Error ? err.message : String(err)}): a atividade da tela não foi considerada.` }
  }
}
