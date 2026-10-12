/**
 * Quem escolhe a IA que vale agora: o Claude Code já instalado e logado neste computador (caminho principal; o Tomada nunca
 * pede nem guarda as credenciais dele), a chave de API da Anthropic do usuário (alternativa; cifrada com `safeStorage`, nunca
 * devolvida à interface) ou, só em teste (`TOMADA_LLM=mock`), as respostas gravadas.
 * Sem Electron: a cifra entra por parâmetro (`KeyVault`).
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { LlmError } from '@shared/llm-json'
import type { LlmStatus } from '@shared/transcription'
import type { Logger } from '../logger'
import { runProcess } from '../process-runner'
import { createAnthropicApiProvider } from './anthropic-api'
import { createClaudeCliProvider, locateClaude } from './claude-cli'
import { createMockProvider, DEFAULT_RECORDED, parseRecorded } from './mock'
import type { LlmProvider } from './provider'

/** Cifra a chave com o cofre do sistema (no app: `safeStorage`). */
export interface KeyVault {
  available(): boolean
  encrypt(plain: string): string
  decrypt(encrypted: string): string
}

export type LlmPrefs = { provider?: 'auto' | 'cli' | 'api'; model?: string; apiKeyEnc?: string }

export interface LlmManager {
  status(): LlmStatus
  /** A IA que vale agora, ou null se não há nenhuma configurada. */
  provider(): LlmProvider | null
  setKey(key: string): Promise<LlmStatus>
  clearKey(): Promise<LlmStatus>
  /** Faz uma pergunta mínima para provar que a IA responde. */
  test(): Promise<{ ok: true } | { ok: false; message: string }>
}

export type LlmManagerDeps = {
  env: NodeJS.ProcessEnv
  getPrefs: () => LlmPrefs
  savePrefs: (patch: LlmPrefs) => Promise<void>
  vault: KeyVault
  /** Pasta de trabalho (vazia) do programa de linha de comando. */
  scratchDir: string
  logger: Logger
  run?: typeof runProcess
  fetchImpl?: typeof fetch
  findClaude?: () => string | null
}

const KEY_RE = /^[\x21-\x7e]{10,400}$/

export function createLlmManager(deps: LlmManagerDeps): LlmManager {
  const { env, vault, logger } = deps
  const find = deps.findClaude ?? ((): string | null => locateClaude(env))

  let mock: LlmProvider | null = null
  const mockProvider = (): LlmProvider => {
    if (mock) return mock
    let recorded = DEFAULT_RECORDED
    const file = env.TOMADA_LLM_RESPONSES?.trim()
    if (file) recorded = parseRecorded(readFileSync(file, 'utf8'))
    mock = createMockProvider({ recorded, ...(env.TOMADA_LLM_DELAY_MS ? { delayMs: Number(env.TOMADA_LLM_DELAY_MS) } : {}) })
    return mock
  }

  const decryptedKey = (): string | null => {
    const enc = deps.getPrefs().apiKeyEnc
    if (!enc) return null
    try {
      return vault.decrypt(enc)
    } catch (err) {
      logger.warn('Não consegui abrir a chave da IA guardada (a conta do Windows mudou?).', err)
      return null
    }
  }

  const resolve = (): { provider: LlmProvider | null; status: LlmStatus } => {
    const prefs = deps.getPrefs()
    const preference = prefs.provider ?? 'auto'
    const cli = find()
    const hasKey = Boolean(prefs.apiKeyEnc)
    const base = { hasKey, cliFound: cli !== null, preference }
    if (env.TOMADA_LLM === 'mock') return { provider: mockProvider(), status: { ...base, provider: 'mock', available: true, detail: null } }
    // só em teste: nenhuma IA configurada, mesmo que o Claude Code esteja instalado neste computador
    if (env.TOMADA_LLM === 'off') return { provider: null, status: { ...base, provider: null, available: false, detail: 'A IA está desligada neste teste.' } }

    const useCli = (): LlmProvider => {
      mkdirSync(deps.scratchDir, { recursive: true })
      return createClaudeCliProvider({ exe: cli!, cwd: deps.scratchDir, ...(prefs.model ? { model: prefs.model } : {}), ...(deps.run ? { run: deps.run } : {}) })
    }
    const useApi = (): LlmProvider =>
      createAnthropicApiProvider({ getKey: decryptedKey, ...(prefs.model ? { model: prefs.model } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) })

    if (preference === 'cli' || (preference === 'auto' && cli)) {
      if (cli) return { provider: useCli(), status: { ...base, provider: 'cli', available: true, detail: null } }
      return { provider: null, status: { ...base, provider: null, available: false, detail: 'Não achei o Claude Code instalado neste computador.' } }
    }
    if (hasKey) return { provider: useApi(), status: { ...base, provider: 'api', available: true, detail: null } }
    return {
      provider: null,
      status: { ...base, provider: null, available: false, detail: preference === 'api' ? 'Cole a chave de API da Anthropic nos Ajustes.' : 'A IA não está configurada: instale o Claude Code e entre com a sua conta, ou cole uma chave de API da Anthropic nos Ajustes.' }
    }
  }

  return {
    status: () => resolve().status,
    provider: () => resolve().provider,
    async setKey(key) {
      const clean = typeof key === 'string' ? key.trim() : ''
      if (!KEY_RE.test(clean)) throw new LlmError('Essa chave não parece válida (sem espaços, de 10 a 400 caracteres).', false)
      if (!vault.available()) throw new LlmError('Este computador não permite guardar a chave com segurança, então não guardei.', false)
      await deps.savePrefs({ apiKeyEnc: vault.encrypt(clean) })
      logger.info('Chave da IA guardada (cifrada).')
      return resolve().status
    },
    async clearKey() {
      await deps.savePrefs({ apiKeyEnc: '' })
      logger.info('Chave da IA apagada.')
      return resolve().status
    },
    async test() {
      const { provider, status } = resolve()
      if (!provider) return { ok: false, message: status.detail ?? 'A IA não está configurada.' }
      try {
        const r = await provider.complete({
          task: 'teste',
          system: 'Você responde somente com JSON válido.',
          prompt: 'Responda exatamente {"ok":true}.',
          schema: z.object({ ok: z.boolean() }),
          timeoutMs: 90_000
        })
        return r.ok ? { ok: true } : { ok: false, message: 'A IA respondeu, mas não como esperado.' }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  }
}
