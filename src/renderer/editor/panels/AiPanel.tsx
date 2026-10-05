/**
 * Aba IA ("editar pedindo"): a pessoa escreve o que quer mudar; a IA devolve operações sobre a transcrição (cortar trechos, zoom,
 * layout, gancho, legenda…) e o programa as valida e aplica como UMA mudança só, com resumo humano, que o Ctrl+Z desfaz. Operação
 * inválida é recusada com o motivo (nunca aplicada pela metade); mudança que tira mais de 20% do vídeo espera confirmação.
 * Só o texto da transcrição vai para a IA.
 */
import { useState } from 'react'
import { useStore } from 'zustand'
import { EDIT_SUGGESTIONS, planAiEdit, type AiEditPlan } from '@shared/ai-edit'
import { formatSpan } from '@shared/format'
import type { Word } from '@shared/types'
import { AlertIcon, CheckIcon, SparkleIcon } from '../../components/Icons'
import { t } from '../../i18n/pt-BR'
import { useApp } from '../../store'
import { Hint, Section } from '../controls'
import { useEditor } from '../context'
import { useAiStatus } from '../ai-status'
import type { AiEntry, AiPending } from '../ai-store'
import { PanelEmpty, TranscriptGate } from './gates'

const T = t.editor.ai
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const INPUT_MAX = 1000

function HistoryItem({ entry }: { entry: AiEntry }) {
  const [details, setDetails] = useState(false)
  return (
    <li className="ai-entry" data-testid="ai-history-item" data-status={entry.status}>
      <div className="ae-head">
        <span className="ae-status" data-status={entry.status}>
          {entry.status === 'applied' ? <CheckIcon size={12} /> : entry.status === 'error' || entry.status === 'refused' ? <AlertIcon size={12} /> : null}
          {T.status[entry.status]}
        </span>
        <q className="ae-ask">{entry.instruction}</q>
      </div>
      <p className="ae-text" data-testid="ai-history-text">
        {entry.text}
      </p>
      {entry.refused.length > 0 ? (
        <>
          <button type="button" className="link" aria-expanded={details} onClick={() => setDetails(!details)} data-testid="ai-refused-toggle">
            {details ? T.hideDetails : T.showDetails}
          </button>
          {details ? (
            <ul className="ae-refused" data-testid="ai-refused">
              {entry.refused.map((why, k) => (
                <li key={k}>{T.refusedLine(why)}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </li>
  )
}

function AiBody({ words }: { words: readonly Word[] }) {
  const { store, ai: aiStore, durationMs, detail } = useEditor()
  const notify = useApp((s) => s.notify)
  const ai = useAiStatus()
  const busy = useStore(aiStore, (s) => s.busy)
  const history = useStore(aiStore, (s) => s.history)
  const pending = useStore(aiStore, (s) => s.pending)
  const [draft, setDraft] = useState('')

  /** Valida e aplica as operações como UM passo de desfazer. Devolve o plano (o que mudou, o que foi recusado). */
  const plan = (ops: readonly unknown[], reply: string | null): AiEditPlan => {
    const st = store.getState()
    return planAiEdit({ project: st.project, words, durationMs, format: st.format, ops, reply })
  }

  const finish = (instruction: string, p: AiEditPlan): void => {
    const refused = p.refused.map((r) => r.why)
    if (p.changed) {
      store.getState().change(() => p.project)
      aiStore.getState().record({ instruction, status: 'applied', text: T.applied(p.summary), refused })
    } else {
      aiStore.getState().record({ instruction, status: refused.length > 0 ? 'refused' : 'noop', text: p.reply ?? p.summary, refused })
    }
  }

  const ask = async (): Promise<void> => {
    const instruction = draft.replace(/\s+/g, ' ').trim()
    if (instruction === '' || busy) return
    aiStore.getState().setBusy(true)
    aiStore.getState().setPending(null)
    try {
      await store.getState().flush()
      // o documento gravado é o que a IA enxerga: o projeto aberto, no formato aberto
      const r = await window.tomada.ai.edit(detail.id, instruction, store.getState().format)
      const p = plan(r.ops, r.reply)
      if (p.changed && p.needsConfirm) {
        const pct = p.beforeMs > 0 ? Math.round((p.removedMs / p.beforeMs) * 100) : 0
        aiStore.getState().setPending({ instruction, ops: r.ops, reply: r.reply, summary: p.summary, removedMs: p.removedMs, pct })
      } else {
        finish(instruction, p)
        setDraft('')
      }
    } catch (err) {
      aiStore.getState().record({ instruction, status: 'error', text: messageOf(err), refused: [] })
      notify({ kind: 'error', text: T.failed, detail: messageOf(err) })
    } finally {
      aiStore.getState().setBusy(false)
    }
  }

  const confirm = (p: AiPending): void => {
    // o documento pode ter mudado enquanto a pessoa decidia: valida de novo sobre o de agora
    finish(p.instruction, plan(p.ops, p.reply))
    aiStore.getState().setPending(null)
    setDraft('')
  }

  const cancelPending = (p: AiPending): void => {
    aiStore.getState().record({ instruction: p.instruction, status: 'cancelled', text: T.cancelledByYou, refused: [] })
    aiStore.getState().setPending(null)
  }

  if (ai.loaded && !ai.available) {
    return (
      <PanelEmpty testId="ai-panel" state="unavailable" icon={<SparkleIcon size={30} />} title={T.unavailable.title} body={T.unavailable.body}>
        {ai.detail ? (
          <p className="ai-off-why" data-testid="ai-unavailable-why">
            {ai.detail}
          </p>
        ) : null}
        <button type="button" className="btn" onClick={ai.refresh} data-testid="ai-recheck">
          {T.recheck}
        </button>
      </PanelEmpty>
    )
  }

  return (
    <div className="panel" data-testid="ai-panel" data-state={busy ? 'busy' : 'ready'}>
      <Section title={T.title} testId="ai-ask-section">
        <Hint>{T.help}</Hint>
        <div className="field-block">
          <label className="field-label" htmlFor="ai-input">
            {T.title}
          </label>
          <textarea
            id="ai-input"
            className="text-field ai-input"
            rows={3}
            maxLength={INPUT_MAX}
            value={draft}
            placeholder={T.placeholder}
            disabled={busy || pending !== null}
            data-testid="ai-input"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void ask()
              }
            }}
          />
        </div>
        <button type="button" className="btn btn-primary btn-wide" disabled={busy || pending !== null || draft.trim() === '' || !ai.loaded} onClick={() => void ask()} data-testid="ai-ask">
          <SparkleIcon size={15} />
          {busy ? T.asking : T.ask}
        </button>
        {busy ? (
          <div className="meter indeterminate" role="progressbar" aria-label={T.asking} data-testid="ai-busy">
            <i />
          </div>
        ) : null}
        <div className="ai-suggest" role="group" aria-label={T.suggestions}>
          {EDIT_SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="chip-btn" disabled={busy || pending !== null} onClick={() => setDraft(s)} data-testid="ai-suggestion">
              {s}
            </button>
          ))}
        </div>
      </Section>

      {pending ? (
        <Section title={T.confirm.title} testId="ai-confirm">
          <p className="ai-confirm-body" role="alert" data-testid="ai-confirm-body">
            {T.confirm.body(pending.pct, formatSpan(pending.removedMs))}
          </p>
          <p className="hint">{pending.summary}</p>
          <div className="cq-actions">
            <button type="button" className="btn btn-primary" onClick={() => confirm(pending)} data-testid="ai-confirm-ok">
              {T.confirm.ok}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => cancelPending(pending)} data-testid="ai-confirm-cancel">
              {T.confirm.cancel}
            </button>
          </div>
        </Section>
      ) : null}

      <Section title={T.history} testId="ai-history">
        {history.length === 0 ? (
          <Hint>{T.historyEmpty}</Hint>
        ) : (
          <ul className="ai-history-list">
            {history.map((h) => (
              <HistoryItem key={h.id} entry={h} />
            ))}
          </ul>
        )}
        <Hint>{T.goToPublish}</Hint>
      </Section>
    </div>
  )
}

export function AiPanel() {
  return (
    <TranscriptGate testId="ai-panel" copy={T.noTranscript}>
      {(words) => <AiBody words={words} />}
    </TranscriptGate>
  )
}
