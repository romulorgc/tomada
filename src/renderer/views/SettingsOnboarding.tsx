import { useCallback, useEffect, useState } from 'react'
import type { DiagnosticSnapshot, MediaPermission } from '@shared/diagnostics'
import type { FfmpegTestResult } from '@shared/ipc'
import { ErrorPanel } from '../components/Feedback'
import { CheckIcon, CrossIcon } from '../components/Icons'
import { TranscriptionPrepare } from '../components/TranscriptionPrepare'
import { m5Settings as T } from '../i18n/m5-settings'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'
import { useTranscription } from '../transcription-store'
import { AiSettings } from './SettingsTranscription'

const messageOf = (err: unknown) => err instanceof Error ? err.message : String(err)
export function SettingsOnboarding() {
  const [view, setView] = useState<DiagnosticSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [test, setTest] = useState<FfmpegTestResult | null>(null)
  const engineState = useTranscription((s) => s.view?.state)
  const go = useApp((s) => s.go)
  const notify = useApp((s) => s.notify)
  const load = useCallback(async () => { setError(null); try { setView(await window.tomada.diagnostics.get()) } catch (err) { setError(messageOf(err)) } }, [])
  useEffect(() => { void load() }, [load, engineState])
  const run = async (work: () => Promise<unknown>) => { setBusy(true); setError(null); try { await work(); await load() } catch (err) { setError(messageOf(err)) } finally { setBusy(false) } }
  const finish = async (complete: boolean) => {
    if (!view) return
    await run(async () => { const current = await window.tomada.settings.get(); await window.tomada.settings.update({ onboarding: { ...current.settings.onboarding, dismissedFingerprint: view.fingerprint, ...(complete ? { completedAt: new Date().toISOString() } : {}) } }); go({ name: 'library' }) })
  }
  const permissions = async () => {
    const result: { camera: MediaPermission; microphone: MediaPermission } = { camera: 'unknown', microphone: 'unknown' }
    const reasons: string[] = []
    // Um dispositivo negado não impede conferir o outro; toda trilha é encerrada imediatamente.
    for (const kind of ['camera', 'microphone'] as const) {
      try { const stream = await navigator.mediaDevices.getUserMedia(kind === 'camera' ? { video: true, audio: false } : { audio: true, video: false }); for (const track of stream.getTracks()) track.stop(); result[kind] = 'granted' }
      catch (err) { result[kind] = 'denied'; reasons.push(`${kind === 'camera' ? T.setup.camera : T.setup.microphone}: ${messageOf(err)}`) }
    }
    await window.tomada.diagnostics.permissions(result)
    if (reasons.length) notify({ kind: 'error', text: T.setup.permissionFailed, detail: reasons.join('\n') })
  }
  if (!view && error) return <ErrorPanel title={T.setup.failed} detail={error} onRetry={() => void load()} extra={<button type="button" className="btn" onClick={() => go({ name: 'settings' })}>{T.setup.back}</button>} />
  if (!view) return <div className="mx-auto max-w-[60rem] px-10 pt-9" aria-busy="true"><div className="skeleton h-8 w-60" /></div>
  return <div className="mx-auto w-full max-w-[60rem] px-10 pb-14 pt-9" data-testid="onboarding-view">
    <h1 className="text-[1.75rem] font-[650] tracking-[-0.02em]">{T.setup.title}</h1><p className="mb-7 mt-2 max-w-[65ch] text-sm text-muted">{T.setup.help}</p>
    {error ? <div role="alert" className="mb-4 rounded-thumb border border-danger/50 bg-surface p-4 text-sm"><p className="whitespace-pre-wrap break-words text-danger">{error}</p><button type="button" className="btn mt-2" onClick={() => void load()}>{t.common.retry}</button></div> : null}
    <div className="grid gap-3">{view.items.map((item) => <section key={item.id} className="rounded-thumb border border-line bg-surface p-4" data-testid={`diagnostic-${item.id}`} data-status={item.status}>
      <div className="flex items-start gap-3"><span className={item.status === 'ok' ? 'mt-1 text-ok' : 'mt-1 text-muted'}>{item.status === 'ok' ? <CheckIcon size={18} /> : <CrossIcon size={18} />}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="font-semibold">{T.setup.names[item.id]}</h2><span className="text-xs text-muted">{T.setup.status[item.status]}</span></div><p className="mt-1 break-words text-sm text-muted">{item.detail}</p>
        {item.id === 'transcription' ? <div className="mt-4"><p className="mb-3 text-sm text-muted">{T.setup.prepareSize}</p><TranscriptionPrepare /></div> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {item.id === 'ffmpeg' ? <button type="button" className="btn" disabled={busy} data-testid="diagnostic-choose-ffmpeg" onClick={() => void run(async () => { const path = await window.tomada.settings.pickFfmpeg(); if (path) await window.tomada.settings.update({ ffmpegPath: path }) })}>{T.setup.chooseFfmpeg}</button> : null}
          {item.id === 'gpu' ? <button type="button" className="btn" disabled={busy || !view.ffmpeg.found} data-testid="diagnostic-test-gpu" onClick={() => void run(async () => setTest(await window.tomada.ffmpeg.test()))}>{T.setup.testGpu}</button> : null}
          {item.id === 'permissions' ? <button type="button" className="btn" disabled={busy} data-testid="diagnostic-test-permissions" onClick={() => void run(permissions)}>{T.setup.permissions}</button> : null}
          {item.id === 'projects' ? <button type="button" className="btn" disabled={busy} data-testid="diagnostic-choose-projects" onClick={() => void run(async () => { const path = await window.tomada.settings.pickProjectsDir(); if (path) { await window.tomada.settings.update({ projectsDir: path }); useApp.setState({ status: 'idle', projects: [] }) } })}>{T.setup.chooseProjects}</button> : null}
          {item.id === 'ai' ? <><button type="button" className="btn" disabled={busy} onClick={() => setAiOpen((old) => !old)} data-testid="diagnostic-configure-ai">{T.setup.ai}</button>{!view.ai.available ? <button type="button" className="btn btn-ghost" disabled={busy} data-testid="diagnostic-without-ai" onClick={() => void run(async () => { const settings = await window.tomada.settings.get(); await window.tomada.settings.update({ onboarding: { ...settings.settings.onboarding, withoutAi: true } }) })}>{T.setup.withoutAi}</button> : null}</> : null}
        </div>
        {item.id === 'gpu' && test ? <div className="mt-3 text-sm" data-testid="diagnostic-gpu-result" data-ok={test.ok}><p className={test.ok ? 'text-ok' : 'text-danger'}>{test.ok ? T.setup.testOk : test.error}</p><ul className="mt-2 grid gap-1 text-muted">{test.steps.map((step) => <li key={step.label}>{step.ok ? '✓' : '–'} {step.label}{step.ok ? '' : ` · ${step.detail}`}</li>)}</ul></div> : null}
        {item.id === 'ai' && aiOpen ? <div className="mt-4"><p className="mb-3 text-sm text-muted">{T.setup.aiHelp}</p><AiSettings changed={() => void load()} /></div> : null}
      </div></div>
    </section>)}</div>
    <div className="mt-6 flex flex-wrap items-center gap-2"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void finish(true)} data-testid="onboarding-done">{T.setup.done}</button><button type="button" className="btn" disabled={busy} onClick={() => void finish(false)} data-testid="onboarding-skip">{T.setup.skip}</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void run(load)} data-testid="onboarding-refresh">{busy ? T.setup.checking : T.setup.refresh}</button><button type="button" className="btn btn-ghost" onClick={() => go({ name: 'settings' })}>{T.setup.back}</button></div>
  </div>
}
