import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, FfmpegStatus, FfmpegTestResult, SettingsView } from '@shared/ipc'
import { ErrorPanel } from '../components/Feedback'
import { CheckIcon, CrossIcon, FolderIcon } from '../components/Icons'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function Section({ title, help, children, testId }: { title: string; help?: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="grid gap-x-10 gap-y-3 border-t border-line py-7 first:border-t-0 first:pt-0 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]" data-testid={testId}>
      <div>
        <h2 className="text-[1.0625rem] font-[650] tracking-[-0.01em]">{title}</h2>
        {help ? <p className="mt-1 max-w-[34ch] text-[0.875rem] text-muted">{help}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

function Row({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="grid grid-cols-[9.5rem_minmax(0,1fr)] gap-3 py-1.5 text-[0.9375rem]">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-all" data-testid={testId}>
        {children}
      </dd>
    </div>
  )
}

export function Settings() {
  const notify = useApp((s) => s.notify)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [view, setView] = useState<SettingsView | null>(null)
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<FfmpegTestResult | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const [i, v, f] = await Promise.all([window.tomada.app.info(), window.tomada.settings.get(), window.tomada.ffmpeg.status()])
      setInfo(i)
      setView(v)
      setFfmpeg(f)
    } catch (err) {
      window.tomada.log({ level: 'error', message: 'Falha ao carregar os Ajustes', detail: messageOf(err) })
      setLoadError(messageOf(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const chooseProjectsDir = async () => {
    try {
      const dir = await window.tomada.settings.pickProjectsDir()
      if (!dir) return
      setView(await window.tomada.settings.update({ projectsDir: dir }))
      // A biblioteca vai ler da pasta nova na próxima vez que abrir.
      useApp.setState({ status: 'idle', projects: [] })
      notify({ kind: 'info', text: t.settings.projects.saved })
    } catch (err) {
      notify({ kind: 'error', text: t.settings.projects.saveFailed, detail: messageOf(err) })
    }
  }

  const changeFfmpeg = async (path: string | null) => {
    try {
      if (path === null) return
      setView(await window.tomada.settings.update({ ffmpegPath: path }))
      setFfmpeg(await window.tomada.ffmpeg.status())
      setTest(null)
      notify({ kind: 'info', text: t.settings.ffmpeg.saved })
    } catch (err) {
      notify({ kind: 'error', text: t.settings.ffmpeg.saveFailed, detail: messageOf(err) })
    }
  }

  const chooseFfmpeg = async () => {
    try {
      await changeFfmpeg(await window.tomada.settings.pickFfmpeg())
    } catch (err) {
      notify({ kind: 'error', text: t.settings.ffmpeg.saveFailed, detail: messageOf(err) })
    }
  }

  const runTest = async () => {
    setTesting(true)
    setTest(null)
    try {
      setTest(await window.tomada.ffmpeg.test())
    } catch (err) {
      notify({ kind: 'error', text: t.settings.ffmpeg.testFailed, detail: messageOf(err) })
    } finally {
      setTesting(false)
    }
  }

  if (loadError) return <ErrorPanel title={t.settings.title} detail={loadError} onRetry={() => void load()} />
  if (!view || !ffmpeg || !info) {
    return (
      <div className="px-10 pt-9" aria-busy="true" aria-label={t.common.loading}>
        <div className="skeleton h-8 w-40" />
      </div>
    )
  }

  const fromEnv = view.effective.projectsDirSource === 'env'
  const usable = ffmpeg.found && !ffmpeg.error

  return (
    <div className="mx-auto w-full max-w-[64rem] px-10 pb-14 pt-9" data-testid="settings-view">
      <h1 className="mb-8 text-[1.75rem] font-[650] leading-none tracking-[-0.02em]">{t.settings.title}</h1>

      <Section title={t.settings.projects.title} help={t.settings.projects.help} testId="settings-projects">
        <div className="flex items-start gap-3 rounded-thumb border border-line bg-surface px-4 py-3">
          <span className="mt-0.5 text-muted">
            <FolderIcon size={18} />
          </span>
          <p className="min-w-0 flex-1 break-all text-[0.9375rem]" data-testid="projects-dir">
            {view.effective.projectsDir}
          </p>
          <button type="button" className="btn shrink-0" onClick={() => void chooseProjectsDir()} data-testid="choose-projects-dir">
            {t.settings.projects.choose}
          </button>
        </div>
        {fromEnv ? <p className="mt-2 text-[0.8125rem] text-muted">{t.settings.projects.fromEnv}</p> : null}
      </Section>

      <Section title={t.settings.ffmpeg.title} help={t.settings.ffmpeg.help} testId="settings-ffmpeg">
        <div className="rounded-thumb border border-line bg-surface px-4 py-3">
          <div className="mb-2 flex items-center gap-2 text-[0.9375rem] font-semibold" data-testid="ffmpeg-status">
            {usable ? (
              <>
                <span className="text-ok">
                  <CheckIcon size={16} />
                </span>
                {t.settings.ffmpeg.found}
              </>
            ) : (
              <>
                <span className="text-danger">
                  <CrossIcon size={16} />
                </span>
                {ffmpeg.found ? t.settings.ffmpeg.brokenTitle : t.settings.ffmpeg.missing}
              </>
            )}
          </div>

          {ffmpeg.error ? (
            <p role="alert" className="mb-2 whitespace-pre-wrap break-words text-[0.875rem] text-danger" data-testid="ffmpeg-error">
              {ffmpeg.error}
            </p>
          ) : null}

          {ffmpeg.found ? (
            <dl>
              <Row label={t.settings.ffmpeg.version} testId="ffmpeg-version">
                {ffmpeg.version ?? '—'}
              </Row>
              <Row label={t.settings.ffmpeg.probeVersion} testId="ffprobe-version">
                {ffmpeg.ffprobeVersion ?? '—'}
              </Row>
              <Row label={t.settings.ffmpeg.path} testId="ffmpeg-path">
                {ffmpeg.ffmpegPath}
              </Row>
              <Row label={t.settings.ffmpeg.origin}>{ffmpeg.source ? t.settings.ffmpeg.origins[ffmpeg.source] : '—'}</Row>
            </dl>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn" onClick={() => void runTest()} disabled={testing || !ffmpeg.found} data-testid="ffmpeg-test">
              {testing ? <span className="spinner" aria-hidden="true" /> : null}
              {testing ? t.settings.ffmpeg.testing : t.settings.ffmpeg.test}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void chooseFfmpeg()}>
              {t.settings.ffmpeg.choose}
            </button>
            {view.settings.ffmpegPath ? (
              <button type="button" className="btn btn-ghost" onClick={() => void changeFfmpeg('')} data-testid="ffmpeg-use-system">
                {t.settings.ffmpeg.useSystem}
              </button>
            ) : null}
          </div>
        </div>

        {test ? (
          <div className="mt-3 rounded-thumb border border-line bg-surface px-4 py-3" data-testid="ffmpeg-test-result" data-ok={test.ok}>
            <p className="mb-2 flex items-center gap-2 text-[0.9375rem] font-semibold">
              <span className={test.ok ? 'text-ok' : 'text-danger'}>{test.ok ? <CheckIcon size={16} /> : <CrossIcon size={16} />}</span>
              {test.ok ? t.settings.ffmpeg.testOk : t.settings.ffmpeg.testFailed}
            </p>
            <ul className="grid gap-1.5">
              {test.steps.map((s) => (
                <li key={s.label} className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 text-[0.875rem]">
                  <span className={s.ok ? 'text-ok' : 'text-muted'}>{s.ok ? <CheckIcon size={14} /> : <CrossIcon size={14} />}</span>
                  <span>
                    {s.label}
                    {s.ok ? null : <span className="block whitespace-pre-wrap break-words text-muted">{s.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {!test.encoders.h264Nvenc ? <p className="mt-3 text-[0.8125rem] text-muted">{t.settings.ffmpeg.nvencNote}</p> : null}
          </div>
        ) : null}
      </Section>

      <Section title={t.settings.about.title} testId="settings-about">
        <dl className="rounded-thumb border border-line bg-surface px-4 py-2">
          <Row label={t.settings.about.version} testId="app-version">
            {info.version}
          </Row>
          <Row label={t.settings.about.electron}>{info.electron}</Row>
          <Row label={t.settings.about.data}>{info.userDataDir}</Row>
          <Row label={t.settings.about.logs}>{info.logsDir}</Row>
        </dl>
      </Section>
    </div>
  )
}
