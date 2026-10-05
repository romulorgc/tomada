/**
 * Peças de interface do editor: dica com atalho, botão de ícone, segmentado, controle deslizante, interruptor,
 * campo de cor e seção de painel. Todas usam os tokens do app (nada de cor solta) e têm estado de foco,
 * hover, ativo e desligado.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/** Atalho como teclas: "Ctrl+Shift+Z" vira três tecladinhos. */
export function Keys({ keys }: { keys: string }) {
  return (
    <span className="keys" aria-hidden="true">
      {keys.split('+').map((k, i) => (
        <kbd key={`${k}-${i}`}>{k}</kbd>
      ))}
    </span>
  )
}

/**
 * Dica ao passar o mouse ou focar com o teclado (com o atalho, se houver). A dica só existe enquanto aparece
 * (não deixa nada escondido ocupando área da janela) e fica sempre inteira na tela: perto da borda, ela anda
 * para dentro em vez de ser cortada.
 */
export function Tip({ label, keys, side = 'top', children }: { label: string; keys?: string; side?: 'top' | 'bottom'; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [dx, setDx] = useState(0)
  const host = useRef<HTMLSpanElement>(null)
  const bubble = useRef<HTMLSpanElement>(null)
  const timer = useRef<number | undefined>(undefined)

  const show = (delay: number): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(true), delay)
  }
  const hide = (): void => {
    window.clearTimeout(timer.current)
    setOpen(false)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])

  useLayoutEffect(() => {
    if (!open) return
    const h = host.current
    const b = bubble.current
    if (!h || !b) return
    const r = h.getBoundingClientRect()
    const half = b.offsetWidth / 2
    const center = r.left + r.width / 2
    const margin = 8
    setDx(Math.min(window.innerWidth - margin - half, Math.max(margin + half, center)) - center)
  }, [open])

  return (
    <span
      ref={host}
      className="tip"
      data-side={side}
      onMouseEnter={() => show(420)}
      onMouseLeave={hide}
      onPointerDown={hide}
      onFocus={(e) => {
        if (e.target.matches(':focus-visible')) show(120)
      }}
      onBlur={hide}
    >
      {children}
      {open ? (
        <span ref={bubble} className="tip-bubble" role="tooltip" style={{ ['--tip-dx' as string]: `${dx}px` }} aria-hidden="true" data-testid="tooltip">
          {label}
          {keys ? <Keys keys={keys} /> : null}
        </span>
      ) : null}
    </span>
  )
}

type IconButtonProps = {
  icon: ReactNode
  label: string
  keys?: string
  onClick?: () => void
  disabled?: boolean
  pressed?: boolean
  text?: string
  side?: 'top' | 'bottom'
  testId?: string
  tone?: 'default' | 'danger'
  size?: 'sm' | 'md'
}

export function IconButton({ icon, label, keys, onClick, disabled, pressed, text, side = 'top', testId, tone = 'default', size = 'md' }: IconButtonProps) {
  return (
    <Tip label={label} {...(keys ? { keys } : {})} side={side}>
      <button
        type="button"
        className="ibtn"
        data-size={size}
        data-tone={tone}
        data-with-text={text ? 'true' : undefined}
        aria-label={label}
        aria-pressed={pressed}
        aria-keyshortcuts={keys}
        disabled={disabled}
        data-testid={testId}
        onClick={onClick}
      >
        {icon}
        {text ? <span>{text}</span> : null}
      </button>
    </Tip>
  )
}

export type SegmentedOption<T extends string> = { value: T; label: string; icon?: ReactNode; disabled?: boolean; testId?: string; title?: string }

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  columns,
  variant = 'text'
}: {
  value: T | null
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  label: string
  columns?: number
  variant?: 'text' | 'icon'
}) {
  return (
    <div className="segc" role="group" aria-label={label} data-variant={variant} style={{ ['--cols' as string]: columns ?? options.length } as CSSProperties}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          disabled={o.disabled}
          title={o.title}
          data-testid={o.testId}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  testId,
  disabled
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  format: (value: number) => string
  testId?: string
  disabled?: boolean
}) {
  const id = useId()
  const pct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0
  return (
    <div className="ctl">
      <div className="ctl-head">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} className="tnum" data-testid={testId ? `${testId}-value` : undefined}>
          {format(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        className="slider"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        data-testid={testId}
        aria-valuetext={format(value)}
        style={{ ['--p' as string]: `${pct}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

export function Toggle({ label, checked, onChange, testId, disabled, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; testId?: string; disabled?: boolean; hint?: string }) {
  const id = useId()
  return (
    <div className="ctl ctl-toggle">
      <div className="ctl-text">
        <label htmlFor={id}>{label}</label>
        {hint ? <p>{hint}</p> : null}
      </div>
      <button id={id} type="button" role="switch" aria-checked={checked} className="switch" disabled={disabled} data-testid={testId} onClick={() => onChange(!checked)}>
        <span />
      </button>
    </div>
  )
}

/** Campo de cor: a amostra abre o seletor nativo do sistema. */
export function ColorField({ label, value, onChange, testId }: { label: string; value: string; onChange: (hex: string) => void; testId?: string }) {
  const id = useId()
  const safe = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'
  return (
    <div className="ctl ctl-color">
      <label htmlFor={id}>{label}</label>
      <span className="color-chip">
        <input id={id} type="color" value={safe} data-testid={testId} onChange={(e) => onChange(e.target.value)} />
        <i style={{ background: safe }} />
        <code className="tnum">{safe.toUpperCase()}</code>
      </span>
    </div>
  )
}

export function Section({ title, action, children, testId }: { title: string; action?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="ps" data-testid={testId}>
      <header>
        <h3>{title}</h3>
        {action}
      </header>
      <div className="ps-body">{children}</div>
    </section>
  )
}

/** Estado vazio/aviso dentro de um painel. */
export function Hint({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' }) {
  return (
    <p className="hint" data-tone={tone}>
      {children}
    </p>
  )
}
