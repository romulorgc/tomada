/**
 * Recomeços pela IA: manda a transcrição (SÓ o texto, com o número de cada palavra) em janelas e junta as respostas.
 * Os índices que a IA devolve são validados um a um (`validateRetakes`): o que não existe é descartado e contado.
 */
import { validateRetakes } from '@shared/clean'
import { buildRetakePrompts, RETAKES_SYSTEM, retakesSchema } from '@shared/retakes-prompt'
import type { RetakesResult } from '@shared/transcription'
import type { Word } from '@shared/types'
import type { LlmProvider } from './provider'

export async function detectRetakes(args: { provider: LlmProvider; words: readonly Word[]; signal?: AbortSignal; onProgress?: (done: number, total: number) => void }): Promise<RetakesResult> {
  const prompts = buildRetakePrompts(args.words)
  const raw: { from: unknown; to: unknown; reason?: unknown }[] = []
  let done = 0
  for (const prompt of prompts) {
    const r = await args.provider.complete({ task: 'retakes', system: RETAKES_SYSTEM, prompt, schema: retakesSchema, ...(args.signal ? { signal: args.signal } : {}) })
    raw.push(...r.retakes)
    args.onProgress?.(++done, prompts.length)
  }
  // os números de palavra são `Word.i`: o teto é a maior posição
  const top = args.words.reduce((m, w) => Math.max(m, w.i), -1)
  return validateRetakes(raw, top + 1)
}
