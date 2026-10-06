import { useEffect, useRef, useState } from 'react'
import { formatDate, formatDateTime, formatDuration } from '@shared/format'
import type { ProjectSummary } from '@shared/types'
import { t } from '../i18n/pt-BR'
import { isJobActive, useTranscription } from '../transcription-store'
import { CameraIcon, CheckIcon, FolderIcon, PencilIcon, ScreenIcon, TrashIcon } from './Icons'

type Props = {
  project: ProjectSummary
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => Promise<boolean>
  onReveal: (id: string) => void
  onAskDelete: (project: ProjectSummary) => void
}

export function ProjectCard({ project, onOpen, onRename, onReveal, onAskDelete }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.title)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const job = useTranscription((s) => s.jobs[project.id])
  // Enter e blur disparam um atrás do outro: só o primeiro vale.
  const settled = useRef(false)

  useEffect(() => {
    if (editing) {
      settled.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const startEdit = () => {
    setDraft(project.title)
    setEditing(true)
  }

  const cancel = () => {
    settled.current = true
    setEditing(false)
  }

  const commit = async () => {
    if (settled.current) return
    settled.current = true
    const next = draft.trim()
    if (!next || next === project.title) {
      setEditing(false)
      return
    }
    setSaving(true)
    const ok = await onRename(project.id, next)
    setSaving(false)
    setEditing(false)
    if (!ok) setDraft(project.title)
  }

  const thumbSrc = project.thumbPath ? window.tomada.mediaUrl(project.id, project.thumbPath, project.thumbVersion) : null

  return (
    <article className="card group flex min-w-0 flex-col gap-3" data-testid="project-card" data-project-id={project.id}>
      <div className="thumb">
        {thumbSrc ? (
          <img src={thumbSrc} alt="" loading="lazy" decoding="async" draggable={false} />
        ) : (
          <>
            <span className="viewfinder" />
            <span className="absolute inset-x-0 bottom-3 text-center text-[0.8125rem] text-faint">{t.library.card.noThumb}</span>
          </>
        )}
        <button
          type="button"
          className="absolute inset-0 cursor-pointer rounded-thumb"
          aria-label={t.library.card.open(project.title)}
          data-testid="card-open"
          onClick={() => onOpen(project.id)}
        />
        {job && isJobActive(job) ? (
          <span className="job-chip tnum" data-testid="card-transcribing" data-state={job.state} role="status">
            <span className="spinner" aria-hidden="true" />
            {job.state === 'queued' ? t.transcription.chip.queued : t.transcription.chip.running(Math.round(job.fraction * 100))}
          </span>
        ) : null}
        <span className="duration-chip tnum" data-testid="card-duration">
          {formatDuration(project.durationMs)}
        </span>
        <div className="card-actions">
          <button type="button" className="icon-btn" aria-label={t.library.card.rename} title={t.library.card.rename} data-testid="card-rename" onClick={startEdit}>
            <PencilIcon size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={t.library.card.reveal}
            title={t.library.card.reveal}
            data-testid="card-reveal"
            onClick={() => onReveal(project.id)}
          >
            <FolderIcon size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            data-tone="danger"
            aria-label={t.library.card.remove}
            title={t.library.card.remove}
            data-testid="card-delete"
            onClick={() => onAskDelete(project)}
          >
            <TrashIcon size={16} />
          </button>
        </div>
      </div>

      <div className="min-w-0 px-0.5">
        {project.hasTranscript || (project.clipCount ?? 0) > 0 ? (
          <div className="project-badges" aria-label={t.library.card.progress}>
            {project.hasTranscript ? <span data-testid="card-transcribed"><CheckIcon size={13} />{t.library.card.transcribed}</span> : null}
            {(project.clipCount ?? 0) > 0 ? <span data-testid="card-clips-ready">{t.library.card.clipsReady(project.clipCount!)}</span> : null}
          </div>
        ) : null}
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            disabled={saving}
            maxLength={200}
            aria-label={t.library.card.renameLabel}
            data-testid="rename-input"
            className="w-full rounded-control border border-line-strong bg-raised px-2 py-1 text-[0.9375rem] font-semibold text-ink"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void commit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                cancel()
              }
            }}
          />
        ) : (
          <h3 className="truncate text-[0.9375rem] font-semibold leading-snug tracking-[-0.005em]" title={project.title} data-testid="card-title" onDoubleClick={startEdit}>
            {project.title}
          </h3>
        )}
        <div className="mt-1 flex items-center justify-between text-[0.8125rem] text-muted">
          <time dateTime={project.createdAt} title={formatDateTime(project.createdAt)} className="tnum" data-testid="card-date">
            {formatDate(project.createdAt)}
          </time>
          <span className="flex items-center gap-2 text-faint">
            {project.hasScreen ? (
              <span title={t.library.card.hasScreen} className="flex">
                <ScreenIcon size={15} />
                <span className="sr-only">{t.library.card.hasScreen}</span>
              </span>
            ) : null}
            {project.hasCamera ? (
              <span title={t.library.card.hasCamera} className="flex">
                <CameraIcon size={15} />
                <span className="sr-only">{t.library.card.hasCamera}</span>
              </span>
            ) : null}
          </span>
        </div>
      </div>
    </article>
  )
}
