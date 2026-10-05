import { describe, expect, it } from 'vitest'
import { drawCaptions, drawHook, layoutText, breakWords } from '@shared/caption-render'
import {
  CAPTION_SIZE_MAX,
  CAPTION_SIZE_MIN,
  CAPTION_STYLE_IDS,
  HOOK_FONT_PX,
  captionStyleDefaults,
  defaultCaptionY,
  maxWordsPerLine,
  resolveCaptionStyle,
  resolveHookStyle
} from '@shared/caption-style'
import { defaultStyle } from '@shared/project'
import { createRenderCache, type CanvasFactory, type CanvasLike, type Ctx2D } from '@shared/render'
import { HORIZONTAL_1080, VERTICAL_1080, layoutGeometry, resolveLayout, type FormatSpec, type SceneCaptions } from '@shared/scene'
import { CAMERA_CORNERS } from '@shared/styles'
import {
  CAPTION_Y_VERTICAL,
  CAPTION_Y_WIDE,
  HOOK_BAND,
  HOOK_CENTER_Y,
  HOOK_CLEAR_Y,
  HOOK_MS,
  PLATFORM_ZONES,
  SAFE_BOX,
  STACK_CAMERA,
  STACK_SCREEN,
  STACK_SPLIT,
  STACK_VIEW_HEIGHT,
  VERTICAL_BUBBLE_SIZE,
  WIDE_BOX,
  cropView,
  layoutFollow,
  safeBoxFor,
  stackRects,
  verticalCaptionY
} from '@shared/vertical'
import type { CaptionStyle, Rect, Style } from '@shared/types'

const SCREEN = { w: 1920, h: 1080 }
const CAMERA = { w: 640, h: 360 }
const V4K: FormatSpec = { kind: 'vertical', w: 2160, h: 3840 }

// ---------------------------------------------------------------------------
// Um canvas falso que só anota onde o texto e a caixa caem (sem DOM): largura do texto = 0,6 × corpo × nº de letras.

type Box = { x0: number; y0: number; x1: number; y1: number }
type Recorder = { ctx: Ctx2D; boxes: Box[]; texts: string[] }

function recorder(): Recorder {
  const boxes: Box[] = []
  const texts: string[] = []
  const stack: { ty: number; sx: number; sy: number; tx: number }[] = []
  let tx = 0
  let ty = 0
  let sx = 1
  let sy = 1
  const px = (font: string): number => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16)
  const point = (x: number, y: number, pad = 0): void => {
    const X = x * sx + tx
    const Y = y * sy + ty
    boxes.push({ x0: X - pad, y0: Y - pad, x1: X + pad, y1: Y + pad })
  }
  const target: Record<string, unknown> = {
    font: '',
    lineWidth: 1,
    globalAlpha: 1,
    save: () => stack.push({ tx, ty, sx, sy }),
    restore: () => {
      const s = stack.pop()
      if (s) ({ tx, ty, sx, sy } = s)
    },
    translate: (x: number, y: number) => {
      tx += x * sx
      ty += y * sy
    },
    scale: (x: number, y: number) => {
      sx *= x
      sy *= y
    },
    measureText: (t: string) => ({ width: t.length * px(String(target.font)) * 0.6 }),
    fillText: (t: string, x: number, y: number) => {
      texts.push(t)
      const p = px(String(target.font))
      const w = t.length * p * 0.6
      boxes.push({ x0: x * sx + tx, x1: (x + w) * sx + tx, y0: (y - p * 0.75) * sy + ty, y1: (y + p * 0.22) * sy + ty })
    },
    strokeText: (t: string, x: number, y: number) => {
      const p = px(String(target.font))
      const w = t.length * p * 0.6
      const half = Number(target.lineWidth) / 2
      boxes.push({ x0: (x - half) * sx + tx, x1: (x + w + half) * sx + tx, y0: (y - p * 0.75 - half) * sy + ty, y1: (y + p * 0.22 + half) * sy + ty })
    },
    rect: (x: number, y: number, w: number, h: number) => {
      point(x, y)
      point(x + w, y + h)
    },
    moveTo: (x: number, y: number) => point(x, y),
    arcTo: (x1: number, y1: number, x2: number, y2: number) => {
      point(x1, y1)
      point(x2, y2)
    }
  }
  const ctx = new Proxy(target, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
    set: (t, k: string, v) => {
      t[k] = v
      return true
    }
  }) as unknown as Ctx2D
  return { ctx, boxes, texts }
}

const factory: CanvasFactory = (w, h) => ({ width: w, height: h, getContext: () => null }) as unknown as CanvasLike
const extent = (boxes: Box[]): Box => ({
  x0: Math.min(...boxes.map((b) => b.x0)),
  y0: Math.min(...boxes.map((b) => b.y0)),
  x1: Math.max(...boxes.map((b) => b.x1)),
  y1: Math.max(...boxes.map((b) => b.y1))
})

function sceneCaptions(cs: CaptionStyle, format: FormatSpec, words: string[], dy = 0, pop = 1): SceneCaptions {
  return { key: `${cs.style}-${words.join('')}-${cs.size}-${cs.positionY}-${format.w}-${pop}`, style: resolveCaptionStyle(cs, format), words, active: 1, pop, alpha: 1, dy }
}

const base: CaptionStyle = { enabled: true, style: 'highlight', wordsPerLine: 3, position: 'bottom', box: true, highlightColor: '#FFD93D' }
const SAMPLE = ['Então', 'vamos', 'clicar', 'aqui', 'no', 'botão']

// ---------------------------------------------------------------------------

describe('caixa segura e zonas das plataformas', () => {
  it('a caixa segura é 65–940 × 270–1440 (as 3 zonas somadas deixam esta área livre)', () => {
    expect(SAFE_BOX).toEqual({ x: 65, y: 270, w: 875, h: 1170 })
    for (const z of PLATFORM_ZONES) {
      // a pior zona de cada plataforma, na medida do quadro 1080×1920, não invade a caixa segura por mais que a folga de projeto
      expect(1920 - z.bottom).toBeGreaterThanOrEqual(SAFE_BOX.y + SAFE_BOX.h - 60)
      expect(z.top).toBeLessThanOrEqual(SAFE_BOX.y)
    }
  })

  it('a caixa acompanha a resolução (4K tem o dobro, mesma proporção)', () => {
    expect(safeBoxFor({ w: 1080 })).toEqual(SAFE_BOX)
    expect(safeBoxFor({ w: 2160 })).toEqual({ x: 130, y: 540, w: 1750, h: 2340 })
  })
})

describe('recorte (view) de cada layout vertical', () => {
  it('V-A: a altura inteira de uma tela 16:9 vira 31,6% da largura (607 px de 1920)', () => {
    const v = cropView(1080 / 1920, SCREEN)
    expect(v.h).toBe(1)
    expect(v.w).toBeCloseTo(0.31640625, 6)
    expect(v.w * SCREEN.w).toBeCloseTo(607.5, 1)
  })

  it('o recorte tem a proporção do destino, para qualquer proporção genérica (9:16, 1:1, 4:5, 16:9) e fonte', () => {
    for (const [dw, dh] of [[9, 16], [1, 1], [4, 5], [16, 9], [3, 4]] as const) {
      for (const src of [SCREEN, { w: 2560, h: 1600 }, { w: 1080, h: 1920 }, { w: 3440, h: 1440 }]) {
        const v = cropView(dw / dh, src)
        expect(v.w).toBeGreaterThan(0)
        expect(v.w).toBeLessThanOrEqual(1)
        expect(v.h).toBeLessThanOrEqual(1)
        expect((v.w * src.w) / (v.h * src.h)).toBeCloseTo(dw / dh, 5)
      }
    }
  })

  it('destino mais largo que a fonte: limita a largura e reduz a altura (nunca passa da fonte)', () => {
    const v = cropView(16 / 9, { w: 1000, h: 1000 })
    expect(v.w).toBe(1)
    expect(v.h).toBeCloseTo(9 / 16, 6)
  })

  it('sem tela ou com medida inválida: recorte inteiro', () => {
    expect(cropView(9 / 16, null)).toEqual({ w: 1, h: 1 })
    expect(cropView(9 / 16, { w: 0, h: 1080 })).toEqual({ w: 1, h: 1 })
    expect(cropView(0, SCREEN)).toEqual({ w: 1, h: 1 })
  })

  it('layoutFollow: horizontal = tela toda; V-A = altura inteira, ganho 1; V-B = faixa larga, ganho 0,5; V-C = tela toda, ganho 0', () => {
    expect(layoutFollow('bubble', HORIZONTAL_1080, SCREEN)).toEqual({ view: { w: 1, h: 1 }, gain: 1 })
    const a = layoutFollow('screen-focus', VERTICAL_1080, SCREEN)
    expect(a.gain).toBe(1)
    expect(a.view.h).toBe(1)
    expect(a.view.w).toBeCloseTo(0.3164, 3)
    const b = layoutFollow('stack', VERTICAL_1080, SCREEN)
    expect(b.gain).toBe(0.5)
    expect(b.view.h).toBeCloseTo(STACK_VIEW_HEIGHT, 6)
    expect((b.view.w * SCREEN.w) / (b.view.h * SCREEN.h)).toBeCloseTo(STACK_SCREEN.w / STACK_SCREEN.h, 4)
    expect(layoutFollow('screen-wide', VERTICAL_1080, SCREEN)).toEqual({ view: { w: 1, h: 1 }, gain: 0 })
    expect(layoutFollow('camera', VERTICAL_1080, SCREEN).gain).toBe(1)
  })
})

describe('V-B sem barras: as duas metades', () => {
  it('stackRects: tela em cima e câmera embaixo; com a câmera em cima as duas trocam, e juntas sempre ocupam 0–1920', () => {
    const a = stackRects()
    expect(a.screen).toEqual({ x: 0, y: 0, w: 1080, h: 960 })
    expect(a.camera).toEqual({ x: 0, y: 960, w: 1080, h: 960 })
    const b = stackRects(true)
    expect(b.camera).toEqual({ x: 0, y: 0, w: 1080, h: 960 })
    expect(b.screen).toEqual({ x: 0, y: 960, w: 1080, h: 960 })
    for (const r of [a, b]) {
      expect(r.screen.h + r.camera.h).toBe(1920) // sem barra em cima nem embaixo
      expect(r.screen.w).toBe(1080)
      expect(r.camera.w).toBe(1080)
    }
    // o recorte da tela mostra 2× a tela inteira: a mesma fração da altura nos dois
    expect(STACK_VIEW_HEIGHT).toBeCloseTo(960 / 2 / 1080, 9)
  })
})

describe('geometria vertical: tudo dentro da caixa segura', () => {
  const style: Style = defaultStyle()
  const sources = { screen: SCREEN, camera: CAMERA }
  const within = (r: Rect, box: { x: number; y: number; w: number; h: number }, tol = 1): boolean =>
    r.x >= box.x - tol && r.y >= box.y - tol && r.x + r.w <= box.x + box.w + tol && r.y + r.h <= box.y + box.h + tol

  for (const format of [VERTICAL_1080, V4K]) {
    const k = format.w / 1080
    const safe = safeBoxFor(format)
    const label = `${format.w}×${format.h}`

    it(`V-A (${label}): a tela ocupa o quadro; a bolha da câmera fica na caixa segura nas 9 posições, com 250 px × escala`, () => {
      for (const corner of CAMERA_CORNERS) {
        const st = { ...style, camera: { ...style.camera, corner, size: VERTICAL_BUBBLE_SIZE } }
        const g = layoutGeometry('screen-focus', st, format, sources)
        expect(g.screen).toEqual({ x: 0, y: 0, w: format.w, h: format.h })
        const c = g.camera!.rect
        expect(within(c, safe), `${corner}: ${JSON.stringify(c)}`).toBe(true)
        expect(c.w).toBe(c.h)
        expect(c.h).toBeCloseTo(250 * k, 0)
      }
    })

    it(`V-A (${label}): com o zoom aberto a bolha encolhe e continua na caixa segura`, () => {
      const st = { ...style, camera: { ...style.camera, corner: 'bottom-right' as const, size: VERTICAL_BUBBLE_SIZE } }
      const open = layoutGeometry('screen-focus', st, format, sources, 1).camera!.rect
      const none = layoutGeometry('screen-focus', st, format, sources, 0).camera!.rect
      expect(open.h).toBeLessThan(none.h)
      expect(within(open, safe)).toBe(true)
      expect(open.x + open.w).toBeLessThanOrEqual(safe.x + safe.w + 1)
      expect(open.y + open.h).toBeLessThanOrEqual(safe.y + safe.h + 1)
    })

    it(`V-B (${label}) SEM barras: tela em cima (y 0–960) e câmera embaixo (y 960–1920), de ponta a ponta`, () => {
      const g = layoutGeometry('stack', style, format, sources)
      expect(g.screen).toEqual({ x: 0, y: 0, w: 1080 * k, h: STACK_SCREEN.h * k })
      expect(g.camera!.rect).toEqual({ x: 0, y: STACK_CAMERA.y * k, w: 1080 * k, h: STACK_CAMERA.h * k })
      expect(g.screen!.y).toBe(0) // começa na borda de cima: sem barra
      expect(g.screen!.y + g.screen!.h).toBe(g.camera!.rect.y) // sem fresta nem sobreposição
      expect(g.camera!.rect.y + g.camera!.rect.h).toBe(format.h) // termina na borda de baixo: sem barra
      expect(g.camera!.radius).toBe(0)
      // E1: tela 48% [44-61] e câmera 50% [38-50] da altura, juntas ocupam tudo
      expect(g.screen!.h / format.h).toBeGreaterThanOrEqual(0.44)
      expect(g.screen!.h / format.h).toBeLessThanOrEqual(0.52)
      expect(g.camera!.rect.h / format.h).toBeGreaterThanOrEqual(0.38)
      expect(g.camera!.rect.h / format.h).toBeLessThanOrEqual(0.52)
    })

    it(`V-B (${label}) com "câmera em cima": as duas metades trocam de lugar, também sem barras`, () => {
      const g = layoutGeometry('stack', { ...style, stackCameraTop: true }, format, sources)
      expect(g.camera!.rect).toEqual({ x: 0, y: 0, w: 1080 * k, h: STACK_CAMERA.h * k })
      expect(g.screen).toEqual({ x: 0, y: STACK_SPLIT * k, w: 1080 * k, h: STACK_SCREEN.h * k })
      expect(g.camera!.rect.y + g.camera!.rect.h).toBe(g.screen!.y)
      expect(g.screen!.y + g.screen!.h).toBe(format.h)
    })

    it(`V-C (${label}): o vídeo 16:9 tem 94% da largura e o centro em y 50%; a bolha fica na caixa segura`, () => {
      const g = layoutGeometry('screen-wide', style, format, sources)
      const s = g.screen!
      expect(s.w / format.w).toBeCloseTo(0.94, 2)
      expect(s.w / s.h).toBeCloseTo(16 / 9, 2)
      expect(s.x + s.w / 2).toBeCloseTo(format.w / 2, 0) // centrado na largura
      expect(Math.abs(s.y + s.h / 2 - format.h / 2)).toBeLessThanOrEqual(1) // centro em y 50% (±1 px do arredondamento)
      expect(within(s, { x: WIDE_BOX.x * k, y: WIDE_BOX.y * k, w: WIDE_BOX.w * k, h: WIDE_BOX.h * k }, 1)).toBe(true)
      expect(within(g.camera!.rect, safe)).toBe(true)
    })

    it(`só a câmera (${label}): preenche o quadro`, () => {
      const g = layoutGeometry('camera', style, format, sources)
      expect(g.camera!.rect).toEqual({ x: 0, y: 0, w: format.w, h: format.h })
      expect(g.screen).toBeNull()
    })
  }

  it('sem câmera, V-A e V-C não têm bolha; sem tela só há câmera', () => {
    expect(layoutGeometry('screen-focus', style, VERTICAL_1080, { screen: SCREEN, camera: null }).camera).toBeNull()
    expect(layoutGeometry('screen-wide', style, VERTICAL_1080, { screen: SCREEN, camera: null }).camera).toBeNull()
    expect(layoutGeometry('stack', style, VERTICAL_1080, { screen: SCREEN, camera: null }).camera).toBeNull()
    const onlyCam = layoutGeometry('stack', style, VERTICAL_1080, { screen: null, camera: CAMERA })
    expect(onlyCam.screen).toBeNull()
    expect(onlyCam.camera!.rect).toEqual({ x: 0, y: 0, w: 1080, h: 1920 })
  })

  it('resolveLayout: os layouts do 16:9 viram V-A no vertical e os do vertical caem em equivalentes no 16:9', () => {
    expect(resolveLayout('bubble', true, true, 'vertical')).toBe('screen-focus')
    expect(resolveLayout('side-by-side', true, true, 'vertical')).toBe('screen-focus')
    expect(resolveLayout('stack', true, true, 'vertical')).toBe('stack')
    expect(resolveLayout('stack', true, true, 'horizontal')).toBe('side-by-side')
    expect(resolveLayout('screen-focus', true, true, 'horizontal')).toBe('bubble')
    expect(resolveLayout('screen-wide', true, true, 'horizontal')).toBe('bubble')
    expect(resolveLayout('stack', true, false, 'vertical')).toBe('screen-focus')
    expect(resolveLayout('screen-wide', true, false, 'vertical')).toBe('screen-wide')
    expect(resolveLayout('stack', false, true, 'vertical')).toBe('camera')
  })

  it('a bolha cabe na caixa segura mesmo com o tamanho máximo configurado', () => {
    for (const corner of CAMERA_CORNERS) {
      const st = { ...style, camera: { ...style.camera, corner, size: 0.3 } }
      const g = layoutGeometry('screen-focus', st, VERTICAL_1080, sources)
      expect(within(g.camera!.rect, SAFE_BOX)).toBe(true)
    }
  })
})

describe('legenda vertical: nunca fora da caixa segura', () => {
  const safeBox = { x0: SAFE_BOX.x, x1: SAFE_BOX.x + SAFE_BOX.w, y0: SAFE_BOX.y, y1: SAFE_BOX.y + SAFE_BOX.h }
  const EPS = 1.5

  function checkInside(cs: CaptionStyle, words: string[], format = VERTICAL_1080, dy = 0, pop = 1): void {
    const k = format.w / 1080
    const rec = recorder()
    const cache = createRenderCache(factory)
    cache.fontsReady = true
    drawCaptions(rec.ctx, cache, sceneCaptions(cs, format, words, dy, pop))
    expect(rec.boxes.length, 'não desenhou nada').toBeGreaterThan(0)
    const e = extent(rec.boxes)
    const where = `${cs.style} tam ${cs.size ?? 1} y ${cs.positionY ?? cs.position} ${JSON.stringify(e)}`
    expect(e.x0, where).toBeGreaterThanOrEqual(safeBox.x0 * k - EPS)
    expect(e.x1, where).toBeLessThanOrEqual(safeBox.x1 * k + EPS)
    expect(e.y0, where).toBeGreaterThanOrEqual(safeBox.y0 * k - EPS - Math.abs(dy))
    expect(e.y1, where).toBeLessThanOrEqual(safeBox.y1 * k + EPS + Math.abs(dy))
  }

  it('cada estilo, na posição padrão, dentro da caixa 65–940 × 270–1440', () => {
    for (const style of CAPTION_STYLE_IDS) for (const position of ['top', 'center', 'bottom'] as const) checkInside({ ...base, style, position }, SAMPLE)
  })

  it('o tamanho mínimo e o máximo (60%–150%) e as posições extremas continuam dentro (a caixa segura prende o bloco)', () => {
    for (const style of CAPTION_STYLE_IDS) {
      for (const size of [CAPTION_SIZE_MIN, 1, CAPTION_SIZE_MAX]) {
        for (const positionY of [0.04, 0.22, 0.5, 1225 / 1920, 0.96]) checkInside({ ...base, style, size, positionY }, SAMPLE)
      }
    }
  })

  it('palavras longas e linhas de uma palavra só ficam dentro (encolhe até caber)', () => {
    for (const style of CAPTION_STYLE_IDS) {
      checkInside({ ...base, style }, ['extraordinariamente', 'inconstitucionalissimamente'])
      checkInside({ ...base, style, size: CAPTION_SIZE_MAX }, ['inconstitucionalissimamente'])
      checkInside({ ...base, style }, ['Oi'])
    }
  })

  it('o "pop" da palavra acesa (+8%) passa da caixa em poucos px por menos de 100 ms, só numa linha que enche a largura: dentro do quadro e de 4% da palavra', () => {
    const rec = recorder()
    const cache = createRenderCache(factory)
    cache.fontsReady = true
    drawCaptions(rec.ctx, cache, sceneCaptions({ ...base, style: 'highlight' }, VERTICAL_1080, ['extraordinariamente', 'inconstitucionalissimamente'], 0, 1.08))
    const e = extent(rec.boxes)
    expect(e.x1).toBeLessThanOrEqual(SAFE_BOX.x + SAFE_BOX.w + 0.05 * 800)
    expect(e.x1).toBeLessThan(1080 - 100)
  })

  it('o mesmo em 4K (a caixa segura escala com o quadro)', () => {
    for (const style of CAPTION_STYLE_IDS) checkInside({ ...base, style }, SAMPLE, V4K)
  })

  it('a posição padrão do bloco é a mesma em qualquer resolução (fração da altura)', () => {
    expect(defaultCaptionY('bottom', 'vertical') * 1920).toBeCloseTo(1344, 3) // y 70% (E1: 70,3% [58,7–77,9])
    expect(defaultCaptionY('bottom', 'horizontal')).toBe(0.94) // 16:9: y 94% (E1, n = 4)
    expect(defaultCaptionY('top', 'vertical')).toBeLessThan(defaultCaptionY('center', 'vertical'))
    expect(defaultCaptionY('center', 'vertical')).toBeLessThan(defaultCaptionY('bottom', 'vertical'))
    expect(resolveCaptionStyle(base, V4K).centerY).toBeCloseTo(resolveCaptionStyle(base, VERTICAL_1080).centerY * 2, 6)
  })

  it('o tamanho é limitado a 60%–150% mesmo se o documento trouxer outro valor', () => {
    const tiny = resolveCaptionStyle({ ...base, size: 0.01 }, VERTICAL_1080).fontPx
    const normal = resolveCaptionStyle(base, VERTICAL_1080).fontPx
    const huge = resolveCaptionStyle({ ...base, size: 99 }, VERTICAL_1080).fontPx
    expect(tiny / normal).toBeCloseTo(CAPTION_SIZE_MIN, 6)
    expect(huge / normal).toBeCloseTo(CAPTION_SIZE_MAX, 6)
  })

  it('os tamanhos vêm dos vídeos reais (E1): Destaque com a maiúscula de 58 px (corpo 80); caixa mista com 46 px (corpo 62–66)', () => {
    const cap = (style: CaptionStyle['style'], format = VERTICAL_1080) => resolveCaptionStyle({ ...base, style, box: false }, format)
    expect(cap('highlight').fontPx).toBe(80)
    expect(cap('highlight').fontPx * 0.7).toBeCloseTo(56, 0) // Montserrat ExtraBold: a maiúscula é 0,70 do corpo (+ contorno: ~58 medida na imagem)
    expect(cap('highlight').outlinePx).toBe(5)
    for (const style of ['natural', 'clean', 'karaoke'] as const) {
      const px = cap(style).fontPx
      expect(px, style).toBeGreaterThanOrEqual(62)
      expect(px, style).toBeLessThanOrEqual(66)
    }
    expect(cap('natural').fontPx * 0.728).toBeCloseTo(46, 0) // Inter: a maiúscula é 0,728 do corpo
    expect(cap('natural').uppercase).toBe(false) // caixa mista
    expect(cap('highlight').uppercase).toBe(true)
    // largura do bloco: no máximo 660 px (menos a margem de tinta), em qualquer estilo e resolução
    for (const style of CAPTION_STYLE_IDS) {
      expect(cap(style).maxWidth, style).toBeLessThanOrEqual(660)
      expect(cap(style).maxWidth, style).toBeGreaterThan(560)
      expect(cap(style, V4K).maxWidth, style).toBeCloseTo(cap(style).maxWidth * 2, 6)
    }
  })

  it('no 16:9 a legenda é de 26 px de maiúscula (corpo 36), centro em y 94%, numa caixa escura translúcida', () => {
    const h = resolveCaptionStyle({ ...base, style: 'natural', box: true }, HORIZONTAL_1080)
    expect(h.fontPx).toBe(36)
    expect(h.fontPx * 0.728).toBeCloseTo(26, 0)
    expect(h.centerY / 1080).toBeCloseTo(0.94, 6)
    expect(h.box).not.toBeNull()
    expect(h.box!.color).toMatch(/^rgba\(10,12,16,0\.\d+\)$/) // escura e translúcida
    expect(h.safeY).toBeNull()
  })

  it('padrões por formato: vertical 1 × 2 palavras sem caixa; 16:9 1 × 5 com caixa (e o Destaque sem); máximos 3 e 6', () => {
    for (const style of CAPTION_STYLE_IDS) expect(captionStyleDefaults(style, 'vertical')).toEqual({ wordsPerLine: 2, box: false })
    expect(captionStyleDefaults('natural', 'horizontal')).toEqual({ wordsPerLine: 5, box: true })
    expect(captionStyleDefaults('karaoke', 'horizontal')).toEqual({ wordsPerLine: 5, box: true })
    expect(captionStyleDefaults('highlight', 'horizontal')).toEqual({ wordsPerLine: 5, box: false })
    expect(maxWordsPerLine('vertical')).toBe(3)
    expect(maxWordsPerLine('horizontal')).toBe(6)
  })

  it('a palavra falada em destaque vem ligada e a pessoa a desliga; a Limpa nunca usa', () => {
    for (const style of ['natural', 'highlight', 'karaoke'] as const) {
      expect(resolveCaptionStyle({ ...base, style }, VERTICAL_1080).active.mode, style).not.toBe('none')
      expect(resolveCaptionStyle({ ...base, style, highlightWord: false }, VERTICAL_1080).active).toMatchObject({ mode: 'none', pop: 0 })
      expect(resolveCaptionStyle({ ...base, style, highlightWord: true }, VERTICAL_1080).active.mode, style).not.toBe('none')
    }
    expect(resolveCaptionStyle({ ...base, style: 'clean' }, VERTICAL_1080).active.mode).toBe('none')
  })

  it('a posição que o LAYOUT pede (autoY) vale só no automático: positionY e "no alto/no meio" mandam mais', () => {
    expect(verticalCaptionY('screen-focus')).toBe(CAPTION_Y_VERTICAL)
    expect(verticalCaptionY('camera')).toBe(CAPTION_Y_VERTICAL)
    expect(verticalCaptionY('screen-wide')).toBe(CAPTION_Y_WIDE) // 71%
    expect(verticalCaptionY('stack')).toBe(STACK_SPLIT / 1920) // a emenda tela/câmera, em 50% (cai entre 45% e 70%)
    const auto = resolveCaptionStyle(base, VERTICAL_1080, 0.5)
    expect(auto.centerY).toBe(960)
    expect(resolveCaptionStyle({ ...base, positionY: 0.3 }, VERTICAL_1080, 0.5).centerY).toBeCloseTo(0.3 * 1920, 6)
    expect(resolveCaptionStyle({ ...base, position: 'top' }, VERTICAL_1080, 0.5).centerY).toBeCloseTo(0.22 * 1920, 6)
    expect(resolveCaptionStyle(base, HORIZONTAL_1080, 0.5).centerY).toBeCloseTo(0.94 * 1080, 6) // o 16:9 ignora o pedido do layout
  })

  it('sem as fontes carregadas não desenha nada (melhor sem legenda do que com a fonte errada)', () => {
    const rec = recorder()
    const cache = createRenderCache(factory)
    cache.fontsReady = false
    drawCaptions(rec.ctx, cache, sceneCaptions(base, VERTICAL_1080, SAMPLE))
    drawHook(rec.ctx, cache, { text: 'Grave sua tela', alpha: 1, style: resolveHookStyle(VERTICAL_1080, HOOK_BAND) })
    expect(rec.texts).toEqual([])
  })

  it('transparência zero ou página vazia: não desenha', () => {
    const rec = recorder()
    const cache = createRenderCache(factory)
    cache.fontsReady = true
    drawCaptions(rec.ctx, cache, { ...sceneCaptions(base, VERTICAL_1080, SAMPLE), alpha: 0 })
    drawCaptions(rec.ctx, cache, sceneCaptions(base, VERTICAL_1080, []))
    expect(rec.texts).toEqual([])
  })
})

describe('título de gancho vertical: 46 px de maiúscula, centro em y 15%, faixa y 228–348', () => {
  const cache = () => {
    const c = createRenderCache(factory)
    c.fontsReady = true
    return c
  }
  const draw = (text: string, format = VERTICAL_1080) => {
    const rec = recorder()
    drawHook(rec.ctx, cache(), { text, alpha: 1, style: resolveHookStyle(format, HOOK_BAND) })
    return { rec, e: extent(rec.boxes), k: format.w / 1080 }
  }

  it('a maiúscula tem 46 px (Anton de 54 px) e o centro da faixa é y 15% (288 px); dura 4 s', () => {
    expect(HOOK_FONT_PX).toBe(54)
    expect(HOOK_FONT_PX * 0.859).toBeCloseTo(46, 0) // a maiúscula do Anton é 0,859 do corpo
    expect(HOOK_CENTER_Y).toBe(288)
    expect(HOOK_CENTER_Y / 1920).toBeCloseTo(0.15, 6)
    expect((HOOK_BAND.top + HOOK_BAND.bottom) / 2).toBe(HOOK_CENTER_Y)
    expect(HOOK_MS).toBe(4000)
    expect(HOOK_CLEAR_Y).toBeGreaterThan(HOOK_BAND.bottom)
    expect(resolveHookStyle(VERTICAL_1080, HOOK_BAND).fontPx).toBe(54)
    expect(resolveHookStyle(V4K, HOOK_BAND).fontPx).toBe(108)
  })

  it('uma frase curta cabe numa linha, centrada em y 15%, dentro da largura da caixa segura', () => {
    const { rec, e, k } = draw('Grave sua tela')
    expect(rec.texts.length).toBeGreaterThan(0)
    expect((e.y0 + e.y1) / 2).toBeGreaterThan((HOOK_CENTER_Y - 14) * k)
    expect((e.y0 + e.y1) / 2).toBeLessThan((HOOK_CENTER_Y + 14) * k)
    expect(e.y1 - e.y0).toBeLessThan(100 * k) // uma linha só
    expect(e.x0).toBeGreaterThanOrEqual(SAFE_BOX.x * k - 1)
    expect(e.x1).toBeLessThanOrEqual((SAFE_BOX.x + SAFE_BOX.w) * k + 1)
  })

  it('frase longa vira duas linhas e encolhe para caber na faixa, nunca sai da largura da caixa segura nem da faixa', () => {
    for (const text of ['Grave sua tela em 1 clique e edite com inteligência artificial', 'Supercalifragilisticexpialidocious', 'a '.repeat(30).trim()]) {
      for (const format of [VERTICAL_1080, V4K]) {
        const { e, k } = draw(text, format)
        expect(e.x0, text).toBeGreaterThanOrEqual(SAFE_BOX.x * k - 1)
        expect(e.x1, text).toBeLessThanOrEqual((SAFE_BOX.x + SAFE_BOX.w) * k + 1)
        expect(e.y0, text).toBeGreaterThanOrEqual((HOOK_BAND.top - 6) * k)
        expect(e.y1, text).toBeLessThanOrEqual((HOOK_BAND.bottom + 20) * k)
      }
    }
  })

  it('texto vazio não desenha', () => {
    const rec = recorder()
    drawHook(rec.ctx, cache(), { text: '   ', alpha: 1, style: resolveHookStyle(VERTICAL_1080, HOOK_BAND) })
    expect(rec.texts).toEqual([])
  })
})

describe('layoutText e breakWords', () => {
  it('uma linha quando cabe; duas equilibradas quando não cabe; null se nem em duas', () => {
    expect(breakWords([100, 100, 100], 10, 400, 2)).toEqual([3])
    expect(breakWords([300, 100, 300, 100], 10, 700, 2)).toEqual([2, 2])
    expect(breakWords([100, 100, 100, 100], 10, 250, 2)).toEqual([2, 2])
    expect(breakWords([300, 300, 300], 10, 400, 2)).toBeNull()
    expect(breakWords([], 10, 400, 2)).toEqual([])
    expect(breakWords([100, 100, 100], 10, 150, 1)).toBeNull()
  })

  it('equilibra as duas linhas; no empate, a de baixo é a maior', () => {
    const counts = breakWords([100, 100, 100, 100, 100], 10, 340, 2)!
    expect(counts).toEqual([2, 3]) // empate: a linha de baixo fica com a maior (pirâmide)
  })

  const rec = recorder()
  const opts = { family: 'Tomada Montserrat', weight: 800, fontPx: 92, minFontPx: 66, lineHeight: 1.05, maxW: 800, maxLines: 2 }

  it('encolhe a fonte (até o mínimo) para caber em duas linhas', () => {
    const l = layoutText(rec.ctx, ['ABCDEFGH', 'ABCDEFGH', 'ABCDEFGH'], opts)
    expect(l.fontPx).toBeLessThanOrEqual(92)
    expect(l.lines.length).toBeLessThanOrEqual(2)
    expect(l.blockW).toBeLessThanOrEqual(800)
  })

  it('uma palavra só mais larga que a caixa encolhe abaixo do mínimo para caber (nunca vaza)', () => {
    const l = layoutText(rec.ctx, ['inconstitucionalissimamente'], opts)
    expect(l.lines).toHaveLength(1)
    expect(l.blockW).toBeLessThanOrEqual(800 + 0.5)
    expect(l.fontPx).toBeLessThan(66)
  })

  it('o espaço extra (gap) separa as palavras: o contorno grosso não gruda', () => {
    const a = layoutText(rec.ctx, ['um', 'dois'], { ...opts, gap: 0 })
    const b = layoutText(rec.ctx, ['um', 'dois'], { ...opts, gap: 12 })
    expect(b.lines[0]!.words[1]!.x - a.lines[0]!.words[1]!.x).toBeCloseTo(12, 5)
  })
})
