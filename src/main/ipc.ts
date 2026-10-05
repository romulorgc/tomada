/**
 * IPC tipado: o ÚNICO lugar do main que fala com o renderer.
 * Os handlers são exigidos pelo tipo `IpcHandlers` (um por canal do contrato em
 * `@shared/ipc`). Erros viram `{ok:false}` com a mensagem limpa; nada some em silêncio.
 */
import { ipcMain } from 'electron'
import type { IpcChannel, IpcEnvelope, IpcHandlers, RendererLogEntry } from '@shared/ipc'
import { LOG_CHANNEL } from '@shared/ipc'
import type { Logger } from './logger'

export function registerIpc(handlers: IpcHandlers, logger: Logger, isTrustedUrl: (url: string) => boolean = () => true): void {
  /** Só páginas do próprio app falam com o processo principal (nenhum quadro de fora, nenhuma janela estranha). */
  const trusted = (event: { senderFrame?: { url: string } | null }): boolean => {
    const url = event.senderFrame?.url
    return typeof url === 'string' && isTrustedUrl(url)
  }
  for (const channel of Object.keys(handlers) as IpcChannel[]) {
    const handler = handlers[channel] as (...args: unknown[]) => Promise<unknown>
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcEnvelope<unknown>> => {
      try {
        if (!trusted(event)) throw new Error('Origem não confiável: só as páginas do Tomada falam com o processo principal.')
        return { ok: true, value: await handler(...args) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`IPC ${channel} falhou`, err)
        return { ok: false, error: { message, ...(err instanceof Error ? { code: err.name } : {}) } }
      }
    })
  }

  // Erros e avisos da interface chegam ao arquivo de log (ida só, sem resposta).
  ipcMain.on(LOG_CHANNEL, (event, entry: RendererLogEntry) => {
    if (!trusted(event)) return
    if (!entry || typeof entry.message !== 'string') return
    const level = entry.level === 'error' || entry.level === 'warn' ? entry.level : 'info'
    // a interface não pode encher o disco: texto cortado
    const detail = typeof entry.detail === 'string' ? entry.detail.slice(0, 8_000) : undefined
    logger[level](`[interface] ${entry.message.slice(0, 2_000)}`, detail)
  })
}
