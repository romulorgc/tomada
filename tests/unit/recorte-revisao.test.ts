/**
 * Revisão independente da C1: os defeitos achados, cada um com o teste que FALHAVA antes do conserto.
 *   2. mudança de geometria DURANTE A PAUSA se perdia na retomada;
 *   3. o retângulo que o arraste aceitava podia virar "tela inteira" em silêncio (limites diferentes);
 *   4. a transição de 200 ms mostrava o que já estava fora da página;
 *   6. a proporção de referência ignorava a duração real do último estado.
 */
import { describe, expect, it } from 'vitest'
import { buildCropTimeline, resolveScreenCrop, stabilizeContentRects, type CropStep } from '@shared/crop'
import { CROP_LOCKS, dragCrop, lockAspect, type CropHandle } from '@shared/crop-drag'
import { setScreenCrop } from '@shared/crop-edit'
import { createProject } from '@shared/project'
import { buildEvents, type RawEvents } from '@shared/recording'
import type { ContentRectSample, Project, Rect } from '@shared/types'

const SRC = { w: 1920, h: 1080 }
const px = (x: number, y: number, w: number, h: number): Rect => ({ x: x / SRC.w, y: y / SRC.h, w: w / SRC.w, h: h / SRC.h })
const sample = (t: number, r: Rect): ContentRectSample => ({ t, ...r })
const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })
const noEvents: RawEvents = { cursor: [], clicks: [], keys: [], windowRects: [] }

// ---------------------------------------------------------------------------------------------------------------------
describe('2. pausa: a página que mudou DURANTE a pausa vale na retomada (F11 → pausar → sair do F11 → retomar)', () => {
  const base = { kind: 'window' as const, screenRect: null, frame: { w: 1359, h: 942 }, t0: 1000, mainToRenderer: 0 }
  const frame = rect(158, 100, 1359, 942)
  const client = rect(159, 100, 1357, 941)
  const page = rect(159, 208, 1358, 834)
  const full = rect(158, 100, 1359, 942) // tela cheia: a página é a janela toda

  it('o último estado medido na pausa entra no tempo da retomada (o rastreador não repete uma medida que não mudou)', () => {
    // pausa de 1,5 s a 2,5 s (tempo do relógio); o rastreador viu a tela cheia aos 1,8 s e NÃO mediu de novo depois
    const built = buildEvents({
      ...base,
      pauses: [{ start: 1500, end: 2500 }],
      raw: {
        ...noEvents,
        windowRects: [
          { t: 1000, frame, client, content: full },
          { t: 1800, frame, client, content: page }
        ]
      }
    })
    // retomada = 1500 − 1000 = 500 ms de gravação
    expect(built.contentRects.map((r) => r.t)).toEqual([0, 500])
    expect(built.contentRects[1]!.y).toBeCloseTo(108 / 942, 4)
  })

  it('se a medida da pausa volta ao que era antes dela, não nasce linha nova', () => {
    const built = buildEvents({
      ...base,
      pauses: [{ start: 1500, end: 2500 }],
      raw: {
        ...noEvents,
        windowRects: [
          { t: 1000, frame, client, content: page },
          { t: 1700, frame, client, content: full },
          { t: 2000, frame, client, content: page }
        ]
      }
    })
    expect(built.contentRects.map((r) => r.t)).toEqual([0])
  })

  it('várias medidas na mesma pausa: vale a última, e a medida seguinte depois da retomada continua valendo', () => {
    const built = buildEvents({
      ...base,
      pauses: [{ start: 1500, end: 2500 }],
      raw: {
        ...noEvents,
        windowRects: [
          { t: 1000, frame, client, content: full },
          { t: 1700, frame, client, content: rect(159, 208, 700, 834) },
          { t: 2000, frame, client, content: page },
          { t: 3000, frame, client, content: rect(159, 208, 900, 834) }
        ]
      }
    })
    expect(built.contentRects.map((r) => r.t)).toEqual([0, 500, 1000])
    expect(built.contentRects[1]!.w).toBeCloseTo(1358 / 1359, 4)
    expect(built.contentRects[2]!.w).toBeCloseTo(900 / 1359, 4)
  })

  it('captura de TELA: o navegador que apareceu (ou sumiu) durante a pausa vale na retomada', () => {
    const monitor = rect(0, 0, 1920, 1080)
    const built = buildEvents({
      raw: { ...noEvents, pages: [{ t: 1000, rect: null }, { t: 1800, rect: rect(100, 150, 1400, 800), exe: 'chrome.exe' }] },
      kind: 'screen',
      screenRect: monitor,
      frame: { w: 1920, h: 1080 },
      t0: 1000,
      mainToRenderer: 0,
      pauses: [{ start: 1500, end: 2500 }]
    })
    expect(built.contentRects.map((r) => r.t)).toEqual([0, 500])
    expect(built.contentRects[1]!.w).toBeCloseTo(1400 / 1920, 4)
  })

  it('a janela que mudou de tamanho na pausa também aparece em window.jsonl na retomada', () => {
    const smaller = rect(158, 100, 1000, 700)
    const built = buildEvents({
      ...base,
      pauses: [{ start: 1500, end: 2500 }],
      raw: { ...noEvents, windowRects: [{ t: 1000, frame, client }, { t: 1800, frame: smaller, client: smaller }] }
    })
    expect(built.windowRects.map((r) => r.t)).toEqual([0, 500])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('3. recorte manual: o que o editor deixa fazer é sempre um recorte válido', () => {
  const HANDLES: CropHandle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
  const start = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }
  const sources = [SRC, { w: 1280, h: 720 }, { w: 2560, h: 1440 }, { w: 1358, h: 866 }]

  for (const src of sources) {
    it(`encolher o máximo, em qualquer alça, ainda dá um recorte que vale (${src.w}×${src.h})`, () => {
      for (const handle of HANDLES) {
        for (const aspect of [null, CROP_LOCKS['16:9'], CROP_LOCKS['4:3']]) {
          const dx = handle.includes('w') ? 5 : handle.includes('e') ? -5 : 0
          const dy = handle.includes('n') ? 5 : handle.includes('s') ? -5 : 0
          const r = dragCrop(start, handle, dx, dy, src, aspect)
          const tl = resolveScreenCrop({ mode: 'manual', manual: r }, undefined, src)
          expect(tl, `${handle} ${aspect ?? 'livre'}: ${JSON.stringify(r)} virou "sem recorte" em silêncio`).not.toBeNull()
        }
      }
    })
  }

  it('travar a proporção de um retângulo já pequeno também dá um recorte que vale', () => {
    const tiny = { x: 0.4, y: 0.4, w: 0.09, h: 0.5 }
    for (const lock of Object.values(CROP_LOCKS)) {
      const r = lockAspect(tiny, lock, SRC)
      expect(resolveScreenCrop({ mode: 'manual', manual: r }, undefined, SRC), `proporção ${lock}`).not.toBeNull()
    }
  })

  it('um retângulo inválido NÃO troca o recorte que já existia (e o documento é o mesmo objeto)', () => {
    const doc: Project = {
      ...createProject({ title: 't', sources: { screen: { path: 'media/screen.mp4', w: SRC.w, h: SRC.h, fps: 30, durationMs: 10_000 } } }),
      screenCrop: { mode: 'manual', manual: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }
    }
    const tiny = { x: 0.1, y: 0.1, w: 0.01, h: 0.01 }
    expect(setScreenCrop(doc, { mode: 'manual', manual: tiny }, null, 10_000)).toBe(doc)
    expect(setScreenCrop(doc, { mode: 'manual' }, null, 10_000)).toBe(doc) // manual sem retângulo
    // o válido troca normalmente
    const ok = setScreenCrop(doc, { mode: 'manual', manual: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 } }, null, 10_000)
    expect(ok.screenCrop!.manual!.x).toBeCloseTo(0.2, 6)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('4. a transição de 200 ms nunca mostra o que está fora da página', () => {
  const FULL = px(0, 0, 1920, 1080) // tela cheia (F11): a página é a janela toda
  const NORMAL = px(1, 108, 1918, 972) // com as abas e a barra de endereço
  const FULL_PAGE = px(1, 108, 1918, 972)
  const NARROW = px(1, 108, 760, 972) // DevTools à direita: a página encolheu para a esquerda
  const EPS = 1e-9
  const inside = (r: Rect, page: Rect): boolean => r.x >= page.x - EPS && r.y >= page.y - EPS && r.x + r.w <= page.x + page.w + EPS && r.y + r.h <= page.y + page.h + EPS

  function check(steps: CropStep[], label: string): void {
    const tl = buildCropTimeline(steps, SRC)!
    for (let t = 0; t <= steps[steps.length - 1]!.t + 2000; t += 5) {
      // a página que vale em `t`: a do último passo que já começou
      let page = steps[0]!.rect
      for (const s of steps) if (s.t <= t) page = s.rect
      const r = tl.at(t)
      expect(inside(r, page), `${label}: em ${t} ms o recorte ${JSON.stringify(r)} sai da página ${JSON.stringify(page)}`).toBe(true)
    }
  }

  it('abrir o DevTools à direita (a página encolhe)', () => {
    check([{ t: 0, rect: FULL_PAGE }, { t: 5000, rect: NARROW }], 'DevTools')
  })

  it('sair da tela cheia (a página ganha as abas em cima)', () => {
    check([{ t: 0, rect: FULL }, { t: 4000, rect: NORMAL }], 'sair do F11')
  })

  it('entrar na tela cheia e fechar o DevTools (a página cresce) também fica dentro da página que vale', () => {
    check([{ t: 0, rect: NARROW }, { t: 3000, rect: FULL_PAGE }, { t: 6000, rect: FULL }], 'crescer')
  })

  it('mudanças em sequência rápida (uma chega no meio da transição da outra)', () => {
    check([{ t: 0, rect: FULL_PAGE }, { t: 1000, rect: NARROW }, { t: 1100, rect: FULL }, { t: 1150, rect: NORMAL }], 'sequência')
  })

  it('a proporção do recorte segue a da referência durante a transição', () => {
    const tl = buildCropTimeline([{ t: 0, rect: FULL_PAGE }, { t: 5000, rect: NARROW }], SRC, { durationMs: 20_000 })!
    const aspect = tl.sizePx.w / tl.sizePx.h
    for (let t = 4900; t < 5400; t += 20) {
      const r = tl.at(t)
      expect((r.w * SRC.w) / (r.h * SRC.h)).toBeCloseTo(aspect, 3)
    }
  })

  it('a transição continua suave (sem salto maior que o necessário) quando a página cresce', () => {
    const tl = buildCropTimeline([{ t: 0, rect: NARROW }, { t: 3000, rect: FULL_PAGE }], SRC, { durationMs: 10_000 })!
    let prev = tl.at(2990)
    let biggest = 0
    for (let t = 3000; t <= 3300; t += 5) {
      const r = tl.at(t)
      biggest = Math.max(biggest, Math.abs(r.w - prev.w) * SRC.w, Math.abs(r.x - prev.x) * SRC.w)
      prev = r
    }
    expect(biggest).toBeLessThan(120) // 5 ms de uma rampa de 200 ms numa mudança de ~1100 px
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('6. a proporção de referência conta a duração REAL do último estado', () => {
  const A = px(1, 108, 1918, 972) // proporção 1918×972
  const B = px(1, 108, 1100, 972) // proporção 1100×972

  it('5 s numa proporção e depois minutos em outra: a referência é a que dura mais', () => {
    const steps: CropStep[] = [{ t: 0, rect: A }, { t: 5000, rect: B }]
    const tl = buildCropTimeline(steps, SRC, { durationMs: 300_000 })!
    expect(tl.sizePx).toEqual({ w: 1100, h: 972 })
  })

  it('sem a duração, o último estado conta 1 s (o comportamento antigo, só para quem não sabe a duração)', () => {
    const tl = buildCropTimeline([{ t: 0, rect: A }, { t: 5000, rect: B }], SRC)!
    expect(tl.sizePx).toEqual({ w: 1918, h: 972 })
  })

  it('resolveScreenCrop passa a duração da gravação ao recorte automático', () => {
    const samples = [sample(0, A), sample(5000, B)]
    const tl = resolveScreenCrop({ mode: 'auto' }, samples, SRC, 300_000)!
    expect(tl.sizePx.w).toBe(1100)
    // a mesma coisa, mas a gravação termina logo depois da mudança: a primeira proporção é a que dura mais
    const short = resolveScreenCrop({ mode: 'auto' }, samples, SRC, 6000)!
    expect(short.sizePx.w).toBe(1918)
  })

  it('o estado que se repete soma o tempo dele (A, B, A: o A de antes e o de depois contam juntos)', () => {
    const steps = stabilizeContentRects([sample(0, A), sample(4000, B), sample(8000, A)], SRC)
    const tl = buildCropTimeline(steps, SRC, { durationMs: 60_000 })!
    expect(tl.sizePx.w).toBe(1918)
  })
})
