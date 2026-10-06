import { useEffect, useRef, useState } from 'react'
import { assessMicLevel, microphoneBaseName, volumePercent, type MicVolumeInfo } from '@shared/mic-level'
import { MicPeakMeter } from './mic-peak'
import { adjustMicVolume, type AdjustOutcome, type AdjustProgress } from './mic-adjust'
import { t } from '../i18n/pt-BR'

/** O pico "da fala" é o maior dos últimos 20 s: quem parou de falar um instante não faz o aviso sumir. */
const WINDOW_MS = 20_000
/** Releitura do volume do Windows (a pessoa pode mexer nele pelo próprio Windows enquanto a tela está aberta). */
const POLL_MS = 5_000

const dbText = (value: number | null): string => value === null ? '--' : value.toFixed(0)

/**
 * Antes de gravar: mostra QUAL microfone está em uso e, se a voz vai entrar baixa demais (volume de entrada do Windows no mínimo ou fala
 * abaixo de ~-24 dBFS de pico), avisa bem alto e oferece "Ajustar sozinho". O volume de entrada decide o ganho da voz ANTES do app: com
 * 0% a voz sai uns 40 dB baixa, a exportação sobe tudo e o chiado sobe junto.
 */
export function MicLevelCheck({ stream, label, idle }: { stream: MediaStream | null; label: string; idle: boolean }) {
  const [windows, setWindows] = useState<MicVolumeInfo | null>(null)
  const [, setTick] = useState(0)
  const [progress, setProgress] = useState<AdjustProgress | null>(null)
  const [running, setRunning] = useState(false)
  const [outcome, setOutcome] = useState<AdjustOutcome | null>(null)
  const meter = useRef<MicPeakMeter | null>(null)
  const cancelled = useRef(false)
  const busy = useRef(false)

  const hasAudio = Boolean(stream?.getAudioTracks().length)
  useEffect(() => {
    if (!stream || !hasAudio) { meter.current = null; return }
    const m = new MicPeakMeter(stream)
    meter.current = m
    setOutcome(null)
    return () => { m.close(); if (meter.current === m) meter.current = null }
  }, [stream, hasAudio])

  useEffect(() => {
    if (!idle || !label || !hasAudio) { setWindows(null); return }
    let alive = true
    const read = (): void => {
      void window.tomada.record.micVolume(label)
        .then((info) => { if (alive) setWindows(info) })
        .catch((err: unknown) => { if (alive) setWindows(null); window.tomada.log({ level: 'warn', message: 'Não consegui ler o volume de entrada do microfone', detail: String(err) }) })
    }
    read()
    // Durante o ajuste quem mexe no volume é o ajuste: sem leituras no meio.
    const timer = window.setInterval(() => { if (!busy.current) read() }, POLL_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [idle, label, hasAudio])

  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 250)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => () => { cancelled.current = true }, [])

  if (!idle || !label || !hasAudio) return null

  const m = meter.current
  const peak = m?.maxSince(WINDOW_MS) ?? null
  const assessment = assessMicLevel({ peakDbfs: peak, observedMs: m?.observedMs(WINDOW_MS) ?? 0, windows })
  const name = windows?.name ?? microphoneBaseName(label)
  const warning = assessment.status === 'too-low' || assessment.status === 'muted'

  const start = (): void => {
    const current = meter.current
    if (!current || busy.current) return
    busy.current = true
    cancelled.current = false
    setRunning(true)
    setOutcome(null)
    void adjustMicVolume({
      label,
      readVolume: (l) => window.tomada.record.micVolume(l),
      setVolumeDb: (l, db) => window.tomada.record.micVolumeSet(l, db),
      waitForSpeech: (ms) => current.waitForSpeech(ms, () => cancelled.current),
      peakSince: (ms) => current.maxSince(ms),
      resetMeter: () => current.reset(),
      sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
      isCancelled: () => cancelled.current,
      onProgress: setProgress
    }).then((result) => {
      setOutcome(result)
      if (result.info) setWindows(result.info)
    }).catch((err: unknown) => {
      window.tomada.log({ level: 'error', message: 'Falha ao ajustar o volume de entrada do microfone', detail: String(err) })
      setOutcome({ kind: 'failed', reason: 'rejected', peakDbfs: null, info: null })
    }).finally(() => { busy.current = false; setRunning(false); setProgress(null) })
  }

  const T = t.micLevel
  const showPanel = warning || running || outcome !== null
  return <section className="mb-4" aria-label={T.using} data-testid="mic-level-check" data-status={assessment.status}>
    <p className="text-[0.9375rem] text-ink">
      <span className="text-muted">{T.using}: </span>
      <strong className="font-semibold" data-testid="mic-name">{name}</strong>
      {windows ? <span className="ml-3 text-[0.8125rem] text-muted tnum" data-testid="mic-windows-volume">{T.windowsVolume(volumePercent(windows.scalar))}</span> : null}
    </p>
    {showPanel ? <div role="alert" className={['mt-2 grid gap-2 rounded-thumb border-2 px-4 py-3', outcome?.kind === 'done' && !warning ? 'border-ok' : 'border-danger'].join(' ')} data-testid="mic-level-warning">
      {warning && !running ? <>
        <p className="text-base font-semibold text-danger" data-testid="mic-level-title">{assessment.status === 'muted' ? T.mutedTitle : T.tooLowTitle}</p>
        <ul className="grid gap-1 text-[0.8125rem] text-muted">
          {assessment.status === 'muted' ? <li>{T.mutedHelp}</li> : <>
            {assessment.reasons.includes('windows-minimum') ? <li>{T.reasonWindowsMinimum}</li> : null}
            {assessment.reasons.includes('speech-low') ? <li>{T.reasonSpeech(dbText(peak))}</li> : null}
            <li>{T.why}</li>
            {!windows ? <li>{T.cannotRead}</li> : !assessment.canAdjust ? <li>{T.cannotAdjustAtMax}</li> : null}
          </>}
        </ul>
        {assessment.canAdjust ? <div><button type="button" className="btn btn-rec" onClick={start} data-testid="mic-adjust">{T.adjust}</button></div> : null}
      </> : null}
      {running ? <div className="grid gap-2" data-testid="mic-adjust-status" data-phase={progress?.phase ?? 'listening'}>
        <p className="text-base font-semibold text-ink">{T.running(progress?.step ?? 1, progress?.total ?? 6)}</p>
        {progress?.peakDbfs !== null && progress?.peakDbfs !== undefined ? <p className="text-[0.8125rem] text-muted tnum">{T.runningPeak(dbText(progress.peakDbfs))}</p> : null}
        <div><button type="button" className="btn btn-quiet" onClick={() => { cancelled.current = true }} data-testid="mic-adjust-cancel">{T.cancel}</button></div>
      </div> : null}
      {!running && outcome ? <p className={outcome.kind === 'done' ? 'text-[0.875rem] font-medium text-ok' : 'text-[0.875rem] text-ink'} data-testid="mic-adjust-result" data-outcome={outcome.kind === 'done' ? 'done' : outcome.reason}>
        {outcome.kind === 'done' ? T.done(volumePercent(outcome.info.scalar), dbText(outcome.peakDbfs)) : T.failed[outcome.reason]}
      </p> : null}
    </div> : null}
  </section>
}
