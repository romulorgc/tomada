import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SourceInfo } from '@shared/ipc'
import { videoScriptSchema, type VideoScript } from '@shared/script'
import {
  DEFAULT_RECORD_PREFS,
  effectiveMode,
  validateRecordRequest,
  type RecordMode,
  type RecordPrefs,
  type RecordRequest
} from '@shared/recording'
import { ErrorPanel } from '../components/Feedback'
import { CameraIcon, CheckIcon, RecordIcon, ScreenIcon } from '../components/Icons'
import { t } from '../i18n/pt-BR'
import { useDeviceLists, useDevicePreview, useMicLevel } from '../recording/devices'
import { useRecorder } from '../recording/controller'
import { useApp } from '../store'
import { PreflightBanner } from '../recording/PreflightBanner'
import { ScriptPanel } from '../recording/ScriptPanel'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  testPrefix,
  disabled
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  testPrefix: string
  disabled?: boolean
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          data-testid={`${testPrefix}-${o.value}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Field({ title, help, children }: { title: string; help?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <h2 className="text-[0.8125rem] font-semibold uppercase tracking-[0.06em] text-muted">{title}</h2>
      {children}
      {help ? <p className="text-[0.8125rem] text-faint">{help}</p> : null}
    </section>
  )
}

function Switch({ checked, onChange, label, testId, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; testId: string; disabled?: boolean }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 text-[0.9375rem]">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className="switch"
        onClick={() => onChange(!checked)}
        data-testid={testId}
      >
        <span />
      </button>
      <span aria-hidden="true">{label}</span>
    </label>
  )
}

function MicMeter({ stream }: { stream: MediaStream | null }) {
  const level = useMicLevel(stream)
  return (
    <div className="meter" role="meter" aria-label={t.record.mic.level} aria-valuemin={0} aria-valuemax={1} aria-valuenow={Number(level.toFixed(2))} data-testid="mic-meter" data-level={level.toFixed(3)}>
      <i style={{ width: `${Math.round(level * 100)}%` }} />
    </div>
  )
}

/**
 * Moldura-guia sobre a prévia: onde ficam a cabeça, o tronco e as mãos para o recorte do layout Apresentador (a pessoa aparece do peito
 * para cima, com as mãos, ancorada na borda de baixo). Só desenha na prévia; nada disto entra na gravação.
 */
function FramingGuide() {
  return (
    <div className="framing-guide" data-testid="framing-guide" role="img" aria-label={t.record.camera.guideLabel}>
      <svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
        <ellipse cx="80" cy="30" rx="12" ry="15" />
        <path d="M44 90 C44 66 58 53 80 53 C102 53 116 66 116 90" />
        <ellipse cx="40" cy="78" rx="8" ry="6" strokeDasharray="3 3" />
        <ellipse cx="120" cy="78" rx="8" ry="6" strokeDasharray="3 3" />
      </svg>
      <p>{t.record.camera.guideTip}</p>
    </div>
  )
}

function CameraPreview({ stream, loading, guide = false }: { stream: MediaStream | null; loading: boolean; guide?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    v.srcObject = stream
    if (stream) void v.play().catch(() => undefined)
  }, [stream])
  const hasVideo = (stream?.getVideoTracks().length ?? 0) > 0
  return (
    <div className="video-frame aspect-video" data-testid="camera-preview" data-live={hasVideo}>
      <video ref={ref} muted playsInline aria-label={t.record.camera.previewLabel} className={hasVideo ? '' : 'invisible'} />
      {!hasVideo ? (
        <p className="absolute inset-0 grid place-items-center p-3 text-center text-[0.875rem] text-muted">
          {loading ? t.record.camera.loading : t.record.camera.off}
        </p>
      ) : null}
      {hasVideo && guide ? <FramingGuide /> : null}
    </div>
  )
}

function SourceCard({ source, selected, onSelect }: { source: SourceInfo; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="source-card" aria-pressed={selected} onClick={onSelect} data-testid="source-card" data-source-id={source.id} data-kind={source.kind}>
      <span className="thumb">
        {source.thumbnail ? <img src={source.thumbnail} alt="" /> : <span className="viewfinder" />}
        {selected ? (
          <span className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-rec text-rec-ink">
            <CheckIcon size={14} />
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 items-baseline gap-2 text-left">
        <span className="truncate text-[0.9375rem] font-medium" title={source.name}>
          {source.name}
        </span>
        {source.primary ? <span className="shrink-0 text-[0.75rem] text-muted">{t.record.source.primary}</span> : null}
        {source.sizePx ? <span className="ml-auto shrink-0 text-[0.75rem] text-faint tnum">{t.record.source.size(source.sizePx.w, source.sizePx.h)}</span> : null}
      </span>
    </button>
  )
}

export function Record() {
  const phase = useRecorder((s) => s.phase)
  const recorderError = useRecorder((s) => s.error)
  const startRecording = useRecorder((s) => s.start)
  const clearError = useRecorder((s) => s.clearError)

  const [prefs, setPrefsState] = useState<RecordPrefs | null>(null)
  const [sources, setSources] = useState<SourceInfo[] | null>(null)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [tab, setTab] = useState<'screens' | 'windows'>('screens')
  const [script, setScript] = useState<VideoScript | null>(null)
  const { lists, error: devicesError } = useDeviceLists()

  const idle = phase === 'idle'

  // --- Preferências (lembradas entre sessões)
  useEffect(() => {
    let alive = true
    window.tomada.record
      .getPrefs()
      .then((p) => alive && setPrefsState(p))
      .catch((err: unknown) => {
        window.tomada.log({ level: 'error', message: 'Falha ao ler as escolhas da tela Gravar', detail: messageOf(err) })
        if (alive) {
          useApp.getState().notify({ kind: 'error', text: t.record.deviceError, detail: messageOf(err) })
          setPrefsState({ ...DEFAULT_RECORD_PREFS })
        }
      })
    return () => {
      alive = false
    }
  }, [])

  const setPrefs = useCallback((patch: Partial<RecordPrefs>) => {
    setPrefsState((p) => (p ? { ...p, ...patch } : p))
    window.tomada.record.setPrefs(patch).catch((err: unknown) => {
      window.tomada.log({ level: 'error', message: 'Falha ao guardar as escolhas da tela Gravar', detail: messageOf(err) })
    })
  }, [])

  // --- Primeira abertura: câmera e microfone padrão. Dispositivo que sumiu: volta para "sem".
  useEffect(() => {
    if (!prefs || !lists) return
    const patch: Partial<RecordPrefs> = {}
    if (!prefs.setupDone) {
      patch.setupDone = true
      patch.cameraId = lists.cameras[0]?.deviceId ?? null
      patch.micId = lists.mics.find((m) => m.deviceId === 'default')?.deviceId ?? lists.mics[0]?.deviceId ?? null
    } else {
      if (prefs.cameraId && !lists.cameras.some((c) => c.deviceId === prefs.cameraId)) patch.cameraId = null
      if (prefs.micId && !lists.mics.some((m) => m.deviceId === prefs.micId)) patch.micId = null
    }
    if (Object.keys(patch).length > 0) setPrefs(patch)
  }, [prefs, lists, setPrefs])

  // --- Telas e janelas (miniaturas atualizadas a cada 2,5 s enquanto a tela está à vista)
  const loadSources = useCallback(async () => {
    try {
      setSources(await window.tomada.record.sources())
      setSourcesError(null)
    } catch (err) {
      window.tomada.log({ level: 'error', message: 'Falha ao listar telas e janelas', detail: messageOf(err) })
      setSourcesError(messageOf(err))
    }
  }, [])
  useEffect(() => {
    if (!idle) return
    void loadSources()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadSources()
    }, 2500)
    return () => window.clearInterval(timer)
  }, [idle, loadSources])

  // A última fonte pode não existir mais: cai na tela principal.
  const selectedSource = useMemo(() => sources?.find((s) => s.id === prefs?.sourceId) ?? null, [sources, prefs?.sourceId])
  useEffect(() => {
    if (!prefs || !sources || sources.length === 0) return
    if (prefs.mode === 'camera') return
    if (!selectedSource) {
      const fallback = sources.find((s) => s.kind === 'screen' && s.primary) ?? sources.find((s) => s.kind === 'screen') ?? sources[0]!
      setPrefs({ sourceId: fallback.id, sourceName: fallback.name })
    }
  }, [prefs, sources, selectedSource, setPrefs])
  useEffect(() => {
    if (selectedSource) setTab(selectedSource.kind === 'window' ? 'windows' : 'screens')
    // só quando a seleção troca; não briga com o clique manual nas abas
  }, [selectedSource?.id])

  // --- Prévia (câmera + microfone) só enquanto está ocioso
  const mode = prefs ? effectiveMode(prefs) : null
  const wantsCamera = prefs ? prefs.mode !== 'screen' : false
  const preview = useDevicePreview({
    cameraId: prefs && wantsCamera ? prefs.cameraId : null,
    micId: prefs?.micId ?? null,
    noiseSuppression: prefs?.noiseSuppression ?? true,
    echoCancellation: prefs?.echoCancellation ?? false,
    enabled: idle && Boolean(prefs) && Boolean(lists)
  })

  const request: RecordRequest | null = useMemo(() => {
    if (!prefs || mode === null) return null
    return {
      mode,
      sourceId: mode === 'camera' ? null : prefs.sourceId,
      fps: prefs.fps,
      cameraId: mode === 'screen' ? null : prefs.cameraId,
      micId: prefs.micId,
      systemAudio: mode === 'camera' ? false : prefs.systemAudio,
      showBubble: prefs.showBubble,
      hideCursor: prefs.hideCursor,
      ...(mode === 'screen-camera' ? { cameraStyle: prefs.cameraStyle } : {}),
      retakeShortcut: prefs.retakeShortcut,
      ...(script ? { script } : {})
    }
  }, [prefs, mode, script])

  const problem = prefs ? (request ? validateRecordRequest(request) : 'no-camera') : 'no-source'

  const begin = useCallback(() => {
    if (!prefs || !request || problem || !idle || (script && !videoScriptSchema.safeParse(script).success)) return
    clearError()
    void startRecording(request, { noiseSuppression: prefs.noiseSuppression, echoCancellation: prefs.echoCancellation })
  }, [prefs, request, problem, idle, script, clearError, startRecording])

  // Ctrl+Shift+R também começa (dentro do app; o atalho global só existe durante a gravação).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyR') {
        e.preventDefault()
        begin()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [begin])

  if (!prefs || !lists) {
    return (
      <div className="px-10 pt-9" aria-busy="true" aria-label={t.common.loading}>
        <div className="skeleton h-8 w-40" />
      </div>
    )
  }

  const screens = (sources ?? []).filter((s) => s.kind === 'screen')
  const windows = (sources ?? []).filter((s) => s.kind === 'window')
  const shown = tab === 'screens' ? screens : windows
  const showSource = prefs.mode !== 'camera'
  const showCamera = prefs.mode !== 'screen'
  const missingSaved = sources !== null && prefs.sourceId !== null && !selectedSource && sources.length > 0

  const modeOptions: { value: RecordMode; label: string }[] = [
    { value: 'screen-camera', label: t.record.modes['screen-camera'] },
    { value: 'screen', label: t.record.modes.screen },
    { value: 'camera', label: t.record.modes.camera }
  ]

  const busyText =
    phase === 'recording' || phase === 'paused' || phase === 'stopping'
      ? t.record.busy.recording
      : phase === 'processing'
        ? t.record.busy.processing
        : phase === 'countdown'
          ? t.record.countdown
          : null

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[120rem] flex-col px-10 pb-12 pt-9" data-testid="record-view" data-phase={phase}>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[1.75rem] font-[650] leading-none tracking-[-0.02em]">{t.record.title}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented label={t.record.modes.label} value={prefs.mode} options={modeOptions} onChange={(mode) => setPrefs({ mode })} testPrefix="mode" disabled={!idle} />
          <button type="button" className="btn btn-rec btn-big" onClick={begin} disabled={!idle || problem !== null || Boolean(script && !videoScriptSchema.safeParse(script).success)} data-testid="record-start">
            {phase === 'preparing' ? <span className="spinner" aria-hidden="true" /> : <RecordIcon size={20} />}
            {phase === 'preparing' ? t.record.starting : t.record.start}
            {idle ? <kbd className="ml-1 text-[0.75rem] font-medium opacity-70">{t.record.startShortcut}</kbd> : null}
          </button>
        </div>
      </header>
      <div className="mb-6 min-h-[1.25rem] text-right text-[0.875rem]" aria-live="polite">
        {problem && idle ? (
          <p className="text-muted" data-testid="record-problem">
            {t.record.cannot[problem]}
          </p>
        ) : null}
        {busyText ? (
          <p className="text-muted" role="status" data-testid="record-busy">
            {busyText}
          </p>
        ) : null}
        {recorderError ? (
          <p role="alert" className="whitespace-pre-wrap break-words text-danger" data-testid="record-error">
            {recorderError}
          </p>
        ) : null}
      </div>

      <PreflightBanner stream={preview.stream} hasMic={Boolean(prefs.micId)} hasCamera={showCamera && Boolean(prefs.cameraId)} idle={idle} onRecord={begin} />
      <div className="grid items-start gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,24rem)]">
        <div className="min-w-0">
          {showSource ? (
            <section aria-label={t.record.source.title} data-testid="source-picker">
              <div className="mb-4 flex items-center justify-between gap-4">
                <h2 className="text-[0.8125rem] font-semibold uppercase tracking-[0.06em] text-muted">{t.record.source.title}</h2>
                <div className="seg" role="tablist" aria-label={t.record.source.title}>
                  <button type="button" role="tab" aria-selected={tab === 'screens'} aria-pressed={tab === 'screens'} onClick={() => setTab('screens')} data-testid="source-tab-screens" disabled={!idle}>
                    <ScreenIcon size={15} /> {t.record.source.screens} <span className="text-faint tnum">{screens.length}</span>
                  </button>
                  <button type="button" role="tab" aria-selected={tab === 'windows'} aria-pressed={tab === 'windows'} onClick={() => setTab('windows')} data-testid="source-tab-windows" disabled={!idle}>
                    {t.record.source.windows} <span className="text-faint tnum">{windows.length}</span>
                  </button>
                </div>
              </div>
              {sourcesError ? (
                <ErrorPanel title={t.record.source.loadFailed} detail={sourcesError} onRetry={() => void loadSources()} />
              ) : sources === null ? (
                <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]" aria-busy="true" aria-label={t.common.loading}>
                  {[0, 1].map((i) => (
                    <div key={i} className="skeleton aspect-video" />
                  ))}
                </div>
              ) : shown.length === 0 ? (
                <p className="rounded-dialog border border-line bg-surface p-5 text-muted">{tab === 'screens' ? t.record.source.noScreens : t.record.source.noWindows}</p>
              ) : (
                <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]" data-testid="source-grid">
                  {shown.map((s) => (
                    <SourceCard key={s.id} source={s} selected={s.id === prefs.sourceId} onSelect={() => idle && setPrefs({ sourceId: s.id, sourceName: s.name })} />
                  ))}
                </div>
              )}
              {missingSaved ? <p className="mt-3 text-[0.875rem] text-muted">{t.record.source.missing}</p> : null}
            </section>
          ) : (
            <section className="rounded-dialog border border-line bg-surface p-6" data-testid="camera-only-hint">
              <div className="mb-3 flex items-center gap-2 text-muted">
                <CameraIcon size={18} /> <span className="text-[0.9375rem] font-medium">{t.record.modes.camera}</span>
              </div>
              <CameraPreview stream={preview.stream} loading={preview.loading} />
            </section>
          )}
          <ScriptPanel script={script} onChange={setScript} prefs={prefs} setPrefs={setPrefs} disabled={!idle} />
        </div>

        <aside className="grid min-w-0 gap-6 lg:sticky lg:top-6" aria-label={t.record.title}>
          {showCamera ? (
            <Field title={t.record.camera.title}>
              <select
                className="field"
                value={prefs.cameraId ?? ''}
                disabled={!idle}
                onChange={(e) => setPrefs({ cameraId: e.target.value || null })}
                aria-label={t.record.camera.title}
                data-testid="camera-select"
              >
                <option value="">{t.record.camera.none}</option>
                {lists.cameras.map((c, i) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label || `${t.record.camera.title} ${i + 1}`}
                  </option>
                ))}
              </select>
              {prefs.mode === 'screen-camera' ? <CameraPreview stream={preview.stream} loading={preview.loading} guide={prefs.framingGuide && prefs.cameraStyle === 'presenter'} /> : null}
              {lists.cameras.length === 0 ? <p className="text-[0.8125rem] text-muted">{t.record.camera.noDevices}</p> : null}
            </Field>
          ) : null}

          {mode === 'screen-camera' ? (
            <Field title={t.record.cameraStyle.title} help={t.record.cameraStyle.help[prefs.cameraStyle]}>
              <Segmented
                label={t.record.cameraStyle.title}
                value={prefs.cameraStyle}
                options={[
                  { value: 'side-by-side' as const, label: t.record.cameraStyle['side-by-side'] },
                  { value: 'presenter' as const, label: t.record.cameraStyle.presenter }
                ]}
                onChange={(cameraStyle) => setPrefs({ cameraStyle })}
                testPrefix="camera-style"
                disabled={!idle}
              />
            </Field>
          ) : null}

          <Field title={t.record.mic.title}>
            <select
              className="field"
              value={prefs.micId ?? ''}
              disabled={!idle}
              onChange={(e) => setPrefs({ micId: e.target.value || null })}
              aria-label={t.record.mic.title}
              data-testid="mic-select"
            >
              <option value="">{t.record.mic.none}</option>
              {lists.mics.map((m, i) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label || `${t.record.mic.title} ${i + 1}`}
                </option>
              ))}
            </select>
            <MicMeter stream={preview.stream} />
            {lists.mics.length === 0 ? <p className="text-[0.8125rem] text-muted">{t.record.mic.noDevices}</p> : null}
            {preview.error || devicesError ? (
              <p role="alert" className="text-[0.8125rem] text-danger" data-testid="device-error">
                {preview.error ?? devicesError}
              </p>
            ) : null}
          </Field>

          {showSource ? (
            <Field title={t.record.system.title} help={t.record.system.help}>
              <Switch checked={prefs.systemAudio} onChange={(v) => setPrefs({ systemAudio: v })} label={prefs.systemAudio ? t.record.system.on : t.record.system.off} testId="system-audio-toggle" disabled={!idle} />
            </Field>
          ) : null}

          {showSource ? (
            <Field title={t.record.quality.title} help={t.record.quality.help}>
              <Segmented
                label={t.record.quality.title}
                value={prefs.fps}
                options={[
                  { value: 30 as const, label: t.record.quality.fps30 },
                  { value: 60 as const, label: t.record.quality.fps60 }
                ]}
                onChange={(fps) => setPrefs({ fps })}
                testPrefix="fps"
                disabled={!idle}
              />
            </Field>
          ) : null}

          <details className="rounded-thumb border border-line bg-surface px-4 py-3">
            <summary className="cursor-pointer text-[0.9375rem] font-medium">{t.record.advanced.title}</summary>
            <div className="mt-3 grid gap-3">
              <Switch checked={prefs.noiseSuppression} onChange={(v) => setPrefs({ noiseSuppression: v })} label={t.record.advanced.noiseSuppression} testId="noise-toggle" disabled={!idle} />
              <Switch checked={prefs.echoCancellation} onChange={(v) => setPrefs({ echoCancellation: v })} label={t.record.advanced.echoCancellation} testId="echo-toggle" disabled={!idle} />
              {mode === 'screen-camera' && prefs.cameraStyle === 'presenter' ? <Switch checked={prefs.framingGuide} onChange={(v) => setPrefs({ framingGuide: v })} label={t.record.advanced.framingGuide} testId="guide-toggle" disabled={!idle} /> : null}
              {prefs.mode === 'screen-camera' ? <Switch checked={prefs.showBubble} onChange={(v) => setPrefs({ showBubble: v })} label={t.record.advanced.bubble} testId="bubble-toggle" disabled={!idle} /> : null}
              <label className="grid gap-1 text-[0.8125rem] text-muted">{t.preparation.retakeShortcut}<select className="field" value={prefs.retakeShortcut} disabled={!idle} onChange={(e) => setPrefs({ retakeShortcut: e.target.value })} data-testid="retake-shortcut">{['Ctrl+Alt+Z', 'Ctrl+Alt+X', 'Ctrl+Alt+E', 'Ctrl+Shift+E', 'Alt+Shift+E'].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
            </div>
          </details>

          <p className="text-[0.8125rem] text-faint">{t.record.privacyHint}</p>
        </aside>
      </div>
    </div>
  )
}
