/**
 * A FILA de exportação dos cortes verticais (M4b): "Exportar selecionados" exporta um corte por vez (o processo
 * principal só faz uma exportação de cada vez), mostra o progresso de cada um e deixa CANCELAR. Se um falha, a falha fica
 * VISÍVEL no item (com o motivo e "Tentar de novo") e a fila segue com o próximo: nunca para calada, nunca joga fora o que
 * já foi exportado.
 *
 * Zustand "vanilla" (sem React e sem DOM): roda igual nos testes. Quem fala com o processo principal entra por `QueueDeps`.
 * Os eventos de progresso podem chegar ANTES de a resposta de `startExport` voltar, então ficam guardados por id; e, se um
 * evento se perder, o estado do processo principal (`pollStatus`) fecha a espera.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { ExportProgress, ExportRequest } from './ipc'

export type QueueItemState = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export type QueueItem = {
  clipId: string
  title: string
  /** O número do corte na lista (o do nome do arquivo). */
  number: number
  state: QueueItemState
  /** 0..1 */
  fraction: number
  outputPath?: string
  textPath?: string
  /** O motivo, em `error` e `cancelled`; um aviso, em `done` (ex.: o texto que acompanha não pôde ser gravado). */
  message?: string
}

export type QueueEntry = Pick<QueueItem, 'clipId' | 'title' | 'number'>

export type QueueState = {
  items: QueueItem[]
  running: boolean
  cancelling: boolean
  /** Começa a fila e devolve quando ela acaba (ou é cancelada). Ignorado se já há uma rodando. */
  start(entries: readonly QueueEntry[]): Promise<void>
  /** Cancela o corte em andamento e tira os que esperam. O que já foi exportado fica. */
  cancel(): Promise<void>
  /** Exporta de novo os cortes que falharam ou foram cancelados (todos, ou só os `clipIds`). */
  retry(clipIds?: readonly string[]): Promise<void>
  /** Esvazia a lista (só quando nada está rodando). */
  clear(): void
}

export type QueueDeps = {
  projectId: string
  /** Grava o documento: o processo principal lê o corte do disco. */
  flush(): Promise<void>
  startExport(request: ExportRequest): Promise<{ exportId: string }>
  cancelExport(exportId: string): Promise<void>
  /** Assina o progresso das exportações; devolve quem cancela a assinatura. */
  onProgress(listener: (p: ExportProgress) => void): () => void
  /** O estado atual do processo principal (conferido de tempos em tempos enquanto espera). */
  pollStatus?(): Promise<ExportProgress | null>
  /** Chamado quando a fila acaba (ou é cancelada), com o resultado de cada item. */
  onFinished?(items: readonly QueueItem[]): void
  /** Padrões da exportação dos cortes. */
  fps?: 30 | 60
  /** De quanto em quanto tempo conferir o estado (ms). */
  pollMs?: number
  /** Sem sinal de vida por tanto tempo (ms), a fila dá o corte por perdido. */
  stallMs?: number
}

const FINAL = new Set<ExportProgress['phase']>(['done', 'error', 'cancelled'])
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export type ClipQueue = StoreApi<QueueState>

export function createClipQueue(deps: QueueDeps): ClipQueue {
  const pollMs = deps.pollMs ?? 2000
  const stallMs = deps.stallMs ?? 60_000
  let currentExportId: string | null = null
  const finals = new Map<string, ExportProgress>()
  const waiters = new Map<string, (p: ExportProgress) => void>()
  let lastSign = 0

  return createStore<QueueState>()((set, get) => {
    const patch = (clipId: string, change: Partial<QueueItem>): void => {
      set((s) => ({ items: s.items.map((i) => (i.clipId === clipId ? { ...i, ...change } : i)) }))
    }

    const onProgress = (p: ExportProgress): void => {
      if (p.projectId !== deps.projectId || p.clipId === undefined) return // a exportação do vídeo inteiro não é desta fila
      lastSign = Date.now()
      const item = get().items.find((i) => i.clipId === p.clipId)
      if (item && item.state === 'running' && !FINAL.has(p.phase)) patch(p.clipId, { fraction: Math.max(item.fraction, Math.min(0.99, p.fraction)) })
      if (FINAL.has(p.phase)) {
        finals.set(p.exportId, p)
        waiters.get(p.exportId)?.(p)
        waiters.delete(p.exportId)
      }
    }

    /** Espera o fim da exportação `exportId`: pelo evento, ou pelo estado do processo principal se o evento se perder. */
    const waitFinal = (exportId: string): Promise<ExportProgress> => {
      const done = finals.get(exportId)
      if (done) return Promise.resolve(done)
      return new Promise<ExportProgress>((resolve, reject) => {
        let timer: ReturnType<typeof setInterval> | undefined
        const finish = (p: ExportProgress): void => {
          if (timer) clearInterval(timer)
          waiters.delete(exportId)
          resolve(p)
        }
        waiters.set(exportId, finish)
        lastSign = Date.now()
        timer = setInterval(() => {
          void (async () => {
            try {
              const st = await deps.pollStatus?.()
              if (st && st.exportId === exportId && FINAL.has(st.phase)) finish(st)
              else if (Date.now() - lastSign > stallMs) {
                if (timer) clearInterval(timer)
                waiters.delete(exportId)
                reject(new Error(`A exportação ficou ${Math.round(stallMs / 1000)} s sem responder.`))
              }
            } catch (err) {
              if (timer) clearInterval(timer)
              waiters.delete(exportId)
              reject(err instanceof Error ? err : new Error(String(err)))
            }
          })()
        }, pollMs)
      })
    }

    async function run(ids: readonly string[]): Promise<void> {
      set({ running: true, cancelling: false })
      const off = deps.onProgress(onProgress)
      try {
        try {
          await deps.flush()
        } catch (err) {
          for (const id of ids) patch(id, { state: 'error', fraction: 0, message: `Não consegui salvar o projeto antes de exportar: ${messageOf(err)}` })
          return
        }
        for (const id of ids) {
          if (get().cancelling) {
            patch(id, { state: 'cancelled', fraction: 0, message: 'Cancelado antes de começar.' })
            continue
          }
          patch(id, { state: 'running', fraction: 0 })
          try {
            const { exportId } = await deps.startExport({ projectId: deps.projectId, resolution: '1080p', fps: deps.fps ?? 30, clipId: id })
            currentExportId = exportId
            // o cancelamento chegou enquanto o pedido de exportar ainda estava indo: cancela agora a que acabou de nascer
            if (get().cancelling) void deps.cancelExport(exportId).catch(() => undefined)
            const final = await waitFinal(exportId)
            currentExportId = null
            if (final.phase === 'done') patch(id, { state: 'done', fraction: 1, ...(final.outputPath ? { outputPath: final.outputPath } : {}), ...(final.textPath ? { textPath: final.textPath } : {}), ...(final.message ? { message: final.message } : {}) })
            else if (final.phase === 'cancelled') patch(id, { state: 'cancelled', message: final.message ?? 'Exportação cancelada.' })
            else patch(id, { state: 'error', message: final.message ?? 'A exportação falhou.' })
          } catch (err) {
            currentExportId = null
            patch(id, { state: 'error', message: messageOf(err) })
          }
        }
      } finally {
        off()
        currentExportId = null
        finals.clear()
        waiters.clear()
        set({ running: false, cancelling: false })
        deps.onFinished?.(get().items)
      }
    }

    return {
      items: [],
      running: false,
      cancelling: false,

      start(entries) {
        if (get().running || entries.length === 0) return Promise.resolve()
        set({ items: entries.map((e) => ({ ...e, state: 'queued' as const, fraction: 0 })) })
        return run(entries.map((e) => e.clipId))
      },

      async cancel() {
        if (!get().running || get().cancelling) return
        set((s) => ({
          cancelling: true,
          items: s.items.map((i) => (i.state === 'queued' ? { ...i, state: 'cancelled' as const, message: 'Cancelado antes de começar.' } : i))
        }))
        const id = currentExportId
        if (id) {
          try {
            await deps.cancelExport(id)
          } catch (err) {
            // não deu para cancelar: a fila segue o curso e o erro aparece no item
            const running = get().items.find((i) => i.state === 'running')
            if (running) patch(running.clipId, { message: `Não consegui cancelar: ${messageOf(err)}` })
          }
        }
      },

      retry(clipIds) {
        if (get().running) return Promise.resolve()
        const ids = get()
          .items.filter((i) => (i.state === 'error' || i.state === 'cancelled') && (!clipIds || clipIds.includes(i.clipId)))
          .map((i) => i.clipId)
        if (ids.length === 0) return Promise.resolve()
        set((s) => ({ items: s.items.map((i) => (ids.includes(i.clipId) ? { clipId: i.clipId, title: i.title, number: i.number, state: 'queued' as const, fraction: 0 } : i)) }))
        return run(ids)
      },

      clear() {
        if (!get().running) set({ items: [] })
      }
    }
  })
}

/** Resumo para o aviso final: "2 de 3 cortes exportados" e o que falhou. */
export function queueSummary(items: readonly QueueItem[]): { done: number; failed: number; cancelled: number; total: number } {
  return {
    done: items.filter((i) => i.state === 'done').length,
    failed: items.filter((i) => i.state === 'error').length,
    cancelled: items.filter((i) => i.state === 'cancelled').length,
    total: items.length
  }
}
