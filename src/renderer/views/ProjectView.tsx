import { useCallback, useEffect, useRef, useState } from 'react'
import { formatBytes, formatDateTime, formatDuration } from '@shared/format'
import type { MediaFile, ProjectDetail } from '@shared/ipc'
import type { Src } from '@shared/types'
import { ErrorPanel } from '../components/Feedback'
import { BackIcon, CameraIcon, FolderIcon, PauseIcon, PlayIcon, ScreenIcon } from '../components/Icons'
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
        <SyncedPlayer detail={detail} />
      )}

      <section className="mt-8 grid max-w-5xl gap-4 sm:grid-cols-2" aria-label={t.project.files}>
        <FileInfo icon={<ScreenIcon size={16} />} label={t.project.screen} src={project.sources.screen} file={detail.media.screen} testId="file-screen" />
        <FileInfo icon={<CameraIcon size={16} />} label={t.project.camera} src={project.sources.camera} file={detail.media.camera} testId="file-camera" />
      </section>

      <p className="mt-6 text-[0.8125rem] text-faint">{t.project.provisional}</p>
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

/**
 * Toca tela e câmera juntas, com um play/pause e uma barra de posição comuns.
 * A tela manda no relógio (se existir); a outra é realinhada se derivar mais de 150 ms.
 * Provisório: a M2 troca isto pelo motor de render.
 */
function SyncedPlayer({ detail }: { detail: ProjectDetail }) {
  const screenRef = useRef<HTMLVideoElement>(null)
  const cameraRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(detail.project.sources.screen?.durationMs ?? detail.project.sources.camera?.durationMs ?? 0)
  const [failed, setFailed] = useState<Record<'screen' | 'camera', boolean>>({ screen: false, camera: false })
  const [playError, setPlayError] = useState<string | null>(null)

  const screenUrl = detail.media.screen?.url
  const cameraUrl = detail.media.camera?.url
  const masterRef = screenUrl ? screenRef : cameraRef
  const videos = useCallback(
    () => [screenUrl ? screenRef.current : null, cameraUrl ? cameraRef.current : null].filter((v): v is HTMLVideoElement => v !== null),
    [screenUrl, cameraUrl]
  )

  // Durante a reprodução, lê o relógio a cada quadro da tela (o `timeupdate` só vem 4×/s).
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const master = masterRef.current
      if (master) {
        setCurrent(master.currentTime * 1000)
        for (const v of videos()) {
          if (v !== master && Math.abs(v.currentTime - master.currentTime) > 0.15) v.currentTime = master.currentTime
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, masterRef, videos])

  const play = useCallback(async () => {
    setPlayError(null)
    const list = videos()
    const master = masterRef.current
    if (master && master.ended) for (const v of list) v.currentTime = 0
    try {
      await Promise.all(list.map((v) => v.play()))
      setPlaying(true)
    } catch (err) {
      for (const v of list) v.pause()
      const message = err instanceof Error ? err.message : String(err)
      window.tomada.log({ level: 'error', message: 'Falha ao reproduzir', detail: message })
      setPlayError(`${t.project.videoError} (${message})`)
    }
  }, [videos, masterRef])

  const pause = useCallback(() => {
    for (const v of videos()) v.pause()
    setPlaying(false)
  }, [videos])

  const toggle = useCallback(() => (playing ? pause() : void play()), [playing, pause, play])

  const seek = (ms: number) => {
    for (const v of videos()) v.currentTime = Math.min(ms / 1000, Number.isFinite(v.duration) ? v.duration : ms / 1000)
    setCurrent(ms)
  }

  // Barra de espaço liga e desliga (fora de campos e botões, que têm o próprio uso).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'BUTTON' || el.tagName === 'TEXTAREA')) return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  const onMasterMetadata = () => {
    const d = masterRef.current?.duration
    if (d && Number.isFinite(d)) setDuration(d * 1000)
  }
  const onMasterEnded = () => {
    for (const v of videos()) v.pause()
    setPlaying(false)
    const d = masterRef.current?.duration
    if (d && Number.isFinite(d)) setCurrent(d * 1000)
  }

  const both = Boolean(screenUrl && cameraUrl)
  const percent = duration > 0 ? Math.min(100, (current / duration) * 100) : 0

  const frame = (kind: 'screen' | 'camera', url: string, ref: React.RefObject<HTMLVideoElement | null>, label: string) => (
    <figure className="min-w-0">
      <div className="video-frame aspect-video">
        <video
          ref={ref}
          src={url}
          preload="auto"
          playsInline
          muted={kind === 'screen' && Boolean(cameraUrl)}
          data-testid={`video-${kind}`}
          onLoadedMetadata={kind === (screenUrl ? 'screen' : 'camera') ? onMasterMetadata : undefined}
          onEnded={kind === (screenUrl ? 'screen' : 'camera') ? onMasterEnded : undefined}
          onError={() => {
            window.tomada.log({ level: 'error', message: `O vídeo ${kind} não abriu`, detail: url })
            setFailed((f) => ({ ...f, [kind]: true }))
          }}
        />
        {failed[kind] ? (
          <p role="alert" className="absolute inset-0 grid place-items-center bg-surface p-4 text-center text-[0.9375rem] text-danger">
            {t.project.videoError}
          </p>
        ) : null}
      </div>
      <figcaption className="mt-2 flex items-center gap-2 text-[0.8125rem] text-muted">
        {kind === 'screen' ? <ScreenIcon size={15} /> : <CameraIcon size={15} />}
        {label}
      </figcaption>
    </figure>
  )

  return (
    <div className="max-w-[88rem]">
      <div className={both ? 'grid items-start gap-5 [grid-template-columns:minmax(0,1fr)_minmax(0,0.4fr)]' : 'max-w-4xl'}>
        {screenUrl ? frame('screen', screenUrl, screenRef, t.project.screen) : null}
        {cameraUrl ? frame('camera', cameraUrl, cameraRef, t.project.camera) : null}
      </div>

      <div className="mt-4 flex items-center gap-4 rounded-thumb border border-line bg-surface px-4 py-3" role="group" aria-label={t.project.position}>
        <button
          type="button"
          className="btn !h-10 !w-10 !min-h-0 !rounded-full !p-0"
          onClick={toggle}
          aria-label={playing ? t.project.pause : t.project.play}
          data-testid="play-toggle"
          data-playing={playing}
        >
          {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        </button>
        <span className="w-[5.5rem] shrink-0 text-[0.9375rem] tnum text-ink" data-testid="current-time" data-seconds={(current / 1000).toFixed(2)}>
          {formatDuration(current)} <span className="text-faint">/ {formatDuration(duration)}</span>
        </span>
        <input
          type="range"
          className="scrubber"
          min={0}
          max={Math.max(1, Math.round(duration))}
          step={10}
          value={Math.min(Math.round(current), Math.round(duration))}
          style={{ ['--p' as string]: `${percent}%` }}
          aria-label={t.project.position}
          aria-valuetext={`${formatDuration(current)} de ${formatDuration(duration)}`}
          data-testid="scrubber"
          disabled={duration <= 0}
          onChange={(e) => seek(Number(e.target.value))}
        />
      </div>
      {playError ? (
        <p role="alert" className="mt-3 text-[0.9375rem] text-danger">
          {playError}
        </p>
      ) : null}
    </div>
  )
}
