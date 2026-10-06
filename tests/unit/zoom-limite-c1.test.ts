import { expect, it } from 'vitest'
import { createProject } from '@shared/project'
import { deriveProject, evaluateScene, prepareEvents, HORIZONTAL_1080, VERTICAL_1080 } from '@shared/scene'
import { computeCameraPath, sampleCameraPath, visibleRect } from '@shared/zoom'
import type { LayoutKind } from '@shared/types'

it('o retângulo final do zoom limita a amostra nas quatro bordas, mesmo ao voltar à escala base', () => {
  // O limite pertence ao retângulo que será desenhado, além do limite das amostras de 60 Hz.
  for (const [cx, cy] of [[0,0],[1,1],[0,1],[1,0],[0.2,0.8]]) {
    for (const scale of [1,1.2,1.35,2]) {
      const r = visibleRect({ scale, cx: cx!, cy: cy! }, { w: 0.5625, h: 1 })
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x+r.w).toBeLessThanOrEqual(1)
      expect(r.y+r.h).toBeLessThanOrEqual(1)
    }
  }
})

it('zoom, volta da escala e transição de layout ficam dentro da página C1, amostrados entre os pontos de 60 Hz', () => {
  const p = createProject({ title:'Limites do navegador', sources: {
    screen: { path:'media/screen.mp4', w:1920, h:1080, fps:30, durationMs:4000 },
    camera: { path:'media/camera.mp4', w:640, h:360, fps:30, durationMs:4000 }
  } })
  p.screenCrop = { mode:'manual', manual:{x:0.07,y:0.14,w:0.86,h:0.78} }
  p.zoomPreset = 'off'
  p.zooms = [{ id:'borda',start:200,end:1600,scale:2,focus:{x:1,y:0},origin:'manual' }]
  const data = prepareEvents({cursor:[{t:0,x:0.99,y:0.01},{t:3000,x:0.01,y:0.99}],clicks:[],keys:[]},4000)
  for (const format of [HORIZONTAL_1080,VERTICAL_1080]) {
    for (const layout of ['screen','screen-focus','stack','screen-wide','presenter'] as LayoutKind[]) {
      p.style.defaultLayout = layout
      p.layouts = [{id:'troca',start:1800,end:4000,layout:'screen-focus'}]
      const d = deriveProject(p,data,format)
      for (let t=0;t<4000;t+=7) {
        const r = evaluateScene(p,d,t,format).screen?.src
        if (!r) continue
        const page = d.crop!.at(t)
        expect(r.x).toBeGreaterThanOrEqual(page.x-1e-12)
        expect(r.y).toBeGreaterThanOrEqual(page.y-1e-12)
        expect(r.x+r.w).toBeLessThanOrEqual(page.x+page.w+1e-12)
        expect(r.y+r.h).toBeLessThanOrEqual(page.y+page.h+1e-12)
      }
    }
  }
  const path = computeCameraPath(p,data.grid,{durationMs:4000,view:{w:0.5625,h:1}})
  for (let t=0;t<4000;t+=7) {
    const r=visibleRect(sampleCameraPath(path,t),{w:0.5625,h:1})
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.y).toBeGreaterThanOrEqual(0)
    expect(r.x+r.w).toBeLessThanOrEqual(1+1e-12)
    expect(r.y+r.h).toBeLessThanOrEqual(1+1e-12)
  }
})
