/**
 * Aba Texto. Antes de existir transcrição ela é o caminho até uma: preparar (primeira vez), transcrever, acompanhar
 * o andamento, ver o erro e tentar de novo. Com a transcrição, tem duas metades: o TEXTO (palavras clicáveis,
 * seleção, busca, correção) e a LIMPEZA (silêncios, hesitações, muletas, recomeços).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { findMatches, struckWords } from '@shared/text-edit'
import { correctedTranscriptWords } from '@shared/dictionary-corrections'
import { AlertIcon, ChevronDownIcon, ChevronUpIcon, CrossIcon, SearchIcon, TextIcon } from '../../components/Icons'
import { TranscriptionPrepare } from '../../components/TranscriptionPrepare'
import { t } from '../../i18n/pt-BR'
import { isJobActive, useTranscription } from '../../transcription-store'
import { IconButton, Segmented } from '../controls'
import { useDoc, useEditor } from '../context'
import { useEditorOps } from '../ops'
import { CleanSection } from './CleanSection'
import { selectionRange, type TextPane } from './text-store'
import { TranscriptView } from './TranscriptView'

const T = t.editor.text

function Empty({ icon, title, body, children, testId }: { icon?: React.ReactNode; title: string; body?: string; children?: React.ReactNode; testId: string }) {
  return (
    <div className="panel" data-testid={testId}>
      <div className="empty-state">
        {icon ?? <TextIcon size={30} />}
        <h3>{title}</h3>
        {body ? <p>{body}</p> : null}
        {children}
      </div>
    </div>
  )
}

/** Busca (Ctrl+F): palavra ou frase, sem ligar para acento, caixa e pontuação. */
function SearchBar({ count, onStep }: { count: number; onStep: (dir: 1 | -1) => void }) {
  const { text } = useEditor()
  const query = useStore(text, (s) => s.query)
  const matchAt = useStore(text, (s) => s.matchAt)
  const tabRequest = useStore(text, (s) => s.tabRequest)
  const input = useRef<HTMLInputElement>(null)

  // abrir (ou pedir de novo com Ctrl+F) leva o foco ao campo
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [tabRequest])

  return (
    <div className="tx-search" role="search" data-testid="text-search">
      <SearchIcon size={14} />
      <input
        ref={input}
        type="search"
        value={query}
        placeholder={T.search.placeholder}
        aria-label={T.search.label}
        data-testid="text-search-input"
        onChange={(e) => text.getState().setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onStep(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            text.getState().closeSearch()
          }
        }}
      />
      <span className="tnum tx-search-count" data-testid="text-search-count" aria-live="polite">
        {query.trim().length === 0 ? '' : count === 0 ? T.search.none : T.search.count(matchAt + 1, count)}
      </span>
      <IconButton icon={<ChevronUpIcon size={14} />} label={T.search.prev} size="sm" disabled={count === 0} onClick={() => onStep(-1)} testId="text-search-prev" />
      <IconButton icon={<ChevronDownIcon size={14} />} label={T.search.next} size="sm" disabled={count === 0} onClick={() => onStep(1)} testId="text-search-next" />
      <IconButton icon={<CrossIcon size={14} />} label={T.search.close} size="sm" onClick={() => text.getState().closeSearch()} testId="text-search-close" />
    </div>
  )
}

/** Barra da seleção: apagar, restaurar e corrigir uma palavra apresentada (inclusive nome composto). */
function SelectionBar() {
  const { text, transcript } = useEditor()
  const ops = useEditorOps()
  const selection = useStore(text, (s) => s.selection)
  const editing = useStore(text, (s) => s.editing)
  const fixes = useDoc((s) => s.project.wordFixes)
  const corrections = useDoc((s) => s.project.review?.dictionaryCorrections)
  const words = transcript.data?.words ?? []
  const range = selectionRange(selection)
  const [draft, setDraft] = useState('')
  const shownWords = useMemo(() => correctedTranscriptWords(words, fixes, corrections), [words, fixes, corrections])
  const first = range ? words[range.from] : undefined, last = range ? words[range.to] : undefined
  const selectedWords = first && last ? shownWords.filter((w) => w.i >= first.i && w.i <= last.i) : []
  const single = range && first && last && (range.from === range.to || (selectedWords.length === 1 && selectedWords[0]!.i === first.i && selectedWords[0]!.end === last.end)) ? range.from : null

  useEffect(() => {
    if (editing === null) return
    const w = words[editing]
    setDraft(fixes?.[String(w?.i)] ?? w?.text.trim() ?? '')
    // só ao abrir o campo; o texto que a pessoa digita não pode ser sobrescrito
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  if (!range) return null
  const n = range.to - range.from + 1

  if (editing !== null && words[editing]) {
    const original = words[editing]!.text.trim()
    const save = (): void => {
      ops.fixWord(editing, draft, single === editing && range.to > range.from ? range.to : undefined)
      text.getState().edit(null)
    }
    return (
      <div className="tx-selbar tx-fix" data-testid="text-fix">
        <label htmlFor="word-fix">{T.fix.label}</label>
        <input
          id="word-fix"
          value={draft}
          autoFocus
          spellCheck
          data-testid="text-fix-input"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              save()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              text.getState().edit(null)
            }
          }}
        />
        <p className="ctl-note">{T.fix.hint}</p>
        <div className="tx-selbar-actions">
          <button type="button" className="btn btn-primary" onClick={save} data-testid="text-fix-save">
            {T.fix.save}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => text.getState().edit(null)}>
            {T.fix.cancel}
          </button>
          {fixes?.[String(words[editing]!.i)] !== undefined ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                ops.fixWord(editing, original)
                text.getState().edit(null)
              }}
              data-testid="text-fix-revert"
            >
              {T.fix.revert}
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="tx-selbar" data-testid="text-selection-bar" role="toolbar" aria-label={T.selection.count(n)}>
      <span className="tx-selbar-count tnum" data-testid="text-selection-count">
        {T.selection.count(n)}
      </span>
      <div className="tx-selbar-actions">
        <button type="button" className="btn" onClick={() => ops.cutWordSelection()} data-testid="text-cut">
          {T.selection.cut}
        </button>
        <button type="button" className="btn" onClick={() => ops.restoreWordSelection()} data-testid="text-restore">
          {T.selection.restore}
        </button>
        {single !== null ? (
          <button type="button" className="btn btn-ghost" onClick={() => text.getState().edit(single)} data-testid="text-fix-open">
            {T.fix.label}
          </button>
        ) : null}
        <IconButton icon={<CrossIcon size={14} />} label={T.selection.clear} size="sm" onClick={() => text.getState().select(null)} testId="text-selection-clear" />
      </div>
    </div>
  )
}

/** Palavras, quantas estão cortadas e o botão de busca. */
function Head({ total, struck }: { total: number; struck: number }) {
  const { text } = useEditor()
  const searchOpen = useStore(text, (s) => s.searchOpen)
  return (
    <div className="tx-head">
      <span className="tx-stats tnum" data-testid="text-stats">
        {T.words(total)}
        {struck > 0 ? ` · ${T.stats(struck, total)}` : ''}
      </span>
      <IconButton icon={<SearchIcon size={15} />} label={T.search.label} keys="Ctrl+F" size="sm" pressed={searchOpen} onClick={() => (searchOpen ? text.getState().closeSearch() : text.getState().openSearch())} testId="text-search-toggle" />
    </div>
  )
}

function TextPane() {
  const { text, transcript, durationMs } = useEditor()
  const ops = useEditorOps()
  const cuts = useDoc((s) => s.project.cuts)
  const searchOpen = useStore(text, (s) => s.searchOpen)
  const query = useStore(text, (s) => s.query)
  const matchAt = useStore(text, (s) => s.matchAt)
  const words = transcript.data?.words ?? []
  const struckCount = useMemo(() => struckWords(words, cuts).filter(Boolean).length, [words, cuts])
  const matches = useMemo(() => (searchOpen ? findMatches(words, query) : []), [words, query, searchOpen])

  const step = (dir: 1 | -1): void => {
    if (matches.length === 0) return
    const next = (matchAt + dir + matches.length) % matches.length
    text.getState().setMatchAt(next)
    ops.seekWord(matches[next]!.first)
  }

  return (
    <>
      <Head total={words.length} struck={struckCount} />
      {searchOpen ? <SearchBar count={matches.length} onStep={step} /> : null}
      <SelectionBar />
      <TranscriptView words={words} durationMs={durationMs} />
    </>
  )
}

export function TextPanel() {
  const { detail, transcript, reloadTranscript, text } = useEditor()
  const voice = useDoc((s) => s.project.sources.voice)
  const pane = useStore(text, (s) => s.pane)
  const view = useTranscription((s) => s.view)
  const job = useTranscription((s) => s.jobs[detail.id])
  const start = useTranscription((s) => s.start)
  const cancel = useTranscription((s) => s.cancel)

  if (!voice) return <Empty testId="text-panel" title={T.noVoice.title} body={T.noVoice.body} />

  if (transcript.status === 'loading') {
    return (
      <div className="panel" data-testid="text-panel" data-state="loading" aria-busy="true" aria-label={t.common.loading}>
        <div className="ps">
          <div className="skeleton h-5 w-40" />
          <div className="skeleton mt-3 h-24 w-full" />
        </div>
      </div>
    )
  }

  if (transcript.status === 'error') {
    return (
      <Empty testId="text-panel" icon={<AlertIcon size={30} />} title={T.loadFailed} body={transcript.error ?? undefined}>
        <button type="button" className="btn" onClick={reloadTranscript} data-testid="text-reload">
          {T.retry}
        </button>
      </Empty>
    )
  }

  if (transcript.status === 'ready' && transcript.data) {
    if (transcript.data.words.length === 0) {
      return (
        <Empty testId="text-panel" title={T.emptyResult.title} body={T.emptyResult.body}>
          <button type="button" className="btn" disabled={isJobActive(job)} onClick={() => void start(detail.id)} data-testid="text-transcribe">
            {T.transcribeAgain}
          </button>
        </Empty>
      )
    }
    return (
      <div className="tx" data-testid="text-panel" data-state="ready" data-pane={pane}>
        <div className="tx-panes">
          <Segmented<TextPane>
            label={T.title}
            value={pane}
            onChange={(v) => text.getState().setPane(v)}
            options={[
              { value: 'text', label: T.title, testId: 'text-pane-text' },
              { value: 'clean', label: t.editor.clean.title, testId: 'text-pane-clean' }
            ]}
          />
        </div>
        {pane === 'text' ? <TextPane /> : <CleanSection />}
      </div>
    )
  }

  // --- ainda não há texto: o caminho até ele ---------------------------------------------------------------------
  if (job && isJobActive(job)) {
    const pct = Math.round(job.fraction * 100)
    return (
      <Empty testId="text-panel" title={job.state === 'queued' ? T.queued : T.running(pct)}>
        <div className="prep-progress" data-testid="text-job" data-state={job.state}>
          <div className="meter big" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <span className="tnum prep-percent">{pct}%</span>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => void cancel(detail.id)} data-testid="text-job-cancel">
          {T.cancel}
        </button>
      </Empty>
    )
  }

  // terminou agora: o texto está sendo lido do disco (sem piscar o convite de transcrever)
  if (job?.state === 'done') {
    return (
      <div className="panel" data-testid="text-panel" data-state="loading" aria-busy="true" aria-label={t.common.loading}>
        <div className="ps">
          <div className="skeleton h-5 w-40" />
        </div>
      </div>
    )
  }

  if (job?.state === 'error') {
    return (
      <Empty testId="text-panel" icon={<AlertIcon size={30} />} title={T.failed} body={job.error}>
        <button type="button" className="btn" onClick={() => void start(detail.id)} data-testid="text-retry">
          {T.retry}
        </button>
      </Empty>
    )
  }

  if (!view) {
    return (
      <div className="panel" data-testid="text-panel" data-state="loading" aria-busy="true" aria-label={t.common.loading}>
        <div className="ps">
          <div className="skeleton h-5 w-40" />
        </div>
      </div>
    )
  }

  if (view.state === 'ready') {
    return (
      <Empty testId="text-panel" title={T.none.title} body={T.none.body}>
        <button type="button" className="btn btn-primary" onClick={() => void start(detail.id)} data-testid="text-transcribe">
          {T.none.cta}
        </button>
      </Empty>
    )
  }

  const preparing = view.state === 'preparing'
  return (
    <Empty testId="text-panel" title={preparing ? T.preparing.title : T.needsPrepare.title} body={preparing ? T.preparing.body : T.needsPrepare.body}>
      <div className="tx-prepare">
        <TranscriptionPrepare compact />
      </div>
    </Empty>
  )
}
