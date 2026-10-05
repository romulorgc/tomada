/**
 * Controles de reprodução sob a prévia: começo, quadro a quadro, tocar/pausar, fim, o relógio em tempo de
 * SAÍDA (com centésimos), a velocidade do J/L e o estado do áudio. O botão de atalhos abre a lista do teclado.
 */
import { useEffect, useRef, useState } from 'react'
import { formatTimecode } from '@shared/format'
import { FrameBackIcon, FrameForwardIcon, KeyboardIcon, PauseIcon, PlayIcon, SkipEndIcon, SkipStartIcon } from '../components/Icons'
import { t } from '../i18n/pt-BR'
import { IconButton, Keys, Tip } from './controls'
import { useDoc, useEditor, usePlayback } from './context'
import type { PreviewEngine } from './engine'

const T = t.editor.transport

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: 'Espaço', label: t.editor.shortcuts.play },
  { keys: 'J+K+L', label: t.editor.shortcuts.jkl },
  { keys: '←+→', label: t.editor.shortcuts.frame },
  { keys: 'Shift+←+→', label: t.editor.shortcuts.second },
  { keys: 'Home+End', label: t.editor.shortcuts.homeEnd },
  { keys: 'Delete', label: t.editor.shortcuts.cut },
  { keys: 'Delete', label: t.editor.shortcuts.cutWords },
  { keys: 'Ctrl+F', label: t.editor.shortcuts.search },
  { keys: 'S', label: t.editor.shortcuts.split },
  { keys: 'Z', label: t.editor.shortcuts.zoom },
  { keys: 'Ctrl+Z', label: t.editor.shortcuts.undo },
  { keys: 'Ctrl+Shift+Z', label: t.editor.shortcuts.redo },
  { keys: 'Ctrl+Roda', label: t.editor.shortcuts.timelineZoom },
  { keys: 'Roda', label: t.editor.shortcuts.scroll },
  { keys: 'Esc', label: t.editor.shortcuts.escape }
]

function ShortcutsPopover({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-shortcuts-button]')) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return (
    <div className="popover" ref={ref} role="dialog" aria-label={t.editor.shortcuts.title} data-testid="shortcuts-popover">
      <h3>{t.editor.shortcuts.title}</h3>
      <dl>
        {SHORTCUTS.map((s) => (
          <div key={`${s.keys}-${s.label}`}>
            <dt>
              <Keys keys={s.keys} />
            </dt>
            <dd>{s.label}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function Transport() {
  const { engineRef, sceneDerived } = useEditor()
  const playing = usePlayback((s) => s.playing)
  const rate = usePlayback((s) => s.rate)
  const outMs = usePlayback((s) => s.outMs)
  const audioTreated = usePlayback((s) => s.audioTreated)
  const audioError = usePlayback((s) => s.audioError)
  const total = sceneDerived?.outputDurationMs ?? 0
  const hasAudio = useDoc((s) => Boolean(s.project.sources.voice || s.project.sources.system))
  const [help, setHelp] = useState(false)
  const engine = (): PreviewEngine | null => engineRef.current

  return (
    <div className="ed-transport" role="group" aria-label={T.label}>
      <div className="tp-buttons">
        <IconButton icon={<SkipStartIcon size={16} />} label={T.start} keys="Home" size="sm" onClick={() => engine()?.jumpTo('start')} testId="tp-start" />
        <IconButton icon={<FrameBackIcon size={16} />} label={T.frameBack} keys="←" size="sm" onClick={() => engine()?.stepFrames(-1)} testId="tp-frame-back" />
        <Tip label={playing ? T.pause : T.play} keys="Espaço">
          <button
            type="button"
            className="play-btn"
            aria-label={playing ? T.pause : T.play}
            aria-keyshortcuts="Space"
            data-testid="play-toggle"
            data-playing={playing}
            onClick={() => engine()?.toggle('button')}
          >
            {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
          </button>
        </Tip>
        <IconButton icon={<FrameForwardIcon size={16} />} label={T.frameForward} keys="→" size="sm" onClick={() => engine()?.stepFrames(1)} testId="tp-frame-forward" />
        <IconButton icon={<SkipEndIcon size={16} />} label={T.end} keys="End" size="sm" onClick={() => engine()?.jumpTo('end')} testId="tp-end" />
      </div>

      <div className="tp-time tnum" data-testid="current-time" data-seconds={(outMs / 1000).toFixed(2)} data-ms={Math.round(outMs)} data-total-ms={Math.round(total)}>
        <b>{formatTimecode(outMs)}</b>
        <span>/ {formatTimecode(total)}</span>
        {rate !== 0 && rate !== 1 ? (
          <em className="tp-rate" data-testid="tp-rate">
            {T.speed(rate)}
          </em>
        ) : null}
      </div>

      <div className="tp-side">
        {!hasAudio ? (
          <span className="chip" data-treated="none" role="status" data-testid="audio-status">
            {t.editor.audioNone}
          </span>
        ) : audioError ? (
          <span className="chip" data-tone="warn" role="status" data-testid="audio-status" title={audioError}>
            {t.editor.audioMissing}
          </span>
        ) : (
          <span className="chip" data-treated={audioTreated} role="status" data-testid="audio-status" title={audioTreated ? t.editor.audioTreated : t.editor.audioRaw}>
            <i aria-hidden="true" />
            {audioTreated ? t.editor.audioTreated : t.editor.audioRaw}
          </span>
        )}
        <span data-shortcuts-button>
          <IconButton icon={<KeyboardIcon size={16} />} label={T.shortcuts} size="sm" pressed={help} onClick={() => setHelp((v) => !v)} testId="tp-shortcuts" />
        </span>
        {help ? <ShortcutsPopover onClose={() => setHelp(false)} /> : null}
      </div>
    </div>
  )
}
