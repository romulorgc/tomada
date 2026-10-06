/**
 * Junção da C1 (recorte do navegador) com a M5a (desfoque) e a M4c (câmera): o recorte muda o ESPAÇO de coordenadas da tela.
 *
 * (a) A região de desfoque é normalizada na tela GRAVADA (origem). Com o recorte ligado ela tem de continuar cobrindo o mesmo
 *     pedaço, nos dois formatos e em todos os layouts com câmera, na prévia (retângulo da interface) e no desenho (a proteção
 *     é aplicada ao quadro inteiro ANTES de o recorte ser desenhado).
 * (b) O foco do zoom por clique na prévia (item 5 da C1) tem de seguir certo com o quadro ao lado e o Apresentador.
 */
import { describe, expect, it } from 'vitest'
import { createBlurRegion, displayRect, sourcePoint } from '@shared/blur'
import { createProject } from '@shared/project'
import { createRenderCache, renderFrame, type CanvasFactory, type Ctx2D, type FrameSet } from '@shared/render'
import { HORIZONTAL_1080, VERTICAL_1080, deriveProject, evaluateScene, focusToPreviewPoint, prepareEvents, previewPointToFocus, type FormatSpec } from '@shared/scene'
import type { LayoutKind, Project, Rect } from '@shared/types'

const DURATION = 20_000
const SOURCE = { w: 2560, h: 1080 }
/** O recorte (na tela gravada). O centro dele é (0,40; 0,50) da tela. */
const CROP: Rect = { x: 0.1, y: 0.2, w: 0.6, h: 0.6 }
/** O clique e o cursor, na tela gravada: no espaço do recorte são (0,5; 0,5). */
const CLICK = { x: 0.4, y: 0.5 }
/** A região protegida, na tela gravada, centrada no clique (o centro do recorte). */
const REGION: Rect = { x: 0.34, y: 0.42, w: 0.12, h: 0.16 }
const H: FormatSpec = HORIZONTAL_1080
const V: FormatSpec = VERTICAL_1080

const cursor = Array.from({ length: Math.floor(DURATION / 8) + 1 }, (_, i) => ({ t: i * 8, x: CLICK.x, y: CLICK.y }))
const data = prepareEvents({ cursor, clicks: [{ t: 1000, x: CLICK.x, y: CLICK.y, button: 'left' }], keys: [] }, DURATION)

function mk(layout: LayoutKind, o: { zoom?: boolean; bar?: boolean; blur?: boolean; mode?: 'blur' | 'pixelate' | 'solid' } = {}): Project {
  const base = createProject({
    title: 'recorte e camera',
    sources: {
      screen: { path: 'media/screen.mp4', ...SOURCE, fps: 30, durationMs: DURATION },
      camera: { path: 'media/camera.mp4', w: 1920, h: 1080, fps: 30, durationMs: DURATION }
    }
  })
  const p: Project = {
    ...base,
    zoomPreset: 'off',
    // o foco do zoom manual é lido no espaço do RECORTE: (0,5; 0,5) é o clique
    zooms: o.zoom ? [{ id: 'z', start: 0, end: DURATION, scale: 2, focus: { x: 0.5, y: 0.5 }, origin: 'manual' }] : [],
    screenCrop: { mode: 'manual', manual: CROP, ...(o.bar ? { browserFrame: { enabled: true, domain: 'exemplo.com.br' } } : {}) },
    style: { ...base.style, defaultLayout: layout, cursor: { ...base.style.cursor, ripple: true } }
  }
  if (!o.blur) return p
  const blurred = createBlurRegion(p, REGION, 0, DURATION, DURATION)!
  return o.mode ? { ...blurred, blurRegions: blurred.blurRegions!.map((r) => ({ ...r, mode: o.mode! })) } : blurred
}

const CASES: Array<{ name: string; layout: LayoutKind; format: FormatSpec }> = [
  { name: 'tela só (16:9)', layout: 'screen', format: H },
  { name: 'quadro ao lado (Tella, 16:9)', layout: 'side-by-side', format: H },
  { name: 'bolha (16:9)', layout: 'bubble', format: H },
  { name: 'Apresentador 16:9', layout: 'presenter', format: H },
  { name: 'V-B (tela e câmera empilhadas)', layout: 'side-by-side', format: V },
  { name: 'V-D (Apresentador vertical)', layout: 'presenter', format: V },
  { name: 'Tela ao centro vertical', layout: 'screen-center', format: V }
]
const sceneOf = (p: Project, f: FormatSpec, t = 1100) => evaluateScene(p, deriveProject(p, data, f), t, f)
const pageOf = (s: { dest: Rect; bar?: { h: number } }, fx: number, fy: number) => {
  const barH = s.bar?.h ?? 0
  return { x: s.dest.x + fx * s.dest.w, y: s.dest.y + barH + fy * (s.dest.h - barH) }
}

describe('(b) o foco do zoom por clique na prévia, com o recorte e os layouts da câmera', () => {
  for (const c of CASES) {
    for (const zoom of [false, true]) {
      it(`${c.name}${zoom ? ', com zoom' : ''}: o ripple do clique, o marcador do foco e o clique de volta caem no mesmo ponto`, () => {
        const scene = sceneOf(mk(c.layout, { zoom }), c.format)
        const screen = scene.screen!
        expect(screen).toBeTruthy()
        expect(scene.ripples).toHaveLength(1)
        // o clique está em (0,5; 0,5) do recorte: o marcador desse foco é onde o ripple foi desenhado
        const marker = focusToPreviewPoint(screen, { x: 0.5, y: 0.5 })
        expect(marker, 'o ponto do clique está na janela visível').not.toBeNull()
        expect(scene.ripples[0]!.x).toBeCloseTo(marker!.x, 3)
        expect(scene.ripples[0]!.y).toBeCloseTo(marker!.y, 3)
        // clicar nesse ponto devolve o mesmo foco
        const back = previewPointToFocus(screen, marker!)!
        expect(back.x).toBeCloseTo(0.5, 4)
        expect(back.y).toBeCloseTo(0.5, 4)
        // outros pontos da página: o caminho de ida e volta fecha
        for (const [fx, fy] of [[0.2, 0.3], [0.8, 0.7]] as const) {
          const click = pageOf(screen, fx, fy)
          const focus = previewPointToFocus(screen, click)!
          expect(focus).not.toBeNull()
          const again = focusToPreviewPoint(screen, focus)!
          expect(again.x).toBeCloseTo(click.x, 3)
          expect(again.y).toBeCloseTo(click.y, 3)
        }
      })
    }
  }

  it('com a moldura de navegador (16:9): o clique na barra não fixa foco e o ripple segue a página abaixo dela', () => {
    for (const c of CASES.filter((k) => k.format === H)) {
      const scene = sceneOf(mk(c.layout, { bar: true }), c.format)
      const screen = scene.screen!
      expect(screen.bar!.h, c.name).toBeGreaterThan(10)
      expect(previewPointToFocus(screen, { x: screen.dest.x + screen.dest.w / 2, y: screen.dest.y + screen.bar!.h / 2 }), c.name).toBeNull()
      const marker = focusToPreviewPoint(screen, { x: 0.5, y: 0.5 })!
      expect(scene.ripples[0]!.x, c.name).toBeCloseTo(marker.x, 3)
      expect(scene.ripples[0]!.y, c.name).toBeCloseTo(marker.y, 3)
      expect(marker.y, c.name).toBeGreaterThan(screen.dest.y + screen.bar!.h)
    }
  })
})

describe('(a) a região de desfoque cobre o mesmo pedaço com o recorte ligado (prévia)', () => {
  for (const c of CASES) {
    for (const [label, o] of [['sem zoom', {}], ['com zoom', { zoom: true }], ...(c.format === H ? [['com a moldura de navegador', { bar: true }] as const] : [])] as Array<[string, { zoom?: boolean; bar?: boolean }]>) {
      it(`${c.name}, ${label}: a região fica sobre o pedaço certo da tela e a conversão inversa devolve a origem`, () => {
        const p = mk(c.layout, { blur: true, ...o })
        const scene = sceneOf(p, c.format, 1000)
        // a região nunca é reescrita pelo recorte: continua no quadro de ORIGEM, como foi criada
        expect(scene.blurRegions).toEqual(p.blurRegions)
        const screen = scene.screen!
        const box = displayRect(REGION, screen)
        // o centro da região é o centro do recorte (0,5; 0,5): é onde a prévia mostra esse ponto
        const marker = focusToPreviewPoint(screen, { x: 0.5, y: 0.5 })!
        expect(box.x + box.w / 2).toBeCloseTo(marker.x, 2)
        expect(box.y + box.h / 2).toBeCloseTo(marker.y, 2)
        // a escala: a região ocupa (w / largura da janela visível, em px da tela gravada) do cartão
        expect(box.w).toBeCloseTo((REGION.w / screen.src.w) * screen.dest.w, 3)
        // e o caminho de volta (desenhar uma região na prévia) cai na tela gravada, nos pontos de origem
        const back = sourcePoint({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, screen)
        expect(back.x).toBeCloseTo(CLICK.x, 3)
        expect(back.y).toBeCloseTo(CLICK.y, 3)
        const corner = sourcePoint({ x: box.x, y: box.y }, screen)
        expect(corner.x).toBeCloseTo(REGION.x, 3)
        expect(corner.y).toBeCloseTo(REGION.y, 3)
      })
    }
  }
})

// ---------------------------------------------------------------------------
// O desenho: a proteção é aplicada ao quadro INTEIRO da origem, e o recorte é desenhado a partir da camada protegida

type Op = { canvas: number; kind: 'drawImage' | 'fillRect'; args: number[]; from?: number; fill?: string }
function recorder(): { factory: CanvasFactory; ops: Op[]; main: Ctx2D } {
  const ops: Op[] = []
  let next = 1
  const make = (id: number, w: number, h: number) => {
    const state: Record<string, unknown> = { globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '' }
    const ctx = new Proxy(state, {
      get(target, key: string) {
        if (key in target) return target[key]
        if (key === 'drawImage') return (img: { __id?: number }, ...args: number[]) => ops.push({ canvas: id, kind: 'drawImage', args, ...(img?.__id !== undefined ? { from: img.__id } : {}) })
        if (key === 'fillRect') return (...args: number[]) => ops.push({ canvas: id, kind: 'fillRect', args, fill: String(target.fillStyle) })
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

describe('(a) a região de desfoque cobre o mesmo pedaço com o recorte ligado (desenho)', () => {
  const RAW = -1
  const frames = (): FrameSet => ({ screen: { image: { __id: RAW }, ...SOURCE }, camera: { image: { __id: -2 }, w: 1920, h: 1080 }, matte: { image: { __id: -3 }, w: 1920, h: 1080 } }) as never

  for (const c of CASES) {
    it(`${c.name}: a tarja entra na tela gravada inteira e o cartão é desenhado só da camada protegida, dentro do recorte`, () => {
      const p = mk(c.layout, { blur: true, mode: 'solid' })
      const r = recorder()
      const cache = createRenderCache(r.factory)
      cache.images.clear()
      renderFrame(r.main, evaluateScene(p, deriveProject(p, data, c.format), 1000, c.format), frames(), cache)

      // o quadro cru da tela entra inteiro na camada protegida (5 argumentos: 0, 0, w, h)
      const copy = r.ops.find((o) => o.kind === 'drawImage' && o.from === RAW && o.args.length === 4)
      expect(copy, 'o quadro cru é copiado inteiro para a camada protegida').toBeTruthy()
      expect(copy!.args).toEqual([0, 0, SOURCE.w, SOURCE.h])
      const layer = copy!.canvas
      // a tarja está na posição da região NA TELA GRAVADA (px do quadro de origem), sem passar pelo recorte
      const bar = r.ops.find((o) => o.kind === 'fillRect' && o.canvas === layer && o.fill === '#111827')
      expect(bar, 'a tarja sólida da região').toBeTruthy()
      const [x, y, w, h] = bar!.args as [number, number, number, number]
      expect(x).toBe(Math.floor(REGION.x * SOURCE.w))
      expect(y).toBe(Math.floor(REGION.y * SOURCE.h))
      expect(x + w).toBeGreaterThanOrEqual(Math.floor((REGION.x + REGION.w) * SOURCE.w) - 1)
      expect(y + h).toBeGreaterThanOrEqual(Math.floor((REGION.y + REGION.h) * SOURCE.h) - 1)
      // o cru nunca vai a outra camada nem ao quadro final: a tela vem sempre da camada protegida
      expect(new Set(r.ops.filter((o) => o.kind === 'drawImage' && o.from === RAW).map((o) => o.canvas)).has(0)).toBe(false)
      const shown = r.ops.filter((o) => o.kind === 'drawImage' && o.from === layer && o.canvas !== layer && o.args.length === 8)
      expect(shown.length, 'o cartão da tela é desenhado a partir da camada protegida').toBeGreaterThan(0)
      // e o pedaço que o cartão mostra é um pedaço do RECORTE (em px da tela gravada)
      const cx = CROP.x * SOURCE.w, cy = CROP.y * SOURCE.h, cw = CROP.w * SOURCE.w, ch = CROP.h * SOURCE.h
      for (const s of shown) {
        const [sx, sy, sw, sh] = s.args as [number, number, number, number]
        expect(sx).toBeGreaterThanOrEqual(cx - 0.5)
        expect(sy).toBeGreaterThanOrEqual(cy - 0.5)
        expect(sx + sw).toBeLessThanOrEqual(cx + cw + 0.5)
        expect(sy + sh).toBeLessThanOrEqual(cy + ch + 0.5)
      }
    })
  }

  it('sem zoom, o 16:9 desenha o recorte inteiro: o pedaço mostrado é exatamente o recorte e a tarja cai no meio dele', () => {
    const p = mk('screen', { blur: true, mode: 'solid' })
    const r = recorder()
    const cache = createRenderCache(r.factory)
    cache.images.clear()
    renderFrame(r.main, evaluateScene(p, deriveProject(p, data, H), 1000, H), frames(), cache)
    const copy = r.ops.find((o) => o.kind === 'drawImage' && o.from === RAW && o.args.length === 4)!
    const shown = r.ops.find((o) => o.kind === 'drawImage' && o.from === copy.canvas && o.canvas !== copy.canvas && o.args.length === 8)!
    const [sx, sy, sw, sh] = shown.args as [number, number, number, number]
    expect(sx).toBeCloseTo(CROP.x * SOURCE.w, 3)
    expect(sy).toBeCloseTo(CROP.y * SOURCE.h, 3)
    expect(sw).toBeCloseTo(CROP.w * SOURCE.w, 3)
    expect(sh).toBeCloseTo(CROP.h * SOURCE.h, 3)
    const bar = r.ops.find((o) => o.kind === 'fillRect' && o.canvas === copy.canvas && o.fill === '#111827')!
    const [bx, by, bw, bh] = bar.args as [number, number, number, number]
    // o centro da tarja é o centro do recorte (a região foi centrada nele)
    expect(bx + bw / 2).toBeCloseTo(CROP.x * SOURCE.w + (CROP.w * SOURCE.w) / 2, 0)
    expect(by + bh / 2).toBeCloseTo(CROP.y * SOURCE.h + (CROP.h * SOURCE.h) / 2, 0)
  })
})
