import { describe, expect, it } from 'vitest'
import { buildFaceFramer, type FaceTrack } from '@shared/face'
import { createProject, defaultStyle } from '@shared/project'
import { HORIZONTAL_1080, deriveProject, evaluateScene, layoutGeometry, prepareEvents, type FormatSpec } from '@shared/scene'
import { SIDE_GAP, SIDE_WIDTH, resolveSideBySide } from '@shared/styles'
import type { Project, Rect, SideBySideStyle } from '@shared/types'

const SCREEN = { w: 1920, h: 1080 }
const CAMERA = { w: 1280, h: 720 }
const F: FormatSpec = HORIZONTAL_1080
const style = defaultStyle()

const geo = (sideBySide?: SideBySideStyle, format: FormatSpec = F) => layoutGeometry('side-by-side', { ...style, ...(sideBySide ? { sideBySide } : {}) }, format, { screen: SCREEN, camera: CAMERA })
const inside = (r: Rect, w = 1920, h = 1080): boolean => r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h
const PAD = Math.round(style.padding * 1080)

describe('lado a lado: o quadro da câmera ao lado da tela (estilo Tella)', () => {
  it('padrão: à direita, em pé (3:4), 27% do quadro, praticamente da altura da tela', () => {
    const g = geo()
    const s = g.screen!
    const c = g.camera!.rect
    expect(c.x).toBeGreaterThanOrEqual(s.x + s.w)
    expect(c.w / c.h).toBeCloseTo(0.75, 2)
    expect(c.w / 1920).toBeCloseTo(SIDE_WIDTH.default, 2)
    expect(Math.abs(c.h - s.h)).toBeLessThanOrEqual(3)
    expect(inside(s) && inside(c)).toBe(true)
  })

  it('à esquerda: a câmera vem antes da tela, e a margem do quadro é a mesma dos dois lados', () => {
    const g = geo({ side: 'left' })
    const s = g.screen!
    const c = g.camera!.rect
    expect(c.x + c.w).toBeLessThanOrEqual(s.x)
    expect(c.x).toBeGreaterThanOrEqual(PAD - 1)
    expect(s.x + s.w).toBeLessThanOrEqual(1920 - PAD + 1)
    // o conjunto é centrado: a sobra à esquerda e à direita é igual
    expect(Math.abs(c.x - (1920 - (s.x + s.w)))).toBeLessThanOrEqual(2)
  })

  it('quadrado: 1:1, centrado na altura da tela', () => {
    const g = geo({ ratio: 'square' })
    const s = g.screen!
    const c = g.camera!.rect
    expect(c.w).toBe(c.h)
    expect(Math.abs(c.y + c.h / 2 - (s.y + s.h / 2))).toBeLessThanOrEqual(1)
    expect(c.h).toBeLessThan(s.h) // quadrado é mais baixo que a tela
  })

  it('largura 25%–45% do quadro; fora da faixa é preso; a câmera nunca passa da altura útil', () => {
    const minW = geo({ width: 0.25, ratio: 'square' }).camera!.rect.w
    expect(minW / 1920).toBeCloseTo(0.25, 2)
    expect(geo({ width: 0.05, ratio: 'square' }).camera!.rect.w).toBe(minW)
    const maxSquare = geo({ width: 0.45, ratio: 'square' }).camera!.rect
    expect(maxSquare.w / 1920).toBeCloseTo(SIDE_WIDTH.max, 2)
    expect(geo({ width: 0.99, ratio: 'square' }).camera!.rect.w).toBe(maxSquare.w)
    // em pé a 45% passaria da altura útil (864 × 1152 > 950): a largura cai para caber, sem deformar
    const tall = geo({ width: 0.45, ratio: 'portrait' }).camera!.rect
    const innerH = 1080 - 2 * PAD
    expect(tall.h).toBeLessThanOrEqual(innerH + 1)
    expect(tall.w / tall.h).toBeCloseTo(0.75, 2)
    expect(inside(tall)).toBe(true)
  })

  it('espaço entre os dois: 0 cola, 8% abre; o padrão é o de sempre (≈39 px)', () => {
    const touch = geo({ gap: 0 })
    expect(Math.abs(touch.camera!.rect.x - (touch.screen!.x + touch.screen!.w))).toBeLessThanOrEqual(1)
    const wide = geo({ gap: SIDE_GAP.max })
    expect(wide.camera!.rect.x - (wide.screen!.x + wide.screen!.w)).toBeCloseTo(Math.round(SIDE_GAP.max * 1080), 0)
    const def = geo()
    expect(def.camera!.rect.x - (def.screen!.x + def.screen!.w)).toBeCloseTo(39, 0)
    expect(inside(wide.screen!) && inside(wide.camera!.rect)).toBe(true)
  })

  it('todas as combinações cabem no quadro e não se sobrepõem (16:9 a 4K)', () => {
    for (const side of ['left', 'right'] as const) {
      for (const ratio of ['portrait', 'square'] as const) {
        for (const width of [0.25, 0.3, 0.36, 0.45]) {
          for (const gap of [0, 0.036, 0.08]) {
            for (const f of [F, { kind: 'horizontal', w: 3840, h: 2160 } as FormatSpec, { kind: 'horizontal', w: 1280, h: 720 } as FormatSpec]) {
              const g = geo({ side, ratio, width, gap }, f)
              const s = g.screen!
              const c = g.camera!.rect
              expect(inside(s, f.w, f.h) && inside(c, f.w, f.h), `${side} ${ratio} ${width} ${gap} ${f.w}`).toBe(true)
              const apart = side === 'right' ? c.x >= s.x + s.w - 1 : s.x >= c.x + c.w - 1
              expect(apart, `${side} ${ratio} ${width} ${gap}`).toBe(true)
              expect(s.w / s.h).toBeCloseTo(16 / 9, 1)
            }
          }
        }
      }
    }
  })

  it('valores inválidos viram o padrão', () => {
    expect(resolveSideBySide(undefined)).toEqual({ side: 'right', ratio: 'portrait', aspect: 0.75, width: SIDE_WIDTH.default, gap: SIDE_GAP.default })
    expect(resolveSideBySide({ width: Number.NaN, gap: Number.POSITIVE_INFINITY })).toMatchObject({ width: SIDE_WIDTH.default, gap: SIDE_GAP.default })
  })
})

describe('lado a lado na cena: cantos e sombra coerentes, enquadramento do rosto', () => {
  function project(over: Partial<Project> = {}): Project {
    const p = createProject({
      title: 't',
      sources: {
        screen: { path: 'media/screen.mp4', w: SCREEN.w, h: SCREEN.h, fps: 30, durationMs: 20_000 },
        camera: { path: 'media/camera.mp4', w: CAMERA.w, h: CAMERA.h, fps: 30, durationMs: 20_000 }
      }
    })
    return { ...p, ...over, style: { ...p.style, defaultLayout: 'side-by-side', ...(over.style ?? {}) } }
  }
  const data = prepareEvents({ cursor: [], clicks: [], keys: [] }, 20_000)
  const face = (cx: number): FaceTrack => ({
    version: 1,
    engine: 'teste',
    frame: CAMERA,
    sampleMs: 200,
    durationMs: 20_000,
    boxes: Array.from({ length: 101 }, (_, i) => ({ t: i * 200, x: cx - 0.07, y: 0.25, w: 0.14, h: 0.3, score: 0.9 })),
    createdAt: ''
  })

  it('a câmera tem os mesmos cantos e a mesma sombra da tela, e não tem borda', () => {
    const p = project()
    const scene = evaluateScene(p, deriveProject(p, data, F), 5000, F)
    expect(scene.camera!.radius).toBe(scene.screen!.radius)
    expect(scene.camera!.shadow).toEqual(scene.screen!.shadow)
    expect(scene.camera!.border).toBeNull()
    // a bolha, ao contrário, leva a borda do estilo e uma sombra menor
    const b = project({ style: { ...defaultStyle(), defaultLayout: 'bubble' } })
    const bubble = evaluateScene(b, deriveProject(b, data, F), 5000, F)
    expect(bubble.camera!.border).not.toBeNull()
    expect(bubble.camera!.shadow!.blur).toBeLessThan(bubble.screen!.shadow!.blur)
  })

  it('sem análise do rosto o recorte é o do centro; com o rosto à direita (0,8) o recorte acompanha', () => {
    const p = project()
    const centered = evaluateScene(p, deriveProject(p, data, F), 5000, F).camera!.src
    expect(centered.x + centered.w / 2).toBeCloseTo(0.5, 5)
    const followed = evaluateScene(p, deriveProject(p, data, F, null, face(0.8)), 5000, F).camera!.src
    expect(followed.x + followed.w / 2).toBeGreaterThan(0.7)
    expect(followed.x + followed.w).toBeLessThanOrEqual(1 + 1e-9)
    // auto desligado volta ao centro
    const off = project({ style: { ...defaultStyle(), defaultLayout: 'side-by-side', camera: { ...defaultStyle().camera, framing: { auto: false } } } })
    const manual = evaluateScene(off, deriveProject(off, data, F, null, face(0.8)), 5000, F).camera!.src
    expect(manual.x + manual.w / 2).toBeCloseTo(0.5, 5)
  })

  it('a câmera escondida não carrega a análise do rosto (e o enquadramento vale para a bolha também)', () => {
    const hidden = project({ style: { ...defaultStyle(), defaultLayout: 'side-by-side', camera: { ...defaultStyle().camera, hidden: true } } })
    expect(deriveProject(hidden, data, F, null, face(0.8)).face).toBeNull()
    const p = project({ style: { ...defaultStyle(), defaultLayout: 'bubble' } })
    const src = evaluateScene(p, deriveProject(p, data, F, null, face(0.8)), 5000, F).camera!.src
    expect(src.x + src.w / 2).toBeGreaterThan(0.6)
    expect(buildFaceFramer(face(0.8), 0, 20_000)).not.toBeNull()
  })
})
