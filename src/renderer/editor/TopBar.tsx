/**
 * Barra superior do editor: voltar à biblioteca, título editável, desfazer/refazer, proporção, estado do
 * salvamento e Exportar (que vira um indicador de progresso enquanto exporta).
 */
import { useEffect, useRef, useState } from 'react'
import { AlertIcon, BackIcon, CheckIcon, ExportIcon, GuideIcon, PencilIcon, RedoIcon, UndoIcon } from '../components/Icons'
import { t } from '../i18n/pt-BR'
import { Tip, IconButton } from './controls'
import { useDoc, useEditor } from './context'
import { MatteChip } from './MatteChip'

const T = t.editor.top
const MAX_TITLE = 200

function SaveStatus() {
  const { store } = useEditor()
  const status = useDoc((s) => s.saveStatus)
  const error = useDoc((s) => s.saveError)
  return (
    <div className="save" data-status={status} data-testid="save-status" role="status" aria-live="polite">
      {status === 'saved' ? (
        <>
          <CheckIcon size={13} />
          <span>{T.save.saved}</span>
        </>
      ) : null}
      {status === 'saving' ? (
        <>
          <i className="save-dot" aria-hidden="true" />
          <span>{T.save.saving}</span>
        </>
      ) : null}
      {status === 'error' ? (
        <>
          <AlertIcon size={13} />
          <span title={error ? T.saveTip(error) : undefined}>{T.save.error}</span>
          <button type="button" className="link" data-testid="save-retry" onClick={() => void store.getState().flush().catch(() => undefined)}>
            {T.save.retry}
          </button>
        </>
      ) : null}
    </div>
  )
}

function TitleField() {
  const { store } = useEditor()
  const title = useDoc((s) => s.project.title)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      input.current?.focus()
      input.current?.select()
    }
  }, [editing])

  const commit = (): void => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== title) store.getState().change((p) => ({ ...p, title: next.slice(0, MAX_TITLE) }), { coalesce: 'title' })
    else setDraft(title)
  }

  if (editing) {
    return (
      <input
        ref={input}
        className="title-input"
        value={draft}
        maxLength={MAX_TITLE}
        aria-label={T.titleLabel}
        data-testid="title-input"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setDraft(title)
            setEditing(false)
          }
        }}
      />
    )
  }
  return (
    <Tip label={T.titleTip} side="bottom">
      <button
        type="button"
        className="title-btn"
        data-testid="project-title"
        aria-label={`${T.titleLabel}: ${title}. ${T.titleTip}`}
        onClick={() => {
          setDraft(title)
          setEditing(true)
        }}
      >
        <span>{title}</span>
        <PencilIcon size={13} />
      </button>
    </Tip>
  )
}

export function TopBar({ onBack }: { onBack: () => void }) {
  const { store, exporter } = useEditor()
  const undoCount = useDoc((s) => s.undoCount)
  const redoCount = useDoc((s) => s.redoCount)
  const format = useDoc((s) => s.format)
  const safeGuide = useDoc((s) => s.safeGuide)
  const p = exporter.progress
  const pct = p ? Math.round(p.fraction * 100) : 0

  return (
    <header className="ed-top" data-testid="editor-top">
      <div className="top-left">
        <Tip label={T.backTip} side="bottom">
          <button type="button" className="btn btn-ghost top-back" data-testid="back-to-library" aria-label={T.backTip} onClick={onBack}>
            <BackIcon size={16} />
            {T.back}
          </button>
        </Tip>
        <span className="top-divider" aria-hidden="true" />
        <TitleField />
      </div>

      <div className="top-mid">
        <IconButton icon={<UndoIcon size={17} />} label={T.undo} keys="Ctrl+Z" side="bottom" disabled={undoCount === 0} onClick={() => store.getState().undo()} testId="undo" />
        <IconButton icon={<RedoIcon size={17} />} label={T.redo} keys="Ctrl+Shift+Z" side="bottom" disabled={redoCount === 0} onClick={() => store.getState().redo()} testId="redo" />
      </div>

      <div className="top-right">
        {format === 'vertical' ? (
          <IconButton icon={<GuideIcon size={16} />} text={T.safeGuide} label={T.safeGuideTip} pressed={safeGuide} side="bottom" testId="safe-guide" onClick={() => store.getState().setSafeGuide(!safeGuide)} />
        ) : null}
        <div className="ratio" role="group" aria-label={T.ratio} data-testid="ratio">
          <Tip label={T.ratioTip.horizontal} side="bottom">
            <button type="button" aria-pressed={format === 'horizontal'} data-testid="ratio-16-9" onClick={() => store.getState().setFormat('horizontal')}>
              {T.ratioHorizontal}
            </button>
          </Tip>
          <Tip label={T.ratioTip.vertical} side="bottom">
            <button type="button" aria-pressed={format === 'vertical'} data-testid="ratio-9-16" onClick={() => store.getState().setFormat('vertical')}>
              {T.ratioVertical}
            </button>
          </Tip>
        </div>
        <MatteChip />
        <SaveStatus />
        {exporter.busy ? (
          <button type="button" className="export-pill" data-testid="export-pill" data-state="busy" onClick={() => exporter.setOpen(true)} aria-label={T.exporting(pct)}>
            <span className="export-pill-bar" style={{ width: `${pct}%` }} aria-hidden="true" />
            <span className="export-pill-text tnum">{T.exporting(pct)}</span>
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="export-open"
            onClick={() => {
              // um resultado antigo (pronto, falhou, cancelado) não fica no lugar do formulário
              if (exporter.progress) exporter.reset()
              exporter.setOpen(true)
            }}
          >
            <ExportIcon size={16} />
            {T.export}
          </button>
        )}
      </div>
    </header>
  )
}
