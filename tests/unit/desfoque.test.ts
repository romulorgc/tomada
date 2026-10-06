import { describe, expect, it, vi } from 'vitest'
import { createProject, migrate, serializeProject } from '../../src/shared/project'
import { activeBlurRegions, createBlurRegion, deleteBlurRegion, moveBlurRegion, resizeBlurRegion, setBlurRect, sourcePoint, displayRect } from '../../src/shared/blur'
import { createEditorStore } from '../../src/shared/editor-store'
import { clipDocument } from '../../src/shared/clips'
import { deriveProject, evaluateScene, HORIZONTAL_1080, prepareEvents, VERTICAL_1080 } from '../../src/shared/scene'
import { projectForFormat } from '../../src/shared/vertical'
import { reviewDocument, type ReviewItem } from '../../src/shared/review'
import { createRenderCache, protectScreen, type CanvasFactory } from '../../src/shared/render'

const project = () => createProject({ title: 'Sintético', sources: { screen: { path: 'media/screen.mp4', w: 2560, h: 1080, fps: 30, durationMs: 60000 } } })

describe('proteção de região da tela de origem', () => {
  it('se a leitura de pixels for bloqueada, substitui por tarja sem expor o original nem interromper o quadro', () => {
    const contexts: {fillStyle:string;fillRect:ReturnType<typeof vi.fn>}[] = []
    const factory = ((w:number,h:number) => {
      const ctx = {save:vi.fn(),restore:vi.fn(),setTransform:vi.fn(),drawImage:vi.fn(),fillRect:vi.fn(),fillStyle:'',getImageData:()=>{throw new Error('canvas sem permissão de leitura')}}
      contexts.push(ctx)
      return {width:w,height:h,getContext:()=>ctx}
    }) as unknown as CanvasFactory
    const cache = createRenderCache(factory)
    const regions = [{id:'b',start:0,end:1000,rect:{x:.1,y:.2,w:.3,h:.2},mode:'blur' as const}]
    expect(()=>protectScreen(cache,{image:{},w:1000,h:1000},regions)).not.toThrow()
    expect(contexts[0]!.fillRect).toHaveBeenCalledWith(100,200,300,200)
    expect(contexts[0]!.fillStyle).toBe('#111827')
  })
  it('cria forte por padrão, preserva em disco e herda no corte vertical', () => {
    const p = createBlurRegion(project(), { x: .4, y: .3, w: .2, h: .1 }, 1000, 3000, 60000)!
    expect(p.blurRegions?.[0]?.mode).toBe('blur')
    expect(migrate(JSON.parse(serializeProject(p))).blurRegions).toEqual(p.blurRegions)
    expect(projectForFormat(clipDocument(p, { ranges: [{ start: 1000, end: 9000 }], hook: '' }), 'vertical').blurRegions).toEqual(p.blurRegions)
    expect(activeBlurRegions(p, 1000)).toHaveLength(1)
    expect(activeBlurRegions(p, 3000)).toHaveLength(0)
  })
  it('ajustes desconhecidos de um item não conseguem desligar a proteção comum', () => {
    const p = createBlurRegion(project(),{x:.4,y:.3,w:.2,h:.1},0,60000,60000)!
    p.review = {items:{youtube:{decision:'pending',origin:'manual',edits:{cuts:[],zooms:[],layouts:[],captions:p.captions,style:p.style,blurRegions:[]} as ReviewItem['edits'] & {blurRegions:never[]}}}}
    expect(reviewDocument(p,'youtube').blurRegions).toEqual(p.blurRegions)
    const saved = migrate(JSON.parse(serializeProject(p)))
    expect(reviewDocument(saved,'youtube').blurRegions).toEqual(saved.blurRegions)
  })
  it('recusa geometria e duração inválidas sem criar proteção vazia', () => {
    expect(createBlurRegion(project(), { x: .1, y: .2, w: 0, h: .1 }, 0, 1000, 60000)).toBeNull()
    expect(createBlurRegion(project(), { x: NaN, y: .2, w: .2, h: .1 }, 0, 1000, 60000)).toBeNull()
    const p = createBlurRegion(project(), { x: -.1, y: .2, w: .3, h: 3 }, -300, 90000, 60000)!
    expect(p.blurRegions?.[0]).toMatchObject({ start: 0, end: 60000, rect: { x: 0, w: .3, h: .8 } })
    expect(p.blurRegions![0]!.rect.y).toBeCloseTo(.2)
    expect(() => migrate({ ...p, blurRegions: [{ ...p.blurRegions![0], mode: 'inventado' }] })).toThrow()
  })
  it('move e redimensiona no tempo, permite duas regiões simultâneas e limita à duração', () => {
    let p = createBlurRegion(project(), { x: .1, y: .2, w: .2, h: .1 }, 1000, 3000, 60000)!
    const id = p.blurRegions![0]!.id
    p = createBlurRegion(p, { x: .6, y: .2, w: .2, h: .1 }, 1000, 3000, 60000)!
    expect(activeBlurRegions(p, 2000)).toHaveLength(2)
    p = moveBlurRegion(p, id, -9000, 60000)
    expect(p.blurRegions![0]).toMatchObject({ start: 0, end: 2000 })
    p = resizeBlurRegion(p, id, 'end', 90000, 60000)
    expect(p.blurRegions![0]?.end).toBe(60000)
    p = setBlurRect(p, id, { x: .9, y: .9, w: .2, h: .1 })
    expect(p.blurRegions![0]?.rect).toEqual({ x: .8, y: .9, w: .2, h: .1 })
    expect(deleteBlurRegion(p, id).blurRegions).toHaveLength(1)
  })
  it('seleção sobrevive à troca de formato e o gesto é desfazível', () => {
    const p = createBlurRegion(project(), { x: .1, y: .2, w: .2, h: .1 }, 1000, 3000, 60000)!
    const id = p.blurRegions![0]!.id
    const st = createEditorStore({ project: p, save: async () => undefined })
    st.getState().setSelection({ kind: 'blur', id })
    st.getState().setFormat('vertical')
    expect(st.getState().selection).toEqual({ kind: 'blur', id })
    st.getState().begin()
    st.getState().change(v => resizeBlurRegion(v, id, 'end', 60000, 60000))
    st.getState().change(v => setBlurRect(v, id, { x: .3, y: .4, w: .2, h: .1 }))
    st.getState().end()
    expect(st.getState().undoCount).toBe(1)
    st.getState().undo()
    expect(st.getState().doc.blurRegions).toEqual(p.blurRegions)
    st.getState().dispose()
  })
  it('coordenadas seguem zoom e recorte; ultrawide ocupa mais de 90% da largura no 16:9 e o V-A enche o quadro', () => {
    const p = createBlurRegion(project(), { x: .4, y: .3, w: .2, h: .1 }, 0, 60000, 60000)!
    const data = prepareEvents({ cursor: [{ t: 0, x: .5, y: .5 }], clicks: [], keys: [] }, 60000)
    for (const f of [HORIZONTAL_1080, VERTICAL_1080]) {
      const view = projectForFormat(p, f.kind)
      const s = evaluateScene(view, deriveProject(view, data, f), 1000, f)
      expect(s.blurRegions).toEqual(p.blurRegions)
      const r = displayRect(p.blurRegions![0]!.rect, s.screen!)
      expect(sourcePoint({ x: r.x, y: r.y }, s.screen!)).toEqual({ x: .4, y: .3 })
      if (f.kind === 'horizontal') {
        expect(s.screen!.dest.w).toBeGreaterThan(1920 * .9)
        expect(s.screen!.dest.h).toBeGreaterThan(700)
      } else expect(s.screen!.dest).toEqual({ x: 0, y: 0, w: 1080, h: 1920 })
    }
  })
  it('o retângulo acompanha o mesmo recorte de um zoom manual nos dois formatos', () => {
    const p = createBlurRegion(project(), { x: .45, y: .4, w: .1, h: .1 }, 0, 60000, 60000)!
    const z = {id:'z1',start:0,end:50000,scale:2,focus:{x:.5,y:.5},origin:'manual' as const}
    p.zooms = [z]; p.zoomPreset = 'moderate'
    p.vertical = {layout:'screen-focus',layouts:[],zooms:[z],zoomPreset:'moderate'}
    const data = prepareEvents({cursor:[{t:0,x:.5,y:.5}],clicks:[],keys:[]},60000)
    for (const f of [HORIZONTAL_1080, VERTICAL_1080]) {
      const view = projectForFormat(p, f.kind)
      const scene = evaluateScene(view, deriveProject(view,data,f),10000,f)
      const r = displayRect(p.blurRegions![0]!.rect,scene.screen!)
      expect(scene.screen!.src.w).toBeLessThan(.55)
      expect(sourcePoint({x:r.x+r.w/2,y:r.y+r.h/2},scene.screen!).x).toBeCloseTo(.5)
      expect(sourcePoint({x:r.x+r.w/2,y:r.y+r.h/2},scene.screen!).y).toBeCloseTo(.45)
      expect(scene.blurRegions).toEqual(p.blurRegions)
    }
  })
})
