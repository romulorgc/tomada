import type { DiskEstimate } from '@shared/disk'
import { formatBytes, formatSpan } from '@shared/format'
import { t } from '../i18n/pt-BR'

/** A mesma estimativa do main, visível antes de iniciar e sem impedir o trabalho. */
export function DiskSpaceNotice({ estimate, recording = false }: { estimate: DiskEstimate | null; recording?: boolean }) {
  if (!estimate) return null
  return (
    <div className="rounded-control border border-line bg-raised px-3 py-2 text-sm" data-testid="disk-space-notice" data-status={estimate.status} role={estimate.status === 'low' ? 'alert' : 'status'}>
      <p className="font-medium">{estimate.status === 'low' ? t.diskSpace.low : estimate.status === 'unknown' ? t.diskSpace.unknown : t.diskSpace.title}</p>
      <p className="mt-1 tnum">{t.diskSpace.estimate(formatBytes(estimate.estimatedBytes), formatSpan(estimate.durationMs))} {estimate.freeBytes === null ? '' : t.diskSpace.free(formatBytes(estimate.freeBytes))}</p>
      <p className="mt-1 text-muted">{estimate.reason}</p>
      {recording ? <p className="mt-1 text-muted">{t.diskSpace.recordingPeriod}</p> : null}
    </div>
  )
}
