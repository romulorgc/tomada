/**
 * Preparação de primeira vez da análise da câmera (M4c): pacotes e detector de rosto, com o progresso REAL, o erro à vista com o
 * passo em que parou e "Tentar de novo" (retoma de onde parou). Mostrada na aba Câmera do editor enquanto a análise não está
 * pronta. O estado vem do store global; este componente só mostra e dispara.
 */
import { useEffect } from 'react'
import type { PrepareStep } from '@shared/transcription'
import { useCamera } from '../camera-store'
import { t } from '../i18n/pt-BR'
import { CheckIcon, CrossIcon } from './Icons'

const T = t.cameraTools
const pct = (fraction: number): number => Math.min(100, Math.max(0, Math.round(fraction * 100)))

function StepRow({ step }: { step: PrepareStep }) {
  return (
    <li className="prep-step" data-testid={`camera-prepare-step-${step.id}`} data-status={step.status}>
      <span className="prep-step-icon" aria-hidden="true">
        {step.status === 'done' ? <CheckIcon size={14} /> : step.status === 'error' ? <CrossIcon size={14} /> : step.status === 'running' ? <span className="spinner" /> : <i />}
      </span>
      <span className="prep-step-body">
        <span className="prep-step-label">
          {T.steps[step.id]}
          <span className="prep-step-status">{step.status === 'running' ? `${pct(step.fraction)}%` : T.stepStatus[step.status]}</span>
        </span>
        {step.detail && step.status !== 'pending' ? <span className="prep-step-detail">{step.detail}</span> : null}
      </span>
    </li>
  )
}

export function CameraPrepare({ explain }: { explain?: string }) {
  const view = useCamera((s) => s.view)
  const prepare = useCamera((s) => s.prepare)
  const storeError = useCamera((s) => s.error)
  const prepareEngine = useCamera((s) => s.prepareEngine)
  const cancelPrepare = useCamera((s) => s.cancelPrepare)
  const refresh = useCamera((s) => s.refresh)

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!view) {
    return (
      <div className="prep prep-compact" data-testid="camera-prepare" data-state="loading" aria-busy="true">
        <div className="skeleton h-6 w-40" />
      </div>
    )
  }

  const running = prepare?.status === 'running' || view.face.state === 'preparing'
  const failed = !running && prepare?.status === 'error' ? prepare : null
  const cancelled = !running && prepare?.status === 'cancelled'
  const ready = view.face.state === 'ready' && !running
  const state = running ? 'running' : ready ? 'ready' : failed ? 'error' : cancelled ? 'cancelled' : 'missing'
  if (ready) return null

  return (
    <div className="prep prep-compact" data-testid="camera-prepare" data-state={state}>
      {running && prepare ? (
        <>
          <div className="prep-progress" data-testid="camera-prepare-progress" aria-live="polite">
            <div className="meter big" role="progressbar" aria-label={T.preparing} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(prepare.fraction)}>
              <i style={{ width: `${pct(prepare.fraction)}%` }} />
            </div>
            <span className="tnum prep-percent">{pct(prepare.fraction)}%</span>
          </div>
          <ul className="prep-steps">
            {prepare.steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </ul>
          <div className="prep-actions">
            <button type="button" className="btn btn-ghost" onClick={() => void cancelPrepare()} data-testid="camera-prepare-cancel">
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
        <div className="prep-error" role="alert" data-testid="camera-prepare-error">
          <p className="prep-error-title">{T.failed(failed.error?.message ?? '')}</p>
          {failed.error ? <p className="prep-error-step">{T.failedStep(T.steps[failed.error.step])}</p> : null}
          <div className="prep-actions">
            <button type="button" className="btn btn-primary" onClick={() => void prepareEngine()} data-testid="camera-prepare-retry">
              {T.retry}
            </button>
          </div>
        </div>
      ) : null}

      {cancelled ? (
        <p className="prep-note" data-testid="camera-prepare-cancelled">
          {T.cancelled}
        </p>
      ) : null}

      {!running && !failed ? (
        <>
          {explain ? <p className="prep-note">{explain}</p> : null}
          {!cancelled && view.face.detail ? <p className="prep-note">{view.face.detail}</p> : null}
          {storeError ? (
            <p className="prep-error-title" role="alert">
              {storeError}
            </p>
          ) : null}
          <div className="prep-actions">
            <button type="button" className="btn btn-primary" onClick={() => void prepareEngine()} data-testid={cancelled ? 'camera-prepare-retry' : 'camera-prepare-start'}>
              {cancelled ? T.retry : T.prepare}
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}
