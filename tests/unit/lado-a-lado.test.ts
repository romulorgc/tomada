import { describe, expect, it } from 'vitest'
import { BUBBLE_TARGET, SIDE_FACE_MIN_FRAME_H, buildFaceFramer, cameraCropRect, sideBySideTarget, type CropTarget, type FaceTrack } from '@shared/face'
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
  it('padrão: à direita, em pé (3:4), 24% do quadro, centrado na altura da tela', () => {
    const g = geo()
    const s = g.screen!
    const c = g.camera!.rect
    expect(c.x).toBeGreaterThanOrEqual(s.x + s.w)
    expect(c.w / c.h).toBeCloseTo(0.75, 2)
    expect(c.w / 1920).toBeCloseTo(SIDE_WIDTH.default, 2)
    expect(Math.abs(c.y + c.h / 2 - (s.y + s.h / 2))).toBeLessThanOrEqual(2)
    expect(inside(s) && inside(c)).toBe(true)
  })

  it('a página gravada do navegador (1920×912, 2,1:1) fica ~4,6% maior e com a MESMA altura do cartão da câmera; a margem e o espaço entre os dois são os de sempre', () => {
    const wide = { w: 1920, h: 912 }
    const at = (width?: number) => layoutGeometry('side-by-side', { ...style, ...(width !== undefined ? { sideBySide: { width } } : {}) }, F, { screen: wide, camera: CAMERA })
    const now = at()
    const before = at(0.27) // o padrão de antes do F3
    const s = now.screen!
    const c = now.camera!.rect
    expect(before.screen!.w).toBe(1233)
    expect(s.w).toBeGreaterThanOrEqual(Math.round(before.screen!.w * 1.045)) // 1290 contra 1233 px
    expect(s.w / 1920).toBeGreaterThan(0.66) // as referências: tela em 60–69% da largura
    expect(s.h).toBeGreaterThan(before.screen!.h)
    expect(Math.abs(c.h - s.h)).toBeLessThanOrEqual(3) // cartão e página alinhados em cima e embaixo
    expect(Math.abs(c.y - s.y)).toBeLessThanOrEqual(3)
    // a margem e o espaço entre os dois não mudaram
    expect(c.x + c.w).toBeCloseTo(1920 - PAD, -1)
    expect(c.x - (s.x + s.w)).toBeCloseTo(39, 0)
    expect(s.x).toBeCloseTo(PAD, -1)
    expect(c.w / 1920).toBeGreaterThanOrEqual(0.23) // dentro das referências (câmera em 23–29%)
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

  it('largura 20%–45% do quadro; fora da faixa é preso; a câmera nunca passa da altura útil', () => {
    const minW = geo({ width: SIDE_WIDTH.min, ratio: 'square' }).camera!.rect.w
    expect(minW / 1920).toBeCloseTo(0.2, 2)
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

  it('a faixa e o padrão vêm das referências lado a lado: câmera em 23–29% do quadro, padrão 24%', () => {
    expect(SIDE_WIDTH).toEqual({ min: 0.2, max: 0.45, default: 0.24 })
    expect(SIDE_WIDTH.default).toBeGreaterThanOrEqual(0.23)
    expect(SIDE_WIDTH.default).toBeLessThanOrEqual(0.29)
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

describe('lado a lado: o cartão estreita, o rosto não encolhe (F3)', () => {
  /** A altura do rosto na imagem final como fração da altura do quadro, com o recorte que o cartão pede. */
  function faceFraction(faceH: number, faceW: number, card: { w: number; h: number }, target: CropTarget): number {
    const cam = { w: 1920, h: 1080 }
    const aim = { cx: 0.5, cy: 0.45, faceW, faceH }
    const crop = cameraCropRect(cam, card.w / card.h, aim, undefined, target)
    return (faceH * card.h) / crop.h / 1080
  }
  const legacy = geo({ width: 0.27 }).camera!.rect // o cartão de antes do F3 (27%)
  const now = geo().camera!.rect // o de agora (24%)

  it('o alvo nunca é menor que o de sempre e cresce quando o cartão é mais baixo; o rosto nunca passa de 62% do cartão', () => {
    expect(sideBySideTarget(1080, legacy.h).targetH).toBeGreaterThanOrEqual(BUBBLE_TARGET.targetH)
    expect(sideBySideTarget(1080, now.h).targetH).toBeGreaterThan(sideBySideTarget(1080, legacy.h).targetH)
    expect(sideBySideTarget(1080, 300).targetH).toBeLessThanOrEqual(0.62)
    expect(sideBySideTarget(1080, 0).targetH).toBe(BUBBLE_TARGET.targetH)
    expect(sideBySideTarget(1080, now.h).maxZoom).toBe(BUBBLE_TARGET.maxZoom)
  })

  it('com o cartão de 24% o rosto nunca fica abaixo do piso das referências nem abaixo do que era no de 27% quando já era menor que o piso (rostos de 30% a 55% da altura da câmera; a gravação real tem 48%)', () => {
    for (const faceH of [0.3, 0.35, 0.4, 0.45, 0.48, 0.55]) {
      const faceW = faceH * 0.43 // a proporção da caixa do detector nas gravações do usuário (20,6% × 48,1%)
      const before = faceFraction(faceH, faceW, legacy, BUBBLE_TARGET)
      const after = faceFraction(faceH, faceW, now, sideBySideTarget(1080, now.h))
      // quem já tinha o rosto acima do piso (>30,5% do quadro) pode perder um pouco até o piso; quem tinha abaixo não perde nada
      expect(after, `rosto de ${faceH}`).toBeGreaterThanOrEqual(Math.min(before, SIDE_FACE_MIN_FRAME_H) - 0.004)
    }
  })

  it('o rosto fica em pelo menos 30,5% da altura do quadro (o quartil inferior das referências) sempre que a câmera deixa aproximar', () => {
    for (const faceH of [0.35, 0.4, 0.45, 0.48]) {
      const after = faceFraction(faceH, faceH * 0.43, now, sideBySideTarget(1080, now.h))
      expect(after, `rosto de ${faceH}`).toBeGreaterThanOrEqual(SIDE_FACE_MIN_FRAME_H - 0.006)
    }
  })

  it('na cena: a câmera do lado a lado usa o alvo novo e a bolha segue com o de sempre', () => {
    const p = createProject({
      title: 't',
      sources: {
        screen: { path: 'media/screen.mp4', w: 1920, h: 912, fps: 30, durationMs: 20_000 },
        camera: { path: 'media/camera.mp4', w: 1920, h: 1080, fps: 30, durationMs: 20_000 }
      }
    })
    const track: FaceTrack = {
      version: 1,
      engine: 'teste',
      frame: { w: 1920, h: 1080 },
      sampleMs: 200,
      durationMs: 20_000,
      boxes: Array.from({ length: 101 }, (_, i) => ({ t: i * 200, x: 0.5 - 0.103, y: 0.45 - 0.2403, w: 0.206, h: 0.4806, score: 0.9 })),
      createdAt: ''
    }
    const data = prepareEvents({ cursor: [], clicks: [], keys: [] }, 20_000)
    const srcOf = (layout: 'side-by-side' | 'bubble'): Rect => {
      const q = { ...p, style: { ...p.style, defaultLayout: layout, camera: { ...p.style.camera, punchIn: false } } }
      return evaluateScene(q, deriveProject(q, data, F, null, track), 5000, F).camera!.src
    }
    const side = srcOf('side-by-side')
    // o cartão de 24% pede o rosto em 0,305 do quadro: o recorte fecha ~1,1× (sem isso o rosto cairia para ~27% do quadro)
    expect(side.h).toBeLessThan(0.93)
    expect(side.h).toBeGreaterThan(0.8)
    expect(srcOf('bubble').h).toBeGreaterThanOrEqual(side.h - 1e-9)
  })
})
