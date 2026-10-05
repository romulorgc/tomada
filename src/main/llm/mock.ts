/**
 * `MockProvider`: respostas GRAVADAS, para os testes (`TOMADA_LLM=mock`). Cada resposta tem um trecho que precisa
 * aparecer no prompt (`match`) e o objeto que volta. O arquivo opcional `TOMADA_LLM_RESPONSES` traz a lista em JSON
 * (`[{ "match": "login", "response": { "retakes": [...] } }]`); sem ele, toda pergunta recebe `{ "retakes": [] }`.
 * Pedido sem resposta gravada falha com erro visível (o teste pega o desvio).
 */
import { LlmError } from '@shared/llm-json'
import { providerFromAsk, type AskFn, type LlmProvider } from './provider'

export type RecordedResponse = { match: string; response: unknown; /** Quantas vezes vale (padrão: sempre). */ times?: number }

export const DEFAULT_RECORDED: readonly RecordedResponse[] = [{ match: '', response: { retakes: [] } }]

export type MockOptions = {
  recorded?: readonly RecordedResponse[]
  delayMs?: number
  /** Cada pergunta feita (para o teste conferir o que foi enviado). */
  onAsk?: (req: { task: string; system: string; prompt: string }) => void
}

export function createMockProvider(opts: MockOptions = {}): LlmProvider {
  const recorded = (opts.recorded ?? DEFAULT_RECORDED).map((r) => ({ ...r }))
  const ask: AskFn = async ({ task, system, prompt, signal }) => {
    opts.onAsk?.({ task, system, prompt })
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
    if (signal?.aborted) throw new LlmError('Cancelado.', false)
    const hit = recorded.find((r) => (r.times === undefined || r.times > 0) && prompt.includes(r.match))
    if (!hit) throw new LlmError(`Teste: não há resposta gravada para este pedido (${task}).`, false)
    if (hit.times !== undefined) hit.times--
    return typeof hit.response === 'string' ? hit.response : JSON.stringify(hit.response)
  }
  return providerFromAsk('mock', ask)
}

/** Lê as respostas gravadas de um JSON (texto do arquivo). */
export function parseRecorded(text: string): RecordedResponse[] {
  const raw = JSON.parse(text) as unknown
  if (!Array.isArray(raw)) throw new Error('O arquivo de respostas gravadas precisa ser uma lista.')
  return raw.map((r, i) => {
    const o = r as { match?: unknown; response?: unknown; times?: unknown }
    if (typeof o.match !== 'string') throw new Error(`Resposta gravada ${i}: falta "match".`)
    return { match: o.match, response: o.response, ...(typeof o.times === 'number' ? { times: o.times } : {}) }
  })
}
