import { useCallback, useEffect, useRef, useState } from 'react'
import type { InterruptedRecording } from '@shared/recovery'
import { formatBytes, formatDuration } from '@shared/format'
import { m5Settings as T } from '../i18n/m5-settings'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'

const messageOf = (err: unknown) => err instanceof Error ? err.message : String(err)
export function RecoveryPrompt() {
  const [items, setItems] = useState<InterruptedRecording[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [discard, setDiscard] = useState<string | null>(null)
  const [later, setLater] = useState(false)
  const dialog = useRef<HTMLElement>(null)
  const notify = useApp((s) => s.notify)
  const load = useCallback(async () => { setError(null); try { setItems(await window.tomada.recovery.list()) } catch (err) { setError(messageOf(err)) } }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => { if (!busy && !later && (items.length || error)) dialog.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [items, error, busy, later, discard])
  const recover = async (id: string) => {
    setBusy(id); useApp.getState().go({ name: 'processing' })
    try { await window.tomada.recovery.recover(id); setItems((old) => old.filter((item) => item.id !== id)) }
    catch (err) { notify({ kind: 'error', text: T.recovery.failed, detail: messageOf(err) }); useApp.getState().go({ name: 'library' }) }
    finally { setBusy(null) }
  }
  const remove = async (id: string) => {
    setBusy(id)
    try { await window.tomada.recovery.discard(id); setItems((old) => old.filter((item) => item.id !== id)); setDiscard(null) }
    catch (err) { notify({ kind: 'error', text: T.recovery.discardFailed, detail: messageOf(err) }) }
    finally { setBusy(null) }
  }
  if (later || busy || (!error && !items.length)) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="recovery-title" className="max-h-[85vh] w-full max-w-[36rem] overflow-y-auto rounded-dialog border border-line-strong bg-surface p-6 shadow-dialog" data-testid="recovery-prompt" onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        const first = buttons[0], last = buttons.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }}>
        <h2 id="recovery-title" className="text-lg font-semibold">{error ? T.recovery.listFailed : T.recovery.title}</h2>
        <p className="mb-4 mt-2 text-sm text-muted">{error ?? T.recovery.help}</p>
        {error ? <button type="button" className="btn" onClick={() => void load()} data-testid="recovery-retry">{t.common.retry}</button> : null}
        <div className="grid gap-4">
          {items.map((item) => (
            <article key={item.id} className="rounded-thumb border border-line p-4" data-testid="recovery-item">
              <h3 className="break-words font-medium">{item.title}</h3>
              <p className="mt-1 text-sm text-muted">{item.recordedMs === null ? T.recovery.durationUnknown : formatDuration(item.recordedMs)} · {formatBytes(item.bytes)}</p>
              {item.error ? <p className="mt-2 break-words text-sm text-danger">{item.error}</p> : null}
              {discard === item.id ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className="btn text-danger" onClick={() => void remove(item.id)} data-testid="recovery-confirm-discard">{T.recovery.confirm}</button>
                  <button type="button" className="btn btn-ghost" onClick={() => setDiscard(null)}>{T.recovery.cancel}</button>
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className="btn btn-primary" onClick={() => void recover(item.id)} data-testid="recovery-recover">{T.recovery.recover}</button>
                  <button type="button" className="btn btn-ghost" onClick={() => setDiscard(item.id)} data-testid="recovery-discard">{T.recovery.discard}</button>
                </div>
              )}
            </article>
          ))}
        </div>
        <button type="button" className="btn btn-ghost mt-4" data-testid="recovery-later" onClick={() => setLater(true)}>{T.recovery.later}</button>
      </section>
    </div>
  )
}
