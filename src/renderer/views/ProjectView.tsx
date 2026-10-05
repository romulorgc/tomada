import { useCallback, useEffect, useState } from 'react'
import type { ProjectDetail } from '@shared/ipc'
import { ErrorPanel } from '../components/Feedback'
import { BackIcon, FolderIcon } from '../components/Icons'
import { Editor } from '../editor/Editor'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'

/** Abrir um projeto: o editor ocupa a janela inteira (a barra de navegação do app sai da frente). */
export function ProjectView({ id }: { id: string }) {
  const go = useApp((s) => s.go)
  const revealProject = useApp((s) => s.revealProject)
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setDetail(await window.tomada.projects.get(id))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      window.tomada.log({ level: 'error', message: `Falha ao abrir o projeto ${id}`, detail: message })
      setError(message)
    }
  }, [id])

  useEffect(() => {
    setDetail(null)
    void load()
  }, [load])

  if (error) {
    return (
      <div className="h-full overflow-y-auto" data-testid="project-view">
        <ErrorPanel
          title={t.project.loadError}
          detail={error}
          onRetry={() => void load()}
          extra={
            <button type="button" className="btn btn-ghost" data-testid="back-to-library" onClick={() => go({ name: 'library' })}>
              {t.common.back}
            </button>
          }
        />
      </div>
    )
  }
  if (!detail) {
    return (
      <div className="h-full px-10 pt-9" aria-busy="true" aria-label={t.common.loading} data-testid="project-view">
        <div className="skeleton mb-6 h-8 w-72" />
        <div className="skeleton aspect-video max-w-4xl" />
      </div>
    )
  }

  const { project } = detail
  if (!project.sources.screen && !project.sources.camera) {
    return (
      <div className="mx-auto h-full max-w-3xl overflow-y-auto px-10 pt-7" data-testid="project-view">
        <div className="mb-5 flex items-center justify-between gap-4">
          <button type="button" className="btn btn-ghost -ml-3" onClick={() => go({ name: 'library' })} data-testid="back-to-library">
            <BackIcon size={16} />
            {t.common.back}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void revealProject(detail.id)}>
            <FolderIcon size={16} />
            {t.project.revealFolder}
          </button>
        </div>
        <h1 className="mb-4 truncate text-[1.5rem] font-[650] tracking-[-0.02em]" data-testid="project-title">
          {project.title}
        </h1>
        <p className="rounded-dialog border border-line bg-surface p-5 text-muted">{t.project.noMedia}</p>
      </div>
    )
  }

  return (
    <div className="h-full" data-testid="project-view">
      <Editor key={detail.id} detail={detail} />
    </div>
  )
}
