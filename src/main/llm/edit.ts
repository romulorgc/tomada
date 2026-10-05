/**
 * "Editar pedindo" pela IA: o pedido da pessoa, o estado do projeto e a transcrição com o número de cada palavra vão
 * como TEXTO; a IA devolve operações (cortar, devolver, zoom, layout, corte vertical, legenda, título). Aqui só se pede e
 * se confere o formato; quem valida o CONTEÚDO de cada operação e a aplica é `planAiEdit` (código puro, na interface,
 * porque é ele que entra no desfazer).
 */
import { buildEditPrompt, editSchema, editSystem, type AiEditResult, type EditFormat } from '@shared/ai-edit'
import type { Project, Word } from '@shared/types'
import type { LlmProvider } from './provider'

export type ProposeEditArgs = {
  provider: LlmProvider
  instruction: string
  words: readonly Word[]
  /** O projeto como o formato aberto o enxerga (zooms e layouts do formato). */
  project: Project
  format: EditFormat
  durationMs: number
  clicks: readonly number[]
  keys: readonly number[]
  signal?: AbortSignal
}

export async function proposeEdit(args: ProposeEditArgs): Promise<AiEditResult> {
  const r = await args.provider.complete({
    task: 'edit',
    system: editSystem(args.format, Boolean(args.project.sources.camera)),
    prompt: buildEditPrompt({ instruction: args.instruction, words: args.words, project: args.project, format: args.format, durationMs: args.durationMs, clicks: args.clicks, keys: args.keys }),
    schema: editSchema,
    ...(args.signal ? { signal: args.signal } : {})
  })
  return { ops: r.ops, reply: r.reply?.trim() ? r.reply.trim().replace(/\s+/g, ' ').slice(0, 400) : null }
}
