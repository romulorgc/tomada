/**
 * Barra flutuante da gravação: ponto vermelho + cronômetro, pausar/continuar, parar,
 * recomeçar, descartar e mini medidor do microfone. Janela sem moldura, sempre no topo,
 * FORA da captura (`setContentProtection`), arrastável. Recomeçar e descartar pedem uma
 * segunda confirmação na própria barra (ela não tem foco, então nada de diálogo).
 */
import { useEffect, useRef, useState } from 'react'
import { formatDuration } from '@shared/format'
import type { BarAction, BarState } from '@shared/ipc'
import { MicIcon, PauseIcon, PlayIcon, RestartIcon, StopIcon, TrashIcon } from '../components/Icons'
import { t } from '../i18n/pt-BR'

type Confirm = 'restart' | 'discard' | null

export function Bar() {
  const [state, setState] = useState<BarState | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [level, setLevel] = useState(0)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const confirmTimer = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    void window.tomada.bar.state().then((s) => alive && s && setState(s))
    const offState = window.tomada.on('bar:state', (s) => setState(s))
    const offLevel = window.tomada.on('bar:level', (p) => setLevel(p.level))
    const timer = window.setInterval(() => setNow(Date.now()), 200)
    return () => {
      alive = false
      offState()
      offLevel()
      window.clearInterval(timer)
    }
  }, [])

  const ask = (what: Exclude<Confirm, null>) => {
    setConfirm(what)
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current)
    confirmTimer.current = window.setTimeout(() => setConfirm(null), 4000)
  }
  const send = (action: BarAction) => {
    setConfirm(null)
    void window.tomada.bar.action(action)
  }

  if (!state) return <div className="bar" aria-busy="true" />

  const running = state.status === 'recording'
  const elapsed = state.elapsedMs + (running ? Math.max(0, now - state.asOf) : 0)
  const stopping = state.status === 'stopping'

  return (
    <div className="bar" role="toolbar" aria-label={t.bar.label} data-testid="bar" data-status={state.status} data-confirm={confirm ?? ''}>
      {confirm ? (
        <div className="flex flex-1 items-center gap-3 px-2" data-testid="bar-confirm">
          <span className="text-[0.9375rem] font-medium">{confirm === 'restart' ? t.bar.confirmRestart : t.bar.confirmDiscard}</span>
          <button type="button" className="bar-btn bar-btn-danger" onClick={() => send(confirm)} data-testid="bar-confirm-yes">
            {t.bar.yes}
          </button>
          <button type="button" className="bar-btn" onClick={() => setConfirm(null)} data-testid="bar-confirm-no">
            {t.bar.no}
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2.5 pl-2 pr-1" aria-live="off">
            <span className="rec-dot" data-live={running} style={running ? undefined : { background: 'var(--color-faint)' }} />
            <span className="w-[4.4rem] text-[1.0625rem] font-semibold tnum" data-testid="bar-time" data-ms={Math.round(elapsed)} aria-label={`${t.bar[state.status]}: ${formatDuration(elapsed)}`}>
              {formatDuration(elapsed)}
            </span>
          </div>

          <button
            type="button"
            className="bar-btn"
            onClick={() => send(running ? 'pause' : 'resume')}
            disabled={stopping}
            aria-label={running ? t.bar.pause : t.bar.resume}
            title={`${running ? t.bar.pause : t.bar.resume} (${state.shortcutPause})`}
            data-testid="bar-pause"
          >
            {running ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
          </button>
          <button
            type="button"
            className="bar-btn bar-btn-stop"
            onClick={() => send('stop')}
            disabled={stopping}
            aria-label={t.bar.stop}
            title={`${t.bar.stop} (${state.shortcutStop})`}
            data-testid="bar-stop"
          >
            <StopIcon size={18} />
          </button>
          <span className="mx-1 h-6 w-px bg-line-strong" aria-hidden="true" />
          <button type="button" className="bar-btn" onClick={() => ask('restart')} disabled={stopping} aria-label={t.bar.restart} title={t.bar.restart} data-testid="bar-restart">
            <RestartIcon size={17} />
          </button>
          <button type="button" className="bar-btn" onClick={() => ask('discard')} disabled={stopping} aria-label={t.bar.discard} title={t.bar.discard} data-testid="bar-discard">
            <TrashIcon size={17} />
          </button>
          <span className="mx-1 h-6 w-px bg-line-strong" aria-hidden="true" />
          <div className="flex w-[4.5rem] items-center gap-1.5 pr-2" title={state.hasMic ? t.bar.mic : t.bar.noMic}>
            <span className={state.hasMic ? 'text-muted' : 'text-faint'}>
              <MicIcon size={16} />
            </span>
            <div className="meter !h-1.5 flex-1" role="meter" aria-label={t.bar.mic} aria-valuemin={0} aria-valuemax={1} aria-valuenow={Number(level.toFixed(2))} data-testid="bar-meter" data-level={level.toFixed(3)}>
              <i style={{ width: state.hasMic ? `${Math.round(level * 100)}%` : '0%' }} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
