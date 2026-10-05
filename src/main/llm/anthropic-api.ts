/**
 * `AnthropicApiProvider`: a IA por chave de API do usuário (guardada com `safeStorage`; a chave nunca volta para a
 * interface). Origem FIXA: `https://api.anthropic.com/v1/messages`, só HTTPS. Sem biblioteca: um `fetch` com
 * tempo limite. Só vai texto (o sistema e a transcrição).
 */
import { LlmError } from '@shared/llm-json'
import { providerFromAsk, type AskFn, type LlmProvider } from './provider'

export const API_URL = 'https://api.anthropic.com/v1/messages'
export const API_VERSION = '2023-06-01'
export const API_DEFAULT_MODEL = 'claude-sonnet-5-5'
export const API_DEFAULT_TIMEOUT_MS = 240_000

export type ApiOptions = {
  /** A chave é lida na hora de cada pergunta (a pessoa pode trocá-la nos Ajustes). */
  getKey: () => string | null
  model?: string
  fetchImpl?: typeof fetch
  url?: string
}

export function createAnthropicApiProvider(opts: ApiOptions): LlmProvider {
  const doFetch = opts.fetchImpl ?? fetch
  const ask: AskFn = async ({ system, prompt, signal, timeoutMs }) => {
    const key = opts.getKey()
    if (!key) throw new LlmError('Falta a chave da IA. Cole a chave nos Ajustes.', false)
    const url = opts.url ?? API_URL
    if (new URL(url).protocol !== 'https:') throw new LlmError('A IA só é chamada por HTTPS.', false)
    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => ctl.abort(), timeoutMs ?? API_DEFAULT_TIMEOUT_MS)
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION },
        body: JSON.stringify({ model: opts.model ?? API_DEFAULT_MODEL, max_tokens: 4096, system, messages: [{ role: 'user', content: prompt }] }),
        signal: ctl.signal
      })
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300)
        if (res.status === 401 || res.status === 403) throw new LlmError('A chave da IA foi recusada. Confira a chave nos Ajustes.', false)
        if (res.status === 429) throw new LlmError('A IA está com limite de uso no momento. Tente de novo daqui a pouco.', true)
        throw new LlmError(`A IA respondeu com erro ${res.status}${body ? `: ${body}` : ''}.`, res.status >= 500)
      }
      const json = (await res.json()) as { content?: { type?: string; text?: string }[] }
      const text = (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
      if (!text) throw new LlmError('A IA respondeu vazio. Tente de novo.', true)
      return text
    } catch (err) {
      if (err instanceof LlmError) throw err
      if (signal?.aborted) throw new LlmError('Cancelado.', false)
      if (ctl.signal.aborted) throw new LlmError('A IA demorou demais para responder. Tente de novo.', true)
      throw new LlmError(`Não consegui falar com a IA: ${err instanceof Error ? err.message : String(err)}`, true)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  return providerFromAsk('api', ask)
}
