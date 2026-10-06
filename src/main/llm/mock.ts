/**
 * `MockProvider`: respostas GRAVADAS, para os testes (`TOMADA_LLM=mock`). Cada resposta tem um trecho que precisa
 * aparecer no prompt (`match`) e o objeto que volta. O arquivo opcional `TOMADA_LLM_RESPONSES` traz a lista em JSON
 * (`[{ "match": "login", "response": { "retakes": [...] } }]`); sem ele, toda pergunta recebe `{ "retakes": [] }`.
 * Pedido sem resposta gravada falha com erro visível (o teste pega o desvio).
 */
import { LlmError } from '@shared/llm-json'
import { providerFromAsk, type AskFn, type LlmProvider } from './provider'

export type RecordedResponse = {
  /** Trecho que precisa aparecer no pedido ("" = qualquer). */
  match: string
  response: unknown
  /** Quantas vezes vale (padrão: sempre). */
  times?: number
  /** Só vale para esta tarefa ("retakes", "clips", "edit", "publish"); ausente = qualquer. */
  task?: string
}

/**
 * Sem arquivo de respostas: os cortes não acham nada, "editar pedindo" não muda nada e a publicação devolve um texto
 * mínimo; qualquer outra pergunta recebe a lista vazia de recomeços (como sempre foi).
 */
export const DEFAULT_RECORDED: readonly RecordedResponse[] = [
  { task: 'dictionary', match: '', response: { corrections: [] } },
  { task: 'script', match: '', response: { title: 'Demonstração do sistema', hook: 'Veja como simplificar seu trabalho.', topics: ['Apresentar o problema', 'Demonstrar a solução', 'Mostrar o resultado'], closing: 'Experimente e conte o que achou.' } },
  { task: 'clips', match: '', response: { clips: [] } },
  { task: 'edit', match: '', response: { ops: [], reply: 'A IA de teste não propõe mudanças.' } },
  { task: 'publish', match: '', response: { titles: ['Título de teste'], description: 'Descrição de teste.', tags: ['teste'], chapters: [], clips: [] } },
  { match: '', response: { retakes: [] } }
]

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
    const hit = recorded.find((r) => (r.times === undefined || r.times > 0) && (r.task === undefined || r.task === task) && prompt.includes(r.match))
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
    const o = r as { match?: unknown; response?: unknown; times?: unknown; task?: unknown }
    if (typeof o.match !== 'string') throw new Error(`Resposta gravada ${i}: falta "match".`)
    return { match: o.match, response: o.response, ...(typeof o.times === 'number' ? { times: o.times } : {}), ...(typeof o.task === 'string' ? { task: o.task } : {}) }
  })
}
