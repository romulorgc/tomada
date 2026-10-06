import { useEffect, useState } from 'react'
import { DEFAULT_AUTOPILOT, PIPELINE_STEPS, type AutopilotPrefs } from '@shared/autopilot'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'
import type { SettingsView } from '@shared/ipc'
const T = t.autopilot
export function SettingsAutopilot({ view, changed }: { view?: SettingsView; changed?(view: SettingsView): void } = {}) {
  const [prefs,setPrefs] = useState(DEFAULT_AUTOPILOT)
  const notify = useApp((s) => s.notify)
  useEffect(() => { if (view) setPrefs({ ...DEFAULT_AUTOPILOT, ...view.settings.autopilot }); else void window.tomada.settings.get().then((s) => setPrefs({ ...DEFAULT_AUTOPILOT,...s.settings.autopilot })).catch((e:unknown) => notify({kind:'error',text:T.error,detail:String(e)})) },[notify, view])
  const update = async (patch:Partial<AutopilotPrefs>) => {
    try { const settings = await window.tomada.settings.update({autopilot:{...prefs,...patch,steps:{...prefs.steps,...patch.steps}}}); setPrefs({...DEFAULT_AUTOPILOT,...settings.settings.autopilot}); changed?.(settings) }
    catch(e) { notify({kind:'error',text:T.error,detail:String(e)}) }
  }
  return <div className="grid gap-4" data-testid="settings-autopilot"><label className="grid gap-2">{T.mode}<select className="rounded-control border border-line bg-surface p-2" value={prefs.mode} data-testid="autopilot-mode" onChange={(e) => void update({mode:e.target.value as AutopilotPrefs['mode']})}><option value="everything">{T.everything}</option><option value="prepare">{T.prepare}</option><option value="nothing">{T.nothing}</option></select></label>
    {PIPELINE_STEPS.map((step) => <label key={step} className="flex gap-2 text-sm"><input type="checkbox" checked={prefs.steps[step] !== false} data-testid={`autopilot-pref-${step}`} onChange={(e) => void update({steps:{[step]:e.target.checked}})} />{T.steps[step]}</label>)}
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={prefs.captionsHorizontal} data-testid="autopilot-captions-horizontal" onChange={(e) => void update({captionsHorizontal:e.target.checked})} />{T.horizontalCaptions}</label>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={prefs.captionsVertical} data-testid="autopilot-captions-vertical" onChange={(e) => void update({captionsVertical:e.target.checked})} />{T.verticalCaptions}</label>
    <label className="grid gap-2 text-sm">{T.youtubeResolution}<select value={prefs.youtubeResolution} className="rounded-control border border-line bg-surface p-2" data-testid="autopilot-youtube-resolution" onChange={(e) => void update({youtubeResolution:e.target.value as AutopilotPrefs['youtubeResolution']})}>{(['1440p','1080p'] as const).map((r) => <option value={r} key={r}>{T.youtubeResolutionOptions[r]}</option>)}</select></label>
    <label className="grid gap-2 text-sm">{T.maxClips}<select value={prefs.maxClips} className="rounded-control border border-line bg-surface p-2" onChange={(e) => void update({maxClips:Number(e.target.value)})}>{[3,4,5].map((n) => <option value={n} key={n}>{n}</option>)}</select></label>
    <label className="grid gap-2 text-sm">{T.score}<input type="number" min={0} max={100} value={prefs.minScore} className="rounded-control border border-line bg-surface p-2" onChange={(e) => { const n=Number(e.target.value); if(n>=0&&n<=100) void update({minScore:n}) }} /></label>
  </div>
}
