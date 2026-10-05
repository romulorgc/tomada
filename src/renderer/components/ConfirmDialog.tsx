import { useEffect, useId, useRef } from 'react'
import { t } from '../i18n/pt-BR'

type Props = {
  title: string
  body: string
  confirmLabel: string
  tone?: 'danger' | 'default'
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Confirmação própria (nunca `confirm()` nativo): foco começa em "Cancelar" (o lado
 * seguro), Tab fica preso no diálogo, Esc cancela e o foco volta para quem abriu.
 */
export function ConfirmDialog({ title, body, confirmLabel, tone = 'default', busy = false, onConfirm, onCancel }: Props) {
  const titleId = useId()
  const bodyId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    return () => opener?.focus?.()
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (!busy) onCancel()
      return
    }
    if (e.key !== 'Tab') return
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
    if (!nodes || nodes.length === 0) return
    const first = nodes[0]!
    const last = nodes[nodes.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="dialog"
        data-testid="confirm-dialog"
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="text-[1.1875rem] font-[650] leading-snug tracking-[-0.01em]">
          {title}
        </h2>
        <p id={bodyId} className="mt-2 max-w-[44ch] text-[0.9375rem] text-muted">
          {body}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy} data-testid="confirm-cancel">
            {t.common.cancel}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'btn btn-danger' : 'btn btn-rec'}
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-ok"
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
