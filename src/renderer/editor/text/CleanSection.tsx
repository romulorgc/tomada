/**
 * Painel Limpeza (aba Texto): silêncio em três ritmos, hesitações, muletas (cortar, silenciar ou misto) e recomeços
 * que a IA aponta. Mostra a PRÉVIA do ganho ("Sai 2 min 14 s · de 12:30 para 10:16") com a mesma conta que aplica,
 * aplica tudo como UMA mudança desfazível e lista os cortes automáticos por motivo, cada um com "Restaurar".
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { computeClean, keptCutRanges, retakeCutMs, retakesNeedConfirmation, type CleanCategory, type FillerMode, type SilenceMode } from '@shared/clean'
import { planClean } from '@shared/clean-plan'
import { reenableCut, restoreCut } from '@shared/cuts'
import { formatDuration, formatSpan, formatTimecode } from '@shared/format'
import { wordIndexAt } from '@shared/text-edit'
import type { Cut, Mute, Word } from '@shared/types'
import { t } from '../../i18n/pt-BR'
import { useApp } from '../../store'
import { Hint, Segmented, Toggle } from '../controls'
import { useDoc, useEditor } from '../context'
import { applyClean, buildCleanInput } from './clean-actions'

const T = t.editor.clean
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const CATEGORY_ORDER: CleanCategory[] = ['silence', 'hesitation', 'gap-speech', 'crutch', 'retake']
const ROWS_STEP = 40

/** O que o corte cobre, em poucas palavras: as palavras que ele leva (ou "pausa de 1,2 s"). */
function cutLabel(cut: Pick<Cut, 'start' | 'end' | 'reason'>, words: readonly Word[]): string {
  if (cut.reason === 'silence') return T.review.pause(formatSpan(cut.end - cut.start))
  const picked: string[] = []
  for (let k = Math.max(0, wordIndexAt(words, cut.start)); k < words.length && picked.length < 6; k++) {
    const w = words[k]!
    if (w.start >= cut.end) break
    const mid = (w.start + w.end) / 2
    if (mid >= cut.start && mid < cut.end) picked.push(w.text.trim())
  }
  if (picked.length === 0) return formatSpan(cut.end - cut.start)
  return picked.length >= 6 ? `${picked.join(' ')}…` : picked.join(' ')
}

type Row = { id: string; start: number; end: number; enabled: boolean; label: string }

function ReviewGroup({
  title,
  rows,
  onSeek,
  onToggle,
  onToggleAll,
  testId
}: {
  title: string
  rows: Row[]
  onSeek: (ms: number) => void
  onToggle: (row: Row) => void
  onToggleAll: (enable: boolean) => void
  testId: string
}) {
  const [shown, setShown] = useState(ROWS_STEP)
  const on = rows.filter((r) => r.enabled).length
  const totalMs = rows.filter((r) => r.enabled).reduce((a, r) => a + (r.end - r.start), 0)
  return (
    <div className="rv-group" data-testid={testId}>
      <header>
        <h4>
          {title} <span className="tnum">· {T.review.item(rows.length)}</span>
        </h4>
        <span className="tnum rv-total" data-testid={`${testId}-total`}>
          {formatSpan(totalMs)}
        </span>
      </header>
      <ul className="rv-list">
        {rows.slice(0, shown).map((r) => (
          <li key={r.id} className="rv-row" data-enabled={r.enabled ? 'true' : 'false'} data-testid="review-row">
            <button type="button" className="rv-seek tnum" title={T.review.goTo} onClick={() => onSeek(r.start)}>
              {formatTimecode(r.start)}
            </button>
            <span className="rv-label" title={r.label}>
              {r.label}
              {r.enabled ? null : <em> · {T.review.disabled}</em>}
            </span>
            <button type="button" className="rv-act" onClick={() => onToggle(r)} data-testid="review-toggle">
              {r.enabled ? T.review.restore : T.review.enable}
            </button>
          </li>
        ))}
      </ul>
      {rows.length > shown ? (
        <button type="button" className="rv-more" onClick={() => setShown((n) => n + ROWS_STEP)}>
          {T.review.more(rows.length - shown)}
        </button>
      ) : null}
      <div className="rv-bulk">
        {on > 0 ? (
          <button type="button" className="rv-act" onClick={() => onToggleAll(false)} data-testid={`${testId}-restore-all`}>
            {T.review.restoreAll}
          </button>
        ) : null}
        {on < rows.length ? (
          <button type="button" className="rv-act" onClick={() => onToggleAll(true)} data-testid={`${testId}-enable-all`}>
            {T.review.enableAll}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function CleanSection() {
  const { store, text, transcript, levels, durationMs, detail, engineRef, screenActive } = useEditor()
  const notify = useApp((s) => s.notify)
  const project = useDoc((s) => s.project)
  const options = useStore(text, (s) => s.options)
  const retakes = useStore(text, (s) => s.retakes)
  const retakesStatus = useStore(text, (s) => s.retakesStatus)
  const retakesError = useStore(text, (s) => s.retakesError)
  const [confirming, setConfirming] = useState(false)
  const [autoClean, setAutoClean] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    void window.tomada.transcription
      .getPrefs()
      .then((p) => alive && setAutoClean(p.autoClean))
      .catch((err: unknown) => window.tomada.log({ level: 'error', message: 'Falha ao ler as preferências da transcrição', detail: messageOf(err) }))
    return () => {
      alive = false
    }
  }, [])

  const words = transcript.data?.words ?? null
  const input = useMemo(
    () => (transcript.data ? buildCleanInput(transcript.data, levels.data, durationMs, retakes?.retakes, { screenActive, fixedCuts: keptCutRanges({ cuts: project.cuts }, options) }) : null),
    [transcript.data, levels.data, durationMs, retakes, screenActive, project.cuts, options]
  )
  const result = useMemo(() => (input ? computeClean(input, options) : null), [input, options])
  const plan = useMemo(() => (result ? planClean({ cuts: project.cuts, ...(project.mutes ? { mutes: project.mutes } : {}) }, result, options, durationMs) : null), [result, project.cuts, project.mutes, options, durationMs])

  const needsConfirm = Boolean(options.retakes && retakes && words && retakesNeedConfirmation(words, retakes.retakes, durationMs))
  const retakePct = words && retakes ? Math.round((retakeCutMs(words, retakes.retakes, durationMs) / Math.max(1, durationMs)) * 100) : 0
  const levelsLoading = levels.status === 'loading'

  const setPref = async (v: boolean): Promise<void> => {
    setAutoClean(v)
    try {
      await window.tomada.transcription.setPrefs({ autoClean: v })
    } catch (err) {
      setAutoClean(!v)
      notify({ kind: 'error', text: t.settings.transcription.prefsFailed, detail: messageOf(err) })
    }
  }

  const findRetakes = async (): Promise<void> => {
    text.getState().setRetakes('loading', null)
    try {
      const r = await window.tomada.ai.retakes(detail.id)
      text.getState().setRetakes('ready', r)
      text.getState().setOptions({ retakes: r.retakes.length > 0 })
    } catch (err) {
      window.tomada.log({ level: 'error', message: 'Falha ao procurar recomeços', detail: messageOf(err) })
      text.getState().setRetakes('error', null, messageOf(err))
    }
  }

  const doApply = (): void => {
    if (!input) return
    setConfirming(false)
    const out = applyClean(store, input, options, durationMs)
    if (!out.applied) notify({ kind: 'info', text: T.nothingToApply })
    else notify({ kind: 'info', text: out.plan.deltaMs > 0 ? T.appliedSaved(formatSpan(out.plan.deltaMs)) : T.appliedMuteOnly })
  }
  const onApply = (): void => {
    if (needsConfirm && !confirming) setConfirming(true)
    else doApply()
  }

  // --- lista de cortes automáticos, por motivo ---------------------------------------------------------------
  const groups = useMemo(() => {
    const g: Record<'silence' | 'filler' | 'retake', Row[]> = { silence: [], filler: [], retake: [] }
    for (const c of project.cuts) {
      if (c.reason === 'silence' || c.reason === 'filler' || c.reason === 'retake') g[c.reason].push({ id: c.id, start: c.start, end: c.end, enabled: c.enabled, label: words ? cutLabel(c, words) : formatSpan(c.end - c.start) })
    }
    return g
  }, [project.cuts, words])
  const mutes = useMemo(
    () => (project.mutes ?? []).map((m: Mute): Row => ({ id: m.id, start: m.start, end: m.end, enabled: m.enabled, label: words ? cutLabel({ ...m, reason: 'filler' }, words) : formatSpan(m.end - m.start) })),
    [project.mutes, words]
  )

  const seek = (ms: number): void => engineRef.current?.seekSource(Math.max(0, ms - 500))
  const toggleCut = (r: Row): void => {
    store.getState().change((p) => ({ ...p, cuts: r.enabled ? restoreCut(p.cuts, r.id) : reenableCut(p.cuts, r.id) }))
  }
  const toggleCuts = (reason: 'silence' | 'filler' | 'retake', enable: boolean): void => {
    store.getState().change((p) => ({ ...p, cuts: p.cuts.map((c) => (c.reason === reason && c.enabled !== enable ? { ...c, enabled: enable } : c)) }))
  }
  const toggleMute = (r: Row): void => {
    store.getState().change((p) => ({ ...p, mutes: (p.mutes ?? []).map((m) => (m.id === r.id ? { ...m, enabled: !m.enabled } : m)) }))
  }
  const toggleMutes = (enable: boolean): void => {
    store.getState().change((p) => ({ ...p, mutes: (p.mutes ?? []).map((m) => (m.enabled === enable ? m : { ...m, enabled: enable })) }))
  }

  const silenceValue: SilenceMode | 'off' = options.silence ?? 'off'
  const fillerActive = options.hesitations || options.crutches
  const counts = result ? CATEGORY_ORDER.filter((c) => result.counts[c] > 0).map((c) => `${T.counts[c]}: ${result.counts[c]}`) : []
  const anyAuto = groups.silence.length + groups.filler.length + groups.retake.length + mutes.length > 0

  let previewText: string = T.preview.none
  if (plan && result) {
    if (plan.changed && plan.deltaMs > 0) previewText = T.preview.cut(formatSpan(plan.deltaMs), formatDuration(plan.fromMs), formatDuration(plan.toMs))
    else if (plan.changed && plan.deltaMs < 0) previewText = T.preview.back(formatSpan(-plan.deltaMs), formatDuration(plan.fromMs), formatDuration(plan.toMs))
    else if (plan.changed && result.muteMs > 0) previewText = T.preview.mute(formatSpan(result.muteMs))
    else if (plan.changed) previewText = T.preview.cut(formatSpan(0), formatDuration(plan.fromMs), formatDuration(plan.toMs))
  }

  return (
    <section className="tx-clean" data-testid="clean-section" aria-label={T.title}>
      <div className="tx-clean-body">
        <p className="ctl-note">{T.help}</p>

        <div className="ctl">
          <div className="ctl-head">
            <span>{T.silence.label}</span>
          </div>
          <Segmented<SilenceMode | 'off'>
            label={T.silence.label}
            value={silenceValue}
            onChange={(v) => text.getState().setOptions({ silence: v === 'off' ? null : v })}
            options={[
              { value: 'off', label: T.silence.off, testId: 'clean-silence-off' },
              { value: 'tutorial', label: T.silence.tutorial, testId: 'clean-silence-tutorial' },
              { value: 'natural', label: T.silence.natural, testId: 'clean-silence-natural' },
              { value: 'fast', label: T.silence.fast, testId: 'clean-silence-fast' },
              { value: 'faster', label: T.silence.faster, testId: 'clean-silence-faster' }
            ]}
          />
          {options.silence ? <p className="ctl-note">{T.silence.hint[options.silence]}</p> : null}
        </div>

        <Toggle label={T.hesitations.label} hint={T.hesitations.hint} checked={options.hesitations} onChange={(v) => text.getState().setOptions({ hesitations: v })} testId="clean-hesitations" />
        <Toggle
          label={T.crutches.label}
          hint={`${T.crutches.hint} · ${result ? T.crutches.count(result.suggestedCrutches) : ''}`}
          checked={options.crutches}
          onChange={(v) => text.getState().setOptions({ crutches: v })}
          testId="clean-crutches"
        />

        {fillerActive ? (
          <div className="ctl">
            <div className="ctl-head">
              <span>{T.mode.label}</span>
            </div>
            <Segmented<FillerMode>
              label={T.mode.label}
              value={options.fillerMode}
              onChange={(v) => text.getState().setOptions({ fillerMode: v })}
              options={[
                { value: 'cut', label: T.mode.cut, testId: 'clean-mode-cut' },
                { value: 'mute', label: T.mode.mute, testId: 'clean-mode-mute' },
                { value: 'mixed', label: T.mode.mixed, testId: 'clean-mode-mixed' }
              ]}
            />
            <p className="ctl-note">{T.mode.hint}</p>
          </div>
        ) : null}

        <div className="ctl">
          <Toggle
            label={T.retakes.include}
            hint={retakes ? T.retakes.found(retakes.retakes.length) : T.retakes.hint}
            checked={options.retakes}
            disabled={!retakes || retakes.retakes.length === 0}
            onChange={(v) => text.getState().setOptions({ retakes: v })}
            testId="clean-retakes"
          />
          <button type="button" className="btn btn-wide" disabled={retakesStatus === 'loading'} onClick={() => void findRetakes()} data-testid="clean-find-retakes">
            {retakesStatus === 'loading' ? <span className="spinner" aria-hidden="true" /> : null}
            {retakesStatus === 'loading' ? T.retakes.finding : T.retakes.find}
          </button>
          {retakesStatus === 'error' ? (
            <p className="hint" data-tone="warn" role="alert" data-testid="clean-retakes-error">
              {T.retakes.failed}
              {retakesError ? `: ${retakesError}` : ''}
            </p>
          ) : null}
          {retakes && retakes.dropped > 0 ? <p className="ctl-note">{T.retakes.dropped(retakes.dropped)}</p> : null}
        </div>

        {levelsLoading ? <Hint>{T.levelsLoading}</Hint> : null}
        {levels.status === 'error' ? <Hint tone="warn">{T.levelsFailed}</Hint> : null}

        <div className="clean-preview" data-testid="clean-preview" data-changed={plan?.changed ? 'true' : 'false'} aria-live="polite">
          <strong className="tnum" data-testid="clean-preview-text">
            {previewText}
          </strong>
          {counts.length > 0 ? (
            <span className="ctl-note" data-testid="clean-counts">
              {counts.join(' · ')}
            </span>
          ) : null}
        </div>

        {confirming && needsConfirm ? (
          <div className="confirm" role="alertdialog" aria-label={T.retakes.confirm.title} data-testid="clean-confirm">
            <p>
              <strong>{T.retakes.confirm.title}.</strong> {T.retakes.confirm.body(retakePct)}
            </p>
            <div className="confirm-actions">
              <button type="button" className="btn btn-primary" onClick={doApply} data-testid="clean-confirm-ok">
                {T.retakes.confirm.ok}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
                {t.common.cancel}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-primary btn-wide" disabled={!plan?.changed || levelsLoading} onClick={onApply} data-testid="clean-apply">
            {T.apply}
          </button>
        )}

        {autoClean !== null ? <Toggle label={T.auto.label} hint={T.auto.hint} checked={autoClean} onChange={(v) => void setPref(v)} testId="clean-auto" /> : null}

        <div className="rv" data-testid="clean-review">
          <h3 className="rv-title">{T.review.title}</h3>
          {anyAuto ? null : <p className="ctl-note">{T.review.none}</p>}
          {groups.silence.length > 0 ? (
            <ReviewGroup title={T.review.reasons.silence} rows={groups.silence} onSeek={seek} onToggle={toggleCut} onToggleAll={(e) => toggleCuts('silence', e)} testId="review-silence" />
          ) : null}
          {groups.filler.length > 0 ? (
            <ReviewGroup title={T.review.reasons.filler} rows={groups.filler} onSeek={seek} onToggle={toggleCut} onToggleAll={(e) => toggleCuts('filler', e)} testId="review-filler" />
          ) : null}
          {groups.retake.length > 0 ? (
            <ReviewGroup title={T.review.reasons.retake} rows={groups.retake} onSeek={seek} onToggle={toggleCut} onToggleAll={(e) => toggleCuts('retake', e)} testId="review-retake" />
          ) : null}
          {mutes.length > 0 ? <ReviewGroup title={T.review.mutes} rows={mutes} onSeek={seek} onToggle={toggleMute} onToggleAll={toggleMutes} testId="review-mutes" /> : null}
        </div>
      </div>
    </section>
  )
}
