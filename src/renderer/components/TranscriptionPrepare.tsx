/**
 * Preparação de primeira vez da transcrição, com o progresso REAL (cada passo pesa pelo que baixa), o erro à vista
 * com o passo em que parou e "Tentar de novo" (retoma de onde parou). Usada nos Ajustes e no estado vazio da aba
 * Texto. O estado vem do store global; este componente só mostra e dispara.
 */
import { useEffect } from 'react'
import type { PrepareSnapshot, PrepareStep } from '@shared/transcription'
import { t } from '../i18n/pt-BR'
import { useTranscription } from '../transcription-store'
import { CheckIcon, CrossIcon } from './Icons'

const T = t.transcription

const pct = (fraction: number): number => Math.min(100, Math.max(0, Math.round(fraction * 100)))

function StepRow({ step }: { step: PrepareStep }) {
  const label = T.steps[step.id]
  return (
    <li className="prep-step" data-testid={`prepare-step-${step.id}`} data-status={step.status}>
      <span className="prep-step-icon" aria-hidden="true">
        {step.status === 'done' ? <CheckIcon size={14} /> : step.status === 'error' ? <CrossIcon size={14} /> : step.status === 'running' ? <span className="spinner" /> : <i />}
      </span>
      <span className="prep-step-body">
        <span className="prep-step-label">
          {label}
          <span className="prep-step-status">{step.status === 'running' ? `${pct(step.fraction)}%` : T.stepStatus[step.status]}</span>
        </span>
        {step.detail && step.status !== 'pending' ? <span className="prep-step-detail">{step.detail}</span> : null}
      </span>
    </li>
  )
}

function Progress({ snap }: { snap: PrepareSnapshot }) {
  const value = pct(snap.fraction)
  return (
    <div className="prep-progress" data-testid="prepare-progress" aria-live="polite">
      <div className="meter big" role="progressbar" aria-label={T.preparing} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
        <i style={{ width: `${value}%` }} />
      </div>
      <span className="tnum prep-percent" data-testid="prepare-percent">
        {value}%
      </span>
    </div>
  )
}

export function TranscriptionPrepare({ compact = false }: { compact?: boolean }) {
  const view = useTranscription((s) => s.view)
  const prepare = useTranscription((s) => s.prepare)
  const storeError = useTranscription((s) => s.error)
  const prepareEngine = useTranscription((s) => s.prepareEngine)
  const cancelPrepare = useTranscription((s) => s.cancelPrepare)
  const refresh = useTranscription((s) => s.refresh)

  // quem abre a tela vê o estado de agora (a assinatura dos eventos já está no App; isto cobre a primeira leitura)
  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!view) {
    return (
      <div className="prep" data-testid="transcription-prepare" data-state="loading" aria-busy="true">
        <div className="skeleton h-6 w-40" />
      </div>
    )
  }

  const running = prepare?.status === 'running' || view.state === 'preparing'
  const failed = !running && prepare?.status === 'error' ? prepare : null
  const cancelled = !running && prepare?.status === 'cancelled'
  const ready = view.state === 'ready' && !running
  const state = running ? 'running' : ready ? 'ready' : failed ? 'error' : cancelled ? 'cancelled' : 'missing'

  return (
    <div className={['prep', compact ? 'prep-compact' : ''].join(' ').trim()} data-testid="transcription-prepare" data-state={state}>
      {ready ? (
        <p className="prep-ready" data-testid="prepare-ready">
          <span className="text-ok" aria-hidden="true">
            <CheckIcon size={16} />
          </span>
          <span>
            {T.state.ready}
            {view.device ? <span className="prep-device"> · {view.device}</span> : null}
          </span>
        </p>
      ) : null}

      {running && prepare ? (
        <>
          <Progress snap={prepare} />
          <ul className="prep-steps">
            {prepare.steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </ul>
          {prepare.notes.length > 0 ? (
            <p className="prep-note" data-testid="prepare-note">
              {prepare.notes[prepare.notes.length - 1]}
            </p>
          ) : null}
          <div className="prep-actions">
            <button type="button" className="btn btn-ghost" onClick={() => void cancelPrepare()} data-testid="prepare-cancel">
              {T.cancel}
            </button>
          </div>
        </>
      ) : null}

      {running && !prepare ? (
        <p className="prep-note" aria-live="polite">
          {T.preparing}
        </p>
      ) : null}

      {failed ? (
        <div className="prep-error" role="alert" data-testid="prepare-error">
          <p className="prep-error-title">{T.failed(failed.error?.message ?? '')}</p>
          {failed.error ? <p className="prep-error-step">{T.failedStep(T.steps[failed.error.step])}</p> : null}
          {/* o botão fica logo abaixo do erro (e não depois da lista de passos): é o que a pessoa procura */}
          <div className="prep-actions">
            <button type="button" className="btn btn-primary" onClick={() => void prepareEngine()} data-testid="prepare-retry">
              {T.retry}
            </button>
          </div>
          <ul className="prep-steps">
            {failed.steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </ul>
        </div>
      ) : null}

      {cancelled ? (
        <p className="prep-note" data-testid="prepare-cancelled">
          {T.cancelled}
        </p>
      ) : null}

      {!ready && !running && !failed ? (
        <>
          {!cancelled && view.detail ? <p className="prep-note">{view.detail}</p> : null}
          {storeError ? (
            <p className="prep-error-title" role="alert">
              {storeError}
            </p>
          ) : null}
          <div className="prep-actions">
            <button type="button" className="btn btn-primary" onClick={() => void prepareEngine()} data-testid={cancelled ? 'prepare-retry' : 'prepare-start'}>
              {cancelled ? T.retry : T.prepare}
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}
