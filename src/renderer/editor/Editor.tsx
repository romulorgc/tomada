import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EXPORT_RESOLUTION_LABEL, EXPORT_SIZES, type ExportFps, type ExportResolution } from '@shared/export'
import { eventsFromText } from '@shared/events'
import { formatDuration } from '@shared/format'
import type { ExportProgress, ProjectDetail } from '@shared/ipc'
import { mediaUrl } from '@shared/media-url'
import { DEFAULT_ZOOM_PRESET, generateAutoZooms, mergeAutoZooms } from '@shared/zoom'
import { HORIZONTAL_1080, deriveProject, prepareEvents, type CursorData } from '@shared/scene'
import { BACKGROUND_PRESETS, CAMERA_CORNERS, NIGHT_PRESET, backgroundFromPreset, presetIdOf } from '@shared/styles'
import type { Corner, LayoutKind, Project, ZoomPresetId } from '@shared/types'
import { t } from '../i18n/pt-BR'
import { PauseIcon, PlayIcon } from '../components/Icons'
import { useApp } from '../store'
import { PreviewEngine } from './preview'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const LAYOUTS: LayoutKind[] = ['bubble', 'side-by-side', 'screen', 'camera']
const ZOOM_CHOICES: (ZoomPresetId | 'off')[] = ['off', 'subtle', 'moderate', 'intense']
const RESOLUTIONS: ExportResolution[] = ['1080p', '1440p', '2160p']

async function fetchText(url: string | null): Promise<string | undefined> {
  if (!url) return undefined
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Não consegui ler ${url} (${r.status}).`)
  return r.text()
}

function formatEta(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
}

/** O editor da M2a: prévia com o motor de render, ajustes rápidos de aparência e exportação. */
export function Editor({ detail }: { detail: ProjectDetail }) {
  const notify = useApp((s) => s.notify)
  const revealProject = useApp((s) => s.revealProject)
  const [project, setProject] = useState<Project>(detail.project)
  const [cursorData, setCursorData] = useState<CursorData | null>(null)
  const [outMs, setOutMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [playError, setPlayError] = useState<string | null>(null)
  const [failed, setFailed] = useState<Record<'screen' | 'camera', boolean>>({ screen: false, camera: false })

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const screenRef = useRef<HTMLVideoElement>(null)
  const cameraRef = useRef<HTMLVideoElement>(null)
  const engineRef = useRef<PreviewEngine | null>(null)

  const screenUrl = detail.media.screen?.url
  const cameraUrl = detail.media.camera?.url
  const durationMs = Math.max(project.sources.screen?.durationMs ?? 0, project.sources.camera?.durationMs ?? 0, project.sources.voice?.durationMs ?? 0)

  // --- eventos (cursor, cliques, teclas) ------------------------------------------------------------
  const [eventsError, setEventsError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [cursor, clicks, keys] = await Promise.all([fetchText(detail.events.cursor), fetchText(detail.events.clicks), fetchText(detail.events.keys)])
        if (alive) setCursorData(prepareEvents(eventsFromText({ cursor, clicks, keys }), durationMs))
      } catch (err) {
        window.tomada.log({ level: 'error', message: 'Falha ao ler os eventos do projeto', detail: messageOf(err) })
        if (alive) {
          setEventsError(messageOf(err))
          setCursorData(prepareEvents({ cursor: [], clicks: [], keys: [] }, durationMs))
        }
      }
    })()
    return () => {
      alive = false
    }
    // eventos só mudam se o projeto trocar (o componente é remontado por `key`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id])

  // --- salvar ----------------------------------------------------------------------------------------
  const latest = useRef(project)
  const dirty = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const inFlight = useRef<Promise<void>>(Promise.resolve())

  const saveNow = useCallback((): Promise<void> => {
    window.clearTimeout(timer.current)
    if (!dirty.current) return inFlight.current
    dirty.current = false
    const doc = latest.current
    inFlight.current = inFlight.current
      .then(() => window.tomada.projects.save(detail.id, doc))
      .then(() => undefined)
      .catch((err: unknown) => {
        dirty.current = true
        notify({ kind: 'error', text: t.editor.saveFailed, detail: messageOf(err) })
      })
    return inFlight.current
  }, [detail.id, notify])

  const change = useCallback(
    (fn: (p: Project) => Project) => {
      setProject((prev) => {
        const next = fn(prev)
        latest.current = next
        dirty.current = true
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => void saveNow(), 500)
        return next
      })
    },
    [saveNow]
  )

  // Ao fechar o projeto, o que ainda não foi gravado vai para o disco.
  useEffect(
    () => () => {
      void saveNow()
    },
    [saveNow]
  )

  // --- zoom automático ---------------------------------------------------------------------------------
  const applyZoomPreset = useCallback(
    (preset: ZoomPresetId | 'off') => {
      if (!cursorData) return
      change((p) => {
        const auto =
          preset === 'off'
            ? []
            : generateAutoZooms({ clicks: cursorData.clicks, keys: cursorData.keys, cursor: cursorData.grid, duration: durationMs, preset })
        return { ...p, zoomPreset: preset, zooms: mergeAutoZooms(p.zooms, auto) }
      })
    },
    [change, cursorData, durationMs]
  )

  // Ao abrir um projeto sem zooms, gera os automáticos do preset padrão (uma vez).
  const generated = useRef(false)
  useEffect(() => {
    if (!cursorData || generated.current) return
    generated.current = true
    if (project.zoomPreset === undefined && project.zooms.length === 0) applyZoomPreset(DEFAULT_ZOOM_PRESET)
  }, [cursorData, project.zoomPreset, project.zooms.length, applyZoomPreset])

  // --- cena --------------------------------------------------------------------------------------------
  const derived = useMemo(() => (cursorData ? deriveProject(project, cursorData, HORIZONTAL_1080) : null), [project, cursorData])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const engine = new PreviewEngine({
      canvas,
      screen: screenUrl ? screenRef.current : null,
      camera: cameraUrl ? cameraRef.current : null,
      onTime: (ms, isPlaying) => {
        setOutMs(ms)
        setPlaying(isPlaying)
      },
      onError: (message) => {
        window.tomada.log({ level: 'error', message: 'Falha ao reproduzir', detail: message })
        setPlayError(`${t.editor.playFailed} (${message})`)
      }
    })
    engineRef.current = engine
    const frame = frameRef.current
    const fit = (): void => {
      if (!frame) return
      const dpr = window.devicePixelRatio || 1
      const w = Math.min(1920, Math.max(320, Math.round(frame.clientWidth * dpr)))
      engine.setSize(w, Math.round((w * 9) / 16))
    }
    fit()
    const ro = new ResizeObserver(fit)
    if (frame) ro.observe(frame)
    return () => {
      ro.disconnect()
      engine.destroy()
      engineRef.current = null
    }
  }, [screenUrl, cameraUrl])

  useEffect(() => {
    if (derived) engineRef.current?.setScene(project, derived)
  }, [project, derived])

  // imagem de fundo (quando o estilo usa uma)
  const bg = project.style.background
  useEffect(() => {
    if (bg.type !== 'image') return
    let alive = true
    void (async () => {
      try {
        const url = /^[a-z]+:\/\//i.test(bg.path) ? bg.path : mediaUrl(detail.id, bg.path)
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Não consegui ler a imagem de fundo (${response.status}).`)
        const bitmap = await createImageBitmap(await response.blob())
        if (alive) engineRef.current?.setBackgroundImage(bg.path, { image: bitmap, w: bitmap.width, h: bitmap.height })
      } catch (err) {
        notify({ kind: 'error', text: 'Não consegui carregar a imagem de fundo', detail: messageOf(err) })
      }
    })()
    return () => {
      alive = false
    }
  }, [bg, detail.id, notify])

  // --- transporte ---------------------------------------------------------------------------------------
  const toggle = useCallback(() => {
    const e = engineRef.current
    if (!e) return
    setPlayError(null)
    if (e.isPlaying) e.pause()
    else void e.play()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'BUTTON' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  const outputTotal = derived?.outputDurationMs ?? 0
  const percent = outputTotal > 0 ? Math.min(100, (outMs / outputTotal) * 100) : 0

  // --- exportação ---------------------------------------------------------------------------------------
  const [resolution, setResolution] = useState<ExportResolution>('1080p')
  const [fps, setFps] = useState<ExportFps>(30)
  const [exp, setExp] = useState<ExportProgress | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const busy = exp !== null && exp.phase !== 'done' && exp.phase !== 'error' && exp.phase !== 'cancelled'

  useEffect(() => {
    let alive = true
    const off = window.tomada.on('export:progress', (p) => {
      if (p.projectId === detail.id && alive) setExp(p)
    })
    void window.tomada.exporter.status().then((p) => {
      if (alive && p && p.projectId === detail.id && p.phase !== 'done' && p.phase !== 'error' && p.phase !== 'cancelled') setExp(p)
    })
    return () => {
      alive = false
      off()
    }
  }, [detail.id])

  const startExport = useCallback(async () => {
    setCancelling(false)
    engineRef.current?.pause()
    try {
      await saveNow()
      setExp(null)
      await window.tomada.exporter.start({ projectId: detail.id, resolution, fps })
    } catch (err) {
      setExp({
        exportId: '',
        projectId: detail.id,
        phase: 'error',
        fraction: 0,
        frame: 0,
        totalFrames: 0,
        renderFps: null,
        etaMs: null,
        audioReady: false,
        message: messageOf(err)
      })
    }
  }, [detail.id, fps, resolution, saveNow])

  const cancelExport = useCallback(async () => {
    if (!exp) return
    setCancelling(true)
    try {
      await window.tomada.exporter.cancel(exp.exportId)
    } catch (err) {
      notify({ kind: 'error', text: 'Não consegui cancelar', detail: messageOf(err) })
    }
  }, [exp, notify])

  // --- interface -----------------------------------------------------------------------------------------
  const activeBg = presetIdOf(bg)
  const hasCamera = Boolean(project.sources.camera)
  const hasScreen = Boolean(project.sources.screen)
  const zoomChoice: ZoomPresetId | 'off' | null = project.zoomPreset ?? (project.zooms.length > 0 ? null : 'off')
  const zoomCount = project.zooms.length

  return (
    <div className="max-w-[88rem]" data-testid="editor">
      <div className="grid items-start gap-6 [grid-template-columns:minmax(0,1fr)_minmax(15rem,20rem)]">
        <div className="min-w-0">
          <div ref={frameRef} className="preview-frame" data-testid="preview-frame">
            <canvas ref={canvasRef} width={1280} height={720} aria-label={t.editor.preview} data-testid="preview-canvas" data-ready="false" />
            {/* As fontes de imagem da prévia: ficam na página (precisam decodificar) mas não aparecem. */}
            {screenUrl ? (
              <video
                ref={screenRef}
                src={screenUrl}
                preload="auto"
                playsInline
                muted={Boolean(cameraUrl)}
                className="preview-source"
                data-testid="video-screen"
                onError={() => {
                  window.tomada.log({ level: 'error', message: 'O vídeo da tela não abriu', detail: screenUrl })
                  setFailed((f) => ({ ...f, screen: true }))
                }}
              />
            ) : null}
            {cameraUrl ? (
              <video
                ref={cameraRef}
                src={cameraUrl}
                preload="auto"
                playsInline
                className="preview-source"
                data-testid="video-camera"
                onError={() => {
                  window.tomada.log({ level: 'error', message: 'O vídeo da câmera não abriu', detail: cameraUrl })
                  setFailed((f) => ({ ...f, camera: true }))
                }}
              />
            ) : null}
            {failed.screen || failed.camera ? (
              <p role="alert" className="absolute inset-0 grid place-items-center bg-surface p-4 text-center text-[0.9375rem] text-danger">
                {t.project.videoError}
              </p>
            ) : null}
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
            <span className="w-[5.5rem] shrink-0 text-[0.9375rem] tnum text-ink" data-testid="current-time" data-seconds={(outMs / 1000).toFixed(2)}>
              {formatDuration(outMs)} <span className="text-faint">/ {formatDuration(outputTotal)}</span>
            </span>
            <input
              type="range"
              className="scrubber"
              min={0}
              max={Math.max(1, Math.round(outputTotal))}
              step={10}
              value={Math.min(Math.round(outMs), Math.round(outputTotal))}
              style={{ ['--p' as string]: `${percent}%` }}
              aria-label={t.project.position}
              aria-valuetext={`${formatDuration(outMs)} de ${formatDuration(outputTotal)}`}
              data-testid="scrubber"
              disabled={outputTotal <= 0}
              onChange={(e) => {
                setPlayError(null)
                engineRef.current?.seekOutput(Number(e.target.value))
                setOutMs(Number(e.target.value))
              }}
            />
          </div>
          {playError ? (
            <p role="alert" className="mt-3 text-[0.9375rem] text-danger">
              {playError}
            </p>
          ) : null}
          {eventsError || (cursorData && cursorData.grid.t.length > 0 && !detail.events.cursor && hasScreen) ? (
            <p className="mt-3 text-[0.8125rem] text-muted" data-testid="no-events">
              {t.editor.noEvents}
            </p>
          ) : null}

          <section className="mt-4 rounded-thumb border border-line bg-surface p-4" data-testid="export-panel">
            <h2 className="mb-3 text-[0.9375rem] font-[650]">{t.editor.export.title}</h2>
            <div className="flex flex-wrap items-end gap-3">
              <label className="grid min-w-[11rem] gap-1 text-[0.8125rem] text-muted">
                {t.editor.export.resolution}
                <select className="field" value={resolution} disabled={busy} data-testid="export-resolution" onChange={(e) => setResolution(e.target.value as ExportResolution)}>
                  {RESOLUTIONS.map((r) => (
                    <option key={r} value={r}>
                      {EXPORT_RESOLUTION_LABEL[r]} ({EXPORT_SIZES[r].w}×{EXPORT_SIZES[r].h})
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid min-w-[6rem] gap-1 text-[0.8125rem] text-muted">
                {t.editor.export.fps}
                <select className="field" value={fps} disabled={busy} data-testid="export-fps" onChange={(e) => setFps(Number(e.target.value) === 60 ? 60 : 30)}>
                  <option value={30}>30</option>
                  <option value={60}>60</option>
                </select>
              </label>
              {busy ? null : (
                <button type="button" className="btn btn-rec" data-testid="export-start" onClick={() => void startExport()}>
                  {t.editor.export.button(EXPORT_RESOLUTION_LABEL[resolution])}
                </button>
              )}
              <p className="ml-auto text-[0.8125rem] text-faint tnum">{t.editor.export.outputTime(formatDuration(outputTotal))}</p>
            </div>

            {busy ? (
              <div className="mt-4" data-testid="export-progress" data-phase={exp.phase} aria-live="polite">
                <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(exp.fraction * 100)}>
                  <i style={{ width: `${(exp.fraction * 100).toFixed(1)}%` }} />
                </div>
                <p className="mt-2 text-[0.875rem] font-medium" data-testid="export-phase">
                  {t.editor.export.phases[exp.phase as keyof typeof t.editor.export.phases]}
                </p>
                <p className="mt-0.5 text-[0.8125rem] text-muted tnum" data-testid="export-detail">
                  {exp.phase === 'rendering' ? t.editor.export.frames(exp.frame, exp.totalFrames) : ''}
                  {exp.renderFps ? ` · ${t.editor.export.speed(Math.round(exp.renderFps))}` : ''}
                  {exp.etaMs ? ` · ${t.editor.export.eta(formatEta(exp.etaMs))}` : ''}
                  {exp.audioReady ? ` · ${t.editor.export.audioReady}` : ''}
                </p>
                <button type="button" className="btn mt-3" disabled={cancelling} data-testid="export-cancel" onClick={() => void cancelExport()}>
                  {cancelling ? t.editor.export.cancelling : t.editor.export.cancel}
                </button>
              </div>
            ) : null}

            {exp?.phase === 'done' && exp.outputPath ? (
              <div className="mt-4 rounded-control border border-line-strong p-3" role="status" data-testid="export-done">
                <p className="text-[0.9375rem] font-[650]">{t.editor.export.doneTitle}</p>
                <p className="mt-1 break-all text-[0.8125rem] text-muted" data-testid="export-done-path">
                  {t.editor.export.doneBody(exp.outputPath.split(/[\\/]/).pop() ?? '')}
                </p>
                {exp.report ? (
                  <p className="mt-1 text-[0.8125rem] text-faint tnum" data-testid="export-report">
                    {exp.report.width}×{exp.report.height} · {Math.round(exp.report.fps)} qps · {Math.round(exp.report.renderFps)} qps de render · áudio × vídeo {exp.report.audioVideoDiffMs} ms
                  </p>
                ) : null}
                <button type="button" className="btn mt-2" onClick={() => void revealProject(detail.id)}>
                  {t.editor.export.reveal}
                </button>
              </div>
            ) : null}
            {exp?.phase === 'error' ? (
              <div className="mt-4 rounded-control border border-danger/50 p-3" role="alert" data-testid="export-error">
                <p className="text-[0.9375rem] font-[650]">{t.editor.export.failedTitle}</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-[0.8125rem] text-muted">{exp.message}</p>
                <button type="button" className="btn mt-2" onClick={() => void startExport()} data-testid="export-retry">
                  {t.editor.export.retry}
                </button>
              </div>
            ) : null}
            {exp?.phase === 'cancelled' ? (
              <p className="mt-4 text-[0.875rem] text-muted" role="status" data-testid="export-cancelled">
                {t.editor.export.cancelled}
              </p>
            ) : null}
          </section>
        </div>

        <aside className="grid min-w-0 gap-5" aria-label={t.editor.style.title}>
          <section className="rounded-thumb border border-line bg-surface p-4" data-testid="style-panel">
            <h2 className="mb-3 text-[0.9375rem] font-[650]">{t.editor.style.title}</h2>

            <p className="panel-label">{t.editor.style.background}</p>
            <div className="swatches" role="group" aria-label={t.editor.style.background} data-testid="bg-swatches">
              {[NIGHT_PRESET, ...BACKGROUND_PRESETS].map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="swatch"
                  title={b.name}
                  aria-label={b.name}
                  aria-pressed={activeBg === b.id}
                  data-testid={`bg-${b.id}`}
                  style={{ background: b.from === b.to ? b.from : `linear-gradient(135deg, ${b.from}, ${b.to})` }}
                  onClick={() => change((p) => ({ ...p, style: { ...p.style, background: backgroundFromPreset(b.id) } }))}
                />
              ))}
            </div>

            <p className="panel-label mt-4">{t.editor.style.layout}</p>
            <div className="seg flex-wrap" role="group" aria-label={t.editor.style.layout}>
              {LAYOUTS.map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={project.style.defaultLayout === l}
                  disabled={l === 'camera' ? !hasCamera : l === 'screen' ? !hasScreen : !(hasCamera && hasScreen)}
                  data-testid={`layout-${l}`}
                  onClick={() => change((p) => ({ ...p, style: { ...p.style, defaultLayout: l } }))}
                >
                  {t.editor.style.layouts[l as keyof typeof t.editor.style.layouts]}
                </button>
              ))}
            </div>

            {hasCamera ? (
              <>
                <p className="panel-label mt-4">{t.editor.style.cameraPosition}</p>
                <div className="corner-grid" role="group" aria-label={t.editor.style.cameraPosition} data-testid="camera-corners">
                  {CAMERA_CORNERS.map((c: Corner) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={t.editor.style.positions[c]}
                      title={t.editor.style.positions[c]}
                      aria-pressed={project.style.camera.corner === c}
                      data-testid={`corner-${c}`}
                      onClick={() => change((p) => ({ ...p, style: { ...p.style, camera: { ...p.style.camera, corner: c } } }))}
                    />
                  ))}
                </div>
              </>
            ) : null}

            <p className="panel-label mt-4">{t.editor.style.zoom}</p>
            <div className="seg flex-wrap" role="group" aria-label={t.editor.style.zoom}>
              {ZOOM_CHOICES.map((z) => (
                <button key={z} type="button" aria-pressed={zoomChoice === z} disabled={!cursorData} data-testid={`zoom-${z}`} onClick={() => applyZoomPreset(z)}>
                  {t.editor.style.zooms[z]}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[0.8125rem] text-faint tnum" data-testid="zoom-count">
              {t.editor.style.zoomCount(zoomCount)}
            </p>
          </section>
        </aside>
      </div>
    </div>
  )
}
