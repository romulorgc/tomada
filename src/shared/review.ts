/** Edição por item. Nunca modifica a edição dos outros vídeos da mesma gravação. */
export { reviewItemSchema } from './review-schema'
import { clipDocument, complementRanges, withClipLayout } from './clips'
import { projectDurationMs } from './project'
import { captionStyleDefaults } from './caption-style'
import type { CaptionStyle, Cut, CutReason, LayoutKind, LayoutSeg, Project, Range, Style, Zoom } from './types'
import { defaultVerticalEdit, mergeFormatView, projectForFormat } from './vertical'

export type ReviewItem = {
  decision: 'pending' | 'approved' | 'discarded'; origin: 'auto' | 'manual'
  phase?: 'queued' | 'exporting' | 'ready' | 'error'; exportPath?: string; textPath?: string; error?: string
  captionsEnabled?: boolean; captionStyle?: CaptionStyle['style']; layout?: LayoutKind
  zoom?: 'softer' | 'stronger' | 'off' | 'auto'; trim?: Range; disabledReasons?: CutReason[]; keepFillers?: string[]
  disabledCutIds?: string[]; disabledZoomIds?: string[]; disabledLayoutIds?: string[]; keptFillerCutIds?: string[]
  enabledCutIds?:string[]; enabledReasons?:CutReason[]
  restoreAutoZooms?:boolean; restoreAutoLayouts?:boolean
  title?: string; hook?: string; text?: string
  edits?: { cuts: Cut[]; zooms: Zoom[]; layouts: LayoutSeg[]; captions: CaptionStyle; style: Style; wordFixes?: Project['wordFixes']; mutes?: Project['mutes']; meta?: Project['meta']; zoomPreset?: Project['zoomPreset']; autoExclusions?:Project['autoExclusions'] }
}
export type ReviewState = { items: Record<string, ReviewItem>; metaOrigin?: 'auto' | 'manual'; titleOrigin?: 'auto' | 'manual' }
export function itemOf(doc: Project, id: string): ReviewItem { return doc.review?.items[id] ?? { decision: 'pending', origin: 'auto' } }
export function updateReviewItem(doc: Project, id: string, patch: Partial<ReviewItem>, manual = true): Project {
  if(patch.disabledReasons) {
    const previous = itemOf(doc,id)
    const cuts = previous.edits?.cuts ?? doc.cuts
    patch = {...patch,enabledCutIds:(patch.enabledCutIds ?? previous.enabledCutIds)?.filter((cutId) => !cuts.some((c) => c.id === cutId && patch.disabledReasons?.includes(c.reason))),enabledReasons:(patch.enabledReasons ?? previous.enabledReasons)?.filter((r) => !patch.disabledReasons?.includes(r))}
  }
  return { ...doc, review: { ...doc.review, items: { ...doc.review?.items, [id]: { ...itemOf(doc, id), ...patch, ...(manual ? { origin: 'manual' as const } : {}) } } } }
}
export function reviewDocument(doc: Project, id: string): Project {
  const item = itemOf(doc, id)
  const clip = id === 'youtube' ? null : doc.clips.find((c) => c.id === id)
  if (id !== 'youtube' && !clip) throw new Error('Esse corte não existe mais.')
  let p = clip ? withClipLayout(clipDocument(doc, clip), clip.layoutV) : doc
  const original = p
  if (item.edits) {
    if (clip) p = mergeFormatView(p,{...projectForFormat(p,'vertical'),...item.edits},'vertical')
    else p = { ...p, ...item.edits }
  }
  const restore = <T extends {start:number;end:number;origin?:'auto'|'manual'}>(current:T[],base:T[]):T[] => {
    const manual = current.filter((s) => s.origin === 'manual')
    return [...manual,...base.filter((s) => s.origin === 'auto' && !manual.some((m) => m.start < s.end && m.end > s.start))].sort((a,b) => a.start-b.start)
  }
  if(item.restoreAutoZooms) {
    if(clip && p.vertical) p = {...p,vertical:{...p.vertical,zooms:restore(p.vertical.zooms,original.vertical?.zooms ?? []),zoomPreset:'moderate'}}
    else p = {...p,zooms:restore(p.zooms,original.zooms),zoomPreset:'moderate'}
  }
  if(item.restoreAutoLayouts) {
    if(clip && p.vertical) p = {...p,vertical:{...p.vertical,layouts:restore(p.vertical.layouts,original.vertical?.layouts ?? [])}}
    else p = {...p,layouts:restore(p.layouts,original.layouts)}
  }
  const missingCuts = original.cuts.filter((c) => c.origin === 'auto' && (item.enabledCutIds?.includes(c.id) || item.enabledReasons?.includes(c.reason)) && !p.cuts.some((s) => s.id === c.id || s.origin === 'manual' && s.reason === c.reason && s.start < c.end && s.end > c.start))
  if(missingCuts.length) p = {...p,cuts:[...p.cuts,...missingCuts]}
  p = { ...p, title: item.title ?? (clip?.title ?? p.title), cuts: p.cuts.map((c) => item.disabledCutIds?.includes(c.id) || item.keptFillerCutIds?.includes(c.id) ? {...c,enabled:false} : item.enabledCutIds?.includes(c.id) ? {...c,enabled:true} : item.disabledReasons?.includes(c.reason) && c.origin !== 'manual' && c.reason !== 'manual' ? { ...c, enabled: false } : item.enabledReasons?.includes(c.reason) && c.reason !== 'manual' && c.origin !== 'manual' ? {...c,enabled:true} : c) }
  if (item.trim) p.cuts = [...p.cuts, ...complementRanges([item.trim], projectDurationMs(p)).map((r, n) => ({ ...r, id: `review-trim-${n}`, reason: 'manual' as const, origin: 'manual' as const, enabled: true }))]
  const transform = (zooms: Zoom[]): Zoom[] => zooms.filter((s) => !item.disabledZoomIds?.includes(s.id) && (item.zoom !== 'off' || s.origin === 'manual')).map((s) => s.origin !== 'auto' ? s : { ...s, scale: 1 + (s.scale - 1) * (item.zoom === 'softer' ? 0.6 : item.zoom === 'stronger' ? 1.4 : 1) })
  p.layouts = p.layouts.filter((s) => !item.disabledLayoutIds?.includes(s.id))
  if (p.vertical) p.vertical = {...p.vertical,layouts:p.vertical.layouts.filter((s) => !item.disabledLayoutIds?.includes(s.id))}
  if (clip) {
    const v = p.vertical ?? defaultVerticalEdit()
    p.vertical = { ...v, zooms: transform(v.zooms), ...(item.zoom === 'off' ? { zoomPreset: 'off' } : {}), ...(item.layout ? { layout: item.layout, layouts: v.layouts.filter((s) => s.origin === 'manual') } : {}), ...(item.hook !== undefined ? { hook: item.hook } : {}), captions: { ...v.captions, ...(item.captionStyle ? { style: item.captionStyle, ...captionStyleDefaults(item.captionStyle, 'vertical') } : {}), ...(item.captionsEnabled !== undefined ? { enabled: item.captionsEnabled } : {}) } }
  } else {
    p.zooms = transform(p.zooms)
    if (item.zoom === 'off') p.zoomPreset = 'off'
    if (item.layout) { p.style = { ...p.style, defaultLayout: item.layout }; p.layouts = p.layouts.filter((s) => s.origin === 'manual') }
    p.captions = { ...p.captions, ...(item.captionStyle ? { style: item.captionStyle, ...captionStyleDefaults(item.captionStyle, 'horizontal') } : {}), ...(item.captionsEnabled !== undefined ? { enabled: item.captionsEnabled } : {}) }
  }
  // Campos futuros/desconhecidos em edits não podem sobrepor uma proteção comum.
  return { ...p, blurRegions: doc.blurRegions }
}
/** Alterar um item automático à mão o protege da regeneração; restaurações ficam lembradas. */
export function preserveManualDecisions(prev: Project, next: Project): Project {
  const mark = <T extends { id: string; origin?: 'auto' | 'manual' }>(old: readonly T[], items: T[]): T[] => items.map((item) => {
    const before = old.find((s) => s.id === item.id)
    return before?.origin === 'auto' && before !== item && JSON.stringify(before) !== JSON.stringify(item) ? { ...item, origin: 'manual' } : item
  })
  const captionChanged = JSON.stringify(prev.captions) !== JSON.stringify(next.captions)
  const items = {...next.review?.items}
  if(captionChanged) items.youtube = {...itemOf(next,'youtube'),origin:'manual',captionsEnabled:next.captions.enabled,captionStyle:next.captions.style}
  return { ...next, cuts: mark(prev.cuts, next.cuts), layouts: mark(prev.layouts, next.layouts), zooms: mark(prev.zooms, next.zooms), ...(next.vertical ? { vertical: { ...next.vertical, layouts: mark(prev.vertical?.layouts ?? [], next.vertical.layouts), zooms: mark(prev.vertical?.zooms ?? [], next.vertical.zooms) } } : {}), clips: next.clips.map((c) => { const old = prev.clips.find((s) => s.id === c.id); return old && JSON.stringify(old) !== JSON.stringify(c) ? { ...c, source: 'manual' } : c }), review: { ...next.review, items, ...(prev.meta !== next.meta && JSON.stringify(prev.meta) !== JSON.stringify(next.meta) ? { metaOrigin: 'manual' } : {}), ...(prev.title !== next.title ? { titleOrigin: 'manual' } : {}) } }
}
