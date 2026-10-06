import { createStore } from 'zustand/vanilla'
import type { RecordPrefs } from '@shared/recording'

type PrefsState = {
  prefs: RecordPrefs | null
  pending: number
  error: string | null
  load(prefs: RecordPrefs): void
  update(patch: Partial<RecordPrefs>): Promise<void>
  canStart(): boolean
  useConfirmed(): void
}

/** A tela pode antecipar controles; só começa com todas as escolhas confirmadas pelo main. */
export function createRecordPrefsStore(deps: { save(patch: Partial<RecordPrefs>): Promise<RecordPrefs> }) {
  let confirmed: RecordPrefs | null = null
  const patches: { patch: Partial<RecordPrefs> }[] = []
  let queue: Promise<void> = Promise.resolve()
  return createStore<PrefsState>((set, get) => {
    const displayed = (): RecordPrefs | null => confirmed ? patches.reduce((prefs, row) => ({ ...prefs, ...row.patch }), confirmed) : null
    return {
      prefs: null, pending: 0, error: null,
      load(prefs) { confirmed = prefs; set({ prefs: displayed() }) },
      canStart: () => get().prefs !== null && get().pending === 0 && get().error === null,
      useConfirmed() { if (get().pending === 0) set({ prefs: confirmed, error: null }) },
      update(patch) {
        const row = { patch: { ...patch } }
        patches.push(row)
        set({ prefs: displayed(), pending: patches.length, error: null })
        const job = queue.then(async () => {
          try { confirmed = await deps.save(row.patch) }
          catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            set({ error: message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') })
          }
          finally {
            patches.splice(patches.indexOf(row), 1)
            set({ prefs: displayed(), pending: patches.length })
          }
        })
        queue = job
        return job
      }
    }
  })
}
