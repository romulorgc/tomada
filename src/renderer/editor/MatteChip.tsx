/**
 * O aviso DISCRETO do recorte do fundo na barra do editor (R1): "Recortando você do fundo: 63%" enquanto o recorte roda em segundo plano
 * (ou "Continuando o recorte… 63%" quando o app foi fechado no meio e ele retomou do último pedaço, ou "em espera" quando dá lugar a uma
 * exportação), e um aviso claro com "Tentar de novo" se falhou. Pronto ou nunca pedido: não aparece. O estado vem de UM lugar:
 * `useEditor().matte.status` (`MatteStatus`, em `@shared/matte-parts`).
 */
import { useCamera } from '../camera-store'
import { AlertIcon } from '../components/Icons'
import { t } from '../i18n/pt-BR'
import { useEditor } from './context'

const M = t.editor.matteChip

export function MatteChip() {
  const { detail, hasCamera, matte } = useEditor()
  const status = matte.status
  if (!hasCamera) return null

  if (status.state === 'running' || status.state === 'queued') {
    const text = status.waiting === 'gpu' ? M.waiting(status.percent) : status.state === 'queued' ? M.queued : status.resumed ? M.resumed(status.percent) : M.running(status.percent)
    return (
      <div className="matte-chip" role="status" aria-live="polite" title={M.tip} data-testid="matte-chip" data-state={status.waiting === 'gpu' ? 'waiting' : status.state} data-resumed={status.resumed ? 'true' : 'false'}>
        <span className="matte-chip-bar" style={{ width: `${status.percent}%` }} aria-hidden="true" />
        <span className="matte-chip-text tnum" data-testid="matte-chip-text">
          {text}
        </span>
      </div>
    )
  }

  if (status.state === 'failed') {
    return (
      <div className="matte-chip matte-chip-failed" role="alert" title={status.error ?? undefined} data-testid="matte-chip" data-state="failed">
        <AlertIcon size={13} />
        <span className="matte-chip-text" data-testid="matte-chip-text">
          {M.failed}
        </span>
        <button type="button" className="link" data-testid="matte-chip-retry" onClick={() => void useCamera.getState().analyze(detail.id, 'matte')}>
          {M.retry}
        </button>
      </div>
    )
  }
  return null
}
