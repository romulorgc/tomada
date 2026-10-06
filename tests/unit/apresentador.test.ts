import { describe, expect, it } from 'vitest'
import { createBlurRegion } from '@shared/blur'
import { BUBBLE_TARGET, PRESENTER_TARGET, cameraCropRect } from '@shared/face'
import { createProject, defaultStyle } from '@shared/project'
import { createRenderCache, renderFrame, type CanvasFactory, type Ctx2D, type FrameSet } from '@shared/render'
import {
  HORIZONTAL_1080,
  LAYOUT_TRANSITION_MS,
  VERTICAL_1080,
  deriveProject,
  evaluateScene,
  layoutGeometry,
  prepareEvents,
  resolveLayout,
  type FormatSpec
} from '@shared/scene'
import { PRESENTER, presenterScreenHeightV, resolvePresenter } from '@shared/styles'
import type { LayoutSeg, PresenterStyle, Project, Rect, Style } from '@shared/types'
import { SAFE_BOX, VERTICAL_H, autoVerticalLayouts, layoutFollow, screenActivity, verticalCaptionY } from '@shared/vertical'

const SCREEN = { w: 1920, h: 1080 }
const CAMERA = { w: 1920, h: 1080 }
const H: FormatSpec = HORIZONTAL_1080
const V: FormatSpec = VERTICAL_1080
const base = defaultStyle()
const styleWith = (presenter?: PresenterStyle, over: Partial<Style> = {}): Style => ({ ...base, ...(presenter ? { presenter } : {}), ...over })
const geo = (presenter?: PresenterStyle, format: FormatSpec = H) => layoutGeometry('presenter', styleWith(presenter), format, { screen: SCREEN, camera: CAMERA })
const data = prepareEvents({ cursor: [], clicks: [], keys: [] }, 20_000)

function project(layout: Style['defaultLayout'], layouts: LayoutSeg[] = [], presenter?: PresenterStyle, over: Partial<Style> = {}): Project {
  const p = createProject({
    title: 't',
    sources: {
      screen: { path: 'media/screen.mp4', w: SCREEN.w, h: SCREEN.h, fps: 30, durationMs: 20_000 },
      camera: { path: 'media/camera.mp4', w: CAMERA.w, h: CAMERA.h, fps: 30, durationMs: 20_000 }
    }
  })
  return { ...p, layouts, style: { ...p.style, defaultLayout: layout, ...(presenter ? { presenter } : {}), ...over } }
}
const sceneAt = (p: Project, t: number, f: FormatSpec) => evaluateScene(p, deriveProject(p, data, f), t, f)

describe('apresentador recortado: padrões e faixas', () => {
  it('valores ausentes ou inválidos viram os padrões medidos (56% no 16:9, 45% no 9:16, à direita)', () => {
    expect(resolvePresenter(undefined)).toEqual({ side: 'right', height: 0.56, heightV: 0.45, outline: false, outlineWidth: 8, shadow: true })
    expect(resolvePresenter({ height: Number.NaN, heightV: Number.POSITIVE_INFINITY, outlineWidth: Number.NaN })).toMatchObject({ height: 0.56, heightV: 0.45, outlineWidth: 8 })
  })

  it('a altura da pessoa fica presa às faixas (16:9 0,45–0,75; 9:16 0,35–0,60) e o contorno a 6–12 px', () => {
    expect(resolvePresenter({ height: 0.1 }).height).toBe(PRESENTER.height.min)
    expect(resolvePresenter({ height: 3 }).height).toBe(PRESENTER.height.max)
    expect(resolvePresenter({ heightV: 0.1 }).heightV).toBe(PRESENTER.heightV.min)
    expect(resolvePresenter({ heightV: 3 }).heightV).toBe(PRESENTER.heightV.max)
    expect(resolvePresenter({ outlineWidth: 2 }).outlineWidth).toBe(6)
    expect(resolvePresenter({ outlineWidth: 40 }).outlineWidth).toBe(12)
    expect(resolvePresenter({ shadow: false }).shadow).toBe(false)
    expect(resolvePresenter({ outline: true }).outline).toBe(true)
  })
})

describe('Apresentador 16:9: janela ancorada na borda de baixo, no canto', () => {
  it('padrão: à direita, colada embaixo, passando um pouco da borda direita; pessoa com 56% da altura do quadro', () => {
    const g = geo()
    const c = g.camera!.rect
    expect(c.y + c.h).toBe(1080) // ancorada na borda de baixo
    expect(c.x + c.w).toBeGreaterThan(1920) // encosta e passa da borda da direita (a pessoa fica colada nela)
    expect(c.x + c.w).toBeLessThanOrEqual(1920 + c.w * PRESENTER.bleed + 1)
    // a pessoa ocupa ~85% da janela: 56% do quadro
    expect((c.h * PRESENTER.personFrac) / 1080).toBeCloseTo(0.56, 2)
    expect(c.w / c.h).toBeCloseTo(PRESENTER.aspect, 2)
    expect(g.camera!.radius).toBe(0)
  })

  it('o centro da pessoa cai em x ≈ 82% do quadro (a mediana medida é 81%) com a altura padrão, e espelhado à esquerda; a janela é larga para não cortar as mãos', () => {
    const right = geo().camera!.rect
    const left = geo({ side: 'left' }).camera!.rect
    expect((right.x + right.w / 2) / 1920).toBeGreaterThan(0.8)
    expect((right.x + right.w / 2) / 1920).toBeLessThan(0.84)
    expect((left.x + left.w / 2) / 1920).toBeCloseTo(1 - (right.x + right.w / 2) / 1920, 2)
    // 1,5 de largura para 1 de altura: a janela mostra 84% da largura de uma webcam 16:9, e fora da pessoa ela é transparente
    expect(right.w / right.h).toBeCloseTo(1.5, 1)
  })

  it('a tela tem a margem de sempre (a mesma do layout só tela) e continua inteira dentro do quadro', () => {
    const only = layoutGeometry('screen', base, H, { screen: SCREEN, camera: CAMERA }).screen!
    expect(geo().screen).toEqual(only)
  })

  it('à esquerda: a janela passa da borda da esquerda; espelhar não muda a janela', () => {
    const c = geo({ side: 'left' }).camera!.rect
    expect(c.x).toBeLessThan(0)
    expect(c.x).toBeGreaterThanOrEqual(-c.w * PRESENTER.bleed - 1)
    expect(c.y + c.h).toBe(1080)
  })

  it('altura da pessoa de 45% a 75%: a janela cresce junto e nunca passa do alto do quadro (16:9 a 4K)', () => {
    for (const f of [H, { kind: 'horizontal', w: 3840, h: 2160 } as FormatSpec, { kind: 'horizontal', w: 1280, h: 720 } as FormatSpec]) {
      let last = 0
      for (const height of [0.45, 0.56, 0.65, 0.7, 0.75]) {
        const c = geo({ height }, f).camera!.rect
        expect(c.y).toBeGreaterThanOrEqual(0)
        expect(c.y + c.h).toBe(f.h)
        expect(c.h).toBeGreaterThan(last)
        last = c.h
        expect((c.h * PRESENTER.personFrac) / f.h).toBeCloseTo(height, 1)
      }
    }
  })

  it('sem câmera o layout cai na só tela; sem tela, na só câmera; no vertical o V-D é preservado', () => {
    expect(resolveLayout('presenter', true, false, 'horizontal')).toBe('screen')
    expect(resolveLayout('presenter', true, false, 'vertical')).toBe('screen-focus')
    expect(resolveLayout('presenter', false, true, 'horizontal')).toBe('camera')
    expect(resolveLayout('presenter', true, true, 'horizontal')).toBe('presenter')
    expect(resolveLayout('presenter', true, true, 'vertical')).toBe('presenter')
  })
})

describe('V-D (9:16): o recorte da tela em cima e o apresentador embaixo, na largura toda', () => {
  it('a janela ocupa a largura e acaba na borda de baixo; a pessoa tem 45% da altura; a tela vai um pouco abaixo da cabeça', () => {
    const g = geo(undefined, V)
    const cam = g.camera!.rect
    const scr = g.screen!
    expect(cam.x).toBe(0)
    expect(cam.w).toBe(1080)
    expect(cam.y + cam.h).toBe(VERTICAL_H)
    expect((cam.h * PRESENTER.personFrac) / VERTICAL_H).toBeCloseTo(0.45, 2)
    expect(scr).toEqual({ x: 0, y: 0, w: 1080, h: Math.round(presenterScreenHeightV(resolvePresenter(undefined)) * VERTICAL_H) })
    const headTop = (1 - 0.45) * VERTICAL_H
    expect(scr.h).toBeGreaterThan(headTop) // a cabeça e as mãos invadem a tela
    expect(scr.h - headTop).toBeLessThan(0.1 * VERTICAL_H)
  })

  it('a legenda fica 4 pontos acima da cabeça e dentro da caixa segura, em toda a faixa de altura', () => {
    for (const heightV of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6]) {
      const y = verticalCaptionY('presenter', { heightV })
      expect(y).toBeCloseTo(1 - heightV - 0.04, 5)
      expect(y * VERTICAL_H).toBeGreaterThanOrEqual(SAFE_BOX.y)
      expect(y * VERTICAL_H).toBeLessThanOrEqual(SAFE_BOX.y + SAFE_BOX.h)
      // acima da cabeça: o rosto (~26% da altura da pessoa, a partir do topo) fica abaixo da legenda
      expect(y).toBeLessThan(1 - heightV)
    }
    expect(verticalCaptionY('presenter')).toBeCloseTo(0.51, 5)
    expect(verticalCaptionY('screen-focus')).toBe(0.7) // os outros layouts não mudaram
  })

  it('o recorte da tela segue o cursor e é mais largo que o do V-A (a faixa de cima é mais larga que o quadro todo)', () => {
    const vd = layoutFollow('presenter', V, SCREEN)
    const va = layoutFollow('screen-focus', V, SCREEN)
    expect(vd.gain).toBe(1)
    expect(vd.view.h).toBe(1)
    expect(vd.view.w).toBeGreaterThan(va.view.w)
    expect(vd.view.w).toBeCloseTo(1080 / (VERTICAL_H * presenterScreenHeightV(resolvePresenter(undefined))) / (SCREEN.w / SCREEN.h), 3)
    expect(layoutFollow('presenter', H, SCREEN)).toEqual({ view: { w: 1, h: 1 }, gain: 1 })
  })

  it('o fundo desfocado da tela aparece embaixo da pessoa (como no V-C) e a tela não tem sombra nem cantos', () => {
    const p = project('presenter')
    const scene = sceneAt(p, 5000, V)
    expect(scene.backdrop).not.toBeNull()
    expect(scene.backdrop!.alpha).toBe(1)
    expect(scene.screen!.shadow).toBeNull()
    expect(scene.screen!.radius).toBe(0)
    expect(scene.camera!.cutout).not.toBeNull()
    expect(scene.camera!.cutout!.weight).toBe(1)
    // fora do V-D não há fundo desfocado (V-A)
    expect(sceneAt(project('screen-focus'), 5000, V).backdrop).toBeNull()
  })

  it('todas as alturas cabem no quadro 9:16, de 540×960 a 2160×3840', () => {
    for (const f of [V, { kind: 'vertical', w: 540, h: 960 } as FormatSpec, { kind: 'vertical', w: 2160, h: 3840 } as FormatSpec]) {
      for (const heightV of [0.35, 0.45, 0.6]) {
        const g = geo({ heightV }, f)
        for (const r of [g.screen!, g.camera!.rect] as Rect[]) {
          expect(r.x).toBeGreaterThanOrEqual(0)
          expect(r.y).toBeGreaterThanOrEqual(0)
          expect(r.x + r.w).toBeLessThanOrEqual(f.w)
          expect(r.y + r.h).toBeLessThanOrEqual(f.h + 1)
        }
        expect(g.camera!.rect.y + g.camera!.rect.h).toBe(f.h)
      }
    }
  })
})

describe('na cena: recorte, contorno, sombra e a troca de layout de 400 ms', () => {
  it('só há recorte no layout presenter; o contorno e a sombra vêm do estilo', () => {
    expect(sceneAt(project('bubble'), 5000, H).camera!.cutout).toBeNull()
    const on = sceneAt(project('presenter', [], { outline: true, outlineWidth: 10, shadow: true }), 5000, H).camera!.cutout!
    expect(on).toMatchObject({ weight: 1, outline: 10 })
    expect(on.shadow).not.toBeNull()
    const off = sceneAt(project('presenter', [], { outline: false, shadow: false }), 5000, H).camera!.cutout!
    expect(off.outline).toBe(0)
    expect(off.shadow).toBeNull()
    // o contorno e a sombra escalam com o quadro (px na altura de 1080)
    const big = sceneAt(project('presenter', [], { outline: true, outlineWidth: 10 }), 5000, { kind: 'horizontal', w: 3840, h: 2160 }).camera!.cutout!
    expect(big.outline).toBeCloseTo(20, 5)
  })

  it('a troca para o apresentador leva 400 ms: o recorte entra aos poucos e o cartão sai', () => {
    const seg: LayoutSeg = { id: 'l1', start: 5000, end: 12_000, layout: 'presenter' }
    const p = project('bubble', [seg])
    const d = deriveProject(p, data, H)
    expect(evaluateScene(p, d, 4900, H).camera!.cutout).toBeNull()
    expect(evaluateScene(p, d, 5000, H).camera!.cutout).toBeNull() // começa em zero
    const mid = evaluateScene(p, d, 5000 + LAYOUT_TRANSITION_MS / 2, H).camera!.cutout!
    expect(mid.weight).toBeGreaterThan(0.3)
    expect(mid.weight).toBeLessThan(0.7)
    expect(evaluateScene(p, d, 5000 + LAYOUT_TRANSITION_MS + 10, H).camera!.cutout!.weight).toBe(1)
    // na volta o recorte sai e some
    const back = evaluateScene(p, d, 12_000 + LAYOUT_TRANSITION_MS / 2, H).camera!.cutout!
    expect(back.weight).toBeGreaterThan(0.3)
    expect(back.weight).toBeLessThan(0.7)
    expect(evaluateScene(p, d, 12_000 + LAYOUT_TRANSITION_MS + 10, H).camera!.cutout).toBeNull()
  })

  it('a janela da câmera anda junto com a troca (nada de salto): o retângulo é intermediário no meio da troca', () => {
    const seg: LayoutSeg = { id: 'l1', start: 5000, end: 12_000, layout: 'presenter' }
    const p = project('bubble', [seg])
    const d = deriveProject(p, data, H)
    const a = evaluateScene(p, d, 4900, H).camera!.dest
    const m = evaluateScene(p, d, 5200, H).camera!.dest
    const z = evaluateScene(p, d, 5600, H).camera!.dest
    expect(m.h).toBeGreaterThan(Math.min(a.h, z.h))
    expect(m.h).toBeLessThan(Math.max(a.h, z.h))
  })

  it('só o apresentador pede a máscara: needsMatte', () => {
    const seg: LayoutSeg = { id: 'l1', start: 5000, end: 6000, layout: 'presenter' }
    expect(deriveProject(project('bubble'), data, H).needsMatte).toBe(false)
    expect(deriveProject(project('presenter'), data, H).needsMatte).toBe(true)
    expect(deriveProject(project('bubble', [seg]), data, H).needsMatte).toBe(true)
    expect(deriveProject(project('presenter', [], undefined, { camera: { ...base.camera, hidden: true } }), data, H).needsMatte).toBe(false)
    expect(deriveProject(project('presenter', []), data, V).needsMatte).toBe(true)
  })

  it('o recorte da câmera do apresentador põe a cabeça perto do topo da janela; o da bolha, o rosto grande no meio', () => {
    const face = { cx: 0.5, cy: 0.4, faceW: 0.1, faceH: 0.14 }
    const pres = cameraCropRect(CAMERA, 1.2, face, undefined, PRESENTER_TARGET)
    const bub = cameraCropRect(CAMERA, 1.2, face, undefined, BUBBLE_TARGET)
    // rosto pequeno na imagem: o apresentador aproxima mais (a pessoa vira ~85% da janela) e a cabeça fica perto do topo
    expect(pres.h).toBeLessThan(1)
    const headTop = (face.cy - face.faceH * 1.05 - pres.y) / pres.h
    expect(headTop).toBeGreaterThanOrEqual(0)
    expect(headTop).toBeLessThan(0.25)
    // a bolha centra o rosto mais para o meio
    const bubbleFaceY = (face.cy - bub.y) / bub.h
    const presFaceY = (face.cy - pres.y) / pres.h
    expect(presFaceY).toBeLessThan(bubbleFaceY)
    // o recorte sempre cabe dentro da imagem
    for (const r of [pres, bub]) {
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9)
      expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9)
    }
  })
})

describe('escolha automática do vertical: com a máscara, a fala sem atividade vira V-D', () => {
  const quiet = (hasMatte?: boolean) =>
    autoVerticalLayouts({
      durationMs: 30_000,
      hasCamera: true,
      clicks: [{ t: 1000 }],
      keys: [],
      cursor: { hz: 60, t: [0], x: [0.5], y: [0.5] } as unknown as Parameters<typeof screenActivity>[0]['cursor'],
      speech: null,
      ...(hasMatte !== undefined ? { hasMatte } : {})
    })

  it('sem máscara continua V-B (stack); com a máscara usa o apresentador (presenter), nos mesmos trechos', () => {
    const without = quiet()
    const withMatte = quiet(true)
    expect(without.length).toBeGreaterThan(0)
    expect(without.every((s) => s.layout === 'stack')).toBe(true)
    expect(withMatte.map((s) => [s.start, s.end])).toEqual(without.map((s) => [s.start, s.end]))
    expect(withMatte.every((s) => s.layout === 'presenter')).toBe(true)
    expect(quiet(false).every((s) => s.layout === 'stack')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// O desenho: a composição com os modos de mistura do Canvas 2D (sem ler pixel de volta)

type Op = { canvas: number; op: string; alpha: number; kind: 'drawImage' | 'fillRect'; from?: number }

/** Um canvas falso que só anota o que foi desenhado e em que modo de mistura (id da camada, modo, opacidade). */
function recorder(): { factory: CanvasFactory; ops: Op[]; main: Ctx2D } {
  const ops: Op[] = []
  let next = 1
  const make = (id: number, w: number, h: number) => {
    const state: Record<string, unknown> = { globalAlpha: 1, globalCompositeOperation: 'source-over' }
    const ctx = new Proxy(state, {
      get(target, key: string) {
        if (key in target) return target[key]
        if (key === 'drawImage') {
          return (img: { __id?: number }) => ops.push({ canvas: id, op: String(target.globalCompositeOperation), alpha: Number(target.globalAlpha), kind: 'drawImage', ...(img?.__id !== undefined ? { from: img.__id } : {}) })
        }
        if (key === 'fillRect') return () => ops.push({ canvas: id, op: String(target.globalCompositeOperation), alpha: Number(target.globalAlpha), kind: 'fillRect' })
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
  return { factory, ops, main }
}

describe('render: apresentador recortado com a máscara', () => {
  const frame = (w = 1920, h = 1080) => ({ image: { __id: -1 }, w, h })
  const draw = (p: Project, t: number, format: FormatSpec, frames: FrameSet) => {
    const r = recorder()
    const cache = createRenderCache(r.factory)
    cache.images.clear()
    renderFrame(r.main, evaluateScene(p, deriveProject(p, data, format), t, format), frames, cache)
    return r.ops
  }

  it('com a máscara: a silhueta é apagada do quadro (multiply) e a pessoa é somada (lighter); sem o cartão da câmera por baixo', () => {
    const ops = draw(project('presenter'), 5000, H, { screen: frame(), camera: frame(), matte: frame() })
    const onMain = ops.filter((o) => o.canvas === 0 && o.kind === 'drawImage')
    expect(onMain.some((o) => o.op === 'multiply')).toBe(true)
    expect(onMain.some((o) => o.op === 'lighter')).toBe(true)
    // o cartão da câmera (camada "camera" desenhada em source-over) não aparece: o último source-over do quadro é o fundo/tela
    const lastLighter = onMain.map((o) => o.op).lastIndexOf('lighter')
    expect(lastLighter).toBeGreaterThan(onMain.map((o) => o.op).lastIndexOf('multiply') - 1)
  })

  it('sem a máscara (ainda processando) a janela da câmera sai inteira, sem modo de mistura', () => {
    const ops = draw(project('presenter'), 5000, H, { screen: frame(), camera: frame(), matte: null })
    const onMain = ops.filter((o) => o.canvas === 0 && o.kind === 'drawImage')
    expect(onMain.some((o) => o.op === 'multiply' || o.op === 'lighter')).toBe(false)
  })

  it('o contorno acrescenta a dilatação da silhueta (modo lighten), a sombra o borrão; sem eles não há nenhum dos dois', () => {
    const lightenCount = (presenter: PresenterStyle) =>
      draw(project('presenter', [], presenter), 5000, H, { screen: frame(), camera: frame(), matte: frame() }).filter((o) => o.op === 'lighten').length
    expect(lightenCount({ outline: false, shadow: false })).toBe(0)
    expect(lightenCount({ outline: true, shadow: false })).toBeGreaterThanOrEqual(24)
    const withShadow = draw(project('presenter', [], { outline: false, shadow: true }), 5000, H, { screen: frame(), camera: frame(), matte: frame() })
    const without = draw(project('presenter', [], { outline: false, shadow: false }), 5000, H, { screen: frame(), camera: frame(), matte: frame() })
    expect(withShadow.filter((o) => o.op === 'difference').length).toBeGreaterThan(without.filter((o) => o.op === 'difference').length)
  })

  it('no meio da troca de layout o recorte entra com opacidade parcial e o cartão ainda aparece', () => {
    const seg: LayoutSeg = { id: 'l1', start: 5000, end: 12_000, layout: 'presenter' }
    const ops = draw(project('bubble', [seg]), 5000 + LAYOUT_TRANSITION_MS / 2, H, { screen: frame(), camera: frame(), matte: frame() })
    const mixes = ops.filter((o) => o.canvas === 0 && (o.op === 'multiply' || o.op === 'lighter'))
    expect(mixes.length).toBeGreaterThan(0)
    expect(mixes.every((o) => o.alpha > 0 && o.alpha < 1)).toBe(true)
  })

  it('layout sem apresentador nunca usa multiply nem lighter, com ou sem máscara (nada mudou para os outros layouts)', () => {
    for (const layout of ['bubble', 'side-by-side', 'screen'] as const) {
      const ops = draw(project(layout), 5000, H, { screen: frame(), camera: frame(), matte: frame() })
      expect(ops.some((o) => o.op === 'multiply' || o.op === 'lighter' || o.op === 'lighten')).toBe(false)
    }
  })
})

// A proteção (desfoque de dado sensível, M5a) é da TELA e vale em todos os layouts com câmera da M4c.
describe('render: o desfoque protege a tela nos layouts do quadro ao lado e do apresentador', () => {
  const SCREEN_ID = -1
  const CAMERA_ID = -2
  const MATTE_ID = -3
  const frames = (): FrameSet => ({ screen: { image: { __id: SCREEN_ID }, w: 1920, h: 1080 }, camera: { image: { __id: CAMERA_ID }, w: 1920, h: 1080 }, matte: { image: { __id: MATTE_ID }, w: 1920, h: 1080 } }) as never
  const protectedProject = (layout: Style['defaultLayout'], withRegion: boolean): Project => {
    const p = project(layout)
    return withRegion ? createBlurRegion(p, { x: 0.2, y: 0.2, w: 0.3, h: 0.2 }, 0, 20_000, 20_000)! : p
  }
  const fromOf = (ops: Op[], id: number): Set<number> => new Set(ops.filter((o) => o.kind === 'drawImage' && o.from === id).map((o) => o.canvas))
  const render = (p: Project, format: FormatSpec) => {
    const r = recorder()
    const cache = createRenderCache(r.factory)
    cache.images.clear()
    renderFrame(r.main, evaluateScene(p, deriveProject(p, data, format), 5000, format), frames(), cache)
    return r.ops
  }

  const cases: Array<[string, Style['defaultLayout'], FormatSpec]> = [
    ['quadro ao lado (Tella, 16:9)', 'side-by-side', H],
    ['Apresentador 16:9 com o recorte da câmera', 'presenter', H],
    ['V-D (Apresentador vertical) com o recorte da câmera', 'presenter', V]
  ]
  for (const [name, layout, format] of cases) {
    it(`${name}: o quadro cru da tela só entra nas camadas da proteção; o que compõe o quadro final é a camada protegida`, () => {
      const p = protectedProject(layout, true)
      const scene = evaluateScene(p, deriveProject(p, data, format), 5000, format)
      expect(scene.blurRegions).toHaveLength(1)
      expect(scene.camera).toBeTruthy()
      const ops = render(p, format)
      // protectScreen é a primeira coisa de renderFrame a criar camadas: a protegida (1) e a amostra do pixelado/desfoque (2).
      // O cru não vai a mais nenhuma camada nem direto ao quadro final (0); drawScreen/drawBackdrop recebem a protegida.
      expect([...fromOf(ops, SCREEN_ID)].sort()).toEqual([1, 2])
      expect(ops.some((o) => o.kind === 'drawImage' && o.from === 1 && o.canvas !== 1)).toBe(true)
      // a câmera e o recorte do fundo seguem como antes (a proteção não os toca)
      expect(fromOf(ops, CAMERA_ID).size).toBeGreaterThan(0)
      if (layout === 'presenter') expect(fromOf(ops, MATTE_ID).size).toBeGreaterThan(0)
    })
    it(`${name}: sem região de desfoque a cena não leva proteção e a tela é desenhada como antes`, () => {
      const p = protectedProject(layout, false)
      expect(evaluateScene(p, deriveProject(p, data, format), 5000, format).blurRegions ?? []).toHaveLength(0)
      expect(fromOf(render(p, format), SCREEN_ID).size).toBeGreaterThan(0)
    })
  }
})
