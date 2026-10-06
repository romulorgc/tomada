/**
 * Aba CORTES: sugere cortes verticais (a IA, ou a heurística quando não há IA), lista cada um com nota e duração, deixa ver, ajustar
 * (título, gancho, layout, legenda, começo e fim de frase em frase) e apagar, e exporta os marcados em lote numa fila com
 * progresso, cancelar e "tentar de novo". A lista mora no documento (`project.clips`): criar, editar e apagar entram no desfazer.
 * O que não vai para o documento (marcados, aberto, em prévia, andamento) mora em `clips-store`.
 */
import { useMemo } from 'react'
import { useStore } from 'zustand'
import { CAPTION_STYLE_IDS } from '@shared/caption-style'
import { queueSummary, type QueueItem } from '@shared/clip-queue'
import { CLIP_ACCEPT_MAX_MS, CLIP_ACCEPT_MIN_MS, HOOK_MAX_WORDS, clipOutputMs, clipText, hookWords, mergeSuggestedClips, shiftClipEdge } from '@shared/clips'
import { formatSpan, formatTimecode } from '@shared/format'
import type { CaptionStyleId, Clip, Project, VerticalLayout, Word } from '@shared/types'
import { AlertIcon, ClipsIcon, FolderIcon, PlayIcon, SparkleIcon, TrashIcon } from '../../components/Icons'
import { t } from '../../i18n/pt-BR'
import { useApp } from '../../store'
import { Hint, Segmented, Section } from '../controls'
import { useDoc, useEditor } from '../context'
import { useAiStatus } from '../ai-status'
import { AiOffNote, TranscriptGate } from './gates'

const T = t.editor.clips
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const LAYOUTS: VerticalLayout[] = ['auto', 'screen-center', 'screen-focus', 'stack', 'presenter', 'screen-wide', 'camera']

/** Troca um corte da lista do documento (os outros ficam como estão). */
const mapClip = (doc: Project, id: string, fn: (c: Clip) => Clip): Project => ({ ...doc, clips: doc.clips.map((c) => (c.id === id ? fn(c) : c)) })

function QueueRow({ item }: { item: QueueItem }) {
  const { queue } = useEditor()
  const notify = useApp((s) => s.notify)
  const running = useStore(queue, (s) => s.running)
  const pct = Math.round(item.fraction * 100)
  const path = item.outputPath
  const run = (what: 'open' | 'reveal'): void => {
    if (!path) return
    const call = what === 'open' ? window.tomada.files.open(path) : window.tomada.files.reveal(path)
    call.catch((err: unknown) => notify({ kind: 'error', text: what === 'open' ? T.queue.openFailed : T.queue.revealFailed, detail: messageOf(err) }))
  }
  return (
    <li className="clip-queue-item" data-testid="clip-queue-item" data-state={item.state} data-clip-id={item.clipId}>
      <div className="cq-head">
        <b>{`${String(item.number).padStart(2, '0')} · ${item.title}`}</b>
        <span className="cq-state" data-state={item.state}>
          {T.queue.state[item.state]}
          {item.state === 'running' ? ` ${pct}%` : ''}
        </span>
      </div>
      {item.state === 'running' || item.state === 'queued' ? (
        <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.state === 'queued' ? 0 : pct}>
          <i style={{ width: `${item.state === 'queued' ? 0 : pct}%` }} />
        </div>
      ) : null}
      {item.message ? (
        <p className="cq-message" data-tone={item.state === 'done' ? 'warn' : 'error'} role={item.state === 'error' ? 'alert' : undefined} data-testid="clip-queue-message">
          {item.message}
        </p>
      ) : null}
      {item.state === 'done' && path ? (
        <div className="cq-actions">
          <button type="button" className="btn btn-ghost" onClick={() => run('open')} data-testid="clip-queue-open">
            <PlayIcon size={14} />
            {T.queue.open}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => run('reveal')} data-testid="clip-queue-reveal">
            <FolderIcon size={14} />
            {T.queue.reveal}
          </button>
        </div>
      ) : null}
      {item.state === 'error' || item.state === 'cancelled' ? (
        <div className="cq-actions">
          <button type="button" className="btn btn-ghost" disabled={running} onClick={() => void queue.getState().retry([item.clipId])} data-testid="clip-queue-retry">
            {T.queue.retry}
          </button>
        </div>
      ) : null}
    </li>
  )
}

function Queue() {
  const { queue } = useEditor()
  const items = useStore(queue, (s) => s.items)
  const running = useStore(queue, (s) => s.running)
  const cancelling = useStore(queue, (s) => s.cancelling)
  if (items.length === 0) return null
  const sum = queueSummary(items)
  const notDone = sum.failed + sum.cancelled
  return (
    <Section title={T.queue.title} testId="clip-queue">
      <p className="hint" data-testid="clip-queue-summary" aria-live="polite">
        {T.queue.summary(sum.done, sum.failed, sum.cancelled, sum.total)}
      </p>
      <ul className="clip-queue-list">
        {items.map((it) => (
          <QueueRow key={it.clipId} item={it} />
        ))}
      </ul>
      <div className="cq-actions">
        {running ? (
          <button type="button" className="btn" disabled={cancelling} onClick={() => void queue.getState().cancel()} data-testid="clips-queue-cancel">
            {cancelling ? T.queue.cancelling : T.queue.cancel}
          </button>
        ) : (
          <>
            {notDone > 1 ? (
              <button type="button" className="btn" onClick={() => void queue.getState().retry()} data-testid="clips-queue-retry-all">
                {T.queue.retryAll(notDone)}
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost" onClick={() => queue.getState().clear()} data-testid="clips-queue-clear">
              {T.queue.clear}
            </button>
          </>
        )}
      </div>
    </Section>
  )
}

function ClipCard({ clip, number, words }: { clip: Clip; number: number; words: readonly Word[] }) {
  const { store, clips, durationMs } = useEditor()
  const cuts = useDoc((s) => s.doc.cuts)
  const format = useDoc((s) => s.format)
  const selected = useStore(clips, (s) => s.selected.includes(clip.id))
  const open = useStore(clips, (s) => s.openId === clip.id)
  const previewing = useStore(clips, (s) => s.previewId === clip.id)
  const outMs = clipOutputMs(clip.ranges, cuts, durationMs)
  const outOfRange = outMs < CLIP_ACCEPT_MIN_MS || outMs > CLIP_ACCEPT_MAX_MS
  const tooManyWords = hookWords(clip.hook) > HOOK_MAX_WORDS

  // o que o ajuste de começo e fim de frase pode fazer (só calculado com o corte aberto)
  const moves = useMemo(() => {
    if (!open) return null
    return {
      startEarlier: shiftClipEdge(clip, words, 'start', -1, durationMs),
      startLater: shiftClipEdge(clip, words, 'start', 1, durationMs),
      endEarlier: shiftClipEdge(clip, words, 'end', -1, durationMs),
      endLater: shiftClipEdge(clip, words, 'end', 1, durationMs)
    }
  }, [open, clip, words, durationMs])
  const text = useMemo(() => (open ? clipText(clip.ranges, words) : ''), [open, clip.ranges, words])

  const edit = (fn: (c: Clip) => Clip, coalesce?: string): void => {
    store.getState().changeDoc((doc) => mapClip(doc, clip.id, fn), coalesce ? { coalesce: `clip-${clip.id}-${coalesce}` } : undefined)
  }
  const move = (key: keyof NonNullable<typeof moves>): void => {
    const next = moves?.[key]
    if (next) edit(() => next)
  }
  const togglePreview = (): void => {
    if (previewing) {
      clips.getState().preview(null)
      return
    }
    if (format !== 'vertical') store.getState().setFormat('vertical')
    clips.getState().preview(clip.id)
  }
  const remove = (): void => {
    clips.getState().forget(clip.id)
    store.getState().changeDoc((doc) => {
      const perClip = doc.meta?.perClip
      const meta = perClip && clip.id in perClip ? { ...doc.meta, perClip: Object.fromEntries(Object.entries(perClip).filter(([k]) => k !== clip.id)) } : doc.meta
      const next: Project = { ...doc, clips: doc.clips.filter((c) => c.id !== clip.id) }
      if (meta) next.meta = meta
      return next
    })
  }

  return (
    <li className="clip-card" data-testid="clip-card" data-clip-id={clip.id} data-selected={selected} data-previewing={previewing} data-open={open}>
      <div className="cc-top">
        <label className="cc-check">
          <input type="checkbox" checked={selected} onChange={() => clips.getState().toggle(clip.id)} aria-label={T.card.select(clip.title)} data-testid="clip-select" />
        </label>
        <div className="cc-main">
          <div className="cc-title">
            <b data-testid="clip-title">{`${number}. ${clip.title}`}</b>
          </div>
          <div className="cc-meta">
            <span className="chip" data-testid="clip-duration" data-tone={outOfRange ? 'warn' : undefined}>
              {formatSpan(outMs)}
            </span>
            {clip.score > 0 ? <span className="chip">{T.card.score(clip.score)}</span> : null}
            {clip.notes ? <span className="cc-notes">{T.card.notes(clip.notes.hook, clip.notes.flow, clip.notes.value)}</span> : null}
            <span className="chip" data-source={clip.source ?? 'manual'}>
              {T.card.source[clip.source ?? 'manual']}
            </span>
          </div>
          {clip.hook ? (
            <p className="cc-hook" data-testid="clip-hook">
              “{clip.hook}”
            </p>
          ) : null}
        </div>
      </div>
      <div className="cc-actions">
        <button type="button" className="btn btn-ghost" aria-pressed={previewing} onClick={togglePreview} data-testid="clip-preview">
          <PlayIcon size={14} />
          {previewing ? T.card.stopPreview : T.card.preview}
        </button>
        <button type="button" className="btn btn-ghost" aria-expanded={open} onClick={() => clips.getState().open(open ? null : clip.id)} data-testid="clip-edit-toggle">
          {open ? T.card.close : T.card.edit}
        </button>
        <button type="button" className="btn btn-danger-ghost" onClick={remove} data-testid="clip-delete" aria-label={`${T.card.remove}: ${clip.title}`}>
          <TrashIcon size={14} />
          {T.card.remove}
        </button>
      </div>
      {open ? (
        <div className="cc-edit" data-testid="clip-edit">
          {outOfRange ? <Hint tone="warn">{T.edit.outOfRange(formatSpan(outMs))}</Hint> : null}
          {clip.reason ? (
            <p className="cc-reason">
              <b>{T.edit.reason}: </b>
              {clip.reason}
            </p>
          ) : null}
          <div className="field-block">
            <label className="field-label" htmlFor={`clip-title-${clip.id}`}>
              {T.edit.title}
            </label>
            <input id={`clip-title-${clip.id}`} className="text-field" type="text" value={clip.title} maxLength={80} data-testid="clip-title-input" onChange={(e) => edit((c) => ({ ...c, title: e.target.value }), 'title')} />
          </div>
          <div className="field-block">
            <label className="field-label" htmlFor={`clip-hook-${clip.id}`}>
              {T.edit.hook}
            </label>
            <input id={`clip-hook-${clip.id}`} className="text-field" type="text" value={clip.hook} maxLength={80} data-testid="clip-hook-input" onChange={(e) => edit((c) => ({ ...c, hook: e.target.value }), 'hook')} />
            <span className="hint" data-testid="clip-hook-count">
              {T.edit.hookCount(hookWords(clip.hook), HOOK_MAX_WORDS)}
            </span>
            {tooManyWords ? <Hint tone="warn">{T.edit.hookTooLong}</Hint> : null}
          </div>
          <div className="field-block">
            <span className="field-label">{T.edit.layout}</span>
            <Segmented<VerticalLayout>
              label={T.edit.layout}
              value={clip.layoutV}
              columns={3}
              onChange={(v) => edit((c) => ({ ...c, layoutV: v }))}
              options={LAYOUTS.map((l) => ({ value: l, label: T.edit.layouts[l], testId: `clip-layout-${l}` }))}
            />
            <span className="hint">{T.edit.layoutHint}</span>
          </div>
          <div className="field-block">
            <label className="field-label" htmlFor={`clip-captions-${clip.id}`}>
              {T.edit.captions}
            </label>
            <select
              id={`clip-captions-${clip.id}`}
              className="text-field"
              value={clip.captionStyle ?? ''}
              data-testid="clip-captions-select"
              onChange={(e) =>
                edit((c) => {
                  const { captionStyle: _drop, ...rest } = c
                  void _drop
                  return e.target.value === '' ? rest : { ...rest, captionStyle: e.target.value as CaptionStyleId }
                })
              }
            >
              <option value="">{T.edit.captionsInherit}</option>
              {CAPTION_STYLE_IDS.map((id) => (
                <option key={id} value={id}>
                  {t.editor.captions.styles[id].name}
                </option>
              ))}
            </select>
          </div>
          <div className="field-block">
            <span className="field-label">{T.edit.ranges}</span>
            <ol className="cc-ranges" data-testid="clip-ranges">
              {clip.ranges.map((r, k) => (
                <li key={k}>{T.edit.range(k + 1, formatTimecode(r.start), formatTimecode(r.end))}</li>
              ))}
            </ol>
            <div className="cc-nudge">
              <button type="button" className="btn btn-ghost" disabled={!moves?.startEarlier} title={moves?.startEarlier ? undefined : T.edit.cannotMove} onClick={() => move('startEarlier')} data-testid="clip-start-earlier">
                {T.edit.startEarlier}
              </button>
              <button type="button" className="btn btn-ghost" disabled={!moves?.startLater} title={moves?.startLater ? undefined : T.edit.cannotMove} onClick={() => move('startLater')} data-testid="clip-start-later">
                {T.edit.startLater}
              </button>
              <button type="button" className="btn btn-ghost" disabled={!moves?.endEarlier} title={moves?.endEarlier ? undefined : T.edit.cannotMove} onClick={() => move('endEarlier')} data-testid="clip-end-earlier">
                {T.edit.endEarlier}
              </button>
              <button type="button" className="btn btn-ghost" disabled={!moves?.endLater} title={moves?.endLater ? undefined : T.edit.cannotMove} onClick={() => move('endLater')} data-testid="clip-end-later">
                {T.edit.endLater}
              </button>
            </div>
          </div>
          <div className="field-block">
            <span className="field-label">{T.edit.text}</span>
            <p className="cc-text" data-testid="clip-text">
              {text}
            </p>
          </div>
        </div>
      ) : null}
    </li>
  )
}

function ClipsBody({ words }: { words: readonly Word[] }) {
  const { store, clips, queue, detail, exporter } = useEditor()
  const notify = useApp((s) => s.notify)
  const ai = useAiStatus()
  const list = useDoc((s) => s.doc.clips)
  const status = useStore(clips, (s) => s.status)
  const error = useStore(clips, (s) => s.error)
  const last = useStore(clips, (s) => s.last)
  const selected = useStore(clips, (s) => s.selected)
  const running = useStore(queue, (s) => s.running)
  const previewId = useStore(clips, (s) => s.previewId)
  const previewTitle = list.find((c) => c.id === previewId)?.title
  const loading = status === 'loading'
  const hasWords = words.length > 0

  const suggest = async (mode: 'auto' | 'heuristic'): Promise<void> => {
    if (loading) return
    clips.getState().setStatus('loading')
    try {
      await store.getState().flush()
      const r = await window.tomada.ai.clips(detail.id, mode)
      let skipped = 0
      let added = 0
      // a lista de agora (pode ter mudado durante a espera): só entra o que não repete um corte que já existe
      store.getState().changeDoc((doc) => {
        const merged = mergeSuggestedClips(doc.clips, r.clips)
        skipped = merged.skipped
        added = merged.added.length
        return merged.added.length > 0 ? { ...doc, clips: merged.clips } : doc
      })
      clips.getState().setLast({ source: r.source, added, skipped, dropped: r.dropped, notice: r.notice })
      clips.getState().setStatus('ready')
    } catch (err) {
      clips.getState().setStatus('error', messageOf(err))
      notify({ kind: 'error', text: T.failed, detail: messageOf(err) })
    }
  }

  const startExport = (): void => {
    const entries = list.flatMap((c, k) => (selected.includes(c.id) ? [{ clipId: c.id, title: c.title, number: k + 1 }] : []))
    if (entries.length === 0) return
    void queue.getState().start(entries)
  }

  const allIds = list.map((c) => c.id)
  const picked = selected.filter((id) => allIds.includes(id))

  return (
    <div className="panel" data-testid="clips-panel" data-state={loading ? 'loading' : 'ready'}>
      {previewTitle ? (
        <div className="clips-previewing" data-testid="clips-previewing">
          <span>{T.preview.banner(previewTitle)}</span>
          <button type="button" className="btn btn-ghost" onClick={() => clips.getState().preview(null)} data-testid="clip-preview-exit">
            {T.preview.exit}
          </button>
        </div>
      ) : null}
      <Section title={T.title} testId="clips-suggest-section">
        <Hint>{T.help}</Hint>
        <AiOffNote ai={ai} copy={T.aiOff} testId="clips-ai-off" />
        <div className="clips-actions">
          <button type="button" className="btn btn-primary btn-wide" disabled={loading || !hasWords} onClick={() => void suggest('auto')} data-testid="clips-suggest">
            <SparkleIcon size={15} />
            {loading ? T.suggesting : list.length > 0 ? T.suggestMore : T.suggest}
          </button>
          {ai.loaded && ai.available ? (
            <button type="button" className="btn btn-ghost btn-wide" disabled={loading || !hasWords} title={T.suggestNoAiHint} onClick={() => void suggest('heuristic')} data-testid="clips-suggest-heuristic">
              {T.suggestNoAi}
            </button>
          ) : null}
        </div>
        {loading ? (
          <div className="meter indeterminate" role="progressbar" aria-label={T.suggesting} data-testid="clips-loading">
            <i />
          </div>
        ) : null}
        {status === 'error' && error ? (
          <p className="cq-message" data-tone="error" role="alert" data-testid="clips-error">
            {T.failed}: {error}
          </p>
        ) : null}
        {last && !loading ? (
          <div className="clips-last" data-testid="clips-last" data-source={last.source}>
            <p>{last.added === 0 ? (last.skipped > 0 ? T.noneNew : T.none) : last.source === 'ai' ? T.found.ai(last.added) : T.found.heuristic(last.added)}</p>
            {last.skipped > 0 ? <p className="hint">{T.skipped(last.skipped)}</p> : null}
            {last.notice ? (
              <p className="hint" data-tone="warn" data-testid="clips-notice">
                {last.notice}
              </p>
            ) : null}
            {last.dropped.length > 0 ? <Dropped dropped={last.dropped} /> : null}
          </div>
        ) : null}
      </Section>

      <Section title={list.length > 0 ? T.listTitle(list.length) : T.title} testId="clips-list-section">
        {list.length === 0 ? (
          <div className="empty-state compact" data-testid="clips-empty">
            <ClipsIcon size={26} />
            <h3>{T.empty.title}</h3>
            <p>{T.empty.body}</p>
          </div>
        ) : (
          <>
            <div className="clips-select-bar">
              <span data-testid="clips-selected-count">{T.export.selected(picked.length)}</span>
              <button type="button" className="link" onClick={() => clips.getState().select(picked.length === allIds.length ? [] : allIds)} data-testid="clips-select-all">
                {picked.length === allIds.length ? T.export.selectNone : T.export.selectAll}
              </button>
            </div>
            <ul className="clip-list" data-testid="clip-list">
              {list.map((c, k) => (
                <ClipCard key={c.id} clip={c} number={k + 1} words={words} />
              ))}
            </ul>
          </>
        )}
      </Section>

      {list.length > 0 ? (
        <Section title={T.export.title} testId="clips-export-section">
          <Hint>{T.export.help}</Hint>
          {exporter.busy ? <Hint tone="warn">{T.export.busy}</Hint> : null}
          <button type="button" className="btn btn-primary btn-wide" disabled={picked.length === 0 || running || exporter.busy} onClick={startExport} data-testid="clips-export-selected">
            {picked.length === 0 ? T.export.buttonNone : T.export.button(picked.length)}
          </button>
        </Section>
      ) : null}

      <Queue />
    </div>
  )
}

function Dropped({ dropped }: { dropped: { title: string; why: string }[] }) {
  return (
    <details className="clips-dropped" data-testid="clips-dropped">
      <summary>
        <AlertIcon size={13} /> {T.dropped(dropped.length)}
      </summary>
      <ul>
        {dropped.map((d, k) => (
          <li key={k}>
            <b>{d.title || '—'}</b>: {d.why}
          </li>
        ))}
      </ul>
    </details>
  )
}

export function ClipsPanel() {
  return (
    <TranscriptGate testId="clips-panel" copy={T.noTranscript}>
      {(words) => <ClipsBody words={words} />}
    </TranscriptGate>
  )
}
