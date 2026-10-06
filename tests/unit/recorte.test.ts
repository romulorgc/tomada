/**
 * Recorte da tela (C1): a página do navegador no lugar da tela inteira. A janela-filha certa (medida no Chrome e no Edge desta
 * máquina), a linha do tempo do recorte (grudada, com transição de 200 ms), o cursor e os cliques no espaço do recorte, e a cena.
 */
import { describe, expect, it } from 'vitest'
import { browserOfExe, pickChromiumPage, type ChildWindow } from '@shared/browser'
import {
  CROP_TRANSITION_MS,
  STICKY_PX,
  buildCropTimeline,
  constantCrop,
  fitAspectInside,
  isFullRect,
  pointToCrop,
  rectFromCrop,
  resolveScreenCrop,
  stabilizeContentRects
} from '@shared/crop'
import { setBrowserFrame, setScreenCrop } from '@shared/crop-edit'
import { eventsFromText } from '@shared/events'
import { createProject } from '@shared/project'
import { buildEvents, type RawEvents } from '@shared/recording'
import { BROWSER_BAR_RATIO, HORIZONTAL_1080, VERTICAL_1080, applyScreenCrop, deriveProject, evaluateScene, prepareEvents } from '@shared/scene'
import type { ClickEvent, ContentRectSample, CursorSample, Project, Rect, ScreenCrop } from '@shared/types'
import { generateAutoZooms } from '@shared/zoom'

// ---------------------------------------------------------------------------
// Qual janela-filha é a página (as listas abaixo são as MEDIDAS no Chrome 154 e no Edge 154, a 125%)

const PAGE = 'Chrome_RenderWidgetHostHWND'
const w = (className: string, visible: boolean, x: number, y: number, ww: number, hh: number): ChildWindow => ({ className, visible, rect: { x, y, w: ww, h: hh } })
const CHROME_FRAME: Rect = { x: 158, y: 100, w: 1359, h: 942 }
const D3D = w('Intermediate D3D Window', true, 159, 100, 1357, 941)

describe('a página dentro da janela de um navegador Chromium', () => {
  it('Chrome sem DevTools: a única janela de página visível (as outras são abas escondidas e popups)', () => {
    const kids = [w(PAGE, false, 712, 206, 2, 2), w(PAGE, false, 302, 151, 822, 56), w(PAGE, false, 159, 100, 1358, 833), w(PAGE, true, 159, 208, 1358, 834), D3D]
    expect(pickChromiumPage(kids, CHROME_FRAME)).toEqual({ x: 159, y: 208, w: 1358, h: 834 })
  })

  it('Edge: a página tem uma margem de 5 px em volta da moldura (e é a medida, não a moldura)', () => {
    const frame = { x: 158, y: 100, w: 1359, h: 942 }
    const kids = [w(PAGE, false, 159, 100, 1348, 837), w(PAGE, true, 164, 200, 1348, 837), D3D]
    expect(pickChromiumPage(kids, frame)).toEqual({ x: 164, y: 200, w: 1348, h: 837 })
  })

  it.each([
    ['à direita', [w(PAGE, true, 159, 208, 664, 834), w(PAGE, true, 159, 208, 1358, 834)], { x: 159, y: 208, w: 664, h: 834 }],
    ['à direita, na outra ordem', [w(PAGE, true, 159, 208, 1358, 834), w(PAGE, true, 159, 208, 664, 834)], { x: 159, y: 208, w: 664, h: 834 }],
    ['embaixo', [w(PAGE, true, 159, 208, 1358, 459), w(PAGE, true, 159, 208, 1358, 834)], { x: 159, y: 208, w: 1358, h: 459 }],
    ['à esquerda (a página fica à direita)', [w(PAGE, true, 852, 208, 665, 834), w(PAGE, true, 159, 208, 1358, 834)], { x: 852, y: 208, w: 665, h: 834 }]
  ])('DevTools acoplado %s: fica a página (a menor), não a área de conteúdo inteira', (_nome, children, esperado) => {
    expect(pickChromiumPage([w(PAGE, false, 302, 151, 822, 56), ...children, D3D], CHROME_FRAME)).toEqual(esperado)
  })

  it('o popup da barra de endereço aberto (visível, acima do conteúdo) não vira a página', () => {
    const kids = [w(PAGE, true, 302, 151, 822, 56), w(PAGE, true, 159, 208, 1358, 834)]
    expect(pickChromiumPage(kids, CHROME_FRAME)).toEqual({ x: 159, y: 208, w: 1358, h: 834 })
  })

  it('sem janela de página visível (ou fora da moldura): nenhuma — quem chama mantém a última boa', () => {
    expect(pickChromiumPage([D3D, w(PAGE, false, 159, 208, 1358, 834)], CHROME_FRAME)).toBeNull()
    expect(pickChromiumPage([w(PAGE, true, 2000, 208, 1358, 834)], CHROME_FRAME)).toBeNull()
    expect(pickChromiumPage([], CHROME_FRAME)).toBeNull()
  })

  it('navegador: pelo nome do executável (Chromium mede a página; Firefox só é reconhecido; Electron não é navegador)', () => {
    expect(browserOfExe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')).toEqual({ exe: 'chrome.exe', engine: 'chromium' })
    expect(browserOfExe('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\MSEDGE.EXE')).toEqual({ exe: 'msedge.exe', engine: 'chromium' })
    expect(browserOfExe('C:\\Program Files\\Mozilla Firefox\\firefox.exe')).toEqual({ exe: 'firefox.exe', engine: 'gecko' })
    expect(browserOfExe('C:\\app\\node_modules\\electron\\dist\\electron.exe')).toBeNull()
    expect(browserOfExe(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// A linha do tempo do recorte

const SRC = { w: 1920, h: 1080 }
const px = (x: number, y: number, ww: number, hh: number): Rect => ({ x: x / SRC.w, y: y / SRC.h, w: ww / SRC.w, h: hh / SRC.h })
const sample = (t: number, r: Rect): ContentRectSample => ({ t, ...r })

describe('o retângulo "grudado"', () => {
  const base = px(1, 108, 1358, 834)

  it('uma medida que varia 1 ou 2 px NÃO muda o recorte (sem tremer)', () => {
    const steps = stabilizeContentRects(
      [sample(0, base), sample(100, px(2, 108, 1358, 834)), sample(200, px(1, 109, 1357, 834)), sample(300, px(0, 108, 1360, 835))],
      SRC
    )
    expect(steps).toHaveLength(1)
    expect(steps[0]!.rect).toEqual(base)
  })

  it(`muda quando a janela muda de verdade (mais de ${STICKY_PX} px)`, () => {
    const moved = px(1, 108, 900, 834)
    const steps = stabilizeContentRects([sample(0, base), sample(500, base), sample(1000, moved)], SRC)
    expect(steps.map((s) => s.t)).toEqual([0, 1000])
    expect(steps[1]!.rect).toEqual(moved)
  })

  it('o limite é de cada lado, em pixels da TELA GRAVADA (não da tela de saída)', () => {
    expect(stabilizeContentRects([sample(0, base), sample(100, px(1, 108, 1358 + STICKY_PX, 834))], SRC)).toHaveLength(1)
    expect(stabilizeContentRects([sample(0, base), sample(100, px(1, 108, 1358 + STICKY_PX + 1, 834))], SRC)).toHaveLength(2)
  })

  it('retângulo minúsculo ou sem sentido é ignorado', () => {
    const steps = stabilizeContentRects([sample(0, { x: 0.1, y: 0.1, w: 0.01, h: 0.5 }), sample(10, { x: NaN, y: 0, w: 1, h: 1 }), sample(20, base)], SRC)
    expect(steps).toHaveLength(1)
    expect(steps[0]!.t).toBe(20)
  })
})

describe('a linha do tempo do recorte', () => {
  const a = px(1, 108, 1358, 834)
  const b = px(1, 108, 700, 834) // o DevTools abriu: a página encolheu

  it('antes da mudança vale o primeiro; depois dos 200 ms vale o novo; no meio, uma transição suave', () => {
    const tl = buildCropTimeline(stabilizeContentRects([sample(0, a), sample(5000, b)], SRC), SRC)!
    expect(tl.at(0).w).toBeCloseTo(tl.at(4999).w, 6)
    const mid = tl.at(5000 + CROP_TRANSITION_MS / 2).w * SRC.w
    expect(mid).toBeGreaterThan(700)
    expect(mid).toBeLessThan(1358)
    // chegou (com a proporção da referência: ver o próximo teste)
    const after = tl.at(5000 + CROP_TRANSITION_MS + 1)
    const afterAt = tl.at(9000)
    expect(after.w).toBeCloseTo(afterAt.w, 6)
    expect(afterAt.w * SRC.w).toBeLessThan(1358)
  })

  it('a referência é o retângulo que vigora por mais tempo, e o recorte efetivo tem sempre a proporção dela', () => {
    const tl = buildCropTimeline(stabilizeContentRects([sample(0, a), sample(60_000, b), sample(61_000, a)], SRC), SRC)!
    expect(tl.sizePx).toEqual({ w: 1358, h: 834 })
    const aspect = tl.sizePx.w / tl.sizePx.h
    for (const t of [0, 59_999, 60_100, 60_500, 61_050, 90_000]) {
      const r = tl.at(t)
      expect((r.w * SRC.w) / (r.h * SRC.h)).toBeCloseTo(aspect, 3)
      // sempre dentro da página medida (nunca mostra a barra de abas)
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(a.y - 1e-9)
      expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9)
      expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('a janela de uma só forma dá um recorte constante', () => {
    const tl = buildCropTimeline(stabilizeContentRects([sample(0, a), sample(1000, px(2, 108, 1358, 834))], SRC), SRC)!
    expect(tl.constant).toBe(true)
    expect(tl.at(0)).toEqual(tl.at(123_456))
  })

  it('uma mudança no meio da transição parte de onde o recorte estava (sem salto)', () => {
    const c = px(1, 108, 1000, 834)
    const steps = stabilizeContentRects([sample(0, a), sample(1000, b), sample(1100, c)], SRC)
    const tl = buildCropTimeline(steps, SRC)!
    const before = tl.at(1099).w
    const after = tl.at(1101).w
    expect(Math.abs(after - before) * SRC.w).toBeLessThan(40)
  })

  it('o maior retângulo de uma proporção que cabe em outro, centrado (nunca passa dele)', () => {
    const r = fitAspectInside(px(100, 100, 800, 400), 1, SRC)
    expect(r.w * SRC.w).toBeCloseTo(400, 3)
    expect(r.h * SRC.h).toBeCloseTo(400, 3)
    expect(r.x * SRC.w).toBeCloseTo(300, 3)
    expect(r.y * SRC.h).toBeCloseTo(100, 3)
  })
})

describe('qual recorte o documento pede', () => {
  const page = px(1, 108, 1358, 834)
  const samples = [sample(0, page)]
  const crop = (c: ScreenCrop | undefined, s: ContentRectSample[] | undefined = samples) => resolveScreenCrop(c, s, SRC)

  it('sem recorte, desligado ou sem medida: a tela inteira', () => {
    expect(crop(undefined)).toBeNull()
    expect(crop({ mode: 'off' })).toBeNull()
    expect(crop({ mode: 'auto' }, [])).toBeNull()
    expect(resolveScreenCrop({ mode: 'auto' }, undefined, SRC)).toBeNull()
    expect(resolveScreenCrop({ mode: 'auto' }, samples, null)).toBeNull()
  })

  it('automático usa a página medida', () => {
    const tl = crop({ mode: 'auto' })!
    expect(tl.sizePx).toEqual({ w: 1358, h: 834 })
  })

  it('página que ocupa a tela toda (tela cheia): nada a recortar', () => {
    expect(crop({ mode: 'auto' }, [sample(0, { x: 0, y: 0, w: 1, h: 1 })])).toBeNull()
    expect(isFullRect({ x: 0.001, y: 0, w: 0.998, h: 1 }, SRC)).toBe(true)
    expect(isFullRect(page, SRC)).toBe(false)
  })

  it('manual usa o retângulo escolhido; manual inválido ou a tela toda não recorta', () => {
    const tl = crop({ mode: 'manual', manual: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } })!
    expect(tl.constant).toBe(true)
    expect(tl.sizePx).toEqual({ w: 960, h: 540 })
    expect(crop({ mode: 'manual' })).toBeNull()
    expect(crop({ mode: 'manual', manual: { x: 0, y: 0, w: 1, h: 1 } })).toBeNull()
    expect(crop({ mode: 'manual', manual: { x: 0.5, y: 0.5, w: 0.01, h: 0.01 } })).toBeNull()
  })

  it('ponto e retângulo passam do espaço da tela ao do recorte e voltam', () => {
    const c: Rect = { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }
    const p = pointToCrop(c, { x: 0.35, y: 0.45 })
    expect(p.x).toBeCloseTo(0.5, 9)
    expect(p.y).toBeCloseTo(0.5, 9)
    expect(p.out).toBe(false)
    expect(pointToCrop(c, { x: 0.05, y: 0.45 }).out).toBe(true)
    expect(pointToCrop(c, { x: 0.05, y: 0.45 }).x).toBe(0)
    expect(rectFromCrop(c, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 })).toEqual({ x: 0.35, y: 0.45, w: 0.25, h: 0.25 })
    const at = constantCrop(c, SRC)!.at(5)
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(at[k]).toBeCloseTo(c[k], 9)
  })
})

// ---------------------------------------------------------------------------
// Dos retângulos do Win32 ao quadro normalizado (DPI misto, janela movida, redimensionada, pausa)

const rect = (x: number, y: number, ww: number, hh: number): Rect => ({ x, y, w: ww, h: hh })
const noEvents: RawEvents = { cursor: [], clicks: [], keys: [], windowRects: [] }

describe('a página medida vira content-rect.jsonl (normalizada no quadro capturado)', () => {
  const base = { kind: 'window' as const, screenRect: null, frame: { w: 1359, h: 942 }, t0: 1000, mainToRenderer: 0, pauses: [] }
  const frame = rect(158, 100, 1359, 942)
  const client = rect(159, 100, 1357, 941)

  it('janela de navegador: a página relativa à moldura capturada', () => {
    const built = buildEvents({ ...base, raw: { ...noEvents, windowRects: [{ t: 1000, frame, client, content: rect(159, 208, 1358, 834) }] } })
    expect(built.contentRects).toHaveLength(1)
    const r = built.contentRects[0]!
    expect(r.t).toBe(0)
    expect(r.x).toBeCloseTo(1 / 1359, 4)
    expect(r.y).toBeCloseTo(108 / 942, 4)
    expect(r.w).toBeCloseTo(1358 / 1359, 4)
    expect(r.h).toBeCloseTo(834 / 942, 4)
  })

  it('monitor em y negativo e a 100% (DPI misto): a conta é relativa à janela, não à origem do monitor', () => {
    const f = rect(-1900, -1000, 1200, 800)
    const built = buildEvents({
      ...base,
      frame: { w: 1200, h: 800 },
      raw: { ...noEvents, windowRects: [{ t: 1000, frame: f, client: f, content: rect(-1899, -900, 1198, 699) }] }
    })
    const r = built.contentRects[0]!
    expect(r.x).toBeCloseTo(1 / 1200, 4)
    expect(r.y).toBeCloseTo(100 / 800, 4)
    expect(r.h).toBeCloseTo(699 / 800, 4)
  })

  it('só grava quando muda de verdade: mover a janela sem mudar a página não cria linha nova', () => {
    const moved = rect(300, 150, 1359, 942)
    const built = buildEvents({
      ...base,
      raw: {
        ...noEvents,
        windowRects: [
          { t: 1000, frame, client, content: rect(159, 208, 1358, 834) },
          { t: 2000, frame: moved, client: moved, content: rect(301, 258, 1358, 834) }
        ]
      }
    })
    expect(built.contentRects).toHaveLength(1)
  })

  it('DevTools aberto: a página encolhe e a linha nova aparece no instante certo', () => {
    const built = buildEvents({
      ...base,
      raw: {
        ...noEvents,
        windowRects: [
          { t: 1000, frame, client, content: rect(159, 208, 1358, 834) },
          { t: 4500, frame, client, content: rect(159, 208, 664, 834) }
        ]
      }
    })
    expect(built.contentRects.map((r) => r.t)).toEqual([0, 3500])
    expect(built.contentRects[1]!.w).toBeCloseTo(664 / 1359, 4)
  })

  it('janela redimensionada: o quadro acompanha, então a página é medida na moldura DE AGORA', () => {
    const big = rect(158, 100, 1659, 942)
    const built = buildEvents({
      ...base,
      raw: {
        ...noEvents,
        windowRects: [
          { t: 1000, frame, client, content: rect(159, 208, 1358, 834) },
          { t: 3000, frame: big, client: big, content: rect(159, 208, 1658, 834) }
        ]
      }
    })
    expect(built.contentRects).toHaveLength(2)
    expect(built.contentRects[1]!.w).toBeCloseTo(1658 / 1659, 4)
  })

  it('o cursor e os cliques depois de redimensionar usam o tamanho de agora (o vídeo é esticado ao tamanho do primeiro quadro)', () => {
    const big = rect(158, 100, 1659, 942)
    const built = buildEvents({
      ...base,
      raw: {
        cursor: [3500, 158 + 1659 / 2, 100 + 942 / 2],
        clicks: [],
        keys: [],
        windowRects: [
          { t: 1000, frame, client, content: rect(159, 208, 1358, 834) },
          { t: 3000, frame: big, client: big, content: rect(159, 208, 1658, 834) }
        ]
      }
    })
    expect(built.cursor[0]!.x).toBeCloseTo(0.5, 3)
    expect(built.cursor[0]!.y).toBeCloseTo(0.5, 3)
  })

  it('amostra dentro de uma pausa não existe; a primeira vale desde o começo', () => {
    const built = buildEvents({
      ...base,
      pauses: [{ start: 1500, end: 2500 }],
      raw: {
        ...noEvents,
        windowRects: [
          { t: 900, frame, client, content: rect(159, 208, 1358, 834) },
          { t: 2000, frame, client, content: rect(159, 208, 700, 834) },
          { t: 3000, frame, client, content: rect(159, 208, 900, 834) }
        ]
      }
    })
    expect(built.contentRects.map((r) => r.t)).toEqual([0, 1000])
  })

  it('janela de outro programa (sem medida): nada é gravado', () => {
    const built = buildEvents({ ...base, raw: { ...noEvents, windowRects: [{ t: 1000, frame, client }] } })
    expect(built.contentRects).toEqual([])
  })

  it('captura de TELA: a página do navegador em primeiro plano, e o quadro todo quando nenhum está à frente', () => {
    const monitor = rect(0, 0, 1920, 1080)
    const built = buildEvents({
      raw: { ...noEvents, pages: [{ t: 1000, rect: null }, { t: 2000, rect: rect(159, 208, 1358, 834), exe: 'chrome.exe' }, { t: 5000, rect: null }] },
      kind: 'screen',
      screenRect: monitor,
      frame: { w: 1920, h: 1080 },
      t0: 1000,
      mainToRenderer: 0,
      pauses: []
    })
    expect(built.contentExe).toBe('chrome.exe')
    expect(built.contentRects.map((r) => [r.t, r.w])).toEqual([
      [0, 1],
      [1000, expect.closeTo(1358 / 1920, 4)],
      [4000, 1]
    ])
  })

  it('captura de tela sem nenhum navegador à frente: nenhum arquivo', () => {
    const built = buildEvents({ raw: { ...noEvents, pages: [{ t: 1000, rect: null }] }, kind: 'screen', screenRect: rect(0, 0, 1920, 1080), frame: { w: 1920, h: 1080 }, t0: 1000, mainToRenderer: 0, pauses: [] })
    expect(built.contentRects).toEqual([])
    expect(built.contentExe).toBeNull()
  })

  it('o arquivo é lido de volta (JSON Lines)', () => {
    const events = eventsFromText({ contentRect: '{"t":0,"x":0.001,"y":0.1,"w":0.99,"h":0.88}\n{"t":5,"x":"ruim"}\n' })
    expect(events.contentRects).toEqual([{ t: 0, x: 0.001, y: 0.1, w: 0.99, h: 0.88 }])
    expect(eventsFromText({}).contentRects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// A cena com o recorte: zoom, cursor, ripple e o recorte vertical trabalham DENTRO da página

const DURATION = 20_000
const CROP: Rect = { x: 0.1, y: 0.2, w: 0.6, h: 0.6 } // 1152×648 numa tela de 1920×1080 (16:9)

function mk(screenCrop: ScreenCrop | undefined, over: Partial<Project> = {}): Project {
  const p = createProject({
    title: 'recorte',
    sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: DURATION } }
  })
  return { ...p, ...(screenCrop ? { screenCrop } : {}), ...over }
}
const still = (x: number, y: number, ms = DURATION): CursorSample[] => Array.from({ length: Math.floor(ms / 8) + 1 }, (_, i) => ({ t: i * 8, x, y }))
const click = (t: number, x: number, y: number): ClickEvent => ({ t, x, y, button: 'left' })
const MANUAL: ScreenCrop = { mode: 'manual', manual: CROP }

describe('o cursor e os cliques no espaço do recorte', () => {
  const clicks = [click(3000, 0.4, 0.5) /* dentro */, click(8000, 0.4, 0.05) /* na barra de abas */, click(12_000, 0.95, 0.5) /* fora, à direita */]
  const raw = prepareEvents({ cursor: still(0.4, 0.5), clicks, keys: [] }, DURATION)

  it('sem recorte devolve os mesmos dados', () => {
    expect(applyScreenCrop(raw, mk(undefined))).toBe(raw)
    expect(applyScreenCrop(raw, mk({ mode: 'off' }))).toBe(raw)
  })

  it('o clique dentro vai para o espaço do recorte; o de fora some (não abre zoom nem ripple)', () => {
    const cd = applyScreenCrop(raw, mk(MANUAL))
    expect(cd.crop).not.toBeNull()
    expect(cd.clicks).toHaveLength(1)
    expect(cd.clicks[0]!.x).toBeCloseTo((0.4 - 0.1) / 0.6, 6)
    expect(cd.clicks[0]!.y).toBeCloseTo((0.5 - 0.2) / 0.6, 6)
  })

  it('o resultado é guardado: o mesmo recorte não refaz a grade', () => {
    const p = mk(MANUAL)
    expect(applyScreenCrop(raw, p)).toBe(applyScreenCrop(raw, p))
    expect(applyScreenCrop(raw, { ...p })).toBe(applyScreenCrop(raw, p))
    expect(applyScreenCrop(applyScreenCrop(raw, p), p)).toBe(applyScreenCrop(raw, p))
  })

  it('zoom automático só nasce de clique DENTRO do recorte', () => {
    const cd = applyScreenCrop(raw, mk(MANUAL))
    const zooms = generateAutoZooms({ clicks: cd.clicks, keys: cd.keys, cursor: cd.grid, duration: DURATION, preset: 'moderate' })
    expect(zooms).toHaveLength(1)
    expect(zooms[0]!.start).toBeLessThan(3000)
    expect(zooms[0]!.end).toBeGreaterThan(3000)
    // sem recorte o clique na barra de abas (8 s) também puxa o zoom (os dois se fundem num só)
    const all = generateAutoZooms({ clicks: raw.clicks, keys: raw.keys, cursor: raw.grid, duration: DURATION, preset: 'moderate' })
    expect(all.some((z) => z.start < 8000 && z.end > 8000)).toBe(true)
    expect(zooms.some((z) => z.start < 8000 && z.end > 8000)).toBe(false)
  })

  it('o cursor que sai da página não puxa a câmera: a grade segura a última posição de dentro', () => {
    const cursor: CursorSample[] = [
      ...Array.from({ length: 200 }, (_, i) => ({ t: i * 8, x: 0.4, y: 0.5 })),
      ...Array.from({ length: 200 }, (_, i) => ({ t: 1600 + i * 8, x: 0.4, y: 0.05 })) // passeando pelas abas
    ]
    const cd = applyScreenCrop(prepareEvents({ cursor, clicks: [], keys: [] }, 4000), mk(MANUAL, { sources: { screen: { path: 'x', w: 1920, h: 1080, fps: 30, durationMs: 4000 } } }))
    const last = cd.grid.y[cd.grid.y.length - 1]!
    expect(last).toBeCloseTo((0.5 - 0.2) / 0.6, 3)
    expect(cd.lookup.at(3000).out).toBe(true)
  })
})

describe('a cena com o recorte', () => {
  const clicks = [click(3000, 0.4, 0.5), click(8000, 0.4, 0.05)]
  const data = prepareEvents({ cursor: still(0.4, 0.5), clicks, keys: [] }, DURATION)
  const F = HORIZONTAL_1080

  it('sem zoom, a tela mostra exatamente o recorte (em coordenadas da tela gravada)', () => {
    const p = mk(MANUAL)
    const d = deriveProject(p, data, F)
    const s = evaluateScene(p, d, 1000, F)
    expect(s.screen!.src.x).toBeCloseTo(CROP.x, 6)
    expect(s.screen!.src.y).toBeCloseTo(CROP.y, 6)
    expect(s.screen!.src.w).toBeCloseTo(CROP.w, 6)
    expect(s.screen!.src.h).toBeCloseTo(CROP.h, 6)
  })

  it('o cartão da tela ganha a proporção do recorte, não a da tela gravada', () => {
    const wide = mk({ mode: 'manual', manual: { x: 0, y: 0.1, w: 1, h: 0.5 } }) // 1920×540 = 32:9
    const s = evaluateScene(wide, deriveProject(wide, data, F), 0, F)
    expect(s.screen!.dest.w / s.screen!.dest.h).toBeCloseTo(1920 / 540, 1)
    const plain = mk(undefined)
    const s2 = evaluateScene(plain, deriveProject(plain, data, F), 0, F)
    expect(s2.screen!.dest.w / s2.screen!.dest.h).toBeCloseTo(16 / 9, 2)
  })

  it('com zoom, a janela visível fica DENTRO do recorte (nunca mostra a barra de abas) e é menor que ele', () => {
    const p = mk(MANUAL, { zooms: [{ id: 'z', start: 2000, end: 6000, scale: 2, focus: 'auto', origin: 'manual' }] })
    const d = deriveProject(p, data, F)
    for (const t of [500, 2500, 4000, 6500, 9000]) {
      const r = evaluateScene(p, d, t, F).screen!.src
      expect(r.x).toBeGreaterThanOrEqual(CROP.x - 1e-9)
      expect(r.y).toBeGreaterThanOrEqual(CROP.y - 1e-9)
      expect(r.x + r.w).toBeLessThanOrEqual(CROP.x + CROP.w + 1e-9)
      expect(r.y + r.h).toBeLessThanOrEqual(CROP.y + CROP.h + 1e-9)
    }
    expect(evaluateScene(p, d, 4500, F).screen!.src.w).toBeLessThan(CROP.w * 0.6)
  })

  it('o ripple do clique de dentro aparece; o do clique na barra de abas não', () => {
    const p = mk(MANUAL)
    const d = deriveProject(p, data, F)
    expect(evaluateScene(p, d, 3100, F).ripples).toHaveLength(1)
    expect(evaluateScene(p, d, 8100, F).ripples).toHaveLength(0)
    // sem recorte o clique na barra aparece (o ponto está na tela gravada)
    const full = mk(undefined)
    expect(evaluateScene(full, deriveProject(full, data, F), 8100, F).ripples).toHaveLength(1)
  })

  it('o ripple cai no lugar certo do cartão (o ponto do clique no recorte)', () => {
    const p = mk(MANUAL)
    const d = deriveProject(p, data, F)
    const s = evaluateScene(p, d, 3100, F)
    const dest = s.screen!.dest
    const u = (0.4 - CROP.x) / CROP.w
    const v = (0.5 - CROP.y) / CROP.h
    expect(s.ripples[0]!.x).toBeCloseTo(dest.x + u * dest.w, 0)
    expect(s.ripples[0]!.y).toBeCloseTo(dest.y + v * dest.h, 0)
  })

  it('halo no cursor real: some quando o cursor sai da página', () => {
    const cursor: CursorSample[] = [...still(0.4, 0.5, 4000), ...Array.from({ length: 200 }, (_, i) => ({ t: 4008 + i * 8, x: 0.4, y: 0.05 }))]
    const raw = prepareEvents({ cursor, clicks: [], keys: [] }, 6000)
    const p = mk(MANUAL, { sources: { screen: { path: 'x', w: 1920, h: 1080, fps: 30, durationMs: 6000 } } })
    p.style.cursor.halo = true
    const d = deriveProject(p, raw, F)
    expect(evaluateScene(p, d, 2000, F).halo).not.toBeNull()
    expect(evaluateScene(p, d, 5000, F).halo).toBeNull()
  })

  it('no vertical o recorte 9:16 que segue o cursor fica dentro da página', () => {
    const p = mk(MANUAL)
    const d = deriveProject(p, data, VERTICAL_1080)
    for (const t of [1000, 3000, 9000, 15_000]) {
      const r = evaluateScene(p, d, t, VERTICAL_1080).screen!.src
      expect(r.x).toBeGreaterThanOrEqual(CROP.x - 1e-9)
      expect(r.y).toBeGreaterThanOrEqual(CROP.y - 1e-9)
      expect(r.x + r.w).toBeLessThanOrEqual(CROP.x + CROP.w + 1e-9)
      expect(r.y + r.h).toBeLessThanOrEqual(CROP.y + CROP.h + 1e-9)
    }
  })

  it('o recorte é o mesmo nos dois formatos: um documento só', () => {
    const p = mk(MANUAL)
    expect(deriveProject(p, data, F).crop).not.toBeNull()
    expect(deriveProject(p, data, VERTICAL_1080).crop).not.toBeNull()
    expect(deriveProject(mk({ mode: 'off' }), data, F).crop).toBeNull()
  })

  it('recorte automático: a página muda no meio (DevTools) e a cena segue, com a mesma proporção', () => {
    const page = (x: number, y: number, ww: number, hh: number): Rect => ({ x: x / 1920, y: y / 1080, w: ww / 1920, h: hh / 1080 })
    const rects: ContentRectSample[] = [{ t: 0, ...page(1, 108, 1358, 834) }, { t: 6000, ...page(1, 108, 664, 834) }]
    const raw = prepareEvents({ cursor: still(0.3, 0.5), clicks: [], keys: [], contentRects: rects }, DURATION)
    const p = mk({ mode: 'auto' })
    const d = deriveProject(p, raw, F)
    expect(d.crop).not.toBeNull()
    const before = evaluateScene(p, d, 3000, F).screen!.src
    const after = evaluateScene(p, d, 9000, F).screen!.src
    expect(after.w).toBeLessThan(before.w)
    // proporção de pixels igual nos dois instantes
    expect((before.w * 1920) / (before.h * 1080)).toBeCloseTo((after.w * 1920) / (after.h * 1080), 3)
  })
})

describe('a moldura de navegador (opcional)', () => {
  const data = prepareEvents({ cursor: still(0.4, 0.5), clicks: [click(3000, 0.4, 0.5)], keys: [] }, DURATION)
  const F = HORIZONTAL_1080

  it('desligada por padrão: nenhuma barra', () => {
    const p = mk(MANUAL)
    expect(deriveProject(p, data, F).bar).toBeNull()
    expect(evaluateScene(p, deriveProject(p, data, F), 0, F).screen!.bar).toBeUndefined()
  })

  it('ligada: a barra ocupa o topo do cartão e a página fica embaixo (o cartão cresce em altura)', () => {
    const p = mk({ ...MANUAL, browserFrame: { enabled: true, domain: 'meusistema.com.br' } })
    const d = deriveProject(p, data, F)
    expect(d.bar!.text).toBe('meusistema.com.br')
    const s = evaluateScene(p, d, 0, F).screen!
    expect(s.bar!.h).toBeGreaterThan(10)
    const pageH = s.dest.h - s.bar!.h
    // a página mantém a proporção do recorte
    expect(s.dest.w / pageH).toBeCloseTo(CROP.w * 1920 / (CROP.h * 1080), 1)
    expect(s.bar!.h / pageH).toBeCloseTo(BROWSER_BAR_RATIO, 1)
  })

  it('o ripple cai sobre a PÁGINA (abaixo da barra)', () => {
    const p = mk({ ...MANUAL, browserFrame: { enabled: true } })
    const d = deriveProject(p, data, F)
    const s = evaluateScene(p, d, 3100, F)
    const pageTop = s.screen!.dest.y + s.screen!.bar!.h
    const pageH = s.screen!.dest.h - s.screen!.bar!.h
    expect(s.ripples[0]!.y).toBeCloseTo(pageTop + ((0.5 - CROP.y) / CROP.h) * pageH, 0)
  })

  it('sem recorte não há barra (não há página para emoldurar); no vertical também não', () => {
    const noCrop = mk({ mode: 'off', browserFrame: { enabled: true } })
    expect(deriveProject(noCrop, data, F).bar).toBeNull()
    const p = mk({ ...MANUAL, browserFrame: { enabled: true } })
    expect(deriveProject(p, data, VERTICAL_1080).bar).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Mudar o recorte no documento: os zooms automáticos são refeitos sobre o que ele mostra

describe('mudar o recorte da tela no documento', () => {
  const clicks = [click(3000, 0.4, 0.5), click(12_000, 0.4, 0.05) /* na barra de abas */]
  const raw = prepareEvents({ cursor: still(0.4, 0.5), clicks, keys: [] }, DURATION)
  const base = (): Project => {
    const p = mk(undefined)
    p.zoomPreset = 'moderate'
    p.zooms = generateAutoZooms({ clicks: raw.clicks, keys: raw.keys, cursor: raw.grid, duration: DURATION, preset: 'moderate' })
    p.zooms.push({ id: 'meu', start: 15_000, end: 17_000, scale: 2, focus: 'auto', origin: 'manual' })
    return p
  }

  it('o clique na barra de abas deixa de abrir zoom; o zoom manual fica; é uma troca só', () => {
    const p = base()
    expect(p.zooms.some((z) => z.origin === 'auto' && z.start < 12_000 && z.end > 12_000)).toBe(true)
    const next = setScreenCrop(p, MANUAL, raw, DURATION)
    expect(next.screenCrop).toEqual(MANUAL)
    expect(next.zooms.some((z) => z.origin === 'auto' && z.start < 12_000 && z.end > 12_000)).toBe(false)
    expect(next.zooms.some((z) => z.origin === 'auto' && z.start < 3000 && z.end > 3000)).toBe(true)
    expect(next.zooms.find((z) => z.id === 'meu')).toEqual(p.zooms.find((z) => z.id === 'meu'))
  })

  it('zoom desligado continua desligado', () => {
    const p = { ...base(), zoomPreset: 'off' as const, zooms: [] }
    const next = setScreenCrop(p, MANUAL, raw, DURATION)
    expect(next.zooms).toEqual([])
    expect(next.zoomPreset).toBe('off')
  })

  it('o vertical também é refeito (com a escala e o teto de vertical)', () => {
    const p = base()
    p.vertical = { layout: 'screen-focus', layouts: [], zooms: [], zoomPreset: 'moderate' }
    const next = setScreenCrop(p, MANUAL, raw, DURATION)
    expect(next.vertical!.zooms.length).toBeGreaterThan(0)
    expect(next.vertical!.zooms.every((z) => z.scale === 1.35)).toBe(true)
    expect(next.vertical!.zooms.some((z) => z.start < 12_000 && z.end > 12_000)).toBe(false)
  })

  it('o mesmo recorte não muda nada (o documento é o mesmo objeto)', () => {
    const p = { ...base(), screenCrop: MANUAL }
    expect(setScreenCrop(p, { ...MANUAL }, raw, DURATION)).toBe(p)
    const semRecorte = mk(undefined)
    expect(setScreenCrop(semRecorte, undefined, raw, DURATION)).toBe(semRecorte)
  })

  it('a moldura de navegador muda só a moldura (nem recorte nem zooms)', () => {
    const p = { ...base(), screenCrop: MANUAL }
    const next = setBrowserFrame(p, { enabled: true, domain: 'meusistema.com.br' })
    expect(next.screenCrop).toEqual({ ...MANUAL, browserFrame: { enabled: true, domain: 'meusistema.com.br' } })
    expect(next.zooms).toBe(p.zooms)
    expect(setBrowserFrame(next, { enabled: true, domain: 'meusistema.com.br' })).toBe(next)
    expect(setBrowserFrame(next, { enabled: false }).screenCrop!.browserFrame).toEqual({ enabled: false })
    // sem recorte ainda: nasce "desligado" com a moldura pedida (a barra só aparece com recorte)
    expect(setBrowserFrame(mk(undefined), { enabled: true }).screenCrop).toEqual({ mode: 'off', browserFrame: { enabled: true } })
  })
})
