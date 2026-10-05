import { useState } from 'react'
import { videoScriptSchema, type VideoScript } from '@shared/script'
import type { RecordPrefs } from '@shared/recording'
import { t } from '../i18n/pt-BR'

export function ScriptPanel({ script, onChange, prefs, setPrefs, disabled }: { script: VideoScript | null; onChange(script: VideoScript | null): void; prefs: RecordPrefs; setPrefs(patch: Partial<RecordPrefs>): void; disabled: boolean }) {
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generate = async () => {
    setBusy(true); setError(null)
    try { onChange(await window.tomada.ai.script(topic)) } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }
  const valid = script ? videoScriptSchema.safeParse(script).success : false
  const patch = (change: Partial<VideoScript>) => { if (script) onChange({ ...script, ...change }) }
  const showPrompter = async () => {
    if (!script || !valid) return
    try { await window.tomada.teleprompter.show({ script, ...prefs.teleprompter }); setError(null) } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }
  return <section className="mt-7 grid gap-3 rounded-dialog border border-line bg-surface p-5" aria-label={t.preparation.script} data-testid="script-panel">
    <label className="grid gap-2 text-[0.9375rem] font-medium">{t.preparation.topic}<textarea className="field min-h-16 resize-y font-normal" value={topic} maxLength={2000} disabled={disabled || busy} onChange={(e) => setTopic(e.target.value)} placeholder={t.preparation.topicHint} data-testid="script-topic" /></label>
    <button className="btn justify-self-start" type="button" disabled={disabled || busy || !topic.trim()} onClick={() => void generate()} data-testid="script-generate">{busy ? t.preparation.generating : error ? t.common.retry : t.preparation.generate}</button>
    {error ? <p className="text-danger text-[0.8125rem]" role="alert" data-testid="script-error">{t.preparation.failed}: {error}</p> : null}
    {script ? <>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="grid gap-1 text-[0.8125rem] text-muted">{t.preparation.title}<input className="field" value={script.title} maxLength={180} disabled={disabled} onChange={(e) => patch({ title: e.target.value })} data-testid="script-title" /></label>
        <label className="grid gap-1 text-[0.8125rem] text-muted">{t.preparation.hook}<input className="field" value={script.hook} maxLength={500} disabled={disabled} onChange={(e) => patch({ hook: e.target.value })} data-testid="script-hook" /></label>
      </div>
      <label className="grid gap-1 text-[0.8125rem] text-muted">{t.preparation.topics}<textarea className="field min-h-28 resize-y" value={script.topics.join('\n')} disabled={disabled} onChange={(e) => patch({ topics: e.target.value.split('\n') })} data-testid="script-topics" /></label>
      <label className="grid gap-1 text-[0.8125rem] text-muted">{t.preparation.closing}<input className="field" value={script.closing} maxLength={500} disabled={disabled} onChange={(e) => patch({ closing: e.target.value })} data-testid="script-closing" /></label>
      {!valid ? <p className="text-danger text-[0.8125rem]">{t.preparation.invalid}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[0.8125rem] text-muted">{t.preparation.mode}<select className="field" value={prefs.teleprompter.mode} disabled={disabled} onChange={(e) => setPrefs({ teleprompter: { ...prefs.teleprompter, mode: e.target.value as 'scroll' | 'topics' } })} data-testid="teleprompter-mode"><option value="scroll">{t.preparation.scroll}</option><option value="topics">{t.preparation.topicMode}</option></select></label>
        <label className="flex items-center gap-2 text-[0.8125rem] text-muted">{t.preparation.speed}<input type="range" min={10} max={120} value={prefs.teleprompter.speed} disabled={disabled} onChange={(e) => setPrefs({ teleprompter: { ...prefs.teleprompter, speed: Number(e.target.value) } })} aria-label={t.preparation.speed} /><span className="tnum">{t.preparation.speedValue(prefs.teleprompter.speed)}</span></label>
        <button className="btn" type="button" disabled={!valid || disabled} onClick={() => void showPrompter()} data-testid="teleprompter-open">{t.preparation.prompt}</button>
        <button className="btn btn-small" type="button" disabled={disabled} onClick={() => { onChange(null); void window.tomada.teleprompter.hide().catch((err: unknown) => setError(String(err))) }} data-testid="script-remove">{t.preparation.remove}</button>
      </div>
      <p className="text-[0.8125rem] text-faint">{t.preparation.promptHelp}</p>
    </> : null}
  </section>
}
