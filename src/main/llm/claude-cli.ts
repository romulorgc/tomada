/**
 * `ClaudeCliProvider`: a IA pelo programa `claude` já instalado e logado neste computador (`claude -p`).
 *
 * Como o processo filho é aberto (tudo o que a segurança pede):
 *  - **sem shell** (`claude.exe`, nunca `.cmd`) e **prompt pelo stdin**: a transcrição nunca vai na linha de comando;
 *  - **sem ferramentas** (`--tools ""`), sem MCP, sem skills, sem sessão gravada e sem ler configurações do projeto:
 *    é só "texto entra, texto sai";
 *  - **pasta de trabalho vazia** (uma pasta temporária do app), para nenhum arquivo do usuário ser lido;
 *  - **sem herdar `ELECTRON_RUN_AS_NODE`** (ver `childEnv`) e **com tempo limite**.
 */
import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { LlmError } from '@shared/llm-json'
import { ProcessError, runProcess, tail } from '../process-runner'
import { providerFromAsk, type AskFn, type LlmProvider } from './provider'

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** O `claude.exe` (PATH e a pasta do instalador nativo). `.cmd` não serve: precisaria de shell. */
export function locateClaude(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const exe = platform === 'win32' ? 'claude.exe' : 'claude'
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path')
  const dirs = (key ? (env[key] ?? '') : '')
    .split(platform === 'win32' ? ';' : delimiter)
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
  const home = env.USERPROFILE ?? env.HOME
  if (home) dirs.push(join(home, '.local', 'bin'))
  for (const dir of dirs) {
    const candidate = join(dir, exe)
    if (isFile(candidate)) return candidate
  }
  return null
}

export type ClaudeCliOptions = {
  exe: string
  /** Pasta de trabalho do processo (vazia). */
  cwd: string
  /** Apelido do modelo ("sonnet"). */
  model?: string
  run?: typeof runProcess
}

export const CLI_DEFAULT_MODEL = 'sonnet'
export const CLI_DEFAULT_TIMEOUT_MS = 240_000

/** Os argumentos fixos do `claude -p`: texto entra, texto sai. O prompt NÃO está aqui (vai pelo stdin). */
export function claudeArgs(system: string, model: string): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--tools',
    '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--model',
    model,
    '--system-prompt',
    system
  ]
}

export function createClaudeCliProvider(opts: ClaudeCliOptions): LlmProvider {
  const run = opts.run ?? runProcess
  const ask: AskFn = async ({ system, prompt, signal, timeoutMs }) => {
    try {
      const { stdout } = await run(opts.exe, claudeArgs(system, opts.model ?? CLI_DEFAULT_MODEL), {
        stdin: prompt,
        cwd: opts.cwd,
        timeoutMs: timeoutMs ?? CLI_DEFAULT_TIMEOUT_MS,
        ...(signal ? { signal } : {})
      })
      let envelope: { is_error?: boolean; result?: unknown; subtype?: string }
      try {
        envelope = JSON.parse(stdout) as typeof envelope
      } catch {
        throw new LlmError('A IA respondeu num formato que não reconheci. Tente de novo.', true)
      }
      if (envelope.is_error || typeof envelope.result !== 'string') {
        const detail = typeof envelope.result === 'string' ? envelope.result : (envelope.subtype ?? '')
        throw new LlmError(`A IA não conseguiu responder${detail ? `: ${detail.slice(0, 300)}` : ''}.`, true)
      }
      return envelope.result
    } catch (err) {
      if (err instanceof LlmError) throw err
      if (err instanceof ProcessError) {
        if (err.reason === 'timeout') throw new LlmError('A IA demorou demais para responder. Tente de novo.', true)
        if (err.reason === 'cancelled') throw new LlmError('Cancelado.', false)
        if (err.reason === 'spawn') throw new LlmError('Não consegui abrir o programa da IA neste computador.', false)
        const why = tail(err.stderr || err.stdout, 3)
        throw new LlmError(`A IA não respondeu${why ? `: ${why}` : ''}. Confira se o programa está logado e tente de novo.`, true)
      }
      throw err
    }
  }
  return providerFromAsk('cli', ask)
}

/** A pasta de trabalho existe? (o gerenciador cria uma vazia). */
export const dirExists = (p: string): boolean => existsSync(p)
