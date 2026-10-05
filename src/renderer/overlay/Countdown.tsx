/**
 * Contagem 3-2-1 com bipe, numa janela transparente sobre a tela que será gravada.
 * Fica fora da captura e não rouba o foco; Esc (atalho global do main) cancela.
 */
import { useEffect, useState } from 'react'
import { t } from '../i18n/pt-BR'

function beep(ctx: AudioContext, frequency: number, ms: number): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = frequency
  const now = ctx.currentTime
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.25, now + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + ms / 1000)
  osc.connect(gain).connect(ctx.destination)
  osc.start(now)
  osc.stop(now + ms / 1000 + 0.02)
}

export function Countdown() {
  const [value, setValue] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    const timers: number[] = []
    let ctx: AudioContext | null = null
    void (async () => {
      const config = await window.tomada.countdown.begin()
      if (!alive) return
      if (!config.silent) {
        try {
          ctx = new AudioContext()
        } catch (err) {
          window.tomada.log({ level: 'warn', message: 'Sem áudio para o bipe da contagem', detail: err instanceof Error ? err.message : String(err) })
        }
      }
      for (let i = 0; i < config.seconds; i++) {
        timers.push(
          window.setTimeout(() => {
            if (!alive) return
            const n = config.seconds - i
            setValue(n)
            if (ctx) beep(ctx, 880, 130)
          }, i * 1000)
        )
      }
      timers.push(
        window.setTimeout(() => {
          if (alive) void window.tomada.countdown.finish(true)
        }, config.seconds * 1000)
      )
    })()
    return () => {
      alive = false
      timers.forEach((id) => window.clearTimeout(id))
      void ctx?.close().catch(() => undefined)
    }
  }, [])

  return (
    <div className="countdown" role="timer" aria-label={t.countdown.label} data-testid="countdown" data-value={value ?? ''}>
      {value !== null ? (
        <div key={value} className="countdown-number" data-testid="countdown-number">
          {value}
        </div>
      ) : null}
      <p className="countdown-hint">{t.countdown.cancel}</p>
    </div>
  )
}
