/**
 * Aba LAYOUT: o layout padrão do vídeo e o do trecho selecionado na trilha Layout. No vertical (9:16) os layouts são
 * outros (Cursor, Câmera + tela, Tela na largura, Só a câmera), a escolha automática por atividade e o título de gancho.
 */
import { useMemo, useState } from 'react'
import { formatSpan, formatTimecode } from '@shared/format'
import { setLayoutOfSeg } from '@shared/edits'
import { legibilitySummary } from '@shared/legible'
import { projectLegibility } from '@shared/scene'
import type { LayoutKind } from '@shared/types'
import { keptRanges } from '@shared/timeline'
import { autoVerticalLayouts, speechRanges } from '@shared/vertical'
import { t } from '../../i18n/pt-BR'
import { useApp } from '../../store'
import { Hint, Section, Toggle } from '../controls'
import { useDoc, useEditor } from '../context'
import { layoutHint, layoutIcon, layoutLabel, layoutUnavailable, kindsOf, KINDS } from '../layout-kinds'
import { useEditorOps } from '../ops'

const T = t.editor.layout
const HOOK_MAX = 80
const iconFor = (l: LayoutKind, vertical: boolean) => layoutIcon(l, vertical, 26)
const unavailable = layoutUnavailable

/**
 * O aviso de letra pequena (9:16): onde, neste layout e neste zoom, a letra do corpo da página fica abaixo de 22 px no vídeo. Nada fica
 * calado: o usuário vê quanto e em que layout, e troca (o Green screen e o Câmera + tela chegam a 30 px).
 */
function LegibilityNote() {
  const { derived } = useEditor()
  const project = useDoc((s) => s.project)
  const summary = useMemo(() => (derived && derived.format.kind === 'vertical' ? legibilitySummary(projectLegibility(project, derived)) : null), [project, derived])
  if (!summary) return null
  const where = summary.layouts.map((l) => layoutLabel(l)).join(', ')
  return (
    <Hint tone="warn">
      <span data-testid="layout-legibility-warn">{T.legibility.warn(summary.minPx, where)}</span>
    </Hint>
  )
}

function LayoutCards({
  value,
  onPick,
  testPrefix,
  hasScreen,
  hasCamera,
  kinds = KINDS,
  vertical = false
}: {
  value: LayoutKind | null
  onPick: (l: LayoutKind) => void
  testPrefix: string
  hasScreen: boolean
  hasCamera: boolean
  kinds?: LayoutKind[]
  vertical?: boolean
}) {
  return (
    <div className="layout-cards" role="group">
      {kinds.map((l) => {
        const reason = unavailable(l, hasScreen, hasCamera)
        const hint = layoutHint(l)
        return (
          <button
            key={l}
            type="button"
            className="layout-card"
            aria-pressed={value === l}
            disabled={reason !== null}
            title={reason ?? hint}
            data-testid={`${testPrefix}-${l}`}
            onClick={() => onPick(l)}
          >
            {iconFor(l, vertical)}
            <span>{layoutLabel(l)}</span>
            {reason ? <small>{reason}</small> : null}
          </button>
        )
      })}
    </div>
  )
}

export function LayoutPanel() {
  const { store, hasScreen, hasCamera, cursorData, transcript, durationMs, matte } = useEditor()
  const notify = useApp((s) => s.notify)
  const ops = useEditorOps()
  const base = useDoc((s) => s.project.style.defaultLayout)
  const layouts = useDoc((s) => s.project.layouts)
  const selection = useDoc((s) => s.selection)
  const format = useDoc((s) => s.format)
  const hook = useDoc((s) => s.project.vertical?.hook ?? '')
  const cameraTop = useDoc((s) => s.project.style.stackCameraTop === true)
  const cuts = useDoc((s) => s.project.cuts)
  const vertical = format === 'vertical'
  const kinds = kindsOf(vertical)
  const selected = selection?.kind === 'layout' ? layouts.find((l) => l.id === selection.id) : undefined
  const [confirming, setConfirming] = useState(false)
  const V = T.vertical

  // Escolha automática por atividade: fala sem nada na tela por 2 s ou mais vira "Câmera + tela"
  const autoPick = (): void => {
    if (!cursorData) return
    const next = autoVerticalLayouts({
      durationMs,
      hasCamera,
      clicks: cursorData.clicks,
      keys: cursorData.keys,
      cursor: cursorData.grid,
      speech: speechRanges(transcript.data?.words),
      kept: keptRanges(durationMs, cuts),
      ...(matte.url ? { hasMatte: true } : {})
    })
    store.getState().change((p) => {
      const manual = p.layouts.filter((s) => s.origin === 'manual')
      return {...p,layouts:[...manual,...next.filter((a) => !p.autoExclusions?.layouts?.includes(a.id) && !manual.some((m) => m.start < a.end && m.end > a.start)).map((s) => ({...s,origin:'auto' as const}))].sort((a,b) => a.start-b.start)}
    })
    store.getState().setSelection(null)
    setConfirming(false)
    notify({ kind: 'info', text: V.autoDone(next.length) })
  }

  return (
    <div className="panel" data-testid="layout-panel">
      <Section title={vertical ? V.video : T.video}>
        <LayoutCards
          value={base}
          onPick={(l) => store.getState().change((p) => ({ ...p, style: { ...p.style, defaultLayout: l } }))}
          testPrefix="layout"
          hasScreen={hasScreen}
          hasCamera={hasCamera}
          kinds={kinds}
          vertical={vertical}
        />
        <p className="ctl-note">{vertical ? V.videoHelp : T.videoHelp}</p>
        {(vertical || base === 'presenter') && layoutHint(base) ? <p className="ctl-note">{layoutHint(base)}</p> : null}
        {vertical ? <LegibilityNote /> : null}
        {vertical ? (
          <Toggle
            label={V.cameraTop}
            hint={V.cameraTopHint}
            checked={cameraTop}
            disabled={!hasCamera || !hasScreen}
            testId="layout-camera-top"
            onChange={(v) =>
              store.getState().change((p) => {
                const style = { ...p.style }
                if (v) style.stackCameraTop = true
                else delete style.stackCameraTop
                return { ...p, style }
              })
            }
          />
        ) : null}
      </Section>

      {vertical ? (
        <>
          <Section title={V.auto}>
            <p className="ctl-note">{V.autoHelp}</p>
            {confirming ? (
              <div className="confirm" role="alertdialog" aria-label={V.auto} data-testid="layout-auto-confirm">
                <p>{V.autoWarn(layouts.length)}</p>
                <div className="confirm-actions">
                  <button type="button" className="btn" data-testid="layout-auto-yes" onClick={autoPick}>
                    {V.autoConfirm}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
                    {V.autoCancel}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn btn-wide" disabled={!cursorData || !hasCamera} title={hasCamera ? undefined : T.needsCamera} data-testid="layout-auto" onClick={() => (layouts.length > 0 ? setConfirming(true) : autoPick())}>
                {V.auto}
              </button>
            )}
          </Section>

          <Section title={V.hook}>
            <textarea
              className="text-field cap-hook"
              value={hook}
              maxLength={HOOK_MAX}
              rows={2}
              placeholder={V.hookPlaceholder}
              aria-label={V.hook}
              data-testid="vertical-hook"
              spellCheck={false}
              onChange={(e) => {
                const value = e.target.value.replace(/\s+/g, ' ').slice(0, HOOK_MAX)
                store.getState().change((p) => ({ ...p, vertical: { ...(p.vertical ?? { layout: p.style.defaultLayout, layouts: p.layouts, zooms: p.zooms }), hook: value } }), { coalesce: 'vertical-hook' })
              }}
            />
            <p className="cap-count tnum">{V.hookCount(hook.length, HOOK_MAX)}</p>
            <p className="ctl-note">{V.hookHelp}</p>
          </Section>
        </>
      ) : null}

      <Section title={selected ? T.segment : T.none} testId="layout-selected">
        {selected ? (
          <>
            <div className="sel-card" data-testid="layout-selected-card">
              <span className="sel-badge" data-kind="layout">
                {T.range}
              </span>
              <span className="tnum">
                {formatTimecode(selected.start)} → {formatTimecode(selected.end)} ({formatSpan(selected.end - selected.start)})
              </span>
            </div>
            <LayoutCards
              value={selected.layout}
              onPick={(l) => store.getState().change((p) => setLayoutOfSeg(p, selected.id, l))}
              testPrefix="layout-seg"
              hasScreen={hasScreen}
              hasCamera={hasCamera}
              kinds={kinds}
              vertical={vertical}
            />
            <p className="ctl-note">{T.segmentHelp}</p>
            <button type="button" className="btn btn-wide btn-danger-ghost" data-testid="layout-remove" onClick={() => ops.deleteSelected()}>
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
