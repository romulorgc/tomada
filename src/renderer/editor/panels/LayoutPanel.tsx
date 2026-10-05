/**
 * Aba LAYOUT: o layout padrão do vídeo e o do trecho selecionado na trilha Layout.
 */
import type { ReactNode } from 'react'
import { formatSpan, formatTimecode } from '@shared/format'
import { setLayoutOfSeg } from '@shared/edits'
import type { LayoutKind } from '@shared/types'
import { LayoutBubbleIcon, LayoutCameraIcon, LayoutScreenIcon, LayoutSideIcon } from '../../components/Icons'
import { t } from '../../i18n/pt-BR'
import { Hint, Section } from '../controls'
import { useDoc, useEditor } from '../context'
import { useEditorOps } from '../ops'

const T = t.editor.layout
const KINDS: LayoutKind[] = ['bubble', 'side-by-side', 'screen', 'camera']
const ICONS: Record<string, ReactNode> = {
  bubble: <LayoutBubbleIcon size={26} />,
  'side-by-side': <LayoutSideIcon size={26} />,
  screen: <LayoutScreenIcon size={26} />,
  camera: <LayoutCameraIcon size={26} />
}

function LayoutCards({ value, onPick, testPrefix, hasScreen, hasCamera }: { value: LayoutKind | null; onPick: (l: LayoutKind) => void; testPrefix: string; hasScreen: boolean; hasCamera: boolean }) {
  return (
    <div className="layout-cards" role="group">
      {KINDS.map((l) => {
        const reason = l === 'camera' ? (hasCamera ? null : T.needsCamera) : l === 'screen' ? (hasScreen ? null : T.needsScreen) : hasCamera && hasScreen ? null : hasCamera ? T.needsScreen : T.needsCamera
        return (
          <button
            key={l}
            type="button"
            className="layout-card"
            aria-pressed={value === l}
            disabled={reason !== null}
            title={reason ?? undefined}
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
  const { store, hasScreen, hasCamera } = useEditor()
  const ops = useEditorOps()
  const base = useDoc((s) => s.project.style.defaultLayout)
  const layouts = useDoc((s) => s.project.layouts)
  const selection = useDoc((s) => s.selection)
  const selected = selection?.kind === 'layout' ? layouts.find((l) => l.id === selection.id) : undefined

  return (
    <div className="panel" data-testid="layout-panel">
      <Section title={T.video}>
        <LayoutCards value={base} onPick={(l) => store.getState().change((p) => ({ ...p, style: { ...p.style, defaultLayout: l } }))} testPrefix="layout" hasScreen={hasScreen} hasCamera={hasCamera} />
        <p className="ctl-note">{T.videoHelp}</p>
      </Section>

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
