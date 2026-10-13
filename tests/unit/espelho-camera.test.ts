/**
 * Câmera ESPELHADA no vídeo final (commit 33b7e5f, 09/10): o padrão passou a `mirror: true` para o vídeo sair como a pessoa se viu. O padrão
 * NÃO muda aqui (decisão do usuário: ver o ENTREGA da F3); o que se prova é que o ajuste "Espelhar" desliga de verdade, na cena e no
 * desenho, em todos os layouts com a câmera, e que a prévia e a exportação leem o mesmo valor (as duas chamam `evaluateScene` + `renderFrame`).
 */
import { describe, expect, it } from 'vitest'
import { createProject, defaultStyle } from '@shared/project'
import { createRenderCache, renderFrame, type CanvasFactory, type Ctx2D, type FrameSet } from '@shared/render'
import { HORIZONTAL_1080, deriveProject, evaluateScene, prepareEvents } from '@shared/scene'
import type { LayoutKind, Project } from '@shared/types'

const data = prepareEvents({ cursor: [], clicks: [], keys: [] }, 20_000)
const frame = { image: { __id: -1 }, w: 1920, h: 1080 }

function project(layout: LayoutKind, mirror?: boolean): Project {
  const p = createProject({
    title: 't',
    sources: {
      screen: { path: 'media/screen.mp4', w: 1920, h: 912, fps: 30, durationMs: 20_000 },
      camera: { path: 'media/camera.mp4', w: 1920, h: 1080, fps: 30, durationMs: 20_000 }
    }
  })
  return { ...p, style: { ...p.style, defaultLayout: layout, camera: { ...p.style.camera, ...(mirror === undefined ? {} : { mirror }) } } }
}

/** Quantas vezes o desenho inverteu o eixo horizontal (`scale(-1, 1)`), em qualquer camada. */
function flips(p: Project): number {
  let count = 0
  let next = 1
  const make = (id: number, w: number, h: number) => {
    const state: Record<string, unknown> = { globalAlpha: 1, globalCompositeOperation: 'source-over' }
    const ctx = new Proxy(state, {
      get(target, key: string) {
        if (key in target) return target[key]
        if (key === 'scale') return (x: number, y: number) => void (x === -1 && y === 1 && count++)
        if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} })
        if (key === 'measureText') return () => ({ width: 10 })
        if (key === 'getImageData' || key === 'createImageData') return () => ({ data: new Uint8ClampedArray(4) })
        return () => undefined
      },
      set(target, key: string, value) {
        target[key] = value
        return true
      }
    }) as unknown as Ctx2D
    return { width: w, height: h, __id: id, getContext: () => ctx }
  }
  const factory: CanvasFactory = (w, h) => make(next++, w, h) as never
  const main = (make(0, 1920, 1080).getContext as (id: '2d') => Ctx2D)('2d')
  const cache = createRenderCache(factory)
  const scene = evaluateScene(p, deriveProject(p, data, HORIZONTAL_1080), 5000, HORIZONTAL_1080)
  renderFrame(main, scene, { screen: frame, camera: frame } as unknown as FrameSet, cache)
  return count
}

describe('Espelhar: o padrão é ligado (33b7e5f) e o ajuste desliga de verdade', () => {
  it('o padrão do projeto novo é espelhado (decisão de 09/10, não mudou na F3)', () => {
    expect(defaultStyle().camera.mirror).toBe(true)
  })

  it('a cena leva o valor do ajuste em todos os layouts com a câmera, ligado e desligado', () => {
    for (const layout of ['side-by-side', 'bubble', 'camera', 'presenter'] as const) {
      for (const mirror of [true, false]) {
        const p = project(layout, mirror)
        const scene = evaluateScene(p, deriveProject(p, data, HORIZONTAL_1080), 5000, HORIZONTAL_1080)
        expect(scene.camera?.mirror, `${layout} ${mirror}`).toBe(mirror)
      }
    }
  })

  it('o desenho inverte a imagem da câmera quando o ajuste está ligado e NÃO inverte quando está desligado', () => {
    for (const layout of ['side-by-side', 'bubble', 'camera'] as const) {
      expect(flips(project(layout, true)), `${layout} espelhado`).toBeGreaterThan(0)
      expect(flips(project(layout, false)), `${layout} sem espelho`).toBe(0)
    }
  })

  it('sem escolher nada o projeto novo sai espelhado, e o JSON salvo com `mirror: false` volta desligado ao abrir', () => {
    expect(flips(project('side-by-side'))).toBeGreaterThan(0)
    const off = project('side-by-side', false)
    const reopened = JSON.parse(JSON.stringify(off)) as Project
    expect(reopened.style.camera.mirror).toBe(false)
    expect(flips(reopened)).toBe(0)
  })
})
