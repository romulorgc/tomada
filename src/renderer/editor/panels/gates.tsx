/**
 * Peças que as abas Cortes, Publicar e IA repartem: o estado vazio, a espera pela transcrição (todas trabalham sobre o texto
 * da voz) e o aviso de "IA indisponível" (o motivo e como ligar; nunca o nome do fornecedor).
 */
import type { ReactNode } from 'react'
import type { Word } from '@shared/types'
import { AlertIcon, SparkleIcon, TextIcon } from '../../components/Icons'
import { t } from '../../i18n/pt-BR'
import { useDoc, useEditor } from '../context'
import type { AiAvailability } from '../ai-status'

export function PanelEmpty({ icon, title, body, children, testId, state }: { icon?: ReactNode; title: string; body?: string; children?: ReactNode; testId: string; state?: string }) {
  return (
    <div className="panel" data-testid={testId} data-state={state}>
      <div className="empty-state">
        {icon ?? <SparkleIcon size={30} />}
        <h3>{title}</h3>
        {body ? <p>{body}</p> : null}
        {children}
      </div>
    </div>
  )
}

/**
 * Mostra o que falta antes de a aba servir (sem voz, transcrição carregando, com erro ou ainda por fazer) e, com a
 * transcrição pronta, entrega as palavras a quem desenha a aba.
 */
export function TranscriptGate({ testId, copy, children }: { testId: string; copy: { title: string; body: string; cta: string }; children: (words: readonly Word[]) => ReactNode }) {
  const { transcript, reloadTranscript, text } = useEditor()
  const voice = useDoc((s) => s.project.sources.voice)

  if (!voice) return <PanelEmpty testId={testId} state="no-voice" icon={<TextIcon size={30} />} title={t.editor.text.noVoice.title} body={t.editor.text.noVoice.body} />

  if (transcript.status === 'loading') {
    return (
      <div className="panel" data-testid={testId} data-state="loading" aria-busy="true" aria-label={t.common.loading}>
        <div className="ps">
          <div className="skeleton h-5 w-40" />
          <div className="skeleton mt-3 h-24 w-full" />
        </div>
      </div>
    )
  }

  if (transcript.status === 'error') {
    return (
      <PanelEmpty testId={testId} state="error" icon={<AlertIcon size={30} />} title={t.editor.text.loadFailed} body={transcript.error ?? undefined}>
        <button type="button" className="btn" onClick={reloadTranscript} data-testid={`${testId}-reload`}>
          {t.editor.text.retry}
        </button>
      </PanelEmpty>
    )
  }

  const words = transcript.data?.words ?? []
  if (transcript.status !== 'ready' || words.length === 0) {
    return (
      <PanelEmpty testId={testId} state="no-transcript" icon={<TextIcon size={30} />} title={copy.title} body={copy.body}>
        <button type="button" className="btn" onClick={() => text.getState().requestTab('text')} data-testid={`${testId}-goto-text`}>
          {copy.cta}
        </button>
      </PanelEmpty>
    )
  }

  return <>{children(words)}</>
}

/** O aviso de que a IA não está disponível: o motivo, como ligar e o que funciona sem ela. */
export function AiOffNote({ ai, copy, testId }: { ai: AiAvailability; copy: { title: string; body: string }; testId: string }) {
  if (!ai.loaded || ai.available) return null
  return (
    <div className="ai-off" role="note" data-testid={testId}>
      <b>{copy.title}</b>
      {ai.detail ? <span>{ai.detail}</span> : null}
      <span>{copy.body}</span>
    </div>
  )
}
