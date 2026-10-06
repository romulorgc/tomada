import { formatTimecode } from '@shared/format'
import { resizeBlurRegion, setBlurRect, updateBlurRegion } from '@shared/blur'
import type { BlurRegion } from '@shared/types'
import { t } from '../../i18n/pt-BR'
import { Section, Segmented, Slider } from '../controls'
import { useDoc, useEditor } from '../context'
import { useEditorOps } from '../ops'

const T = t.editor.blur
export function BlurPanel() {
  const { store, engineRef, durationMs, hasScreen } = useEditor()
  const regions = useDoc(s => s.project.blurRegions)
  const selection = useDoc(s => s.selection)
  const drawing = useDoc(s => s.blurDrawing)
  const selected = selection?.kind === 'blur' ? regions?.find(r => r.id === selection.id) : undefined
  const ops = useEditorOps()
  return <div className="panel" data-testid="blur-panel">
    <p className="ctl-note">{T.limits}</p>
    <Section title={T.title}>
      <p className="ctl-note">{T.hint}</p>
      <button className="btn btn-wide" type="button" disabled={!hasScreen} aria-pressed={drawing} data-testid="blur-draw" onClick={() => { engineRef.current?.pause(); store.getState().setBlurDrawing(!drawing) }}>{drawing ? T.drawing : T.draw}</button>
      {(regions ?? []).map((r, i) => <button key={r.id} className="btn btn-wide" type="button" aria-pressed={selected?.id === r.id} data-testid={`blur-select-${r.id}`} onClick={() => { store.getState().setSelection({ kind: 'blur', id: r.id }); engineRef.current?.seekSource(r.start) }}>{T.region} {i + 1} · {formatTimecode(r.start)} → {formatTimecode(r.end)}</button>)}
      {!regions?.length ? <p className="ctl-note">{T.none}</p> : null}
    </Section>
    {selected ? <Section title={T.selected}>
      <Segmented<BlurRegion['mode']> label={T.mode} value={selected.mode} columns={1} options={(['blur', 'pixelate', 'solid'] as const).map(mode => ({ value: mode, label: T.modes[mode], testId: `blur-mode-${mode}` }))} onChange={mode => store.getState().change(p => updateBlurRegion(p, selected.id, { mode }))} />
      <p className="ctl-note">{T.move}</p>
      {(['x', 'y', 'w', 'h'] as const).map(key => <Slider key={key} label={T[key]} min={key === 'w' || key === 'h' ? .005 : 0} max={1} step={.005} value={selected.rect[key]} format={v => `${Math.round(v * 100)}%`} testId={`blur-${key}`} onChange={v => store.getState().change(p => setBlurRect(p, selected.id, { ...selected.rect, [key]: v }), { coalesce: `blur-${key}-${selected.id}` })} />)}
      {(['start', 'end'] as const).map(edge => <label key={edge} className="field-block">{T[edge]}<input className="text-field tnum" type="number" min={0} max={durationMs} step={100} value={selected[edge]} data-testid={`blur-${edge}`} onChange={e => store.getState().change(p => resizeBlurRegion(p, selected.id, edge, Number(e.target.value), durationMs), { coalesce: `blur-${edge}-${selected.id}` })} /></label>)}
      <button className="btn btn-wide" type="button" data-testid="blur-until-end" onClick={() => ops.blurUntilEnd()}>{T.untilEnd} · B</button>
      <button className="btn btn-wide btn-danger-ghost" type="button" data-testid="blur-remove" onClick={() => ops.deleteSelected()}>{T.remove}</button>
    </Section> : null}
  </div>
}
