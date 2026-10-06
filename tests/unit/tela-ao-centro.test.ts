import { describe, expect, it } from 'vitest'
import { createProject, parseProject, serializeProject } from '@shared/project'
import { deriveProject, evaluateScene, layoutGeometry, prepareEvents, VERTICAL_1080 } from '@shared/scene'
import { defaultVerticalEdit, ensureVertical, layoutFollow, projectForFormat, verticalCaptionY, HOOK_BAND } from '@shared/vertical'
import type { LayoutKind } from '@shared/types'

const durationMs=6000
const data=prepareEvents({ cursor:[{t:0,x:0.5,y:0.5},{t:6000,x:0.95,y:0.5}], clicks:[], keys:[] },durationMs)
function doc(w=1920,h=1080) {
  return createProject({title:'Página sintética',sources:{screen:{path:'media/screen.mp4',w,h,fps:30,durationMs},camera:{path:'media/camera.mp4',w:640,h:360,fps:30,durationMs}}})
}
const center='screen-center' as LayoutKind

describe('Tela ao centro',()=>{
  it('é o padrão automático, aceita salvar e mantém V-A para escolha manual',()=>{
    expect(defaultVerticalEdit().layout).toBe(center)
    const p=ensureVertical(doc(),data,{durationMs})
    expect(p.vertical!.layout).toBe(center)
    expect(parseProject(serializeProject(p)).vertical!.layout).toBe(center)
    p.vertical!.layout='screen-focus'
    expect(projectForFormat(p,'vertical').style.defaultLayout).toBe('screen-focus')
  })
  it('preserva o quadrado no projeto só de tela, sem criar câmera',()=>{
    const p=doc()
    delete p.sources.camera
    const view=projectForFormat(ensureVertical(p,data,{durationMs}),'vertical')
    const derived=deriveProject(view,data,VERTICAL_1080)
    const scene=evaluateScene(view,derived,1000,VERTICAL_1080)
    expect(scene.debug.layout).toBe(center)
    expect(scene.camera).toBeNull()
    expect(scene.screen!.dest).toEqual({x:90,y:384,w:900,h:900})
    expect(scene.screen!.src.w*1920).toBeCloseTo(1080,5)
  })
  it.each([[1920,1080],[3840,2160],[2560,1080]])('recorta um quadrado da fonte %i×%i sem ampliar na base',(w,h)=>{
    const p=doc(w,h)
    p.style.defaultLayout=center
    const s=evaluateScene(p,deriveProject(p,data,VERTICAL_1080),1000,VERTICAL_1080)
    expect(s.screen!.src.w*w).toBeCloseTo(s.screen!.src.h*h,5)
    expect(s.screen!.src.w).toBeCloseTo(h/w,5)
    expect(s.screen!.dest.w).toBe(s.screen!.dest.h)
    expect(s.screen!.dest.w/(s.screen!.src.w*w)).toBeLessThanOrEqual(1)
    expect(s.backdrop).not.toBeNull()
  })
  it('usa a mesma suavização de foco, limita cliques a 1,35 e não invade gancho/legenda/bolha',()=>{
    const p=doc()
    p.style.defaultLayout=center
    p.zooms=[{id:'forte',start:0,end:durationMs,scale:3,focus:'auto',origin:'auto'}]
    const d=deriveProject(p,data,VERTICAL_1080)
    for (let t=0;t<durationMs;t+=41) {
      const s=evaluateScene(p,d,t,VERTICAL_1080)
      expect(s.debug.zoom.scale).toBeLessThanOrEqual(1.35)
      expect(s.screen!.dest.y).toBeGreaterThan(HOOK_BAND.bottom)
      expect(s.screen!.dest.y+s.screen!.dest.h).toBeLessThan(verticalCaptionY(center)*1920-46)
      expect(s.camera!.dest.y+s.camera!.dest.h).toBeLessThanOrEqual(s.screen!.dest.y)
      expect(s.screen!.src.x).toBeGreaterThanOrEqual(0)
      expect(s.screen!.src.x+s.screen!.src.w).toBeLessThanOrEqual(1+1e-12)
    }
    expect(d.paths[center]!.path.cx.at(-1)).toBeGreaterThan(d.paths[center]!.path.cx[0]!)
  })
  it.each(['stack','presenter'] as LayoutKind[])('%s também mostra pelo menos o quadrado da tela na base',(layout)=>{
    const f=layoutFollow(layout,VERTICAL_1080,{w:1920,h:1080})
    expect(f.view.w).toBeCloseTo(1080/1920,5)
    expect(f.view.h).toBe(1)
    const g=layoutGeometry(layout,doc().style,VERTICAL_1080,{screen:{w:1920,h:1080},camera:{w:640,h:360}})
    expect(g.screen!.w).toBe(g.screen!.h)
  })
})
