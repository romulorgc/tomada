import type { ProcessStepState } from '@shared/ipc'
import { CheckIcon, CrossIcon, FolderIcon } from '../components/Icons'
import { t } from '../i18n/pt-BR'
import { useRecorder } from '../recording/controller'
import { useApp } from '../store'

function StepIcon({ status }: { status: ProcessStepState['status'] }) {
  switch (status) {
    case 'done':
      return (
        <span className="text-ok">
          <CheckIcon size={18} />
        </span>
      )
    case 'error':
      return (
        <span className="text-danger">
          <CrossIcon size={18} />
        </span>
      )
    case 'running':
      return <span className="spinner" aria-hidden="true" />
    case 'skipped':
      return <span className="text-faint">—</span>
    default:
      return <span className="inline-block h-2 w-2 rounded-full bg-faint" aria-hidden="true" />
  }
}

export function Processing() {
  const snapshot = useRecorder((s) => s.processing)
  const retry = useRecorder((s) => s.retryProcessing)
  const go = useApp((s) => s.go)
  const revealProject = useApp((s) => s.revealProject)

  if (!snapshot) {
    return (
      <div className="mx-auto flex min-h-full max-w-xl flex-col items-center justify-center px-10 py-16 text-center" data-testid="processing-view" data-status="empty">
        <p className="text-muted">{t.processing.empty}</p>
        <button type="button" className="btn mt-5" onClick={() => go({ name: 'library' })}>
          {t.processing.toLibrary}
        </button>
      </div>
    )
  }

  const failed = snapshot.status === 'failed'
  const total = snapshot.steps.length || 1
  const finished = snapshot.steps.reduce((acc, s) => acc + (s.status === 'done' || s.status === 'skipped' ? 1 : s.status === 'running' ? s.fraction : 0), 0)
  const overall = Math.round((finished / total) * 100)

  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-10 pb-12 pt-12" data-testid="processing-view" data-status={snapshot.status}>
      <h1 className="text-[1.75rem] font-[650] leading-none tracking-[-0.02em]">{failed ? t.processing.failedTitle : t.processing.title}</h1>
      <p className="mt-3 text-[0.9375rem] text-muted">{failed ? t.processing.failedBody : t.processing.body}</p>

      <div className="mt-6 h-1.5 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={overall} aria-label={t.processing.title}>
        <div className={['h-full rounded-full transition-[width] duration-200', failed ? 'bg-danger' : 'bg-rec'].join(' ')} style={{ width: `${overall}%` }} data-testid="processing-overall" />
      </div>
      <p className="mt-2 text-right text-sm text-muted tnum" role="status">{overall}%</p>

      <ol className="mt-6 grid gap-1" data-testid="processing-steps">
        {snapshot.steps.map((step) => (
          <li
            key={step.id}
            className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 rounded-control px-3 py-2.5 text-[0.9375rem]"
            data-testid={`step-${step.id}`}
            data-status={step.status}
            aria-label={`${t.processing.steps[step.id]}: ${t.processing.status[step.status]}`}
          >
            <span className="grid place-items-center">
              <StepIcon status={step.status} />
            </span>
            <span className={step.status === 'pending' ? 'text-faint' : step.status === 'error' ? 'text-danger' : ''}>
              {t.processing.steps[step.id]}
              {step.detail && step.status !== 'error' ? <span className="ml-2 text-[0.8125rem] text-muted">{step.detail}</span> : null}
            </span>
            <span className="text-[0.8125rem] text-muted tnum">{step.status === 'running' ? `${Math.round(step.fraction * 100)}%` : ''}</span>
          </li>
        ))}
      </ol>

      {failed && snapshot.error ? (
        <div role="alert" className="mt-6 rounded-dialog border border-danger/50 bg-surface p-5" data-testid="processing-error">
          <p className="text-[0.9375rem] font-semibold">
            {t.processing.steps[snapshot.error.step]}: {t.processing.status.error.toLowerCase()}
          </p>
          <p className="mt-2 whitespace-pre-wrap break-words text-[0.875rem] text-muted" data-testid="processing-error-detail">
            {snapshot.error.message}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="btn btn-rec" onClick={() => void retry()} data-testid="processing-retry">
              {t.processing.retry}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void revealProject(snapshot.folder)} data-testid="processing-reveal">
              <FolderIcon size={16} />
              {t.processing.reveal}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => go({ name: 'library' })}>
              {t.processing.toLibrary}
            </button>
          </div>
        </div>
      ) : null}

      {snapshot.notes.length > 0 ? (
        <section className="mt-6" aria-label={t.processing.notes} data-testid="processing-notes">
          <h2 className="mb-2 text-[0.8125rem] font-semibold uppercase tracking-[0.06em] text-muted">{t.processing.notes}</h2>
          <ul className="grid gap-1.5 text-[0.875rem] text-muted">
            {snapshot.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
