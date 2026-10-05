/**
 * Formatação para a interface (pt-BR). Código puro: sem DOM, sem Node.
 */

/** Duração em ms → `m:ss` (ou `h:mm:ss` a partir de 1 hora). Trunca os milissegundos. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** Bytes → "1,5 MB" (base 1024, vírgula decimal, até 1 casa; bytes inteiros sem casa). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  if (unit === 0) return `${Math.round(value)} B`
  // Arredonda a 1 casa; se virar 1024, sobe de unidade (ex.: 1023,96 KB → 1 MB).
  let rounded = Math.round(value * 10) / 10
  if (rounded >= 1024 && unit < UNITS.length - 1) {
    rounded = Math.round((rounded / 1024) * 10) / 10
    unit++
  }
  const text = rounded.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 1 })
  return `${text} ${UNITS[unit]}`
}

export type DateFormatOptions = {
  /** Fuso IANA (ex.: "America/Sao_Paulo"). Padrão: o do sistema. */
  timeZone?: string
}

/** "04/10/2026" */
export function formatDate(iso: string, opts: DateFormatOptions = {}): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {})
  }).format(d)
}

/** "04/10/2026 às 15:30" */
export function formatDateTime(iso: string, opts: DateFormatOptions = {}): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const time = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {})
  }).format(d)
  return `${formatDate(iso, opts)} às ${time}`
}
