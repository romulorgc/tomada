/**
 * Aba ZOOM: liga/desliga e intensidade do zoom automático, "gerar de novo a partir dos cliques" (avisa o
 * que substitui e o que mantém) e os ajustes do zoom selecionado (escala, foco, trecho, apagar).
 */
import { useState } from 'react'
import { formatSpan, formatTimecode } from '@shared/format'
import { regenerateZooms, setZoomFocus, setZoomScale, zoomCounts, ZOOM_SCALE_MAX, ZOOM_SCALE_MIN } from '@shared/edits'
import { DEFAULT_VERTICAL_ZOOM_PRESET, DEFAULT_ZOOM_PRESET, generateAutoZooms, zoomPresetFor } from '@shared/zoom'
import type { Project, ZoomPresetId } from '@shared/types'
import { ZoomInIcon } from '../../components/Icons'
import { t } from '../../i18n/pt-BR'
import { Hint, Section, Segmented, Slider } from '../controls'
import { useDoc, useEditor } from '../context'
import { useEditorOps } from '../ops'

const T = t.editor.zoom
type Choice = ZoomPresetId | 'off'
const CHOICES: Choice[] = ['off', 'subtle', 'moderate', 'intense']

export function ZoomPanel() {
  const { store, cursorData, durationMs, eventsError, detail } = useEditor()
  const ops = useEditorOps()
  const zooms = useDoc((s) => s.project.zooms)
  const preset = useDoc((s) => s.project.zoomPreset)
  const selection = useDoc((s) => s.selection)
  const format = useDoc((s) => s.format)
  const [confirming, setConfirming] = useState(false)

  const counts = zoomCounts({ zooms })
  const choice: Choice | null = preset ?? (zooms.length > 0 ? null : 'off')
  const noEvents = !cursorData || eventsError !== null || !detail.events.cursor
  const selected = selection?.kind === 'zoom' ? zooms.find((z) => z.id === selection.id) : undefined

  const generate = (p: Choice): void => {
    if (!cursorData) return
    // no vertical os tempos são os do preset e a escala e o teto por minuto são os de vertical (1,2-1,5×): o recorte já parte de ~1,78×
    const auto = p === 'off' ? [] : generateAutoZooms({ clicks: cursorData.clicks, keys: cursorData.keys, cursor: cursorData.grid, duration: durationMs, preset: zoomPresetFor(format, p) })
    store.getState().change((doc) => regenerateZooms(doc, p, auto))
    setConfirming(false)
  }

  const fallback: ZoomPresetId = format === 'vertical' ? DEFAULT_VERTICAL_ZOOM_PRESET : DEFAULT_ZOOM_PRESET
  const regenerate = (): void => {
    if (counts.auto > 0) setConfirming(true)
    else generate(preset && preset !== 'off' ? preset : fallback)
  }

  const edit = (fn: (p: Project) => Project, coalesce?: string): void => {
    store.getState().change(fn, coalesce ? { coalesce } : undefined)
  }

  return (
    <div className="panel" data-testid="zoom-panel">
      <Section title={T.title}>
        <Segmented<Choice>
          label={T.title}
          value={choice}
          onChange={generate}
          columns={2}
          options={CHOICES.map((c) => ({ value: c, label: T.presets[c], disabled: noEvents && c !== 'off', testId: `zoom-${c}` }))}
        />
        {choice ? <p className="ctl-note">{(format === 'vertical' ? T.presetHelpVertical : T.presetHelp)[choice]}</p> : null}
        {noEvents ? <Hint tone="warn">{t.editor.noEvents}</Hint> : null}

        <div className="zoom-count" data-testid="zoom-count-line">
          <b data-testid="zoom-count" className="tnum">
            {T.count(zooms.length)}
          </b>
          {zooms.length > 0 ? <span className="tnum">{T.countDetail(counts.auto, counts.manual)}</span> : null}
        </div>

        {confirming ? (
          <div className="confirm" role="alertdialog" aria-label={T.regenerate} data-testid="zoom-regenerate-confirm">
            <p>{T.regenerateWarn(counts.auto, counts.manual)}</p>
            <div className="confirm-actions">
              <button type="button" className="btn" data-testid="zoom-regenerate-yes" onClick={() => generate(preset && preset !== 'off' ? preset : fallback)}>
                {T.regenerateConfirm}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
                {T.regenerateCancel}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-wide" disabled={noEvents} data-testid="zoom-regenerate" onClick={regenerate}>
            {T.regenerate}
          </button>
        )}
      </Section>

      <Section title={selected ? T.selected : T.none} testId="zoom-selected">
        {selected ? (
          <>
            <div className="sel-card" data-testid="zoom-selected-card">
              <span className="sel-badge" data-kind="zoom">
                <ZoomInIcon size={14} /> {T.origin[selected.origin]}
              </span>
              <span className="tnum">
                {formatTimecode(selected.start)} → {formatTimecode(selected.end)} ({formatSpan(selected.end - selected.start)})
              </span>
            </div>
            <Slider
              label={T.scale}
              value={selected.scale}
              min={ZOOM_SCALE_MIN}
              max={ZOOM_SCALE_MAX}
              step={0.05}
              testId="zoom-scale"
              format={T.scaleValue}
              onChange={(v) => edit((p) => setZoomScale(p, selected.id, v), `zoom-scale-${selected.id}`)}
            />
            <Segmented<'auto' | 'fixed'>
              label={T.focus}
              value={selected.focus === 'auto' ? 'auto' : 'fixed'}
              onChange={(v) => {
                if (v === 'auto') edit((p) => setZoomFocus(p, selected.id, 'auto'))
                else {
                  const at = cursorData?.lookup.at((selected.start + selected.end) / 2)
                  edit((p) => setZoomFocus(p, selected.id, at && !at.out ? { x: at.x, y: at.y } : { x: 0.5, y: 0.5 }))
                }
              }}
              options={[
                { value: 'auto', label: T.focusAuto, testId: 'zoom-focus-auto' },
                { value: 'fixed', label: T.focusManual, testId: 'zoom-focus-fixed' }
              ]}
            />
            {selected.focus !== 'auto' ? (
              <p className="ctl-note" data-testid="zoom-focus-help">
                {T.focusManualHelp} ({Math.round(selected.focus.x * 100)}%, {Math.round(selected.focus.y * 100)}%)
              </p>
            ) : null}
            <button type="button" className="btn btn-wide btn-danger-ghost" data-testid="zoom-remove" onClick={() => ops.deleteSelected()}>
              {T.remove}
            </button>
          </>
        ) : (
          <Hint>{T.noneHelp}</Hint>
        )}
      </Section>
    </div>
  )
}
