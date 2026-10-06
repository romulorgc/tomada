import { useEffect, useState } from 'react'
import type { ProjectSummary } from '@shared/types'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ErrorPanel } from '../components/Feedback'
import { RecordIcon } from '../components/Icons'
import { ProjectCard } from '../components/ProjectCard'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'

export function Library() {
  const projects = useApp((s) => s.projects)
  const status = useApp((s) => s.status)
  const error = useApp((s) => s.error)
  const loadProjects = useApp((s) => s.loadProjects)
  const renameProject = useApp((s) => s.renameProject)
  const trashProject = useApp((s) => s.trashProject)
  const revealProject = useApp((s) => s.revealProject)
  const notify = useApp((s) => s.notify)
  const go = useApp((s) => s.go)

  const [toDelete, setToDelete] = useState<ProjectSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    void loadProjects()
    // Quem voltar de outro programa (Explorer, por exemplo) vê a pasta como está agora.
    const refresh = () => void loadProjects()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [loadProjects])

  const confirmDelete = async () => {
    if (!toDelete) return
    setDeleting(true)
    const ok = await trashProject(toDelete.id)
    setDeleting(false)
    setToDelete(null)
    if (ok) notify({ kind: 'info', text: t.library.notices.removed })
  }

  const rename = async (id: string, title: string) => {
    const ok = await renameProject(id, title)
    if (ok) notify({ kind: 'info', text: t.library.notices.renamed })
    return ok
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[120rem] flex-col px-10 pb-12 pt-9">
      <header className="mb-7 flex items-end justify-between gap-6">
        <div>
          <h1 className="text-[1.75rem] font-[650] leading-none tracking-[-0.02em]">{t.library.title}</h1>
          {status === 'ready' && projects.length > 0 ? (
            <p className="mt-2 text-[0.9375rem] text-muted tnum" data-testid="library-count">
              {t.library.count(projects.length)}
            </p>
          ) : null}
        </div>
        <button type="button" className="btn btn-rec" onClick={() => go({ name: 'record' })} data-testid="new-recording">
          <RecordIcon size={16} />
          {t.library.newRecording}
        </button>
      </header>

      {status === 'error' ? (
        <ErrorPanel title={t.library.loadError} detail={error} onRetry={() => void loadProjects()} />
      ) : status === 'idle' || status === 'loading' ? (
        <div className="grid gap-x-6 gap-y-8" style={gridStyle} aria-busy="true" aria-label={t.common.loading}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-3">
              <div className="skeleton aspect-video" />
              <div className="skeleton h-4 w-2/3" />
            </div>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState onRecord={() => go({ name: 'record' })} />
      ) : (
        <div className="grid gap-x-6 gap-y-8" style={gridStyle} data-testid="library-grid">
          {projects.map((p) => (
            <div key={p.id}>
            <ProjectCard
              key={p.id}
              project={p}
              onOpen={(id) => go({ name: 'project', id })}
              onRename={rename}
              onReveal={(id) => void revealProject(id)}
              onAskDelete={setToDelete}
            />
            <button className="btn btn-ghost mt-2" data-testid="card-review" onClick={() => go({name:'review',id:p.id})}>{t.autopilot.review}</button>
            {p.autopilotNotice ? <p className="mt-1 text-sm text-muted" role="alert" data-testid="card-autopilot-notice">{p.autopilotNotice}</p> : null}
            </div>
          ))}
        </div>
      )}

      {toDelete ? (
        <ConfirmDialog
          title={t.library.confirmDelete.title(toDelete.title)}
          body={t.library.confirmDelete.body}
          confirmLabel={t.library.confirmDelete.confirm}
          tone="danger"
          busy={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setToDelete(null)}
        />
      ) : null}
    </div>
  )
}

/** Cartões crescem com a janela: de 1280 a 2560 px de largura mantêm um tamanho confortável. */
const gridStyle = { gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(16rem, 17vw, 24rem), 1fr))' } as const

function EmptyState({ onRecord }: { onRecord: () => void }) {
  return (
    <div className="m-auto flex max-w-md flex-col items-center py-16 text-center" data-testid="empty-state">
      <div className="thumb mb-8 w-64 !rounded-dialog">
        <span className="viewfinder" style={{ ['--vf' as string]: 'var(--color-muted)' }} />
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <span className="rec-dot !h-3 !w-3" data-live="true" />
        </span>
      </div>
      <h2 className="text-[1.375rem] font-[650] tracking-[-0.015em]">{t.library.empty.title}</h2>
      <p className="mt-2 text-[0.9375rem] text-muted">{t.library.empty.body}</p>
      <button type="button" className="btn btn-rec mt-6" onClick={onRecord} data-testid="empty-record">
        <RecordIcon size={16} />
        {t.library.empty.cta}
      </button>
    </div>
  )
}
