/** Acabamento B: o layout do vídeo inteiro segue o estilo da câmera escolhido antes de gravar. */
import { describe, expect, it } from 'vitest'
import { cameraStyleLayouts } from '@shared/camera-style-layouts'
import { createProject } from '@shared/project'
import type { Project } from '@shared/types'

const screen = { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: 18_000 }
const camera = { path: 'media/camera.mp4', w: 3840, h: 2160, fps: 30, durationMs: 18_000 }
const project = (over: Partial<Project> = {}, sources: Project['sources'] = { screen, camera }): Project => ({ ...createProject({ title: 'Teste', sources }), ...over })

describe('layout do estilo da câmera', () => {
  it('Quadro ao lado sem o recorte do fundo ainda: lado a lado no 16:9 e V-B (tela em cima, rosto embaixo) no 9:16', () => {
    expect(cameraStyleLayouts(project({ cameraStyle: 'side-by-side' }), false)).toEqual({ style: 'side-by-side', horizontal: 'side-by-side', vertical: 'stack' })
  })

  it('F2: com o recorte pronto o 9:16 é o V-E Green screen qualquer que seja o estilo; o 16:9 segue a escolha (Quadro ao lado)', () => {
    expect(cameraStyleLayouts(project({ cameraStyle: 'side-by-side' }), true)).toEqual({ style: 'side-by-side', horizontal: 'side-by-side', vertical: 'greenscreen' })
  })

  it('projeto antigo, sem o campo do estilo, é Quadro ao lado no 16:9, nunca vira bolinha, e ganha o Green screen no 9:16 quando o recorte existe', () => {
    const p = project()
    expect(p.cameraStyle).toBeUndefined()
    expect(cameraStyleLayouts(p, true)).toEqual({ style: 'side-by-side', horizontal: 'side-by-side', vertical: 'greenscreen' })
    expect(cameraStyleLayouts(p, false)).toEqual({ style: 'side-by-side', horizontal: 'side-by-side', vertical: 'stack' })
  })

  it('Você sem fundo (green screen) escolhido ao gravar, com o recorte pronto: o mesmo no 16:9 e V-E Green screen no 9:16', () => {
    expect(cameraStyleLayouts(project({ cameraStyle: 'presenter' }), true)).toEqual({ style: 'presenter', horizontal: 'presenter', vertical: 'greenscreen' })
  })

  it('Você sem fundo sem o recorte do fundo: cai no quadro ao lado e V-B', () => {
    expect(cameraStyleLayouts(project({ cameraStyle: 'presenter' }), false)).toEqual({ style: 'side-by-side', horizontal: 'side-by-side', vertical: 'stack' })
  })

  it('sem câmera, com a câmera escondida ou sem tela: nada a impor', () => {
    expect(cameraStyleLayouts(project({}, { screen }), true)).toBeNull()
    expect(cameraStyleLayouts(project({}, { camera }), true)).toBeNull()
    const hidden = project()
    hidden.style = { ...hidden.style, camera: { ...hidden.style.camera, hidden: true } }
    expect(cameraStyleLayouts(hidden, true)).toBeNull()
  })
})
