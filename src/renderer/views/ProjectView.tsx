import { useCallback, useEffect, useState } from 'react'
import { formatBytes, formatDateTime } from '@shared/format'
import type { MediaFile, ProjectDetail } from '@shared/ipc'
import type { Src } from '@shared/types'
import { ErrorPanel } from '../components/Feedback'
import { BackIcon, CameraIcon, FolderIcon, ScreenIcon } from '../components/Icons'
import { Editor } from '../editor/Editor'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'

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
      <ErrorPanel
        title={t.project.loadError}
        detail={error}
        onRetry={() => void load()}
        extra={
          <button type="button" className="btn btn-ghost" onClick={() => go({ name: 'library' })}>
            {t.common.back}
          </button>
        }
      />
    )
  }
  if (!detail) {
    return (
      <div className="px-10 pt-9" aria-busy="true" aria-label={t.common.loading}>
        <div className="skeleton mb-6 h-8 w-72" />
        <div className="skeleton aspect-video max-w-4xl" />
      </div>
    )
  }

  const { project } = detail
  const noMedia = !project.sources.screen && !project.sources.camera

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[120rem] flex-col px-10 pb-12 pt-7" data-testid="project-view">
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

      <header className="mb-6">
        <h1 className="truncate text-[1.75rem] font-[650] leading-tight tracking-[-0.02em]" data-testid="project-title" title={project.title}>
          {project.title}
        </h1>
        <p className="mt-1.5 text-[0.9375rem] text-muted tnum">
          {t.project.created} {formatDateTime(project.createdAt)}
        </p>
      </header>

      {noMedia ? (
        <p className="rounded-dialog border border-line bg-surface p-5 text-muted">{t.project.noMedia}</p>
      ) : (
        <Editor key={detail.id} detail={detail} />
      )}

      <section className="mt-8 grid max-w-5xl gap-4 sm:grid-cols-2" aria-label={t.project.files}>
        <FileInfo icon={<ScreenIcon size={16} />} label={t.project.screen} src={project.sources.screen} file={detail.media.screen} testId="file-screen" />
        <FileInfo icon={<CameraIcon size={16} />} label={t.project.camera} src={project.sources.camera} file={detail.media.camera} testId="file-camera" />
      </section>
    </div>
  )
}

function FileInfo({
  icon,
  label,
  src,
  file,
  testId
}: {
  icon: React.ReactNode
  label: string
  src: Src | undefined
  file: MediaFile | null
  testId: string
}) {
  if (!src) return null
  return (
    <div className="rounded-thumb border border-line bg-surface px-4 py-3" data-testid={testId}>
      <div className="flex items-center gap-2 text-[0.9375rem] font-semibold">
        <span className="text-muted">{icon}</span>
        {label}
      </div>
      <p className="mt-1 break-all text-[0.8125rem] text-muted">{src.path}</p>
      {file ? (
        <p className="mt-0.5 text-[0.8125rem] text-muted tnum">
          {t.project.fileLine(src.w, src.h, src.fps)}, {formatBytes(file.bytes)}
        </p>
      ) : (
        <p className="mt-0.5 text-[0.8125rem] text-danger" role="alert">
          {t.project.missingFile}
        </p>
      )}
    </div>
  )
}
