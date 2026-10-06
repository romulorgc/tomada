import { useCallback, useEffect, useRef, useState } from 'react'
import { planAiEdit, type AiEditPlan } from '@shared/ai-edit'
import { formatDuration, formatSpan } from '@shared/format'
import { projectDurationMs } from '@shared/project'
import { buildClipText, buildYoutubeText, fallbackClipMeta } from '@shared/publish'
import { itemOf, reviewDocument, type ReviewItem } from '@shared/review'
import { keptRanges, outputDuration, sourceToOutput } from '@shared/timeline'
import type { Project, Transcript, CutReason, LayoutKind, CaptionStyleId } from '@shared/types'
import { projectForFormat } from '@shared/vertical'
import { ErrorPanel } from '../components/Feedback'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'
import './review.css'

const T = t.autopilot
const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e)
const decisionList = <T extends {id:string}>(base:T[],edited:T[]):T[] => [...new Map([...base,...edited].map((s) => [s.id,s])).values()]

export function Review({ id }: { id: string }) {
  const [doc,setDoc] = useState<Project|null>(null)
  const [transcript,setTranscript] = useState<Transcript|null>(null)
  const [error,setError] = useState<string|null>(null)
  const [category,setCategory] = useState<CutReason|'zooms'|'layouts'|'clips'|'texts'|null>(null)
  const go = useApp((s) => s.go)
  const notify = useApp((s) => s.notify)
  const load = useCallback(async () => {
    try { const detail = await window.tomada.projects.get(id); setDoc(detail.project); setError(null); setTranscript(await window.tomada.transcription.get(id)) }
    catch(e) { setError(messageOf(e)) }
  },[id])
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(),1200)
    const off = window.tomada.on('autopilot:progress',(s) => { if(s.projectId === id) void load() })
    return () => { clearInterval(timer); off() }
  },[id,load])
  const action = async (fn: () => Promise<unknown>) => { try { await fn(); await load() } catch(e) { notify({ kind: 'error',text: T.error,detail: messageOf(e) }) } }
  const change = async (itemId: string,patch: Partial<ReviewItem>,reexport = true) => action(async () => { setDoc(await window.tomada.review.update(id,itemId,patch,reexport)) })
  if (!doc) return error ? <ErrorPanel title={T.review} detail={error} onRetry={() => void load()} /> : <div className="p-10" aria-busy="true">{t.common.loading}</div>
  const running = doc.autopilot?.status === 'running'
  const items = ['youtube',...doc.clips.map((c) => c.id)]
  const youtubeView = reviewDocument(doc,'youtube')
  const automatic = youtubeView.cuts.filter((c) => c.reason !== 'manual' && c.origin !== 'manual')
  const categories: CutReason[] = ['silence','filler','retake']
  return <div className="review" data-testid="review-view" data-status={running ? 'running' : 'done'}>
    <header className="review-head">
      <div><button className="btn btn-ghost" onClick={() => go({name:'library'})}>{t.nav.library}</button><p className="review-eyebrow">{T.review}</p><h1>{doc.title}</h1><p className="text-muted" role="status">{running ? T.running : doc.autopilot?.steps.some((s) => s.status === 'error') ? T.hasErrors : T.ready}</p></div>
      <div className="review-head-actions"><button className="btn" onClick={() => go({name:'project',id})} data-testid="review-editor">{T.editor}</button><button className="btn btn-rec" data-testid="review-post" onClick={() => void action(() => window.tomada.review.post(id))}>{T.post}</button><p className="text-muted text-xs">{T.postHelp}</p></div>
    </header>
    {error ? <p role="alert">{error}</p> : null}
    <div className="review-layout">
      <aside className="review-summary" aria-label={T.summary}>
        <h2>{T.summary}</h2>
        {categories.map((reason) => { const found = automatic.filter((c) => c.reason === reason && c.enabled); return <button key={reason} className="review-summary-link" onClick={() => setCategory(reason)} data-testid={`review-summary-${reason}`}>{T.cutsCount(found.length,T.reasons[reason],formatDuration(found.reduce((n,c) => n+c.end-c.start,0)))} <span>{T.view} →</span></button> })}
        <button className="review-summary-link" onClick={() => setCategory('zooms')}>{T.zoomCount(youtubeView.zooms.filter((z) => z.origin === 'auto').length)} <span>{T.view} →</span></button>
        <button className="review-summary-link" onClick={() => setCategory('layouts')}>{T.layoutCount(youtubeView.layouts.filter((l) => l.origin === 'auto').length)} <span>{T.view} →</span></button>
        <button className="review-summary-link" onClick={() => setCategory('clips')}>{T.clipCount(doc.clips.length)} <span>{T.view} →</span></button>
        <button className="review-summary-link" onClick={() => setCategory('texts')}>{T.texts} <span>{T.view} →</span></button>
        <details open={running}><summary>{T.title}</summary><ol className="review-steps">{doc.autopilot?.steps.map((step) => <li key={step.id} data-status={step.status} data-testid={`pipeline-${step.id}`}><span>{step.status === 'running' ? '◌' : step.status === 'done' ? '✓' : step.status === 'error' ? '!' : '·'} {T.steps[step.id]}</span>{step.detail ? <p>{step.detail}</p> : null}{step.status === 'error' ? <button className="btn" onClick={() => void action(() => window.tomada.autopilot.retry(id,step.id))}>{T.retry}</button> : null}{step.status === 'done' && step.id !== 'notify' ? <button className="link" onClick={() => void action(() => window.tomada.autopilot.retry(id,step.id))}>{T.regenerate}</button> : null}</li>)}</ol></details>
        {category ? <section className="review-decisions" data-testid="review-decisions">
          <h3>{category === 'zooms' ? T.zoom : category === 'layouts' ? T.layout : category === 'clips' ? T.vertical : category === 'texts' ? T.texts : T.reasons[category]}</h3>
          <p className="text-muted text-xs">{T.decisionHelp}</p>
          {items.map((itemId) => {
            const item = itemOf(doc,itemId)
            const base = itemId === 'youtube' ? doc : projectForFormat(doc,'vertical')
            const original = item.edits ? {...base,...item.edits,cuts:decisionList(base.cuts,item.edits.cuts),zooms:decisionList(base.zooms,item.edits.zooms),layouts:decisionList(base.layouts,item.edits.layouts)} : base
            const effective = projectForFormat(reviewDocument(doc,itemId),itemId === 'youtube' ? 'horizontal' : 'vertical')
            const ranges = doc.clips.find((c) => c.id === itemId)?.ranges
            const relevant = (segment:{start:number;end:number}) => !ranges || ranges.some((r) => r.start < segment.end && r.end > segment.start)
            const label = itemId === 'youtube' ? T.youtube : doc.clips.find((c) => c.id === itemId)?.title
            const key = category === 'zooms' ? 'disabledZoomIds' : category === 'layouts' ? 'disabledLayoutIds' : 'disabledCutIds'
            const segments = category === 'zooms' ? original.zooms.filter((s) => s.origin === 'auto' && relevant(s)) : category === 'layouts' ? original.layouts.filter((s) => s.origin === 'auto' && relevant(s)) : original.cuts.filter((s) => s.reason === category && s.origin !== 'manual' && relevant(s))
            return <div className="review-decision-group" key={itemId}><strong>{label}</strong>
              {category === 'clips' ? itemId !== 'youtube' && <button className="link" onClick={() => void change(itemId,{decision:item.decision === 'discarded' ? 'pending' : 'discarded'},false)}>{item.decision === 'discarded' ? T.restore : T.discard}</button> : category === 'texts' ? <><button className="link" onClick={() => document.querySelector(`[data-testid="review-${itemId}-text"]`)?.scrollIntoView({block:'center'})}>{T.view}</button><button className="link" onClick={() => void change(itemId,{text:undefined},false)}>{T.resetText}</button></> : <>
                <button className="link" onClick={() => void change(itemId,category === 'zooms' ? {zoom:'off'} : category === 'layouts' ? {disabledLayoutIds:segments.map((s) => s.id)} : {disabledReasons:[...new Set([...(item.disabledReasons ?? []),category])]})}>{T.restoreAll}</button>
                <button className="link" onClick={() => void change(itemId,category === 'zooms' ? {zoom:'auto',disabledZoomIds:[],restoreAutoZooms:true} : category === 'layouts' ? {layout:undefined,disabledLayoutIds:[],restoreAutoLayouts:true} : {enabledReasons:[...new Set([...(item.enabledReasons ?? []),category])],enabledCutIds:[],disabledReasons:item.disabledReasons?.filter((r) => r !== category),disabledCutIds:(item.disabledCutIds ?? []).filter((id) => !segments.some((s) => s.id === id))})}>{T.enableAll}</button>
                {segments.map((segment) => <label key={segment.id} className="review-decision"><input type="checkbox" checked={category === 'zooms' ? effective.zooms.some((s) => s.id === segment.id) : category === 'layouts' ? effective.layouts.some((s) => s.id === segment.id) : !!effective.cuts.find((c) => c.id === segment.id)?.enabled} onChange={(e) => void change(itemId,{...(category !== 'zooms' && category !== 'layouts' ? {enabledCutIds:e.target.checked ? [...(item.enabledCutIds ?? []),segment.id] : item.enabledCutIds?.filter((id) => id !== segment.id)} : {}),[key]:e.target.checked ? item[key]?.filter((id) => id !== segment.id) : [...(item[key] ?? []),segment.id], ...(e.target.checked && category === 'zooms' ? {zoom:'auto',restoreAutoZooms:true,disabledZoomIds:segments.filter((s) => s.id !== segment.id && !effective.zooms.some((z) => z.id === s.id)).map((s) => s.id)} : {}), ...(e.target.checked && category === 'layouts' ? {layout:undefined,restoreAutoLayouts:true,disabledLayoutIds:segments.filter((s) => s.id !== segment.id && !effective.layouts.some((l) => l.id === s.id)).map((s) => s.id)} : {}), ...(e.target.checked && item.disabledReasons?.includes(category as CutReason) ? {disabledReasons:item.disabledReasons.filter((r) => r !== category),disabledCutIds:segments.filter((s) => s.id !== segment.id).map((s) => s.id)} : {})})} />{formatSpan(segment.start)}–{formatSpan(segment.end)} {'layout' in segment ? t.editor.layout.options[segment.layout] : 'scale' in segment ? `${segment.scale.toFixed(1)}×` : T.reasons[segment.reason]}</label>)}
              </>}
            </div>
          })}
          {category === 'clips' ? <button className="btn" onClick={() => void action(async () => { for(const clip of doc.clips) await window.tomada.review.update(id,clip.id,{decision:'discarded'},false) })}>{T.discardAll}</button> : null}
          {category === 'texts' ? <button className="btn" onClick={() => void action(async () => { for(const itemId of items) await window.tomada.review.update(id,itemId,{text:undefined},false) })}>{T.resetAllTexts}</button> : null}
        </section> : null}
      </aside>
      <section className="review-board" aria-label={T.review}>{items.map((itemId) => <ReviewCard key={itemId} id={id} itemId={itemId} doc={doc} transcript={transcript} change={change} action={action} />)}</section>
    </div>
  </div>
}

function ReviewCard({ id,itemId,doc,transcript,change,action }: { id:string; itemId:string; doc:Project; transcript:Transcript|null; change:(id:string,patch:Partial<ReviewItem>,reexport?:boolean)=>Promise<void>; action:(fn:()=>Promise<unknown>)=>Promise<void> }) {
  const clip = itemId === 'youtube' ? null : doc.clips.find((c) => c.id === itemId)!
  const format = clip ? 'vertical' : 'horizontal'
  const item = itemOf(doc,itemId)
  const project = reviewDocument(doc,itemId)
  const view = projectForFormat(project,format)
  const duration = projectDurationMs(doc)
  const outputMs = outputDuration(duration,project.cuts)
  const title = item.title ?? clip?.title ?? doc.title
  const meta = clip ? project.meta?.perClip?.[itemId] ?? fallbackClipMeta(clip,transcript?.words ?? null) : null
  const computedText = clip ? buildClipText({...clip,title,hook:item.hook ?? clip.hook},meta!) : buildYoutubeText({title,titles:item.title ? [item.title,...(project.meta?.youtube?.titles ?? []).filter((t) => t !== item.title)].slice(0,3) : project.meta?.youtube?.titles ?? [],description:project.meta?.youtube?.description ?? '',tags:project.meta?.youtube?.tags ?? [],chapters:project.meta?.youtube?.chapters ?? [],kept:keptRanges(duration,project.cuts)})
  const [text,setText] = useState(item.text ?? computedText)
  const [trim,setTrim] = useState(item.trim ?? {start:clip?.ranges[0]?.start ?? 0,end:clip?.ranges.at(-1)?.end ?? duration})
  const [instruction,setInstruction] = useState('')
  const [busy,setBusy] = useState(false)
  const [plan,setPlan] = useState<AiEditPlan|null>(null)
  const video = useRef<HTMLVideoElement|null>(null)
  useEffect(() => { setText(item.text ?? computedText) },[item.text,computedText])
  const commitTrim = () => void change(itemId,{trim})
  const ask = async () => {
    if (!transcript) return
    setBusy(true)
    await action(async () => { const result = await window.tomada.review.ask(id,itemId,instruction); setPlan(planAiEdit({project:view,words:transcript.words,durationMs:duration,format,ops:result.ops,reply:result.reply})) })
    setBusy(false)
  }
  const apply = async () => {
    if (!plan?.changed) return
    const p = plan.project
    await change(itemId,{title:p.title,hook:p.vertical?.hook ?? item.hook,edits:{cuts:p.cuts,zooms:p.zooms,layouts:p.layouts,captions:p.captions,style:p.style,wordFixes:p.wordFixes ?? {},mutes:p.mutes ?? [],meta:p.meta ?? {},zoomPreset:p.zoomPreset,autoExclusions:p.autoExclusions}})
    setPlan(null); setInstruction('')
  }
  const layoutOptions: LayoutKind[] = clip ? ['screen-focus','stack','screen-wide','camera'] : ['bubble','side-by-side','screen','camera']
  return <article className={['review-card',clip ? 'review-vertical' : 'review-horizontal'].join(' ')} data-testid={`review-item-${itemId}`} data-phase={item.phase ?? 'empty'} data-decision={item.decision}>
    <div className="review-card-heading"><span>{clip ? T.vertical : T.youtube}</span><span>{clip ? T.note(clip.score) : formatDuration(outputMs)}</span></div>
    <div className="review-player">{item.exportPath ? <video ref={video} controls preload="metadata" src={window.tomada.mediaUrl(id,item.exportPath)} data-testid={`review-${itemId}-player`} /> : <div className="review-player-empty">{item.phase === 'exporting' || item.phase === 'queued' ? T.exporting : T.noExport}</div>}</div>
    <div className="review-card-body"><h2>{title}</h2><p className="text-muted text-xs">{T.duration}: {formatSpan(outputMs)} {clip ? `· ${clip.reason}` : ''}</p>
      <div className="review-actions"><button className="btn btn-rec" data-testid={`review-${itemId}-approve`} aria-pressed={item.decision === 'approved'} onClick={() => void change(itemId,{decision:'approved'},false)}>{item.decision === 'approved' ? T.approved : T.approve}</button><button className="btn btn-ghost" data-testid={`review-${itemId}-discard`} onClick={() => void change(itemId,{decision:item.decision === 'discarded' ? 'pending' : 'discarded'},false)}>{item.decision === 'discarded' ? T.pending : T.discard}</button><button className="btn btn-ghost" onClick={() => useApp.getState().go({name:'project',id,itemId})}>{T.editor}</button></div>
      {item.error ? <p role="alert" className="text-danger">{item.error}</p> : null}
      {item.phase === 'exporting' || item.phase === 'queued' ? <p role="status">{T.exporting}</p> : null}
      {item.phase !== 'ready' && item.phase !== 'exporting' && item.phase !== 'queued' ? <button className="btn" data-testid={`review-${itemId}-export`} onClick={() => void action(() => window.tomada.review.export(id,itemId))}>{item.error ? T.retry : T.export}</button> : null}
      <details data-testid={`review-${itemId}-quick`}><summary>{T.quick}</summary><div className="review-controls"><button className="btn" data-testid={`review-${itemId}-save-style`} onClick={() => void action(async () => { await window.tomada.settings.saveStyle(id,itemId); useApp.getState().notify({kind:'info',text:T.styleSaved}) })}>{T.saveStyle}</button>
        <label><input type="checkbox" checked={view.captions.enabled} data-testid={`review-${itemId}-captions`} onChange={(e) => void change(itemId,{captionsEnabled:e.target.checked})} /> {T.captions}</label>
        <label>{T.start} · {formatSpan(trim.start)}<input type="range" min={0} max={Math.max(0,trim.end-100)} step={100} value={trim.start} aria-label={T.start} onChange={(e) => setTrim({...trim,start:Number(e.target.value)})} onPointerUp={commitTrim} onKeyUp={commitTrim} /></label>
        <label>{T.end} · {formatSpan(trim.end)}<input type="range" min={trim.start+100} max={duration} step={100} value={trim.end} aria-label={T.end} onChange={(e) => setTrim({...trim,end:Number(e.target.value)})} onPointerUp={commitTrim} onKeyUp={commitTrim} /></label>
        <div className="review-transcript" data-testid={`review-${itemId}-transcript`}>{transcript?.words.filter((w) => w.start >= trim.start && w.end <= trim.end).map((w) => <button key={w.i} title={formatSpan(w.start)} className={project.cuts.some((c) => c.enabled && w.start >= c.start && w.end <= c.end) ? 'cut' : ''} onClick={() => { if(video.current) video.current.currentTime = sourceToOutput(w.start,keptRanges(duration,project.cuts))/1000 }}>{w.text} </button>)}</div>
        <label>{T.layout}<select value={item.layout ?? view.style.defaultLayout} onChange={(e) => void change(itemId,{layout:e.target.value as LayoutKind})}>{layoutOptions.map((l) => <option key={l} value={l}>{t.editor.layout.options[l]}</option>)}</select></label>
        <label>{T.captionStyle}<select value={view.captions.style} onChange={(e) => void change(itemId,{captionStyle:e.target.value as CaptionStyleId})}>{(['natural','highlight','clean','karaoke'] as const).map((s) => <option value={s} key={s}>{t.editor.captions.styles[s].name}</option>)}</select></label>
        <label>{T.zoom}<select value={item.zoom ?? 'auto'} onChange={(e) => void change(itemId,{zoom:e.target.value as ReviewItem['zoom']})}><option value="auto">{T.auto}</option><option value="softer">{T.softer}</option><option value="stronger">{T.stronger}</option><option value="off">{T.off}</option></select></label>
        <label>{T.titleLabel}<input defaultValue={title} key={`${itemId}-title-${title}`} maxLength={200} onBlur={(e) => { if(e.target.value !== title) void change(itemId,{title:e.target.value}) }} /></label>
        {clip ? <label>{T.hook}<input defaultValue={item.hook ?? clip.hook} key={`${itemId}-hook-${item.hook ?? clip.hook}`} maxLength={200} onBlur={(e) => { if(e.target.value !== (item.hook ?? clip.hook)) void change(itemId,{hook:e.target.value}) }} /></label> : null}
        <fieldset><legend>{T.clean}</legend>{(['silence','filler','retake'] as CutReason[]).map((reason) => <label key={reason}><input type="checkbox" checked={item.disabledReasons?.includes(reason) ?? false} onChange={(e) => void change(itemId,{enabledReasons:e.target.checked ? item.enabledReasons?.filter((r) => r !== reason) : [...new Set([...(item.enabledReasons ?? []),reason])],disabledReasons:e.target.checked ? [...(item.disabledReasons ?? []),reason] : item.disabledReasons?.filter((r) => r !== reason)})} /> {T.reasons[reason]}</label>)}<label><input type="checkbox" checked={item.keepFillers?.includes('né') ?? false} onChange={(e) => void change(itemId,{keepFillers:e.target.checked ? ['né'] : []})} /> {T.keepNe}</label></fieldset>
      </div></details>
      <div className="review-ask"><label>{T.ask}<input placeholder={T.askPlaceholder} maxLength={2000} value={instruction} data-testid={`review-${itemId}-instruction`} onChange={(e) => setInstruction(e.target.value)} /></label><button className="btn" onClick={() => void ask()} disabled={busy || !instruction.trim() || !transcript} data-testid={`review-${itemId}-ask`}>{T.ask}</button>{plan ? <div role="status"><p>{plan.summary}</p>{plan.needsConfirm ? <p>{T.confirmation}</p> : null}{plan.changed ? <button className="btn btn-rec" onClick={() => void apply()} data-testid={`review-${itemId}-apply`}>{plan.needsConfirm ? T.confirm : T.apply}</button> : null}</div> : null}</div>
      <label className="review-text-label">{T.text}<textarea value={text} data-testid={`review-${itemId}-text`} onChange={(e) => setText(e.target.value)} onBlur={() => { if(text !== (item.text ?? computedText)) void change(itemId,{text},false) }} /></label><button className="btn btn-ghost" data-testid={`review-${itemId}-copy`} onClick={() => void action(async () => { await window.tomada.clipboard.write(text); useApp.getState().notify({kind:'info',text:T.copied}) })}>{T.copy}</button>
    </div>
  </article>
}
