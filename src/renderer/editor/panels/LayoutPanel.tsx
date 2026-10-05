/**
 * Aba LAYOUT: o layout padrão do vídeo e o do trecho selecionado na trilha Layout. No vertical (9:16) os layouts são
 * outros (Cursor, Câmera + tela, Tela na largura, Só a câmera), a escolha automática por atividade e o título de gancho.
 */
import { useState, type ReactNode } from 'react'
import { formatSpan, formatTimecode } from '@shared/format'
import { setLayoutOfSeg } from '@shared/edits'
import type { LayoutKind } from '@shared/types'
import { autoVerticalLayouts, speechRanges } from '@shared/vertical'
import { LayoutBubbleIcon, LayoutCameraIcon, LayoutFocusIcon, LayoutScreenIcon, LayoutSideIcon, LayoutStackIcon, LayoutWideIcon } from '../../components/Icons'
import { t } from '../../i18n/pt-BR'
import { useApp } from '../../store'
import { Hint, Section } from '../controls'
import { useDoc, useEditor } from '../context'
import { useEditorOps } from '../ops'

const T = t.editor.layout
const KINDS: LayoutKind[] = ['bubble', 'side-by-side', 'screen', 'camera']
/** No vertical: V-A Cursor, V-B Câmera + tela, V-C Tela na largura e só a câmera. */
const VERTICAL_KINDS: LayoutKind[] = ['screen-focus', 'stack', 'screen-wide', 'camera']
const HOOK_MAX = 80
const ICONS: Record<string, ReactNode> = {
  bubble: <LayoutBubbleIcon size={26} />,
  'side-by-side': <LayoutSideIcon size={26} />,
  screen: <LayoutScreenIcon size={26} />,
  camera: <LayoutCameraIcon size={26} />,
  'screen-focus': <LayoutFocusIcon size={26} />,
  stack: <LayoutStackIcon size={26} />,
  'screen-wide': <LayoutWideIcon size={26} />
}

/** Por que um layout não está disponível neste projeto (ou `null` se está). */
function unavailable(l: LayoutKind, hasScreen: boolean, hasCamera: boolean): string | null {
  if (l === 'camera') return hasCamera ? null : T.needsCamera
  if (l === 'screen' || l === 'screen-focus' || l === 'screen-wide') return hasScreen ? null : T.needsScreen
  return hasCamera && hasScreen ? null : hasCamera ? T.needsScreen : T.needsCamera
}

function LayoutCards({
  value,
  onPick,
  testPrefix,
  hasScreen,
  hasCamera,
  kinds = KINDS
}: {
  value: LayoutKind | null
  onPick: (l: LayoutKind) => void
  testPrefix: string
  hasScreen: boolean
  hasCamera: boolean
  kinds?: LayoutKind[]
}) {
  return (
    <div className="layout-cards" role="group">
      {kinds.map((l) => {
        const reason = unavailable(l, hasScreen, hasCamera)
        const hint = (T.optionHints as Record<string, string>)[l]
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
            {ICONS[l]}
            <span>{T.options[l as keyof typeof T.options]}</span>
            {reason ? <small>{reason}</small> : null}
          </button>
        )
      })}
    </div>
  )
}

export function LayoutPanel() {
  const { store, hasScreen, hasCamera, cursorData, transcript, durationMs } = useEditor()
  const notify = useApp((s) => s.notify)
  const ops = useEditorOps()
  const base = useDoc((s) => s.project.style.defaultLayout)
  const layouts = useDoc((s) => s.project.layouts)
  const selection = useDoc((s) => s.selection)
  const format = useDoc((s) => s.format)
  const hook = useDoc((s) => s.project.vertical?.hook ?? '')
  const vertical = format === 'vertical'
  const kinds = vertical ? VERTICAL_KINDS : KINDS
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
      speech: speechRanges(transcript.data?.words)
    })
    store.getState().change((p) => ({ ...p, layouts: next }))
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
        />
        <p className="ctl-note">{vertical ? V.videoHelp : T.videoHelp}</p>
        {vertical && (T.optionHints as Record<string, string>)[base] ? <p className="ctl-note">{(T.optionHints as Record<string, string>)[base]}</p> : null}
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
