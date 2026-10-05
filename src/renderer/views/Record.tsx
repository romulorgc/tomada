import { RecordIcon } from '../components/Icons'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'

/** Provisória: a gravação em si chega na M1b. */
export function Record() {
  const go = useApp((s) => s.go)
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[120rem] flex-col px-10 pb-12 pt-9" data-testid="record-view">
      <h1 className="text-[1.75rem] font-[650] leading-none tracking-[-0.02em]">{t.record.title}</h1>
      <div className="m-auto flex max-w-lg flex-col items-center py-12 text-center">
        <div className="thumb mb-8 w-72 !rounded-dialog">
          <span className="viewfinder" style={{ ['--vf' as string]: 'var(--color-muted)' }} />
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-rec">
            <RecordIcon size={34} />
          </span>
        </div>
        <h2 className="text-[1.375rem] font-[650] tracking-[-0.015em]">{t.record.headline}</h2>
        <p className="mt-2 text-[0.9375rem] text-muted">{t.record.body}</p>
        <button type="button" className="btn mt-6" onClick={() => go({ name: 'library' })} data-testid="record-to-library">
          {t.record.cta}
        </button>
      </div>
    </div>
  )
}
