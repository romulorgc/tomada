/**
 * IPC tipado: o ÚNICO lugar do main que fala com o renderer.
 * Os handlers são exigidos pelo tipo `IpcHandlers` (um por canal do contrato em
 * `@shared/ipc`). Erros viram `{ok:false}` com a mensagem limpa; nada some em silêncio.
 */
import { ipcMain } from 'electron'
import type { IpcChannel, IpcEnvelope, IpcHandlers, RendererLogEntry } from '@shared/ipc'
import { LOG_CHANNEL } from '@shared/ipc'
import type { Logger } from './logger'

export function registerIpc(handlers: IpcHandlers, logger: Logger): void {
  for (const channel of Object.keys(handlers) as IpcChannel[]) {
    const handler = handlers[channel] as (...args: unknown[]) => Promise<unknown>
    ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<IpcEnvelope<unknown>> => {
      try {
        return { ok: true, value: await handler(...args) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`IPC ${channel} falhou`, err)
        return { ok: false, error: { message, ...(err instanceof Error ? { code: err.name } : {}) } }
      }
    })
  }

  // Erros e avisos da interface chegam ao arquivo de log (ida só, sem resposta).
  ipcMain.on(LOG_CHANNEL, (_event, entry: RendererLogEntry) => {
    if (!entry || typeof entry.message !== 'string') return
    const level = entry.level === 'error' || entry.level === 'warn' ? entry.level : 'info'
    logger[level](`[interface] ${entry.message}`, entry.detail)
  })
}
