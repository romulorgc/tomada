/**
 * Diálogo de EXPORTAR: predefinições (YouTube 1080p, 1440p, 4K; 30 ou 60 qps), nome do arquivo, pasta;
 * depois o progresso real (quadros, velocidade, tempo restante) com cancelar; ao terminar, tocar, mostrar na
 * pasta e copiar o caminho. A exportação roda fora da tela do editor: fechar o diálogo não a interrompe.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { EXPORT_RESOLUTION_LABEL, EXPORT_SIZES, defaultExportStem, exportBitrate, type ExportFormatKind, type ExportFps, type ExportResolution } from '@shared/export'
import { usesPresenter } from '@shared/scene'
import { projectForFormat } from '@shared/vertical'
import { formatBytes, formatSpan } from '@shared/format'
import { cameraJobKey, isCameraJobActive, useCamera } from '../camera-store'
import { AlertIcon, CheckIcon, CopyIcon, CrossIcon, FolderIcon, PlayFolderIcon } from '../components/Icons'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'
import { Segmented } from './controls'
import { useDoc, useEditor } from './context'
import { DiskSpaceNotice } from '../components/DiskSpaceNotice'
import type { DiskEstimate } from '@shared/disk'
import { DEFAULT_EXPORT_DEFAULTS, type ExportDefaults } from '@shared/settings-defaults'

const T = t.editor.export
const RESOLUTIONS: ExportResolution[] = ['1080p', '1440p', '2160p']
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function formatEta(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

export function ExportDialog() {
  const { exporter, detail, derived, transcript, matte } = useEditor()
  const notify = useApp((s) => s.notify)
  const title = useDoc((s) => s.project.title)
  const doc = useDoc((s) => s.doc)
  const openFormat = useDoc((s) => s.format)
  const progress = exporter.progress
  const busy = exporter.busy

  // o formato que está aberto no editor é o que se oferece primeiro
  const [format, setFormat] = useState<ExportFormatKind>(openFormat)
  const vertical = format === 'vertical'
  const [resolution, setResolution] = useState<ExportResolution>('1080p')
  const [fps, setFps] = useState<ExportFps>(30)
  const [name, setName] = useState<string | null>(null) // null = o nome padrão
  const [dir, setDir] = useState<string | null>(null) // null = exports/ do projeto
  const [defaults, setDefaults] = useState<ExportDefaults>(DEFAULT_EXPORT_DEFAULTS)
  const [disk, setDisk] = useState<DiskEstimate | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  const stem = name ?? defaultExportStem(title, { resolution, fps, format })
  const outMs = derived?.outputDurationMs ?? 0
  const sep = detail.dir.includes('\\') ? '\\' : '/'
  const shownDir = dir ?? `${detail.dir}${sep}exports`
  const estimate = useMemo(() => formatBytes(((exportBitrate(resolution, fps, format) + 320_000) * (outMs / 1000)) / 8), [resolution, fps, format, outMs])
  // legenda ligada neste formato e nenhuma palavra para legendar: o vídeo sai sem legenda, e a pessoa precisa saber
  const captionsWithoutText = projectForFormat(doc, format).captions.enabled && (transcript.data?.words.length ?? 0) === 0
  // o layout Apresentador desenha a câmera pela máscara do fundo: sem ela o vídeo sairia diferente da prévia, então a exportação espera
  const needsMatte = usesPresenter(projectForFormat(doc, format), format) && !matte.url
  const matteJob = useCamera((s) => s.jobs[cameraJobKey(detail.id, 'matte')])
  useEffect(() => {
    let alive = true
    void window.tomada.settings.get().then((view) => {
      if (!alive) return
      const saved = view.settings.exportDefaults ?? DEFAULT_EXPORT_DEFAULTS
      setDefaults(saved); setResolution(saved.horizontal.resolution); setFps(saved[openFormat].fps)
    }).catch((err: unknown) => window.tomada.log({level:'warn',message:'Falha ao ler padrões de exportação',detail:messageOf(err)}))
    return () => { alive = false }
  }, [openFormat])
  useEffect(() => {
    if (progress) return
    let alive = true
    const timer = window.setTimeout(() => {
      void exporter.diskSpace({resolution,fps,format,...(name !== null && name.trim() ? {fileName:name.trim()} : {}),...(dir ? {dir} : {})}).then((estimate) => { if (alive) setDisk(estimate) }).catch((err: unknown) => window.tomada.log({level:'warn',message:'Falha ao medir o disco antes de exportar',detail:messageOf(err)}))
    }, 150)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [exporter.diskSpace, resolution, fps, format, name, dir, progress, doc])

  // Esc fecha (a exportação segue rodando); o foco entra no diálogo ao abrir
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        exporter.setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // só ao abrir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chooseDir = async (): Promise<void> => {
    try {
      const picked = await window.tomada.exporter.pickDir(dir ?? detail.dir)
      if (picked) setDir(picked)
    } catch (err) {
      notify({ kind: 'error', text: T.pickFailed, detail: messageOf(err) })
    }
  }

  const start = (): void => {
    void exporter.start({ resolution, fps, format, ...(name !== null && name.trim() ? { fileName: name.trim() } : {}), ...(dir ? { dir } : {}) })
  }

  const run = async (what: 'open' | 'reveal' | 'copy', path: string): Promise<void> => {
    try {
      if (what === 'open') await window.tomada.files.open(path)
      else if (what === 'reveal') await window.tomada.files.reveal(path)
      else {
        await window.tomada.clipboard.write(path)
        notify({ kind: 'info', text: T.copied })
      }
    } catch (err) {
      notify({ kind: 'error', text: what === 'open' ? T.openFailed : what === 'reveal' ? T.revealFailed : T.copyFailed, detail: messageOf(err) })
    }
  }

  const phase = progress?.phase
  const form = !progress

  return (
    <div className="dialog-backdrop" data-testid="export-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && exporter.setOpen(false)}>
      <div className="dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" ref={dialogRef} data-testid="export-dialog" data-phase={phase ?? 'form'}>
        <header className="export-head">
          <div>
            <h2 id="export-title">{T.title}</h2>
            <p>{vertical ? T.subtitleVertical : T.subtitle}</p>
          </div>
          <button type="button" className="btn btn-ghost icon-only" aria-label={T.close} data-testid="export-close" onClick={() => exporter.setOpen(false)}>
            <CrossIcon size={16} />
          </button>
        </header>

        {form ? (
          <>
            <div className="field-block">
              <span className="field-label">{T.formatLabel}</span>
              <Segmented<ExportFormatKind>
                label={T.formatLabel}
                value={format}
                onChange={(f) => {
                  setFormat(f)
                  setFps(defaults[f].fps)
                  setName(null)
                }}
                options={[
                  { value: 'horizontal', label: T.formats.horizontal, testId: 'export-format-horizontal' },
                  { value: 'vertical', label: T.formats.vertical, testId: 'export-format-vertical' }
                ]}
              />
            </div>

            <div className="field-block">
              <span className="field-label" id="export-quality">
                {T.presets}
              </span>
              <div className="preset-cards" role="radiogroup" aria-labelledby="export-quality">
                {vertical ? (
                  <button type="button" role="radio" aria-checked="true" className="preset-card" data-testid="export-preset-vertical" data-autofocus="true">
                    <b>{T.verticalCard.name}</b>
                    <span className="tnum">{T.verticalCard.detail}</span>
                  </button>
                ) : null}
                {(vertical ? [] : RESOLUTIONS).map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={resolution === r}
                    className="preset-card"
                    data-testid={`export-preset-${r}`}
                    {...(resolution === r ? { 'data-autofocus': true } : {})}
                    onClick={() => setResolution(r)}
                  >
                    <b>{T.preset[r]}</b>
                    <span className="tnum">{T.presetSize(EXPORT_SIZES[r].w, EXPORT_SIZES[r].h)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="field-block">
              <span className="field-label">{T.fps}</span>
              <Segmented<'30' | '60'>
                label={T.fps}
                value={String(fps) as '30' | '60'}
                onChange={(v) => setFps(v === '60' ? 60 : 30)}
                options={[
                  { value: '30', label: '30', testId: 'export-fps-30' },
                  { value: '60', label: '60', testId: 'export-fps-60' }
                ]}
              />
            </div>

            <div className="field-block">
              <label className="field-label" htmlFor="export-name">
                {T.fileName}
              </label>
              <div className="name-field">
                <input id="export-name" className="text-field" value={stem} maxLength={200} spellCheck={false} data-testid="export-name" onChange={(e) => setName(e.target.value)} />
                <span className="name-ext">.mp4</span>
              </div>
            </div>

            <div className="field-block">
              <span className="field-label">{T.folder}</span>
              <div className="folder-field">
                <FolderIcon size={16} />
                <span className="folder-path" title={shownDir} data-testid="export-dir">
                  {shownDir}
                </span>
                <button type="button" className="btn" data-testid="export-choose-dir" onClick={() => void chooseDir()}>
                  {T.folderChoose}
                </button>
              </div>
              {dir ? (
                <button type="button" className="link" data-testid="export-reset-dir" onClick={() => setDir(null)}>
                  {T.folderReset}
                </button>
              ) : null}
            </div>

            <p className="export-summary tnum" data-testid="export-summary">
              {outMs > 0 ? T.summary(formatSpan(outMs), estimate) : T.nothing}
            </p>
            <DiskSpaceNotice estimate={disk} />
            {captionsWithoutText ? (
              <p className="ctl-note" data-testid="export-captions-warning" role="status">
                {T.captionsNoText}
              </p>
            ) : null}
            {needsMatte ? (
              <p className="ctl-note" data-testid="export-matte-warning" role="alert">
                {isCameraJobActive(matteJob) ? T.matteRunning(Math.round((matteJob?.fraction ?? 0) * 100)) : T.matteMissing}
              </p>
            ) : null}

            <footer className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={() => exporter.setOpen(false)}>
                {t.common.cancel}
              </button>
              <button type="button" className="btn btn-primary" disabled={outMs <= 0 || stem.trim() === '' || needsMatte} data-testid="export-start" onClick={start}>
                {T.button(vertical ? T.formats.vertical : EXPORT_RESOLUTION_LABEL[resolution])}
              </button>
            </footer>
          </>
        ) : null}

        {progress && busy ? (
          <div className="export-run" data-testid="export-progress" data-phase={progress.phase} aria-live="polite">
            <div className="meter big" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.fraction * 100)}>
              <i style={{ width: `${(progress.fraction * 100).toFixed(1)}%` }} />
            </div>
            <p className="export-phase" data-testid="export-phase">
              {T.phases[progress.phase as keyof typeof T.phases]}
            </p>
            <p className="export-detail tnum" data-testid="export-detail">
              {progress.phase === 'rendering' ? T.frames(progress.frame, progress.totalFrames) : ''}
              {progress.renderFps ? ` · ${T.speed(Math.round(progress.renderFps))}` : ''}
              {progress.etaMs ? ` · ${T.eta(formatEta(progress.etaMs))}` : ''}
              {progress.audioReady ? ` · ${T.audioReady}` : ''}
            </p>
            <p className="ctl-note">{T.runningHint}</p>
            <footer className="dialog-actions">
              <button type="button" className="btn btn-ghost" data-testid="export-keep-editing" onClick={() => exporter.setOpen(false)}>
                {T.keepEditing}
              </button>
              <button type="button" className="btn" disabled={exporter.cancelling} data-testid="export-cancel" onClick={() => void exporter.cancel()}>
                {exporter.cancelling ? T.cancelling : T.cancel}
              </button>
            </footer>
          </div>
        ) : null}

        {progress && phase === 'done' && progress.outputPath ? (
          <div className="export-result" data-testid="export-done" role="status">
            <div className="result-head">
              <span className="result-icon" data-tone="ok">
                <CheckIcon size={18} />
              </span>
              <div>
                <h3>{T.doneTitle}</h3>
                <p className="file-name" data-testid="export-done-path" title={progress.outputPath}>
                  {T.doneBody(baseName(progress.outputPath))}
                </p>
              </div>
            </div>
            {progress.textPath ? (
              <p className="export-detail" data-testid="export-text-path" title={progress.textPath}>
                {T.textSaved(baseName(progress.textPath))}
              </p>
            ) : null}
            {progress.message ? (
              <p className="export-detail" data-tone="warn" role="alert" data-testid="export-warning">
                {progress.message}
              </p>
            ) : null}
            {progress.report ? (
              <p className="export-detail tnum" data-testid="export-report">
                {T.report(progress.report.width, progress.report.height, Math.round(progress.report.fps), (progress.report.bytes / 1e6).toFixed(1), progress.report.audioVideoDiffMs)}
              </p>
            ) : null}
            <div className="result-actions">
              <button type="button" className="btn btn-primary" data-testid="export-play" {...{ 'data-autofocus': true }} onClick={() => void run('open', progress.outputPath!)}>
                <PlayFolderIcon size={16} />
                {T.play}
              </button>
              <button type="button" className="btn" data-testid="export-reveal" onClick={() => void run('reveal', progress.outputPath!)}>
                <FolderIcon size={16} />
                {T.reveal}
              </button>
              <button type="button" className="btn" data-testid="export-copy" onClick={() => void run('copy', progress.outputPath!)}>
                <CopyIcon size={16} />
                {T.copyPath}
              </button>
            </div>
            <footer className="dialog-actions">
              <button type="button" className="btn btn-ghost" data-testid="export-again" onClick={() => exporter.reset()}>
                {T.again}
              </button>
              <button type="button" className="btn" data-testid="export-done-close" onClick={() => exporter.setOpen(false)}>
                {T.close}
              </button>
            </footer>
          </div>
        ) : null}

        {progress && phase === 'error' ? (
          <div className="export-result" data-testid="export-error" role="alert">
            <div className="result-head">
              <span className="result-icon" data-tone="danger">
                <AlertIcon size={18} />
              </span>
              <div>
                <h3>{T.failedTitle}</h3>
                <p className="error-detail">{progress.message}</p>
              </div>
            </div>
            <footer className="dialog-actions">
              <button type="button" className="btn btn-ghost" data-testid="export-back" onClick={() => exporter.reset()}>
                {t.editor.export.title}
              </button>
              <button type="button" className="btn btn-primary" data-testid="export-retry" onClick={start}>
                {T.retry}
              </button>
            </footer>
          </div>
        ) : null}

        {progress && phase === 'cancelled' ? (
          <div className="export-result" data-testid="export-cancelled" role="status">
            <p className="export-phase">{T.cancelled}</p>
            <footer className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={() => exporter.setOpen(false)}>
                {T.close}
              </button>
              <button type="button" className="btn btn-primary" data-testid="export-restart" onClick={() => exporter.reset()}>
                {T.again}
              </button>
            </footer>
          </div>
        ) : null}
      </div>
    </div>
  )
}
