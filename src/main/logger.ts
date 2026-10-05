/**
 * Log em arquivo: `<userData>/logs/tomada-AAAA-MM-DD.log`.
 * Nunca lança: falha ao escrever log não pode derrubar o que estava sendo feito.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  readonly dir: string
  debug(message: string, detail?: unknown): void
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

export type LogEntry = { level: LogLevel; message: string; detail?: string }

function describe(detail: unknown): string | undefined {
  if (detail === undefined) return undefined
  if (detail instanceof Error) return detail.stack ?? `${detail.name}: ${detail.message}`
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

function localDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function createLogger(dir: string, opts: { echo?: boolean } = {}): Logger {
  let ready = false
  const write = (level: LogLevel, message: string, detail?: unknown): void => {
    const now = new Date()
    const extra = describe(detail)
    const line = `${now.toISOString()} [${level}] ${message}${extra ? ` | ${extra.replace(/\r?\n/g, '\n    ')}` : ''}\n`
    try {
      if (!ready) {
        mkdirSync(dir, { recursive: true })
        ready = true
      }
      appendFileSync(join(dir, `tomada-${localDate(now)}.log`), line, 'utf8')
    } catch {
      // sem ter onde registrar, o console é o último recurso
      if (!opts.echo) console.error(`[log indisponível] ${line.trimEnd()}`)
    }
    if (opts.echo) (level === 'error' ? console.error : console.log)(line.trimEnd())
  }
  return {
    dir,
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d)
  }
}

/** Logger que guarda em memória (testes). */
export function createMemoryLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const add =
    (level: LogLevel) =>
    (message: string, detail?: unknown): void => {
      const extra = describe(detail)
      entries.push({ level, message, ...(extra ? { detail: extra } : {}) })
    }
  return { dir: '(memória)', entries, debug: add('debug'), info: add('info'), warn: add('warn'), error: add('error') }
}
