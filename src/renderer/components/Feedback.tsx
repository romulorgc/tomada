import { useEffect } from 'react'
import { t } from '../i18n/pt-BR'
import { useApp, type Notice } from '../store'
import { CheckIcon, CrossIcon } from './Icons'

/** Faixa de erro dentro da tela, com o motivo e o "tentar de novo". */
export function ErrorPanel({
  title,
  detail,
  onRetry,
  extra
}: {
  title: string
  detail?: string | null
  onRetry?: () => void
  extra?: React.ReactNode
}) {
  return (
    <div role="alert" data-testid="error-panel" className="mx-auto mt-16 max-w-xl rounded-dialog border border-line-strong bg-surface p-6">
      <h2 className="text-[1.0625rem] font-[650]">{title}</h2>
      {detail ? <p className="mt-2 whitespace-pre-wrap break-words text-[0.9375rem] text-muted">{detail}</p> : null}
      <div className="mt-5 flex gap-2">
        {onRetry ? (
          <button type="button" className="btn" onClick={onRetry}>
            {t.common.retry}
          </button>
        ) : null}
        {extra}
      </div>
    </div>
  )
}

function ToastItem({ notice }: { notice: Notice }) {
  const dismiss = useApp((s) => s.dismiss)
  const isError = notice.kind === 'error'

  // Aviso de sucesso some sozinho; erro fica até a pessoa fechar (não pode passar batido).
  useEffect(() => {
    if (isError) return
    const id = window.setTimeout(() => dismiss(notice.id), 4500)
    return () => window.clearTimeout(id)
  }, [dismiss, isError, notice.id])

  return (
    <div
      role={isError ? 'alert' : 'status'}
      data-testid={isError ? 'toast-error' : 'toast'}
      className={[
        'pointer-events-auto flex max-w-[26rem] items-start gap-3 rounded-dialog border bg-surface px-4 py-3 shadow-dialog',
        isError ? 'border-danger/50' : 'border-line-strong'
      ].join(' ')}
    >
      <span className={['mt-0.5 shrink-0', isError ? 'text-danger' : 'text-ok'].join(' ')}>
        {isError ? <CrossIcon size={16} /> : <CheckIcon size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[0.9375rem] font-medium">{notice.text}</p>
        {notice.detail ? <p className="mt-0.5 whitespace-pre-wrap break-words text-[0.8125rem] text-muted">{notice.detail}</p> : null}
      </div>
      <button type="button" className="btn btn-ghost !min-h-0 !p-1" aria-label={t.common.close} onClick={() => dismiss(notice.id)}>
        <CrossIcon size={14} />
      </button>
    </div>
  )
}

export function Toasts() {
  const notices = useApp((s) => s.notices)
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex flex-col items-end gap-2">
      {notices.map((n) => (
        <ToastItem key={n.id} notice={n} />
      ))}
    </div>
  )
}
