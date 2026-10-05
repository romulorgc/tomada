/**
 * Aba PUBLICAR: textos prontos para copiar. YouTube (títulos, descrição, capítulos, tags) e, por corte vertical, legenda e
 * hashtags de TikTok, Reels e Shorts. A IA escreve; tudo é editável; os capítulos valem as regras do YouTube (primeiro em 00:00, pelo
 * menos 3, cada um com 10 s ou mais) e saem no tempo do vídeo FINAL (com os cortes de agora). Sem IA, os capítulos saem das pausas
 * e as legendas dos cortes, do gancho e das palavras que mais aparecem. O Tomada não publica nada sozinho: só copia e grava o .txt.
 */
import { useState } from 'react'
import { useStore } from 'zustand'
import { chapterLines, chaptersText, checkChapters, descriptionWithChapters, fallbackClipMeta, heuristicChapters, normalizeHashtags, normalizeTags, resolveClipMeta } from '@shared/publish'
import { keptRanges, outputDuration } from '@shared/timeline'
import type { Clip, ClipMeta, ProjectMeta, Word, YoutubeChapter } from '@shared/types'
import { AlertIcon, CheckIcon, CopyIcon, SparkleIcon } from '../../components/Icons'
import { t } from '../../i18n/pt-BR'
import { useApp } from '../../store'
import { Hint, Section } from '../controls'
import { useDoc, useEditor } from '../context'
import { useAiStatus } from '../ai-status'
import { AiOffNote, TranscriptGate } from './gates'

const T = t.editor.publish
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Copia para a área de transferência e avisa (o resultado nunca passa em silêncio). */
function useCopy(): (text: string) => void {
  const notify = useApp((s) => s.notify)
  return (text) => {
    window.tomada.clipboard.write(text).then(
      () => notify({ kind: 'info', text: T.copied }),
      (err: unknown) => notify({ kind: 'error', text: T.copyFailed, detail: messageOf(err) })
    )
  }
}

function CopyButton({ text, label = T.copy, testId, disabled }: { text: string; label?: string; testId: string; disabled?: boolean }) {
  const copy = useCopy()
  return (
    <button type="button" className="btn btn-ghost" disabled={disabled || text.trim() === ''} onClick={() => copy(text)} data-testid={testId}>
      <CopyIcon size={14} />
      {label}
    </button>
  )
}

/** Campo de lista (tags ou hashtags): digita à vontade e só confere ao sair do campo. */
function ListField({ id, label, hint, value, parse, join, onCommit, testId, placeholder }: { id: string; label: string; hint?: string; value: readonly string[]; parse: (text: string) => string[]; join: string; onCommit: (list: string[]) => void; testId: string; placeholder?: string }) {
  const shown = value.join(join)
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <div className="field-block">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="text-field"
        type="text"
        value={draft ?? shown}
        placeholder={placeholder}
        data-testid={testId}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) onCommit(parse(draft))
          setDraft(null)
        }}
      />
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}

function ClipPublish({ clip, words }: { clip: Clip; words: readonly Word[] }) {
  const { store } = useEditor()
  const meta = useDoc((s) => s.doc.meta?.perClip?.[clip.id])
  const stored = meta !== undefined && Boolean(meta.caption?.trim() || meta.tiktok?.length || meta.reels?.length || meta.shorts?.length || meta.hashtags?.length)
  const fallback = fallbackClipMeta(clip, words)
  const shown = resolveClipMeta(meta, fallback)

  const set = (patch: Partial<ClipMeta>, coalesce?: string): void => {
    store.getState().changeDoc(
      (doc) => ({ ...doc, meta: { ...doc.meta, perClip: { ...doc.meta?.perClip, [clip.id]: { ...doc.meta?.perClip?.[clip.id], ...patch } } } }),
      coalesce ? { coalesce: `publish-clip-${clip.id}-${coalesce}` } : undefined
    )
  }
  const tags = (list: readonly string[]): string => list.join(' ')
  const full = `${shown.caption ?? ''}\n\n${tags(shown.tiktok ?? [])}`.trim()
  const parse = (text: string): string[] => normalizeHashtags(text.split(/[\s,]+/), 10)

  return (
    <div className="pub-clip" data-testid="publish-clip" data-clip-id={clip.id}>
      <b className="pub-clip-title">{clip.title}</b>
      <div className="field-block">
        <label className="field-label" htmlFor={`pub-caption-${clip.id}`}>
          {T.clipCaption}
        </label>
        <textarea id={`pub-caption-${clip.id}`} className="text-field" rows={3} maxLength={2200} value={shown.caption ?? ''} data-testid="publish-clip-caption" onChange={(e) => set({ caption: e.target.value }, 'caption')} />
      </div>
      <ListField id={`pub-tiktok-${clip.id}`} label={T.tiktok} hint={T.hashtagsHelp} value={shown.tiktok ?? []} parse={parse} join=" " testId="publish-clip-tiktok" onCommit={(list) => set({ tiktok: list })} />
      <ListField id={`pub-reels-${clip.id}`} label={T.reels} value={shown.reels ?? []} parse={parse} join=" " testId="publish-clip-reels" onCommit={(list) => set({ reels: list })} />
      <ListField id={`pub-shorts-${clip.id}`} label={T.shorts} value={shown.shorts ?? []} parse={parse} join=" " testId="publish-clip-shorts" onCommit={(list) => set({ shorts: list })} />
      {!stored ? <Hint>{T.clipFallback}</Hint> : null}
      <CopyButton text={full} label={T.copyClip} testId="publish-clip-copy" />
    </div>
  )
}

function PublishBody({ words }: { words: readonly Word[] }) {
  const { store, ai: aiStore, detail, durationMs } = useEditor()
  const notify = useApp((s) => s.notify)
  const ai = useAiStatus()
  const ui = useStore(aiStore, (s) => s.publish)
  const meta = useDoc((s) => s.doc.meta)
  const cuts = useDoc((s) => s.doc.cuts)
  const clips = useDoc((s) => s.doc.clips)
  const [titleUsed, setTitleUsed] = useState<number | null>(null)

  const youtube = meta?.youtube
  const titles = youtube?.titles ?? []
  const description = youtube?.description ?? ''
  const tags = youtube?.tags ?? []
  const chapters = youtube?.chapters ?? []
  const kept = keptRanges(durationMs, cuts)
  const outMs = outputDuration(durationMs, cuts)
  const lines = chapterLines(chapters, kept)
  const check = checkChapters(lines, outMs)
  const withChapters = descriptionWithChapters(description, lines, outMs)

  const setYoutube = (patch: NonNullable<ProjectMeta['youtube']>, coalesce?: string): void => {
    store.getState().changeDoc((doc) => ({ ...doc, meta: { ...doc.meta, youtube: { ...doc.meta?.youtube, ...patch } } }), coalesce ? { coalesce: `publish-${coalesce}` } : undefined)
  }

  const generate = async (): Promise<void> => {
    if (ui.busy) return
    aiStore.getState().setPublish({ busy: true, error: null, notes: [] })
    try {
      await store.getState().flush()
      const r = await window.tomada.ai.publish(detail.id)
      store.getState().changeDoc((doc) => {
        const prev = doc.meta ?? {}
        const perClip = { ...prev.perClip }
        for (const [id, m] of Object.entries(r.clips)) if (doc.clips.some((c) => c.id === id)) perClip[id] = m
        return {
          ...doc,
          meta: {
            ...prev,
            youtube: { titles: r.titles, description: r.description, tags: r.tags, chapters: r.chapters.length > 0 ? r.chapters : (prev.youtube?.chapters ?? []) },
            perClip
          }
        }
      })
      aiStore.getState().setPublish({ busy: false, notes: r.notes, chaptersByPauses: false, chaptersWhy: null })
      setTitleUsed(null)
    } catch (err) {
      aiStore.getState().setPublish({ busy: false, error: messageOf(err) })
      notify({ kind: 'error', text: T.generateFailed, detail: messageOf(err) })
    }
  }

  const byPauses = (): void => {
    const r = heuristicChapters(words, durationMs, cuts)
    if (r.chapters.length === 0) {
      aiStore.getState().setPublish({ chaptersWhy: r.why ?? T.chaptersNone, chaptersByPauses: false })
      return
    }
    setYoutube({ chapters: r.chapters })
    aiStore.getState().setPublish({ chaptersByPauses: true, chaptersWhy: null })
  }

  // o título do projeto mora no documento (como na barra de cima): entra no desfazer e no salvamento
  const useTitle = (title: string, k: number): void => {
    store.getState().change((p) => ({ ...p, title: title.slice(0, 200) }), { coalesce: 'title' })
    setTitleUsed(k)
    notify({ kind: 'info', text: T.titleUsed })
  }

  const setChapterTitle = (start: number, title: string): void => {
    setYoutube({ chapters: chapters.map((c: YoutubeChapter) => (c.start === start ? { ...c, title } : c)) }, 'chapter-title')
  }

  return (
    <div className="panel" data-testid="publish-panel" data-state={ui.busy ? 'busy' : 'ready'}>
      <Section title={T.title} testId="publish-generate-section">
        <Hint>{T.help}</Hint>
        <AiOffNote ai={ai} copy={T.aiOff} testId="publish-ai-off" />
        <button type="button" className="btn btn-primary btn-wide" disabled={ui.busy || !ai.loaded || !ai.available} onClick={() => void generate()} data-testid="publish-generate">
          <SparkleIcon size={15} />
          {ui.busy ? T.generating : T.generate}
        </button>
        {ui.busy ? (
          <div className="meter indeterminate" role="progressbar" aria-label={T.generating} data-testid="publish-busy">
            <i />
          </div>
        ) : null}
        {ui.error ? (
          <p className="cq-message" data-tone="error" role="alert" data-testid="publish-error">
            {T.generateFailed}: {ui.error}
          </p>
        ) : null}
        {ui.notes.length > 0 ? (
          <p className="hint" data-tone="warn" data-testid="publish-notes">
            {T.notes(ui.notes.join('; '))}
          </p>
        ) : null}
      </Section>

      <Section title={T.youtube} testId="publish-youtube">
        <div className="field-block">
          <span className="field-label">{T.titles}</span>
          {titles.length === 0 ? <Hint>{T.noTitles}</Hint> : null}
          <ol className="pub-titles">
            {titles.map((title, k) => (
              <li key={k} className="pub-title" data-testid="publish-title-option">
                <input
                  className="text-field"
                  type="text"
                  value={title}
                  maxLength={100}
                  aria-label={T.titleOption(k + 1)}
                  data-testid="publish-title-input"
                  onChange={(e) => setYoutube({ titles: titles.map((x, j) => (j === k ? e.target.value : x)) }, `title-${k}`)}
                />
                <div className="cq-actions">
                  <CopyButton text={title} testId="publish-title-copy" />
                  <button type="button" className="btn btn-ghost" disabled={title.trim() === ''} onClick={() => useTitle(title.trim(), k)} data-testid="publish-title-use">
                    {titleUsed === k ? <CheckIcon size={14} /> : null}
                    {T.useTitle}
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="field-block">
          <label className="field-label" htmlFor="pub-description">
            {T.description}
          </label>
          <textarea id="pub-description" className="text-field" rows={6} maxLength={5000} value={description} placeholder={T.descriptionPlaceholder} data-testid="publish-description" onChange={(e) => setYoutube({ description: e.target.value }, 'description')} />
          <CopyButton text={withChapters.text} label={T.copyDescription} testId="publish-description-copy" />
        </div>

        <div className="field-block" data-testid="publish-chapters" data-valid={check.ok}>
          <span className="field-label">{T.chapters}</span>
          <Hint>{T.chaptersHelp}</Hint>
          {lines.length === 0 ? <Hint>{T.chaptersNone}</Hint> : null}
          <ol className="pub-chapters" data-testid="publish-chapter-list">
            {lines.map((l) => (
              <li key={`${l.start}-${l.time}`} data-testid="publish-chapter">
                <time className="tnum" data-testid="publish-chapter-time">
                  {l.time}
                </time>
                <input className="text-field" type="text" value={l.title} maxLength={60} aria-label={T.chapterTitle(l.time)} data-testid="publish-chapter-title" onChange={(e) => setChapterTitle(l.start, e.target.value)} />
              </li>
            ))}
          </ol>
          {lines.length > 0 ? (
            check.ok ? (
              <p className="hint ok" data-testid="publish-chapters-ok">
                <CheckIcon size={13} /> {T.chaptersOk}
              </p>
            ) : (
              <p className="hint" data-tone="warn" data-testid="publish-chapters-problems">
                <AlertIcon size={13} /> {T.chaptersProblems(check.problems.join('; '))}
              </p>
            )
          ) : null}
          {ui.chaptersByPauses && lines.length > 0 ? (
            <p className="hint" data-testid="publish-chapters-pauses-note">
              {T.chaptersPausesNote}
            </p>
          ) : null}
          {ui.chaptersWhy ? (
            <p className="hint" data-tone="warn" data-testid="publish-chapters-why">
              {ui.chaptersWhy}
            </p>
          ) : null}
          <div className="cq-actions">
            <button type="button" className="btn" onClick={byPauses} data-testid="publish-chapters-pauses">
              {T.chaptersByPauses}
            </button>
            <CopyButton text={chaptersText(lines)} testId="publish-chapters-copy" />
          </div>
        </div>

        <ListField id="pub-tags" label={T.tags} hint={T.tagsHelp} value={tags} parse={(text) => normalizeTags(text.split(','))} join=", " testId="publish-tags" onCommit={(list) => setYoutube({ tags: list })} />
        <CopyButton text={tags.join(', ')} testId="publish-tags-copy" />
      </Section>

      <Section title={T.perClip} testId="publish-per-clip">
        {clips.length === 0 ? (
          <Hint>{T.noClips}</Hint>
        ) : (
          <div className="pub-clips">
            {clips.map((c) => (
              <ClipPublish key={c.id} clip={c} words={words} />
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

export function PublishPanel() {
  return (
    <TranscriptGate testId="publish-panel" copy={T.noTranscript}>
      {(words) => <PublishBody words={words} />}
    </TranscriptGate>
  )
}
