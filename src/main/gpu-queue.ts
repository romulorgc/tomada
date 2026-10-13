/** Transcrição e render usam a mesma GPU, inclusive quando pedidos pelo editor. */

/**
 * O que o trabalho de FUNDO (o recorte da câmera, R1) consulta para dar lugar a quem usa a placa na frente da pessoa: exportação e
 * transcrição (as que passam por `createGpuQueue().start`) e a prévia do editor tocando. Quem usa o gate nunca entra na fila: só espera
 * ela esvaziar, e quando ela volta a encher o recorte para no fim do pedaço em curso e retoma depois.
 */
export type GpuGate = {
  /** Há trabalho mais importante na placa agora? `work` = exportação ou transcrição; `preview` = a prévia do editor tocando. */
  busy(): 'work' | 'preview' | null
  /** Resolve quando a placa ficar livre (e livre por um instante: a prévia só conta como parada depois de uns segundos). Rejeita se `signal` abortar. */
  whenIdle(signal: AbortSignal): Promise<void>
  /** Avisa quando a placa passa de livre a ocupada; devolve a função que cancela o aviso. */
  onBusy(listener: () => void): () => void
}

/** A prévia só deixa de contar como "tocando" depois deste tempo parada (ms): pausar e tocar de novo não faz o recorte parar e recomeçar. */
export const PREVIEW_QUIET_MS = 2500
/** Cada aviso de "tocando" vale por este tempo (ms): o editor repete o aviso enquanto toca; se ele sumir (janela fechada), a prévia deixa de contar sozinha. */
export const PREVIEW_TTL_MS = 15_000

export function createGpuQueue(opts: { previewQuietMs?: number; previewTtlMs?: number; now?: () => number } = {}) {
  const quietMs = opts.previewQuietMs ?? PREVIEW_QUIET_MS
  const ttlMs = opts.previewTtlMs ?? PREVIEW_TTL_MS
  const now = opts.now ?? ((): number => Date.now())
  let queue: Promise<unknown> = Promise.resolve()
  let pending = 0
  let previewUntil = 0
  let previewTimer: NodeJS.Timeout | undefined
  const busyListeners = new Set<() => void>()
  const idleWaiters = new Set<() => void>()

  const reason = (): 'work' | 'preview' | null => (pending > 0 ? 'work' : now() < previewUntil ? 'preview' : null)
  const notifyBusy = (): void => {
    for (const l of [...busyListeners]) l()
  }
  const notifyIdle = (): void => {
    if (reason() !== null) return
    for (const w of [...idleWaiters]) w()
  }
  const arm = (): void => {
    if (previewTimer) clearTimeout(previewTimer)
    const left = previewUntil - now()
    if (left > 0) previewTimer = setTimeout(() => notifyIdle(), left + 5)
  }

  const gate: GpuGate = {
    busy: reason,
    whenIdle(signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Error('Cancelado.'))
        if (reason() === null) return resolve()
        const cleanup = (): void => {
          idleWaiters.delete(check)
          signal.removeEventListener('abort', onAbort)
        }
        const check = (): void => {
          if (reason() !== null) return
          cleanup()
          resolve()
        }
        const onAbort = (): void => {
          cleanup()
          reject(new Error('Cancelado.'))
        }
        idleWaiters.add(check)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    },
    onBusy(listener) {
      busyListeners.add(listener)
      return () => busyListeners.delete(listener)
    }
  }

  return {
    gate,
    /** A prévia do editor está tocando (ou parou): o recorte de fundo dá lugar a ela. */
    setPreviewActive(active: boolean): void {
      const wasBusy = reason() !== null
      // tocando: vale por `ttlMs` (o editor repete o aviso); parou: continua valendo só por `quietMs` (quem pausa e toca de novo logo não derruba o recorte)
      previewUntil = now() + (active ? ttlMs : quietMs)
      arm()
      if (active && !wasBusy) notifyBusy()
    },
    start<T>(start: () => Promise<T>, idle: () => Promise<void>): { started: Promise<T>; done: Promise<void> } {
      let resolve!: (value: T) => void
      let reject!: (reason: unknown) => void
      const started = new Promise<T>((yes,no) => { resolve = yes; reject = no })
      const wasBusy = reason() !== null
      pending++
      if (!wasBusy) notifyBusy()
      const done = queue.then(async () => {
        try { resolve(await start()); await idle() }
        catch (error) { reject(error); throw error }
      })
      queue = done.catch(() => undefined)
      const release = (): void => { pending--; notifyIdle() }
      done.then(release, release)
      return {started,done}
    }
  }
}
