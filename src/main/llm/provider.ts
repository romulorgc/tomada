/**
 * `LlmProvider`: a porta única da IA de texto (base também da M4). `complete({system, prompt, schema})` devolve um
 * objeto JÁ VALIDADO (zod). Cada fornecedor só sabe fazer uma pergunta e devolver o texto (`ask`); a leitura do JSON,
 * a validação e a regra "JSON quebrado → UMA nova tentativa pedindo correção → depois erro visível" são daqui e
 * valem para todos.
 *
 * A interface NUNCA nomeia o fornecedor para o usuário final: as mensagens dizem "IA".
 */
import type { z } from 'zod'
import { correctionPrompt, LlmError, parseLlmJson } from '@shared/llm-json'
import type { LlmProviderId } from '@shared/transcription'

export type LlmRequest<T> = {
  /** Nome da tarefa ("retakes"): vai para o log e escolhe a resposta gravada do `MockProvider`. */
  task: string
  system: string
  prompt: string
  schema: z.ZodType<T>
  signal?: AbortSignal
  /** Tempo máximo de CADA pergunta (ms). */
  timeoutMs?: number
}

export interface LlmProvider {
  readonly id: LlmProviderId
  complete<T>(req: LlmRequest<T>): Promise<T>
}

/** O que cada fornecedor implementa: uma pergunta, o texto da resposta. */
export type AskFn = (req: { task: string; system: string; prompt: string; signal?: AbortSignal; timeoutMs?: number }) => Promise<string>

/** Monta o provedor a partir do `ask`: lê o JSON, valida e, se vier quebrado, pede a correção UMA vez. */
export function providerFromAsk(id: LlmProviderId, ask: AskFn): LlmProvider {
  return {
    id,
    async complete<T>(req: LlmRequest<T>): Promise<T> {
      const base = { task: req.task, system: req.system, ...(req.signal ? { signal: req.signal } : {}), ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}) }
      const first = await ask({ ...base, prompt: req.prompt })
      const a = parseLlmJson(first, req.schema)
      if (a.ok) return a.value
      const second = await ask({ ...base, prompt: correctionPrompt(req.prompt, first, a.error) })
      const b = parseLlmJson(second, req.schema)
      if (b.ok) return b.value
      throw new LlmError(`A IA devolveu uma resposta que não consegui usar, mesmo depois de pedir de novo (${b.error}). Tente de novo.`, true)
    }
  }
}
