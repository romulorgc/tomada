/** Transcrição e render usam a mesma GPU, inclusive quando pedidos pelo editor. */
export function createGpuQueue() {
  let queue: Promise<unknown> = Promise.resolve()
  return {
    start<T>(start: () => Promise<T>, idle: () => Promise<void>): { started: Promise<T>; done: Promise<void> } {
      let resolve!: (value: T) => void
      let reject!: (reason: unknown) => void
      const started = new Promise<T>((yes,no) => { resolve = yes; reject = no })
      const done = queue.then(async () => {
        try { resolve(await start()); await idle() }
        catch (error) { reject(error); throw error }
      })
      queue = done.catch(() => undefined)
      return {started,done}
    }
  }
}
