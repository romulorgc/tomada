import { describe, expect, it } from 'vitest'
import { PRESENTER_TARGET } from '@shared/face'
import { createProject } from '@shared/project'
import { HORIZONTAL_1080, VERTICAL_1080, deriveProject, evaluateScene, prepareEvents, type FormatSpec } from '@shared/scene'
import { presenterWindow, resolvePresenter } from '@shared/styles'
import type { CursorSample, LayoutKind, PresenterStyle, Project, Word } from '@shared/types'
import { HOOK_BAND, HOOK_BAND_H, HOOK_MS, STACK_SPLIT, VERTICAL_H, hookPlacement, projectForFormat, verticalCaptionY } from '@shared/vertical'

/** Gancho e legenda do vertical nunca cobrem a página nem a boca: onde cada layout põe o gancho e o que a legenda faz. */

const D = 20_000
const WORDS: Word[] = [
  ['Olá', 0, 600],
  ['pessoal.', 600, 1300],
  ['Veja', 2000, 2500],
  ['como', 2500, 3000],
  ['isto', 3300, 3700],
  ['aqui.', 3700, 4200],
  ['funciona', 5000, 5500],
  ['por', 5500, 5900]
].map(([text, start, end], i) => ({ i, text: text as string, start: start as number, end: end as number, prob: 1, kind: 'word' as const }))

function doc(vertical: NonNullable<Project['vertical']>, over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p1',
    title: 't',
    createdAt: '2026-10-06T12:00:00.000Z',
    sources: {
      screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: D },
      camera: { path: 'media/camera.mp4', w: 3840, h: 2160, fps: 30, durationMs: D }
    }
  })
  p.captions = { ...p.captions, enabled: true }
  return { ...p, ...over, vertical }
}

const cursor: CursorSample[] = Array.from({ length: D / 8 + 1 }, (_, i) => ({ t: i * 8, x: 0.5, y: 0.5 }))
const data = prepareEvents({ cursor, clicks: [], keys: [] }, D)

function sceneAt(project: Project, t: number, format: FormatSpec = VERTICAL_1080) {
  const view = projectForFormat(project, format.kind)
  return evaluateScene(view, deriveProject(view, data, format, WORDS), t, format)
}
const layoutDoc = (layout: LayoutKind, extra: Partial<NonNullable<Project['vertical']>> = {}, over: Partial<Project> = {}) =>
  doc({ layout, layouts: [], zooms: [], zoomPreset: 'off', hook: 'Sua página inteira no vídeo', ...extra }, over)

describe('onde o gancho fica em cada layout vertical', () => {
  it('nos layouts de tela a faixa continua em y 15% (228–348), acima da página, e a legenda não se mexe', () => {
    for (const layout of ['screen-center', 'screen-focus', 'screen-wide', 'camera'] as LayoutKind[]) {
      const placement = hookPlacement(layout)
      expect(placement.band, layout).toEqual({ top: 228, bottom: 348 })
      expect(placement.captionY, layout).toBeNull()
    }
    expect(HOOK_BAND_H).toBe(120)
  })

  it('V-B com a câmera embaixo: a faixa começa na emenda (sobre a câmera, nunca sobre a página) e a legenda desce para logo abaixo dela', () => {
    const { band, captionY } = hookPlacement('stack')
    expect(band.top).toBeGreaterThanOrEqual(STACK_SPLIT)
    expect(band.bottom - band.top).toBe(HOOK_BAND_H)
    // a legenda (meia altura de ~40 px) fica inteira abaixo da faixa, dentro da caixa segura (até y 1440)
    expect(captionY! * VERTICAL_H - 40).toBeGreaterThanOrEqual(band.bottom)
    expect(captionY! * VERTICAL_H + 40).toBeLessThanOrEqual(1440)
  })

  it('V-B com a câmera em cima: a faixa fica sobre o tronco, acima da emenda, e a legenda (na emenda) não a toca', () => {
    const { band, captionY } = hookPlacement('stack', { cameraTop: true })
    expect(band.bottom).toBeLessThanOrEqual(STACK_SPLIT - 40)
    expect(captionY).toBeNull()
    expect(verticalCaptionY('stack') * VERTICAL_H - 40).toBeGreaterThanOrEqual(band.bottom)
    // abaixo do queixo do rosto de 40% da altura da câmera (centro em 42%): a faixa não pisa nele
    const chin = 0.42 * STACK_SPLIT + 0.2 * STACK_SPLIT
    expect(band.top).toBeGreaterThan(chin)
  })

  it('V-D: a faixa fica na área do apresentador, abaixo do queixo, para qualquer altura da pessoa; a legenda segue acima da cabeça', () => {
    for (const heightV of [0.35, 0.45, 0.6]) {
      const presenter: PresenterStyle = { heightV }
      const { band, captionY } = hookPlacement('presenter', { presenter })
      const win = presenterWindow(resolvePresenter(presenter), { w: 1080, h: VERTICAL_H }, true)
      const chin = win.y + (PRESENTER_TARGET.headroomY + PRESENTER_TARGET.targetH / 2) * win.h
      expect(band.top, `heightV ${heightV}`).toBeGreaterThanOrEqual(chin)
      expect(band.bottom, `heightV ${heightV}`).toBeLessThanOrEqual(VERTICAL_H - 120)
      expect(band.bottom - band.top).toBe(HOOK_BAND_H)
      expect(captionY).toBeNull()
      // a legenda do V-D (acima da cabeça) não está dentro da faixa do gancho
      const caption = verticalCaptionY('presenter', presenter) * VERTICAL_H
      expect(caption < band.top - 40 || caption > band.bottom + 40).toBe(true)
    }
  })
})

describe('o gancho e a legenda na cena', () => {
  it('V-B: com o gancho na tela ele não toca a página, a legenda fica logo abaixo e, sem ele, a legenda volta à emenda', () => {
    const p = layoutDoc('stack')
    const hook = sceneAt(p, 1000).hook!
    const page = sceneAt(p, 1000).screen!.dest
    expect(hook.style.bandTop).toBeGreaterThanOrEqual(page.y + page.h)
    const withHook = sceneAt(p, 1000).captions!
    expect(withHook.style.centerY - 40).toBeGreaterThanOrEqual(hook.style.bandBottom)
    expect(sceneAt(p, 5200).hook).toBeNull()
    expect(sceneAt(p, 5200).captions!.style.centerY).toBeCloseTo(STACK_SPLIT, 0)
  })

  it('V-B: a legenda desce com o fade de entrada do gancho e sobe com o de saída, sem salto e sem passar da faixa abaixo dele', () => {
    const p = layoutDoc('stack')
    const down = [40, 80, 120, 160, 400].map((t) => sceneAt(p, t).captions!.style.centerY)
    for (let i = 1; i < down.length; i++) expect(down[i]!).toBeGreaterThanOrEqual(down[i - 1]! - 1e-9)
    expect(down[0]!).toBeGreaterThanOrEqual(STACK_SPLIT - 1e-9) // nunca acima da emenda
    expect(down.at(-1)!).toBeCloseTo(hookPlacement('stack').captionY! * VERTICAL_H, 3)
    const up = [3700, 3800, 3900, 3990, 4300].map((t) => sceneAt(p, t).captions!.style.centerY)
    for (let i = 1; i < up.length; i++) expect(up[i]!).toBeLessThanOrEqual(up[i - 1]! + 1e-9)
    expect(up.at(-1)!).toBeCloseTo(STACK_SPLIT, 3)
  })

  it('V-B com a câmera em cima: a faixa fica acima da emenda e a legenda continua nela', () => {
    const p = layoutDoc('stack', { cameraTop: true })
    const scene = sceneAt(p, 1000)
    expect(scene.hook!.style.bandBottom).toBeLessThanOrEqual(STACK_SPLIT - 40)
    expect(scene.captions!.style.centerY).toBeCloseTo(STACK_SPLIT, 0)
    expect(scene.captions!.style.centerY - 40).toBeGreaterThanOrEqual(scene.hook!.style.bandBottom)
  })

  it('V-D: a faixa fica sobre o tronco da pessoa, fora da faixa da tela, e a legenda não se mexe', () => {
    const p = layoutDoc('presenter')
    const scene = sceneAt(p, 1000)
    const page = scene.screen!.dest
    expect(scene.hook!.style.bandTop).toBeGreaterThanOrEqual(page.y + page.h)
    const normal = sceneAt(p, 5200).captions!.style.centerY
    expect(sceneAt(p, 1000).captions!.style.centerY).toBeCloseTo(verticalCaptionY('presenter') * VERTICAL_H, 0)
    expect(normal).toBeCloseTo(verticalCaptionY('presenter') * VERTICAL_H, 0)
  })

  it('a posição escolhida pela pessoa para a legenda manda: o gancho não a empurra', () => {
    const p = layoutDoc('stack', { captions: { positionY: 0.8 } })
    expect(sceneAt(p, 1000).captions!.style.centerY).toBeCloseTo(0.8 * VERTICAL_H, 0)
  })

  it('Tela ao centro continua com o gancho em y 15% acima do quadrado, e o 16:9 não tem gancho', () => {
    const p = layoutDoc('screen-center')
    const scene = sceneAt(p, 1500)
    expect(scene.hook!.style.bandTop).toBe(HOOK_BAND.top)
    expect(scene.hook!.style.bandBottom).toBe(HOOK_BAND.bottom)
    expect(scene.hook!.style.bandBottom).toBeLessThanOrEqual(scene.screen!.dest.y)
    expect(sceneAt(p, 1500, HORIZONTAL_1080).hook).toBeNull()
    expect(sceneAt(p, HOOK_MS + 100).hook).toBeNull()
  })

  it('na troca de layout a faixa do gancho anda de uma posição à outra, sem salto', () => {
    const p = layoutDoc('screen-center', { layouts: [{ id: 'l1', start: 700, end: 20_000, layout: 'stack' }] })
    const tops = [650, 800, 900, 1000, 1100, 1300].map((t) => sceneAt(p, t).hook!.style.bandTop)
    expect(tops[0]!).toBe(HOOK_BAND.top)
    expect(tops.at(-1)!).toBeCloseTo(hookPlacement('stack').band.top, 3)
    for (let i = 1; i < tops.length; i++) expect(tops[i]!).toBeGreaterThanOrEqual(tops[i - 1]! - 1e-9)
  })
})
