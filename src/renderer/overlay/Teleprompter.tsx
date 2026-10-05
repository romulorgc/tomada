import { useEffect, useRef, useState } from 'react'
import { teleprompterLines, type TeleprompterAction, type TeleprompterState } from '@shared/script'
import { t } from '../i18n/pt-BR'

export function Teleprompter() {
  const [state, setState] = useState<TeleprompterState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const position = useRef(0)
  const send = (action: TeleprompterAction) => { void window.tomada.teleprompter.action(action).catch((err: unknown) => setError(String(err))) }
  useEffect(() => {
    let alive = true
    void window.tomada.teleprompter.state().then((s) => { if (alive) setState(s) }).catch((err: unknown) => { if (alive) setError(String(err)) })
    const off = window.tomada.on('teleprompter:state', setState)
    const offCommand = window.tomada.on('teleprompter:command', (action) => { void window.tomada.teleprompter.action(action).catch((err: unknown) => setError(String(err))) })
    return () => { alive = false; off(); offCommand() }
  }, [])
  useEffect(() => {
    if (!state || state.mode !== 'scroll') return
    const element = viewport.current?.querySelector<HTMLElement>(`[data-line="${state.topicIndex}"]`)
    if (element && viewport.current) { position.current = element.offsetTop - 16; viewport.current.scrollTop = position.current }
  }, [state?.topicIndex, state?.mode])
  useEffect(() => {
    if (!state || state.paused || state.mode !== 'scroll') return
    let frame = 0, previous = performance.now()
    const animate = (now: number) => {
      const div = viewport.current
      if (div) {
        position.current = Math.min(div.scrollHeight - div.clientHeight, position.current + Math.min(100, now - previous) * state.speed / 1000)
        div.scrollTop = position.current
      }
      previous = now; frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame)
  }, [state?.paused, state?.mode, state?.speed])
  if (!state) return <div aria-busy="true" />
  const lines = teleprompterLines(state.script)
  return <section className="m-1 flex h-[292px] flex-col overflow-hidden rounded-dialog border border-line-strong bg-[#11141bf2] p-4 text-white shadow-lg" data-testid="teleprompter" data-paused={state.paused} data-mode={state.mode} data-topic={state.topicIndex}>
    <header className="mb-3 flex items-center gap-3 text-[0.8125rem] text-muted [-webkit-app-region:drag]">
      <span className="mr-auto">{t.preparation.protected}</span>
      <button type="button" className="btn btn-small [-webkit-app-region:no-drag]" onClick={() => send('previous')} aria-label={t.preparation.previous} data-testid="teleprompter-previous">←</button>
      <button type="button" className="btn btn-small [-webkit-app-region:no-drag]" onClick={() => send('pause')} data-testid="teleprompter-pause">{state.paused ? t.preparation.resume : t.preparation.pause}</button>
      <button type="button" className="btn btn-small [-webkit-app-region:no-drag]" onClick={() => send('next')} aria-label={t.preparation.next} data-testid="teleprompter-next">→</button>
      <button type="button" className="btn btn-small [-webkit-app-region:no-drag]" onClick={() => { void window.tomada.teleprompter.hide().catch((err: unknown) => setError(String(err))) }} aria-label={t.preparation.close}>×</button>
    </header>
    <div ref={viewport} className="relative min-h-0 flex-1 overflow-auto text-[1.75rem] font-medium leading-[1.45]" data-testid="teleprompter-text" onScroll={(e) => { position.current = e.currentTarget.scrollTop }}>
      {state.mode === 'topics' ? <p>{lines[state.topicIndex]}</p> : <div className="pb-[200px]">{lines.map((line, i) => <p key={i} data-line={i} className="mb-7">{line}</p>)}</div>}
    </div>
    <footer className="mt-2 flex items-center gap-2 text-[0.75rem] text-muted">
      {state.mode === 'scroll' ? <><button type="button" className="btn btn-small" aria-label={t.preparation.slower} onClick={() => send('slower')}>−</button><span>{t.preparation.speedValue(state.speed)}</span><button type="button" className="btn btn-small" aria-label={t.preparation.faster} onClick={() => send('faster')}>+</button></> : <span>{t.preparation.progress(state.topicIndex + 1, lines.length)}</span>}
      <span>{t.preparation.promptHelp}</span>
    </footer>
    {error ? <p role="alert" className="text-danger text-[0.75rem]">{error}</p> : null}
  </section>
}
