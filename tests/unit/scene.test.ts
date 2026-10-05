import { describe, expect, it } from 'vitest'
import { createProject, defaultStyle } from '@shared/project'
import {
  CAMERA_ZOOM_SHRINK,
  HORIZONTAL_1080,
  LAYOUT_TRANSITION_MS,
  RIPPLE_MS,
  RIPPLE_RADIUS,
  baseView,
  buildLayoutPoints,
  deriveProject,
  evaluateScene,
  layoutAt,
  layoutGeometry,
  prepareEvents,
  resolveLayout,
  type FormatSpec
} from '@shared/scene'
import { CAMERA_CORNERS, coverCrop, cornerFractions } from '@shared/styles'
import type { ClickEvent, CursorSample, LayoutKind, Project, Rect, Zoom } from '@shared/types'

const SCREEN = { w: 1920, h: 1080 }
const CAMERA = { w: 640, h: 360 }
const F: FormatSpec = HORIZONTAL_1080

function project(over: Partial<Project> = {}): Project {
  const p = createProject({
    title: 't',
    sources: {
      screen: { path: 'media/screen.mp4', w: SCREEN.w, h: SCREEN.h, fps: 30, durationMs: 20_000 },
      camera: { path: 'media/camera.mp4', w: CAMERA.w, h: CAMERA.h, fps: 30, durationMs: 20_000 }
    }
  })
  return { ...p, ...over }
}

const click = (t: number, x: number, y: number): ClickEvent => ({ t, x, y, button: 'left' })
const still = (x: number, y: number, ms = 20_000): CursorSample[] => Array.from({ length: Math.floor(ms / 8) + 1 }, (_, i) => ({ t: i * 8, x, y }))

function derive(p: Project, clicks: ClickEvent[] = [], cursor: CursorSample[] = still(0.5, 0.5), format = F) {
  return deriveProject(p, prepareEvents({ cursor, clicks, keys: [] }, 20_000), format)
}

const inside = (r: Rect, w = 1920, h = 1080): boolean => r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h

describe('geometria dos layouts horizontais', () => {
  const style = defaultStyle()

  it('bubble: tela com a proporção da fonte dentro da margem e bolha circular no canto', () => {
    const g = layoutGeometry('bubble', style, F, { screen: SCREEN, camera: CAMERA })
    const pad = Math.round(style.padding * 1080)
    const s = g.screen!
    expect(s.w / s.h).toBeCloseTo(16 / 9, 2)
    expect(s.x).toBeGreaterThanOrEqual(pad)
    expect(s.y).toBeGreaterThanOrEqual(pad)
    expect(s.x + s.w).toBeLessThanOrEqual(1920 - pad)
    expect(s.y + s.h).toBeLessThanOrEqual(1080 - pad)
    // centrada
    expect(Math.abs(s.x - (1920 - s.x - s.w))).toBeLessThanOrEqual(1)
    expect(Math.abs(s.y - (1080 - s.y - s.h))).toBeLessThanOrEqual(1)

    const c = g.camera!
    expect(c.rect.w).toBe(c.rect.h) // círculo: quadrado
    expect(c.rect.h).toBeCloseTo(style.camera.size * 1080, 0)
    expect(c.radius).toBeCloseTo(c.rect.w / 2, 5)
    // canto inferior direito, dentro da tela
    expect(c.rect.x + c.rect.w).toBeLessThan(s.x + s.w)
    expect(c.rect.y + c.rect.h).toBeLessThan(s.y + s.h)
    expect(c.rect.x).toBeGreaterThan(s.x + s.w / 2)
    expect(c.rect.y).toBeGreaterThan(s.y + s.h / 2)
  })

  it('a bolha encolhe 30% durante o zoom', () => {
    const none = layoutGeometry('bubble', style, F, { screen: SCREEN, camera: CAMERA }, 0).camera!.rect
    const full = layoutGeometry('bubble', style, F, { screen: SCREEN, camera: CAMERA }, 1).camera!.rect
    expect(full.h / none.h).toBeCloseTo(1 - CAMERA_ZOOM_SHRINK, 1)
    const half = layoutGeometry('bubble', style, F, { screen: SCREEN, camera: CAMERA }, 0.5).camera!.rect
    expect(half.h).toBeLessThan(none.h)
    expect(half.h).toBeGreaterThan(full.h)
  })

  it('todas as 9 posições da grade 3×3 ficam dentro da tela e nos lugares certos', () => {
    expect(CAMERA_CORNERS).toHaveLength(9)
    const base = layoutGeometry('bubble', style, F, { screen: SCREEN, camera: CAMERA }).screen!
    for (const corner of CAMERA_CORNERS) {
      const st = { ...style, camera: { ...style.camera, corner } }
      const c = layoutGeometry('bubble', st, F, { screen: SCREEN, camera: CAMERA }).camera!.rect
      expect(c.x).toBeGreaterThanOrEqual(base.x)
      expect(c.y).toBeGreaterThanOrEqual(base.y)
      expect(c.x + c.w).toBeLessThanOrEqual(base.x + base.w)
      expect(c.y + c.h).toBeLessThanOrEqual(base.y + base.h)
      const { fx, fy } = cornerFractions(corner)
      const cx = (c.x + c.w / 2 - base.x) / base.w
      const cy = (c.y + c.h / 2 - base.y) / base.h
      if (fx === 0) expect(cx).toBeLessThan(0.25)
      if (fx === 0.5) expect(cx).toBeCloseTo(0.5, 1)
      if (fx === 1) expect(cx).toBeGreaterThan(0.75)
      if (fy === 0) expect(cy).toBeLessThan(0.3)
      if (fy === 0.5) expect(cy).toBeCloseTo(0.5, 1)
      if (fy === 1) expect(cy).toBeGreaterThan(0.7)
    }
  })

  it('formas da câmera: círculo é 1:1; arredondado e retângulo são 4:3 (raio 20% e reto)', () => {
    const rounded = layoutGeometry('bubble', { ...style, camera: { ...style.camera, shape: 'rounded' } }, F, { screen: SCREEN, camera: CAMERA }).camera!
    expect(rounded.rect.w / rounded.rect.h).toBeCloseTo(4 / 3, 1)
    expect(rounded.radius).toBeCloseTo(rounded.rect.h * 0.2, 0)
    const square = layoutGeometry('bubble', { ...style, camera: { ...style.camera, shape: 'square' } }, F, { screen: SCREEN, camera: CAMERA }).camera!
    expect(square.radius).toBe(0)
  })

  it('side-by-side: tela ~70% da largura útil, câmera em pé (3:4, 27% do quadro) ao lado, praticamente da altura da tela, tudo dentro do quadro', () => {
    const g = layoutGeometry('side-by-side', style, F, { screen: SCREEN, camera: CAMERA })
    const s = g.screen!
    const c = g.camera!.rect
    expect(c.x).toBeGreaterThanOrEqual(s.x + s.w)
    expect(Math.abs(c.h - s.h)).toBeLessThanOrEqual(3) // o padrão (27%, 3:4) deixa os dois da mesma altura, como no Tella
    expect(Math.abs(c.y - s.y)).toBeLessThanOrEqual(2)
    expect(c.w / 1920).toBeCloseTo(0.27, 2)
    expect(c.w / c.h).toBeCloseTo(0.75, 2)
    expect(c.h).toBeGreaterThan(c.w) // em pé
    const pad = Math.round(style.padding * 1080)
    const usable = 1920 - 2 * pad
    expect(s.w / usable).toBeGreaterThan(0.64)
    expect(s.w / usable).toBeLessThan(0.72)
    expect(s.w / s.h).toBeCloseTo(16 / 9, 1)
    expect(inside(s) && inside(c)).toBe(true)
    expect(c.x + c.w).toBeLessThanOrEqual(1920 - pad + 1)
  })

  it('screen: só a tela; camera: só a câmera; sem fonte cai no que existe', () => {
    const screenOnly = layoutGeometry('screen', style, F, { screen: SCREEN, camera: CAMERA })
    expect(screenOnly.camera).toBeNull()
    expect(screenOnly.screen).not.toBeNull()
    const cam = layoutGeometry('camera', style, F, { screen: SCREEN, camera: CAMERA })
    expect(cam.screen).toBeNull()
    expect(cam.camera!.rect.w / cam.camera!.rect.h).toBeCloseTo(16 / 9, 1)
    expect(resolveLayout('bubble', true, false, 'horizontal')).toBe('screen')
    expect(resolveLayout('side-by-side', true, false, 'horizontal')).toBe('screen')
    expect(resolveLayout('bubble', false, true, 'horizontal')).toBe('camera')
    expect(resolveLayout('stack', true, true, 'horizontal')).toBe('side-by-side')
    expect(layoutGeometry('bubble', style, F, { screen: null, camera: CAMERA }).screen).toBeNull()
    expect(layoutGeometry('bubble', style, F, { screen: null, camera: null })).toEqual({ screen: null, camera: null })
  })

  it('a margem e o raio escalam com o tamanho do quadro (4K, prévia)', () => {
    const f4k: FormatSpec = { kind: 'horizontal', w: 3840, h: 2160 }
    const a = layoutGeometry('screen', style, F, { screen: SCREEN, camera: null }).screen!
    const b = layoutGeometry('screen', style, f4k, { screen: SCREEN, camera: null }).screen!
    expect(b.w / a.w).toBeCloseTo(2, 1)
    expect(b.x / a.x).toBeCloseTo(2, 1)
  })

  it('formato vertical: a tela ocupa o quadro e a bolha fica dentro dele', () => {
    const v: FormatSpec = { kind: 'vertical', w: 1080, h: 1920 }
    const g = layoutGeometry('bubble', style, v, { screen: SCREEN, camera: CAMERA })
    expect(g.screen).toEqual({ x: 0, y: 0, w: 1080, h: 1920 })
    expect(inside(g.camera!.rect, 1080, 1920)).toBe(true)
    const view = baseView(v, SCREEN)
    expect(view.w).toBeCloseTo(0.3164, 3)
    expect(view.h).toBe(1)
  })

  it('coverCrop corta o excesso e centraliza', () => {
    expect(coverCrop({ w: 640, h: 360 }, 1)).toEqual({ x: (1 - 9 / 16) / 2, y: 0, w: 9 / 16, h: 1 })
    expect(coverCrop({ w: 640, h: 360 }, 16 / 9)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    const tall = coverCrop({ w: 640, h: 360 }, 0.5)
    expect(tall.w).toBeCloseTo(0.5 / (16 / 9), 6)
    expect(tall.h).toBe(1)
  })
})

describe('layouts ao longo do tempo', () => {
  it('buildLayoutPoints: segmentos viram pontos e voltam ao padrão', () => {
    const p = project({
      layouts: [
        { id: 'a', start: 2000, end: 5000, layout: 'screen' },
        { id: 'b', start: 5000, end: 8000, layout: 'camera' }
      ]
    })
    const pts = buildLayoutPoints(p)
    expect(pts.map((x) => [x.t, x.layout])).toEqual([
      [Number.NEGATIVE_INFINITY, 'bubble'],
      [2000, 'screen'],
      [5000, 'camera'],
      [8000, 'bubble']
    ])
    expect(layoutAt(pts, 1000)).toMatchObject({ layout: 'bubble', prev: 'bubble' })
    expect(layoutAt(pts, 2000)).toMatchObject({ layout: 'screen', prev: 'bubble', since: 2000 })
    expect(layoutAt(pts, 6000)).toMatchObject({ layout: 'camera', prev: 'screen', since: 5000 })
    expect(layoutAt(pts, 99_999)).toMatchObject({ layout: 'bubble', prev: 'camera' })
  })

  it('transição de 400 ms: começa no layout anterior, termina no novo, e passa pelo meio', () => {
    const p = project({ layouts: [{ id: 'a', start: 5000, end: 12_000, layout: 'side-by-side' }] })
    const d = derive(p)
    const before = evaluateScene(p, d, 4999, F)
    const at0 = evaluateScene(p, d, 5000, F)
    const mid = evaluateScene(p, d, 5000 + LAYOUT_TRANSITION_MS / 2, F)
    const end = evaluateScene(p, d, 5000 + LAYOUT_TRANSITION_MS, F)
    expect(at0.screen!.dest).toEqual(before.screen!.dest) // ainda no layout anterior
    expect(end.screen!.dest).toEqual(layoutGeometry('side-by-side', p.style, F, { screen: SCREEN, camera: CAMERA }).screen)
    // o meio fica entre os dois
    const a = at0.screen!.dest
    const b = end.screen!.dest
    const m = mid.screen!.dest
    expect(m.w).toBeLessThan(a.w)
    expect(m.w).toBeGreaterThan(b.w)
    expect(m.w).toBeCloseTo((a.w + b.w) / 2, 0) // ease-in-out cúbico passa por 50% no meio
    expect(at0.debug.transition).toBe(0)
    expect(end.debug.transition).toBe(1)
    // a câmera (bolha → cartão): o raio vai do círculo ao canto do cartão
    expect(at0.camera!.radius).toBeGreaterThan(end.camera!.radius)
  })

  it('elementos que aparecem ou somem entram e saem com opacidade', () => {
    const p = project({ layouts: [{ id: 'a', start: 5000, end: 12_000, layout: 'screen' }] })
    const d = derive(p)
    expect(evaluateScene(p, d, 5000, F).camera!.opacity).toBeCloseTo(1, 6) // ainda bolha
    const mid = evaluateScene(p, d, 5200, F)
    expect(mid.camera!.opacity).toBeGreaterThan(0)
    expect(mid.camera!.opacity).toBeLessThan(1)
    expect(evaluateScene(p, d, 5400, F).camera).toBeNull()
    expect(evaluateScene(p, d, 8000, F).camera).toBeNull()
  })

  it('layout só câmera: sem tela na cena', () => {
    const p = project({ layouts: [{ id: 'a', start: 0, end: 12_000, layout: 'camera' }] })
    const s = evaluateScene(p, derive(p), 6000, F)
    expect(s.screen).toBeNull()
    expect(s.camera).not.toBeNull()
  })
})

describe('evaluateScene: zoom, ripple e cursor', () => {
  it('sem zoom o recorte é a fonte inteira; durante o zoom segue o caminho da câmera', () => {
    const zoom: Zoom = { id: 'z', start: 3000, end: 9000, scale: 2, focus: { x: 0.75, y: 0.25 }, origin: 'manual' }
    const p = project({ zooms: [zoom] })
    const d = derive(p)
    const flat = evaluateScene(p, d, 1000, F)
    expect(flat.screen!.src).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    const z = evaluateScene(p, d, 8000, F)
    expect(z.screen!.src.w).toBeCloseTo(0.5, 2)
    expect(z.screen!.src.x + z.screen!.src.w / 2).toBeCloseTo(0.75, 2)
    expect(z.screen!.src.y + z.screen!.src.h / 2).toBeCloseTo(0.25, 2)
    expect(z.debug.zoom.scale).toBeCloseTo(2, 2)
    // a bolha encolheu
    expect(z.camera!.dest.h).toBeLessThan(flat.camera!.dest.h * 0.75)
  })

  it('é puro: a mesma entrada devolve a mesma cena', () => {
    const p = project({ zooms: [{ id: 'z', start: 3000, end: 9000, scale: 1.7, focus: 'auto', origin: 'auto' }] })
    const d = derive(p, [click(4000, 0.4, 0.4)], still(0.4, 0.4))
    const a = evaluateScene(p, d, 4200, F)
    const b = evaluateScene(p, d, 4200, F)
    expect(a).toEqual(b)
    // ... e não depende da ordem das chamadas (sem estado entre quadros)
    evaluateScene(p, d, 9000, F)
    expect(evaluateScene(p, d, 4200, F)).toEqual(a)
  })

  it('ripple: 500 ms, raio 0 → 40 px, opacidade 0,5 → 0, posição levada pelo recorte do zoom', () => {
    const p = project()
    const d = derive(p, [click(5000, 0.5, 0.5)])
    const s0 = evaluateScene(p, d, 5000, F)
    expect(s0.ripples).toHaveLength(1)
    expect(s0.ripples[0]!.radius).toBeCloseTo(0, 6)
    expect(s0.ripples[0]!.alpha).toBeCloseTo(0.5, 6)
    // centro da tela (sem zoom o clique em 0,5 / 0,5 cai no centro do retângulo da tela)
    const dest = s0.screen!.dest
    expect(s0.ripples[0]!.x).toBeCloseTo(dest.x + dest.w / 2, 3)
    expect(s0.ripples[0]!.y).toBeCloseTo(dest.y + dest.h / 2, 3)
    const mid = evaluateScene(p, d, 5000 + RIPPLE_MS / 2, F).ripples[0]!
    expect(mid.radius).toBeGreaterThan(RIPPLE_RADIUS * 0.8) // ease-out: já quase no tamanho
    expect(mid.radius).toBeLessThan(RIPPLE_RADIUS)
    expect(mid.alpha).toBeLessThan(0.1)
    const late = evaluateScene(p, d, 5000 + RIPPLE_MS - 1, F).ripples[0]!
    expect(late.radius).toBeCloseTo(RIPPLE_RADIUS, 0)
    expect(late.alpha).toBeCloseTo(0, 2)
    expect(evaluateScene(p, d, 5000 + RIPPLE_MS, F).ripples).toHaveLength(0)
    expect(evaluateScene(p, d, 4999, F).ripples).toHaveLength(0)
  })

  it('ripple: com zoom 2 em foco fixo, o ponto do clique é levado pelo recorte', () => {
    const zoom: Zoom = { id: 'z', start: 0, end: 20_000, scale: 2, focus: { x: 0.5, y: 0.5 }, origin: 'manual' }
    const p = project({ zooms: [zoom] })
    const d = derive(p, [click(10_000, 0.6, 0.55)])
    const s = evaluateScene(p, d, 10_000, F)
    const r = s.ripples[0]!
    const src = s.screen!.src
    const dest = s.screen!.dest
    expect(r.x).toBeCloseTo(dest.x + ((0.6 - src.x) / src.w) * dest.w, 3)
    expect(r.y).toBeCloseTo(dest.y + ((0.55 - src.y) / src.h) * dest.h, 3)
    // com zoom 2 o ponto fica mais longe do centro do que sem zoom
    expect(r.x - (dest.x + dest.w / 2)).toBeCloseTo(0.1 * 2 * dest.w, 0)
  })

  it('o ripple obedece ao estilo (desligado não gera nada) e escala com o quadro', () => {
    const p = project()
    p.style.cursor.ripple = false
    expect(evaluateScene(p, derive(p, [click(5000, 0.5, 0.5)]), 5100, F).ripples).toEqual([])
    const q = project()
    const f4k: FormatSpec = { kind: 'horizontal', w: 3840, h: 2160 }
    const r = evaluateScene(q, derive(q, [click(5000, 0.5, 0.5)], still(0.5, 0.5), f4k), 5000 + 400, f4k).ripples[0]!
    const r1 = evaluateScene(q, derive(q, [click(5000, 0.5, 0.5)]), 5000 + 400, F).ripples[0]!
    expect(r.radius / r1.radius).toBeCloseTo(2, 3)
  })

  it('halo só no modo real e só quando ligado, na posição do cursor levada pelo recorte', () => {
    const p = project()
    const d = derive(p, [], still(0.3, 0.6))
    expect(evaluateScene(p, d, 5000, F).halo).toBeNull() // desligado por padrão
    p.style.cursor.halo = true
    const s = evaluateScene(p, d, 5000, F)
    const dest = s.screen!.dest
    expect(s.halo!.x).toBeCloseTo(dest.x + 0.3 * dest.w, 3)
    expect(s.halo!.y).toBeCloseTo(dest.y + 0.6 * dest.h, 3)
    expect(s.cursor).toBeNull()
  })

  it('cursor sintético: só no modo synthetic, aperta no clique e some depois de parado', () => {
    const p = project()
    p.style.cursor.mode = 'synthetic'
    const d = derive(p, [click(5000, 0.5, 0.5)], still(0.5, 0.5))
    expect(evaluateScene(p, d, 1000, F).cursor).not.toBeNull()
    const idle = evaluateScene(p, d, 1000, F).cursor!
    const pressed = evaluateScene(p, d, 5060, F).cursor!
    expect(pressed.scale).toBeLessThan(idle.scale)
    expect(pressed.scale / idle.scale).toBeCloseTo(0.85, 2)
    expect(evaluateScene(p, d, 19_000, F).cursor).toBeNull() // parado há mais de 2 s
    expect(evaluateScene(p, d, 1000, F).halo).toBeNull()
  })

  it('a cena cobre o quadro: fundo do estilo, formato e unidade', () => {
    const p = project()
    const s = evaluateScene(p, derive(p), 100, F)
    expect(s.format).toEqual(F)
    expect(s.unit).toBe(1)
    expect(s.background).toEqual(p.style.background)
    expect(s.captions).toBeNull()
    expect(s.screen!.shadow).toMatchObject({ blur: 40, opacity: 0.45, offsetY: 16 })
    expect(s.camera!.shadow!.blur).toBeLessThan(s.screen!.shadow!.blur)
    expect(s.camera!.border).toEqual({ width: 4, color: '#ffffff' })
    expect(s.screen!.radius).toBe(18)
  })

  it('deriveProject calcula trechos mantidos e a duração de saída', () => {
    const p = project({ cuts: [{ id: 'c', start: 2000, end: 5000, reason: 'manual', enabled: true }] })
    const d = derive(p)
    expect(d.kept).toEqual([
      { start: 0, end: 2000 },
      { start: 5000, end: 20_000 }
    ])
    expect(d.outputDurationMs).toBe(17_000)
    expect(d.durationMs).toBe(20_000)
  })

  it('layouts de TODOS os tipos produzem retângulos finitos e dentro do quadro', () => {
    const kinds: LayoutKind[] = ['bubble', 'side-by-side', 'screen', 'camera', 'stack', 'screen-focus']
    for (const kind of kinds) {
      const p = project({ layouts: [{ id: 'a', start: 0, end: 20_000, layout: kind }] })
      const s = evaluateScene(p, derive(p), 10_000, F)
      for (const el of [s.screen, s.camera]) {
        if (!el) continue
        for (const v of Object.values(el.dest)) expect(Number.isFinite(v)).toBe(true)
        expect(inside(el.dest)).toBe(true)
      }
    }
  })
})
