/**
 * "Recorte da tela" (C1), no alto da aba Estilo: Automático (a página do navegador, sem abas nem barra de endereço) · Manual (um
 * retângulo arrastado sobre a tela inteira, com proporção livre ou travada) · Desligado. E a moldura de navegador limpa (opcional).
 * Mudar o recorte refaz os zooms automáticos sobre o que ele mostra; é UM passo de desfazer.
 */
import { useState } from 'react'
import { CROP_LOCKS, defaultManualCrop, lockAspect, type CropLockId } from '@shared/crop-drag'
import { setBrowserFrame, setScreenCrop } from '@shared/crop-edit'
import type { Rect, ScreenCrop } from '@shared/types'
import { t } from '../../i18n/pt-BR'
import { useApp } from '../../store'
import { Hint, Section, Segmented, Toggle } from '../controls'
import { useDoc, useEditor } from '../context'

const T = t.editor.crop
type Mode = ScreenCrop['mode']
const LOCKS: (CropLockId | 'free')[] = ['free', '16:9', '16:10', '4:3']

export function CropSection() {
  const { store, rawData, derived, durationMs, detail, hasScreen, playback } = useEditor()
  const crop = useDoc((s) => s.doc.screenCrop)
  const capture = useDoc((s) => s.doc.capture)
  const source = useDoc((s) => s.doc.sources.screen)
  const ui = useDoc((s) => s.cropUi)
  const format = useDoc((s) => s.format)
  const notify = useApp((s) => s.notify)
  const [suggesting, setSuggesting] = useState(false)

  if (!hasScreen || !source) return null

  const sourcePx = { w: source.w, h: source.h }
  const mode: Mode = crop?.mode ?? 'off'
  const measured = Boolean(detail.events.contentRect)
  const browser = capture.browser

  const apply = (next: ScreenCrop | undefined): void => {
    store.getState().changeDoc((doc) => setScreenCrop(doc, next, rawData, durationMs))
  }
  /** O retângulo de partida de um recorte manual: o que o automático mostra agora; senão, uma margem na tela. */
  const startRect = (): Rect => {
    const now = derived?.crop?.at(playback.getState().sourceMs)
    return now ? { ...now } : defaultManualCrop()
  }

  const choose = (m: Mode): void => {
    if (m === mode) {
      if (m === 'manual') store.getState().setCropUi({ editing: true })
      return
    }
    const keep = crop?.browserFrame ? { browserFrame: crop.browserFrame } : {}
    if (m === 'manual') {
      apply({ mode: 'manual', manual: crop?.manual ?? startRect(), ...keep })
      store.getState().setCropUi({ editing: true })
      return
    }
    store.getState().setCropUi({ editing: false })
    apply({ mode: m, ...(crop?.manual ? { manual: crop.manual } : {}), ...keep })
  }

  /** Sem a página medida (Firefox…): procura a barra do navegador nos quadros e propõe um recorte manual, para a pessoa conferir. */
  const suggest = async (): Promise<void> => {
    setSuggesting(true)
    try {
      const found = await window.tomada.derived.cropSuggest(detail.id)
      if (!found) {
        notify({ kind: 'info', text: T.suggestNone })
        return
      }
      apply({ mode: 'manual', manual: found.rect, ...(crop?.browserFrame ? { browserFrame: crop.browserFrame } : {}) })
      store.getState().setCropUi({ editing: true })
      notify({ kind: 'info', text: T.suggestDone })
    } catch (err) {
      notify({ kind: 'error', text: T.suggestFailed, detail: err instanceof Error ? err.message : String(err) })
    } finally {
      setSuggesting(false)
    }
  }
  const suggestButton = (
    <button type="button" className="btn btn-wide" onClick={() => void suggest()} disabled={suggesting} title={T.suggestHelp} data-testid="crop-suggest">
      {suggesting ? T.suggesting : T.suggest}
    </button>
  )

  const lockId: CropLockId | 'free' = ui.lock ?? 'free'
  const chooseLock = (id: CropLockId | 'free'): void => {
    const lock = id === 'free' ? null : id
    store.getState().setCropUi({ lock })
    if (lock && crop?.mode === 'manual' && crop.manual) {
      // travar uma proporção ajusta o retângulo que já existe (o maior que cabe, com o mesmo centro)
      apply({ ...crop, manual: lockAspect(crop.manual, CROP_LOCKS[lock], sourcePx) })
    }
  }

  const frame = crop?.browserFrame
  const frameAvailable = mode !== 'off' && format === 'horizontal'

  return (
    <Section title={T.title} testId="crop-section">
      <Segmented<Mode>
        label={T.title}
        value={mode}
        onChange={choose}
        options={[
          { value: 'auto', label: T.modes.auto, disabled: !measured, testId: 'crop-mode-auto', title: measured ? undefined : T.autoMissingShort },
          { value: 'manual', label: T.modes.manual, testId: 'crop-mode-manual' },
          { value: 'off', label: T.modes.off, testId: 'crop-mode-off' }
        ]}
      />

      {mode === 'auto' ? <Hint>{capture.kind === 'screen' ? T.autoScreenHelp : T.autoHelp}</Hint> : null}
      {mode === 'off' && measured ? (
        <Hint tone="warn">
          <span data-testid="crop-offer">{capture.kind === 'screen' ? T.offerScreen : T.offerWindow}</span>
        </Hint>
      ) : null}
      {mode === 'off' && !measured ? <Hint>{browser?.engine === 'gecko' ? T.geckoHelp : T.offHelp}</Hint> : null}
      {mode === 'off' && !measured ? suggestButton : null}

      {mode === 'manual' ? (
        <div className="ctl-stack" data-testid="crop-manual">
          <Hint>{T.manualHelp}</Hint>
          <button type="button" className="btn btn-wide" onClick={() => store.getState().setCropUi({ editing: !ui.editing })} aria-pressed={ui.editing} data-testid="crop-adjust">
            {ui.editing ? T.done : T.adjust}
          </button>
          {measured ? null : suggestButton}
          <Segmented<CropLockId | 'free'>
            label={T.lockLabel}
            value={lockId}
            onChange={chooseLock}
            columns={4}
            options={LOCKS.map((id) => ({ value: id, label: id === 'free' ? T.locks.free : id, testId: `crop-lock-${id === 'free' ? 'free' : id.replace(':', 'x')}` }))}
          />
          {crop?.manual ? (
            <p className="ctl-note tnum" data-testid="crop-manual-size">
              {T.size(Math.round(crop.manual.w * sourcePx.w), Math.round(crop.manual.h * sourcePx.h))}
            </p>
          ) : null}
          {measured ? (
            <button type="button" className="link" onClick={() => choose('auto')} data-testid="crop-back-auto">
              {T.backToAuto}
            </button>
          ) : null}
        </div>
      ) : null}

      {mode === 'auto' ? (
        <button
          type="button"
          className="link"
          onClick={() => {
            apply({ mode: 'manual', manual: startRect(), ...(crop?.browserFrame ? { browserFrame: crop.browserFrame } : {}) })
            store.getState().setCropUi({ editing: true })
          }}
          data-testid="crop-to-manual"
        >
          {T.adjustByHand}
        </button>
      ) : null}

      {frameAvailable ? (
        <div className="ctl-stack" data-testid="crop-frame">
          <Toggle
            label={T.frameToggle}
            hint={T.frameHelp}
            checked={frame?.enabled === true}
            testId="crop-frame-toggle"
            onChange={(on) => store.getState().changeDoc((doc) => setBrowserFrame(doc, { enabled: on, ...(frame?.domain ? { domain: frame.domain } : {}) }))}
          />
          {frame?.enabled ? (
            <label className="ctl">
              <span className="ctl-head">{T.domain}</span>
              <input
                type="text"
                className="field"
                maxLength={120}
                placeholder={T.domainPlaceholder}
                value={frame.domain ?? ''}
                data-testid="crop-domain"
                onChange={(e) => store.getState().changeDoc((doc) => setBrowserFrame(doc, { enabled: true, domain: e.target.value }), { coalesce: 'crop-domain' })}
              />
            </label>
          ) : null}
        </div>
      ) : mode !== 'off' && format === 'vertical' ? (
        <Hint>{T.frameOnlyHorizontal}</Hint>
      ) : null}
    </Section>
  )
}
