/**
 * Roda um programa como processo FILHO, sem shell, e devolve a saída. Usado pela transcrição (Python, whisper.cpp)
 * e pelo assistente de IA (`claude -p`). Regras que valem para todos:
 *
 *  - **Sem shell**: `spawn(exe, args)` com `shell: false`. O executável é um caminho que o processo principal
 *    montou (nunca texto vindo do renderer) e os argumentos não passam por interpretação.
 *  - **Entrada pelo stdin**: texto longo (prompt, pedido em JSON) vai por aqui, nunca pela linha de comando.
 *  - **Ambiente limpo**: `ELECTRON_RUN_AS_NODE` NÃO é herdada (um Electron filho viraria um Node comum, e esta
 *    máquina a tem ligada).
 *  - **Tempo limite e cancelamento**: estourar o tempo ou abortar mata a ÁRVORE inteira de processos (o filho e os netos: o Python
 *    abre o ffmpeg, e um ffmpeg órfão seguiria com o arquivo aberto), ESPERA o encerramento e só então rejeita com o motivo.
 *    Quem limpa arquivo depois de um cancelamento (o parcial da máscara) pode confiar que ninguém mais o tem aberto.
 *
 * Sem Electron.
 */
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export type ProcessFailure = 'exit' | 'timeout' | 'cancelled' | 'spawn'

export class ProcessError extends Error {
  override readonly name = 'ProcessError'
  constructor(
    message: string,
    readonly reason: ProcessFailure,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(message)
  }
}

export type RunProcessOptions = {
  cwd?: string
  /** Variáveis acrescentadas ao ambiente limpo. */
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Cada pedaço de texto que chega (para progresso). Linhas podem vir partidas: junte você mesmo se precisar. */
  onStdout?: (text: string) => void
  onStderr?: (text: string) => void
  /** Máximo de bytes guardados de cada saída (o resto é descartado; o rabo é o que importa). */
  maxOutput?: number
}

export type ProcessResult = { stdout: string; stderr: string; exitCode: 0 }

/** Depois de pedir a morte da árvore, quanto esperar o `close` do filho antes de desistir de esperar (ms). */
const KILL_GRACE_MS = 10_000

/**
 * Encerra o processo e TODOS os que ele abriu. No Windows (`taskkill /T /F`) não existe grupo de processos que o Node alcance; no resto,
 * o filho foi aberto como líder de grupo (`detached`) e o sinal vai ao grupo todo.
 */
function killTree(child: ReturnType<typeof spawn>): Promise<void> {
  const pid = child.pid
  if (!pid) {
    child.kill()
    return Promise.resolve()
  }
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
      const fallback = (): void => {
        child.kill()
        resolve()
      }
      killer.on('error', fallback)
      // código 128 = o processo já tinha acabado: não é problema
      killer.on('close', () => {
        child.kill()
        resolve()
      })
    })
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
  return Promise.resolve()
}

/** O ambiente do filho: o do app, sem `ELECTRON_RUN_AS_NODE`. */
export function childEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && k.toUpperCase() !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  }
  return { ...env, ...extra }
}

/** Últimas `n` linhas não vazias. */
export function tail(text: string, n = 10): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-n)
    .join('\n')
}

export function runProcess(exe: string, args: readonly string[], opts: RunProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new ProcessError('Cancelado.', 'cancelled', null, '', ''))
      return
    }
    const cap = opts.maxOutput ?? 64 * 1024 * 1024
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, [...args], {
        cwd: opts.cwd,
        env: childEnv(opts.env),
        windowsHide: true,
        shell: false,
        // fora do Windows o filho lidera um grupo: é por ele que a árvore inteira é encerrada
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      reject(new ProcessError(`Não consegui abrir ${exe}: ${err instanceof Error ? err.message : String(err)}`, 'spawn', null, '', ''))
      return
    }

    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    let stdout = ''
    let stderr = ''
    let settled = false
    let stopping = false
    let timer: NodeJS.Timeout | undefined

    const keep = (current: string, add: string): string => {
      const next = current + add
      return next.length > cap ? next.slice(next.length - cap) : next
    }
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    /** Mata a árvore, espera o filho fechar (com teto) e só então rejeita. */
    const stop = (reason: ProcessFailure, message: string): void => {
      if (stopping || settled) return
      stopping = true
      if (timer) clearTimeout(timer)
      void (async () => {
        const closed = new Promise<void>((resolveClosed) => {
          const grace = setTimeout(resolveClosed, KILL_GRACE_MS)
          child.once('close', () => {
            clearTimeout(grace)
            resolveClosed()
          })
        })
        await killTree(child)
        await closed
        stdout = keep(stdout, outDecoder.end())
        stderr = keep(stderr, errDecoder.end())
        done(() => reject(new ProcessError(message, reason, null, stdout, stderr)))
      })()
    }
    const onAbort = (): void => stop('cancelled', 'Cancelado.')
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => stop('timeout', `O programa passou do tempo limite (${Math.round(opts.timeoutMs! / 1000)} s) e foi interrompido.`), opts.timeoutMs)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = outDecoder.write(chunk)
      if (!text) return
      stdout = keep(stdout, text)
      opts.onStdout?.(text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = errDecoder.write(chunk)
      if (!text) return
      stderr = keep(stderr, text)
      opts.onStderr?.(text)
    })
    // o programa pode fechar o stdin antes de ler tudo (erro de partida): isso não pode derrubar o app
    child.stdin?.on('error', () => undefined)
    child.on('error', (err: NodeJS.ErrnoException) => {
      done(() =>
        reject(
          new ProcessError(
            err.code === 'ENOENT' ? `Não achei o programa ${exe}.` : `Não consegui abrir ${exe}: ${err.message}`,
            'spawn',
            null,
            stdout,
            stderr
          )
        )
      )
    })
    child.on('close', (code) => {
      if (stopping) return // quem está encerrando a árvore rejeita com o motivo certo (cancelado ou tempo limite)
      stdout = keep(stdout, outDecoder.end())
      stderr = keep(stderr, errDecoder.end())
      done(() => {
        if (code === 0) resolve({ stdout, stderr, exitCode: 0 })
        else {
          const why = tail(stderr) || tail(stdout)
          reject(new ProcessError(`O programa terminou com código ${code}.${why ? `\n${why}` : ''}`, 'exit', code, stdout, stderr))
        }
      })
    })

    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin, 'utf8')
    else child.stdin?.end()
  })
}
