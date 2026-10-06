import { describe, expect, it } from 'vitest'
import { createProject } from '../../src/shared/project'
import { reviewDocument, updateReviewItem, preserveManualDecisions, refreshReviewSnapshots, type ReviewItem } from '../../src/shared/review'
import { defaultVerticalEdit } from '../../src/shared/vertical'
import type { Project, Zoom } from '../../src/shared/types'

it('legenda por corte desligada continua desligada mesmo com estilo de legenda próprio', () => {
  const doc = createProject({ title: 'Teste', sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: 20000 } } })
  doc.clips = [{ id: 'clip-1', title: 'Corte', hook: 'Veja o resultado', ranges: [{ start: 0, end: 20000 }], score: 80, reason: 'valor', format: 'vertical', layoutV: 'auto', captionStyle: 'highlight' }]
  const next = updateReviewItem(doc, 'clip-1', { captionsEnabled: false, disabledReasons: ['filler'] })
  expect(reviewDocument(next, 'clip-1').vertical?.captions?.enabled).toBe(false)
  expect(next.review?.items['clip-1']?.origin).toBe('manual')
})
it('restaurar uma categoria só no item não altera os outros nem os cortes manuais', () => {
  const doc = createProject({ title: 'Teste' })
  doc.cuts = [{ id: 'a', start: 100, end: 200, enabled: true, reason: 'filler', origin: 'auto' }, { id: 'm', start: 300, end: 400, enabled: true, reason: 'manual', origin: 'manual' }]
  const next = updateReviewItem(doc, 'youtube', { disabledReasons: ['filler'] })
  expect(reviewDocument(next, 'youtube').cuts.map((c) => c.enabled)).toEqual([false, true])
  expect(next.cuts.every((c) => c.enabled)).toBe(true)
})
it('mudar automático à mão protege cortes e layouts na regeneração', () => {
  const prev = createProject({ title: 'Teste' })
  prev.layouts = [{ id: 'a', start: 0, end: 1000, layout: 'bubble', origin: 'auto' }]
  prev.cuts = [{ id: 'c', start: 0, end: 300, reason: 'silence', enabled: true, origin: 'auto' }]
  const next = preserveManualDecisions(prev, { ...prev, layouts: [{ ...prev.layouts[0]!, layout: 'screen' }], cuts: [{ ...prev.cuts[0]!, end: 400 }] })
  expect(next.layouts[0]?.origin).toBe('manual')
  expect(next.cuts[0]?.origin).toBe('manual')
})

it('restaurar uma decisão é independente e pode ser ligado de novo sem tocar o documento base',() => {
  const doc = createProject({title:'Teste'})
  doc.zooms = [{id:'z1',start:0,end:1000,scale:1.7,focus:'auto',origin:'auto'},{id:'z2',start:2000,end:3000,scale:1.7,focus:'auto',origin:'auto'}]
  doc.layouts = [{id:'l',start:0,end:1000,layout:'screen',origin:'auto'}]
  const restored = updateReviewItem(doc,'youtube',{disabledZoomIds:['z1'],disabledLayoutIds:['l']})
  expect(reviewDocument(restored,'youtube').zooms.map((z) => z.id)).toEqual(['z2'])
  expect(reviewDocument(restored,'youtube').layouts).toEqual([])
  expect(doc.zooms).toHaveLength(2)
  expect(reviewDocument(updateReviewItem(restored,'youtube',{disabledZoomIds:[],disabledLayoutIds:[]}),'youtube').zooms).toHaveLength(2)
})

it('reaplicar limpeza religa a categoria mesmo depois de um ajuste materializado no editor',() => {
  const doc = createProject({title:'Teste'})
  doc.cuts = [{id:'s',start:100,end:200,reason:'silence',enabled:true,origin:'auto'}]
  const off = updateReviewItem(doc,'youtube',{edits:{cuts:[{...doc.cuts[0]!,enabled:false}],zooms:[],layouts:[],captions:doc.captions,style:doc.style}})
  expect(reviewDocument(off,'youtube').cuts[0]?.enabled).toBe(false)
  const on = updateReviewItem(off,'youtube',{enabledReasons:['silence']})
  expect(reviewDocument(on,'youtube').cuts[0]?.enabled).toBe(true)
})
it('reaplicar uma categoria preserva o corte que o usuário restaurou manualmente',() => {
  const doc = createProject({title:'Teste'})
  doc.cuts = [{id:'manual',start:100,end:200,reason:'filler',enabled:false,origin:'manual'},{id:'auto',start:300,end:400,reason:'filler',enabled:false,origin:'auto'}]
  expect(reviewDocument(updateReviewItem(doc,'youtube',{enabledReasons:['filler']}),'youtube').cuts.map((c) => c.enabled)).toEqual([false,true])
})
it('restaurar uma categoria desliga também o automático que foi reativado individualmente',() => {
  const doc = createProject({title:'Teste'})
  doc.cuts = [{id:'f',start:100,end:200,reason:'filler',enabled:false,origin:'auto'}]
  const on = updateReviewItem(doc,'youtube',{enabledCutIds:['f']})
  expect(reviewDocument(on,'youtube').cuts[0]?.enabled).toBe(true)
  expect(reviewDocument(updateReviewItem(on,'youtube',{disabledReasons:['filler']}),'youtube').cuts[0]?.enabled).toBe(false)
})
it('reaplicar zooms e layouts recupera automáticos ausentes da fotografia e mantém os manuais',() => {
  const doc = createProject({title:'Teste'})
  doc.zooms = [{id:'z',start:0,end:1000,scale:1.7,focus:'auto',origin:'auto'}]
  doc.layouts = [{id:'l',start:0,end:1000,layout:'screen',origin:'auto'}]
  const manualZoom = {id:'zm',start:2000,end:3000,scale:1.3,focus:'auto' as const,origin:'manual' as const}
  const manualLayout = {id:'lm',start:2000,end:3000,layout:'camera' as const,origin:'manual' as const}
  const off = updateReviewItem(doc,'youtube',{edits:{cuts:[],zooms:[manualZoom],layouts:[manualLayout],zoomPreset:'off',captions:doc.captions,style:doc.style}})
  const restored = reviewDocument(updateReviewItem(off,'youtube',{zoom:'auto',restoreAutoZooms:true,restoreAutoLayouts:true} as Partial<ReviewItem>),'youtube')
  expect(restored.zooms.map((s) => s.id).sort()).toEqual(['z','zm'])
  expect(restored.layouts.map((s) => s.id).sort()).toEqual(['l','lm'])
  expect(restored.zoomPreset).not.toBe('off')
})
it('reativar decisão ou categoria recupera o corte automático removido da fotografia',() => {
  const doc = createProject({title:'Teste'})
  doc.cuts = [{id:'s',start:100,end:200,reason:'silence',enabled:true,origin:'auto'}]
  const off = updateReviewItem(doc,'youtube',{edits:{cuts:[],zooms:[],layouts:[],captions:doc.captions,style:doc.style}})
  expect(reviewDocument(updateReviewItem(off,'youtube',{enabledCutIds:['s']}),'youtube').cuts.map((c) => c.id)).toEqual(['s'])
  expect(reviewDocument(updateReviewItem(off,'youtube',{enabledReasons:['silence']}),'youtube').cuts.map((c) => c.id)).toEqual(['s'])
})

describe('refreshReviewSnapshots: a fotografia do item guarda só as decisões do usuário', () => {
  const zoom = (id: string, start: number, over: Partial<Zoom> = {}): Zoom => ({ id, start, end: start + 1000, scale: 1.5, focus: 'auto', origin: 'auto', ...over })
  const withSnapshot = (doc: Project, edits: Partial<NonNullable<ReviewItem['edits']>>, id = 'youtube'): Project =>
    updateReviewItem(doc, id, { edits: { cuts: doc.cuts, zooms: doc.zooms, layouts: doc.layouts, captions: doc.captions, style: doc.style, ...edits } })

  it('cópias automáticas viram as novas do documento; o zoom manual e o ajustado à mão ficam', () => {
    const prev = createProject({ title: 'Teste' })
    prev.zooms = [zoom('a1', 0), zoom('a2', 2000), zoom('m1', 4000, { origin: 'manual' })]
    // o usuário mexeu na escala do a2 dentro da fotografia
    const withEdit = withSnapshot(prev, { zooms: [zoom('a1', 0), zoom('a2', 2000, { scale: 1.9 }), zoom('m1', 4000, { origin: 'manual' })] })
    const next = { ...withEdit, zooms: [zoom('n1', 100), zoom('m1', 4000, { origin: 'manual' })] }
    const view = reviewDocument(refreshReviewSnapshots(withEdit, next), 'youtube')
    expect(view.zooms.map((z) => z.id).sort()).toEqual(['a2', 'm1', 'n1'])
    expect(view.zooms.find((z) => z.id === 'a2')?.scale).toBeCloseTo(1.9)
  })
  it('automático que o usuário tirou da fotografia não volta, nem o excluído pelo editor', () => {
    const prev = createProject({ title: 'Teste' })
    prev.zooms = [zoom('a1', 0), zoom('a2', 2000)]
    prev.layouts = [{ id: 'l1', start: 0, end: 1000, layout: 'screen', origin: 'auto' }]
    const withEdit = withSnapshot(prev, { zooms: [zoom('a1', 0)], layouts: [], autoExclusions: { layouts: ['l-novo'] } })
    const next = { ...withEdit, zooms: [zoom('a1', 0), zoom('a2', 2000), zoom('a3', 6000)], layouts: [{ id: 'l1', start: 0, end: 1000, layout: 'screen' as const, origin: 'auto' as const }, { id: 'l-novo', start: 3000, end: 4000, layout: 'camera' as const, origin: 'auto' as const }, { id: 'l2', start: 5000, end: 6000, layout: 'camera' as const, origin: 'auto' as const }] }
    const view = reviewDocument(refreshReviewSnapshots(withEdit, next), 'youtube')
    expect(view.zooms.map((z) => z.id)).toEqual(['a1', 'a3'])
    expect(view.layouts.map((l) => l.id)).toEqual(['l2'])
  })
  it('limpar de novo troca os cortes automáticos da fotografia e mantém o corte manual dela', () => {
    const prev = createProject({ title: 'Teste' })
    prev.cuts = [{ id: 'cut-1', start: 0, end: 300, reason: 'silence', enabled: true, origin: 'auto' }]
    const withEdit = withSnapshot(prev, { cuts: [...prev.cuts, { id: 'meu', start: 900, end: 1000, reason: 'manual', enabled: true, origin: 'manual' }] })
    const next = { ...withEdit, cuts: [{ id: 'cut-1', start: 0, end: 500, reason: 'silence' as const, enabled: true, origin: 'auto' as const }] }
    const view = reviewDocument(refreshReviewSnapshots(withEdit, next), 'youtube')
    expect(view.cuts.map((c) => [c.id, c.end])).toEqual([['cut-1', 500], ['meu', 1000]])
  })
  it('corte vertical: a fotografia acompanha os automáticos do vertical do projeto', () => {
    const prev = createProject({ title: 'Teste', sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: 20_000 } } })
    prev.clips = [{ id: 'clip-1', title: 'Corte', hook: 'Gancho', ranges: [{ start: 0, end: 20_000 }], score: 80, reason: 'x', format: 'vertical', layoutV: 'auto' }]
    prev.vertical = { ...defaultVerticalEdit(), zooms: [zoom('v1', 1000)] }
    const withEdit = withSnapshot(prev, { zooms: [zoom('v1', 1000)] }, 'clip-1')
    const next = { ...withEdit, vertical: { ...withEdit.vertical!, zooms: [zoom('v2', 3000)] } }
    const view = reviewDocument(refreshReviewSnapshots(withEdit, next), 'clip-1')
    expect(view.vertical?.zooms.map((z) => z.id)).toEqual(['v2'])
  })
  it('sem fotografia, devolve o mesmo documento', () => {
    const doc = createProject({ title: 'Teste' })
    expect(refreshReviewSnapshots(doc, doc)).toBe(doc)
  })
})
