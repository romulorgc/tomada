import type { AudioQualityReport } from '@shared/audio-quality'
import { audioQualityWarningMessages } from '@shared/audio-quality-messages'
import { t } from '../i18n/pt-BR'

/** Usa o relatório SALVO no projeto, tanto na primeira abertura quanto nas seguintes. */
export function AudioQualityNotice({ report, pcmSyncWarning }: { report?: AudioQualityReport; pcmSyncWarning?: boolean }) {
  const messages = audioQualityWarningMessages(report, pcmSyncWarning)
  if (!messages.length) return null
  return <section role="alert" aria-label={t.audioQuality.title} data-testid="audio-quality-notice" className="mx-3 my-2 shrink-0 rounded-control border border-warn/50 bg-surface px-3 py-2 text-xs leading-relaxed">
    <h2 className="font-semibold text-warn">{t.audioQuality.title}</h2>
    <ul className="mt-1 grid gap-1 text-muted">{messages.map((message) => <li key={message}>{message}</li>)}</ul>
  </section>
}
