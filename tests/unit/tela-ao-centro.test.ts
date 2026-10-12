import { describe, expect, it } from 'vitest'
import { createProject, parseProject, serializeProject } from '@shared/project'
import { deriveProject, evaluateScene, layoutGeometry, prepareEvents, VERTICAL_1080 } from '@shared/scene'
import { defaultVerticalEdit, ensureVertical, layoutFollow, projectForFormat, verticalCaptionY, HOOK_BAND } from '@shared/vertical'
import { LEGIBLE_MAX_ZOOM, TEXT_TARGET_PX, bodyTextPx } from '@shared/legible'
import type { LayoutKind } from '@shared/types'

const durationMs=6000
// o cursor anda de 50% a 95% da largura em 6 s (amostras de 100 ms, como a gravação: a grade não interpola buracos de mais de 250 ms)
const data=prepareEvents({ cursor:Array.from({length:61},(_,i)=>({t:i*100,x:0.5+0.45*i/60,y:0.5})), clicks:[], keys:[] },durationMs)
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
    // F2: o zoom vem da letra (30 px de 13 px estimados): 900 px de destino mostram ~390 px da fonte, não mais os 1080 de antes
    expect(scene.screen!.src.w*1920).toBeCloseTo(900/(TEXT_TARGET_PX/bodyTextPx({w:1920,h:1080})),1)
  })
  it.each([[1920,1080],[3840,2160],[2560,1080]])('recorta um quadrado da fonte %i×%i com a letra no alvo (F2)',(w,h)=>{
    const p=doc(w,h)
    p.style.defaultLayout=center
    const s=evaluateScene(p,deriveProject(p,data,VERTICAL_1080),1000,VERTICAL_1080)
    expect(s.screen!.src.w*w).toBeCloseTo(s.screen!.src.h*h,5)
    expect(s.screen!.dest.w).toBe(s.screen!.dest.h)
    // a janela é de 1:1 (um quadrado de pixels da fonte) e a letra estimada chega em 30 px
    expect(bodyTextPx({w,h})*s.screen!.dest.w/(s.screen!.src.w*w)).toBeCloseTo(TEXT_TARGET_PX,1)
    expect(s.backdrop).not.toBeNull()
  })
  it('o zoom vem da letra (sem o teto de 1,35 dos cliques) e a janela não invade gancho/legenda/bolha',()=>{
    const p=doc()
    p.style.defaultLayout=center
    p.zooms=[{id:'forte',start:0,end:durationMs,scale:3,focus:'auto',origin:'auto'}]
    const d=deriveProject(p,data,VERTICAL_1080)
    for (let t=0;t<durationMs;t+=41) {
      const s=evaluateScene(p,d,t,VERTICAL_1080)
      expect(s.debug.zoom.scale).toBeLessThanOrEqual(LEGIBLE_MAX_ZOOM)
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
