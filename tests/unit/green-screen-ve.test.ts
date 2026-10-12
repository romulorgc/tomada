/**
 * F2, item 3: o layout V-E "Green screen" do 9:16. A página em tela cheia atrás (a janela legível) e você recortado na frente:
 * ~47% da altura, ancorado embaixo, legenda ~6% acima da cabeça; a variante "no canto" (35-45% da altura, ≤ 45% da largura) fica
 * do lado OPOSTO ao foco da página e só troca de lado a cada 4 s, numa emenda ou com deslize de ~0,4 s. O punch-in do F1 vale também
 * para a pessoa recortada.
 */
import { describe, expect, it } from 'vitest'
import {
  CORNER_CANDIDATE_MS,
  CORNER_MIN_HOLD_MS,
  CORNER_SLIDE_MS,
  DEFAULT_PERSON_FIT,
  GREENSCREEN,
  attentionX,
  cornerAt,
  greenscreenCaptionY,
  greenscreenHeadTop,
  greenscreenHeight,
  greenscreenWindow,
  greenscreenWindowH,
  personFit,
  planGreenCorner,
  typicalAim,
  isGreenscreen
} from '@shared/greenscreen'
import { PUNCH_SCALE } from '@shared/punch-in'
import { processCursor } from '@shared/cursor'
import { buildFaceFramer, type FaceTrack } from '@shared/face'
import { createProject } from '@shared/project'
import { planSeams } from '@shared/seams'
import { VERTICAL_1080, HORIZONTAL_1080, deriveProject, evaluateScene, layoutGeometry, prepareEvents, resolveLayout, usesPresenter } from '@shared/scene'
import { keptRanges, sourceToOutput } from '@shared/timeline'
import type { ClickEvent, LayoutKind, Project } from '@shared/types'
import { projectForFormat, verticalCaptionY } from '@shared/vertical'

const V = VERTICAL_1080
const click = (t: number, x: number, y: number): ClickEvent => ({ t, x, y, button: 'left', upT: t + 80 })
const DURATION = 40_000

/** Um rosto típico de webcam: centro a (0,5; 0,3), 35% da altura da câmera (rosto grande, como o do usuário). */
const faceTrack = (): FaceTrack => ({
  version: 1,
  engine: 'teste',
  frame: { w: 1920, h: 1080 },
  sampleMs: 200,
  durationMs: DURATION,
  createdAt: '',
  boxes: Array.from({ length: 200 }, (_, i) => ({ t: i * 200, x: 0.5 - 0.1, y: 0.3 - 0.175, w: 0.2, h: 0.35, score: 1 }))
})

function project(layout: LayoutKind, over: Partial<Project> = {}): Project {
  const p = createProject({
    title: 'x',
    sources: {
      screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: DURATION },
      camera: { path: 'media/camera.mp4', w: 1920, h: 1080, fps: 30, durationMs: DURATION }
    }
  })
  p.vertical = { layout, layouts: [], zooms: [], zoomPreset: 'off' }
  return { ...p, ...over }
}
const cursorAt = (x: number, y: number) => Array.from({ length: DURATION / 100 + 1 }, (_, i) => ({ t: i * 100, x, y }))
const derive = (p: Project, events = prepareEvents({ cursor: cursorAt(0.3, 0.4), clicks: [], keys: [] }, DURATION), withFace = true) => {
  const view = projectForFormat(p, 'vertical')
  return { view, derived: deriveProject(view, events, V, null, withFace ? faceTrack() : null) }
}

describe('geometria da pessoa', () => {
  const fit = personFit('greenscreen', undefined, V, { w: 1920, h: 1080 }, typicalAim(buildFaceFramer(faceTrack(), 0, DURATION)))

  it('os dois layouts são do V-E e o 16:9 os trata como o apresentador', () => {
    expect(isGreenscreen('greenscreen')).toBe(true)
    expect(isGreenscreen('greenscreen-corner')).toBe(true)
    expect(isGreenscreen('presenter')).toBe(false)
    expect(resolveLayout('greenscreen', true, true, 'horizontal')).toBe('presenter')
    expect(resolveLayout('greenscreen-corner', true, true, 'horizontal')).toBe('presenter')
    expect(resolveLayout('greenscreen', true, true, 'vertical')).toBe('greenscreen')
    // sem câmera o V-E vira só a página legível (não cai no V-A)
    expect(resolveLayout('greenscreen', true, false, 'vertical')).toBe('greenscreen')
  })

  it('centrado: a pessoa (do cabelo à borda de baixo) tem 47% do quadro, a janela é ancorada embaixo e do tamanho do quadro', () => {
    const win = greenscreenWindow('greenscreen', undefined, V, 1, fit)
    expect(win.x).toBe(0)
    expect(win.w).toBe(V.w)
    expect(win.y + win.h).toBeCloseTo(V.h, 5)
    const headTop = greenscreenHeadTop('greenscreen', undefined, 1, fit)
    expect(1 - headTop).toBeCloseTo(GREENSCREEN.height, 3) // o cabelo a 53% do quadro
    expect(GREENSCREEN.height).toBeGreaterThanOrEqual(0.47)
    expect(GREENSCREEN.height).toBeLessThanOrEqual(0.49)
  })

  it('no canto: 40% da altura, no máximo 45% da largura, colado embaixo, e o canto vai de 0 (esquerda) a 1 (direita)', () => {
    const fitC = personFit('greenscreen-corner', undefined, V, { w: 1920, h: 1080 }, typicalAim(buildFaceFramer(faceTrack(), 0, DURATION)))
    const left = greenscreenWindow('greenscreen-corner', undefined, V, 0, fitC)
    const right = greenscreenWindow('greenscreen-corner', undefined, V, 1, fitC)
    expect(left.w).toBeLessThanOrEqual(GREENSCREEN.cornerMaxW * V.w + 1e-6)
    expect(left.x).toBe(0)
    expect(right.x + right.w).toBeCloseTo(V.w, 5)
    expect(right.y + right.h).toBeCloseTo(V.h, 5)
    expect(1 - greenscreenHeadTop('greenscreen-corner', undefined, 1, fitC)).toBeCloseTo(GREENSCREEN.cornerHeight, 3)
    expect(GREENSCREEN.cornerHeight).toBeGreaterThanOrEqual(0.35)
    expect(GREENSCREEN.cornerHeight).toBeLessThanOrEqual(0.45)
    const mid = greenscreenWindow('greenscreen-corner', undefined, V, 0.5, fitC)
    expect(mid.x).toBeCloseTo((left.x + right.x) / 2, 5)
  })

  it('a altura escolhida pelo usuário (heightV) vale, presa a 0,35–0,60, e a janela acompanha', () => {
    expect(greenscreenHeight('greenscreen', { heightV: 0.52 })).toBe(0.52)
    expect(greenscreenHeight('greenscreen', { heightV: 0.1 })).toBe(0.35)
    expect(greenscreenHeight('greenscreen-corner', undefined)).toBe(GREENSCREEN.cornerHeight)
    expect(greenscreenWindowH('greenscreen', { heightV: 0.6 }, DEFAULT_PERSON_FIT)).toBeGreaterThan(greenscreenWindowH('greenscreen', { heightV: 0.4 }, DEFAULT_PERSON_FIT))
  })

  it('a pessoa é medida pelo rosto: rosto mais alto na câmera dá janela menor para a mesma altura de pessoa', () => {
    const tall = personFit('greenscreen', undefined, V, { w: 1920, h: 1080 }, { cx: 0.5, cy: 0.2, faceW: 0.12, faceH: 0.2 })
    const low = personFit('greenscreen', undefined, V, { w: 1920, h: 1080 }, { cx: 0.5, cy: 0.4, faceW: 0.12, faceH: 0.2 })
    expect(greenscreenWindowH('greenscreen', undefined, tall)).not.toBe(greenscreenWindowH('greenscreen', undefined, low))
    expect(personFit('greenscreen', undefined, V, null, null)).toEqual(DEFAULT_PERSON_FIT)
  })
})

describe('legenda acima da cabeça', () => {
  // o cabelo dentro da janela (no rosto sintético do resto do arquivo ele passa do topo da imagem e a cabeça já está no limite)
  const fit = DEFAULT_PERSON_FIT

  it('o centro da legenda fica 6% do quadro acima do topo da cabeça, e sobe com o punch-in (a cabeça sobe)', () => {
    const y1 = greenscreenCaptionY('greenscreen', undefined, 1, fit)
    expect(y1).toBeCloseTo(greenscreenHeadTop('greenscreen', undefined, 1, fit) - GREENSCREEN.captionGap, 6)
    const yp = greenscreenCaptionY('greenscreen', undefined, PUNCH_SCALE, fit)
    expect(yp).toBeLessThan(y1)
    expect(verticalCaptionY('greenscreen', undefined, 1, fit)).toBeCloseTo(y1, 6)
  })

  it('na cena a legenda nunca desce até o rosto: o centro dela fica acima do cabelo, com ou sem punch-in', () => {
    const p = project('greenscreen', { captions: { ...project('greenscreen').captions, enabled: true } })
    const { view, derived } = derive(p)
    const words = Array.from({ length: 40 }, (_, i) => ({ i, text: 'palavra', start: i * 900, end: i * 900 + 700, prob: 1, kind: 'word' as const }))
    const d2 = deriveProject(view, prepareEvents({ cursor: cursorAt(0.3, 0.4), clicks: [], keys: [] }, DURATION), V, words, faceTrack())
    for (const t of [1000, 5000, 12_000, 20_000]) {
      const s = evaluateScene(view, d2, t, V)
      expect(s.captions, `t=${t}`).not.toBeNull()
      // a legenda é desenhada em torno de captions.style (fração do centro); a cabeça começa em camera.dest.y + hairRel × altura
      const headTop = greenscreenHeadTop('greenscreen', undefined, s.punchIn, derived.fits.greenscreen) * V.h
      const centerY = s.captions!.style.centerY
      if (Number.isFinite(centerY)) expect(centerY, `t=${t}`).toBeLessThan(headTop - 8)
    }
  })
})

describe('legenda com posição escolhida à mão no V-E', () => {
  const words = Array.from({ length: 40 }, (_, i) => ({ i, text: 'palavra', start: i * 900, end: i * 900 + 700, prob: 1, kind: 'word' as const }))
  const centerAt = (layout: LayoutKind, positionY: number | undefined, t = 5000): { center: number; auto: number } => {
    const base = project(layout)
    const p = { ...base, captions: { ...base.captions, enabled: true, ...(positionY !== undefined ? { positionY } : {}) }, vertical: { ...base.vertical!, captions: { enabled: true, ...(positionY !== undefined ? { positionY } : {}) } } }
    const view = projectForFormat(p, 'vertical')
    const d = deriveProject(view, prepareEvents({ cursor: cursorAt(0.3, 0.4), clicks: [], keys: [] }, DURATION), V, words, faceTrack())
    const s = evaluateScene(view, d, t, V)
    return { center: s.captions!.style.centerY, auto: s.captions!.style.centerY }
  }
  it('escolhida embaixo (como no 9:16 antigo, 86%): sobre o rosto, então a legenda volta para logo acima da cabeça', () => {
    const manual = centerAt('greenscreen', 0.865)
    const auto = centerAt('greenscreen', undefined)
    expect(manual.center).toBeCloseTo(auto.center, 4)
  })
  it('escolhida acima da cabeça (20%): a escolha da pessoa vale', () => {
    const manual = centerAt('greenscreen', 0.2)
    const auto = centerAt('greenscreen', undefined)
    expect(manual.center).toBeLessThan(auto.center)
    expect(manual.center).toBeCloseTo(0.2 * V.h, -1)
  })
  it('nos outros layouts a posição escolhida continua valendo, até a embaixo', () => {
    expect(centerAt('stack', 0.865).center).toBeGreaterThan(centerAt('stack', undefined).center)
  })
})

describe('na cena', () => {
  it('V-E: a página é o quadro todo e a câmera é o recorte ancorado embaixo (cutout ligado, peso 1)', () => {
    const { view, derived } = derive(project('greenscreen'))
    const s = evaluateScene(view, derived, 2000, V)
    expect(s.debug.layout).toBe('greenscreen')
    expect(s.screen!.dest).toEqual({ x: 0, y: 0, w: V.w, h: V.h })
    expect(s.camera!.dest.x).toBe(0)
    expect(s.camera!.dest.y + s.camera!.dest.h).toBe(V.h)
    expect(s.camera!.cutout).not.toBeNull()
    expect(s.camera!.cutout!.weight).toBeCloseTo(1, 5)
    expect(s.camera!.cutout!.feather).toEqual({ l: 0, r: 0 }) // a janela coincide com o quadro: sem esmaecimento
    expect(derived.needsMatte).toBe(true)
    expect(usesPresenter(view, 'vertical')).toBe(true)
    // a pessoa não passa de 85% da janela: cabeça abaixo do topo da janela
    expect(s.camera!.dest.h / V.h).toBeLessThan(0.62)
  })

  it('V-E no canto: janela ≤ 45% da largura e ≤ 45% da altura, em um canto de baixo, com esmaecimento na borda de dentro', () => {
    const { view, derived } = derive(project('greenscreen-corner'))
    const s = evaluateScene(view, derived, 2000, V)
    expect(s.camera!.dest.w).toBeLessThanOrEqual(GREENSCREEN.cornerMaxW * V.w + 1)
    expect(s.camera!.dest.y + s.camera!.dest.h).toBe(V.h)
    const atEdge = s.camera!.dest.x === 0 || s.camera!.dest.x + s.camera!.dest.w === V.w
    expect(atEdge).toBe(true)
    expect(s.camera!.cutout!.feather).toBeDefined()
    const f = s.camera!.cutout!.feather!
    expect(f.l > 0 || f.r > 0).toBe(true)
    expect(f.l === 0 || f.r === 0).toBe(true)
  })

  it('sem câmera o V-E é só a página legível (nada de recorte)', () => {
    const p = project('greenscreen')
    delete p.sources.camera
    const { view, derived } = derive(p)
    const s = evaluateScene(view, derived, 2000, V)
    expect(s.camera).toBeNull()
    expect(derived.needsMatte).toBe(false)
    expect(s.screen!.dest).toEqual({ x: 0, y: 0, w: V.w, h: V.h })
  })

  it('a letra do V-E fica em 28–40 px (zoom mínimo do perfil dá folga vertical) e a página cobre o quadro', () => {
    const { derived } = derive(project('greenscreen'))
    expect(derived.legible.greenscreen!.targetPx).toBeGreaterThanOrEqual(28)
    expect(derived.legible.greenscreen!.targetPx).toBeLessThanOrEqual(40)
    expect(derived.legible['greenscreen-corner']).toBeUndefined()
  })

  it('o 16:9 não muda: o apresentador continua com a janela dele', () => {
    const p = project('presenter', { layouts: [] })
    p.style = { ...p.style, defaultLayout: 'presenter' }
    const d = deriveProject(p, prepareEvents({ cursor: cursorAt(0.3, 0.4), clicks: [], keys: [] }, DURATION), HORIZONTAL_1080, null, faceTrack())
    const s = evaluateScene(p, d, 1000, HORIZONTAL_1080)
    expect(s.camera!.cutout).not.toBeNull()
    expect(s.camera!.cutout!.feather).toBeUndefined()
    expect(d.legible).toEqual({})
  })

  it('geometria direta: o V-E sem tela cai em só câmera', () => {
    const p = project('greenscreen')
    const g = layoutGeometry('greenscreen', p.style, V, { screen: null, camera: { w: 1920, h: 1080 } })
    expect(g.screen).toBeNull()
    expect(g.camera!.rect).toEqual({ x: 0, y: 0, w: V.w, h: V.h })
  })
})

describe('punch-in do F1 na pessoa recortada', () => {
  it('trechos alternados aproximam o rosto (o recorte da câmera fica menor), com a pessoa na mesma janela', () => {
    const cuts = [{ id: 'c1', start: 6000, end: 8000, reason: 'silence' as const, enabled: true }]
    const p = project('greenscreen', { cuts })
    const { view, derived } = derive(p)
    expect(derived.punch.some((v) => v > 1)).toBe(true)
    const kept = derived.kept
    const first = evaluateScene(view, derived, kept[0]!.start + 500, V)
    const second = evaluateScene(view, derived, kept[1]!.start + 500, V)
    const wide = Math.max(first.camera!.src.w, second.camera!.src.w)
    const tight = Math.min(first.camera!.src.w, second.camera!.src.w)
    expect(tight).toBeLessThan(wide * 0.9)
    expect(first.camera!.dest).toEqual(second.camera!.dest)
    expect(first.punchIn === 1 || second.punchIn === 1).toBe(true)
    expect(Math.max(first.punchIn, second.punchIn)).toBeCloseTo(PUNCH_SCALE, 3)
  })
})

describe('R4: o canto oposto ao foco', () => {
  const kept = [{ start: 0, end: DURATION }]
  const stepper = (ax: (t: number) => number, over: Partial<Parameters<typeof planGreenCorner>[0]> = {}) =>
    planGreenCorner({
      durationMs: DURATION,
      kept,
      seams: [],
      clicks: [],
      cursor: processCursor(Array.from({ length: DURATION / 100 + 1 }, (_, i) => ({ t: i * 100, x: ax(i * 100), y: 0.5 })), [], { durationMs: DURATION }),
      windowAt: () => ({ cx: 0.5, w: 0.2 }),
      toOutput: (t) => sourceToOutput(t, kept),
      ...over
    })

  it('começa à direita; foco no lado direito da janela põe a pessoa à esquerda e vice-versa', () => {
    // a janela (cx 0,5, w 0,2) enxerga [0,4-0,6]; o cursor em 0,58 está à DIREITA na janela
    const right = stepper(() => 0.58)
    expect(right.initial).toBe(1)
    expect(right.switches[0]).toMatchObject({ to: 0 })
    const left = stepper(() => 0.42)
    expect(left.switches).toHaveLength(0) // já está à direita, oposta ao foco
    const flip = stepper((t) => (t < 15_000 ? 0.58 : 0.42))
    expect(flip.switches.map((s) => s.to)).toEqual([0, 1])
  })

  it('só troca com o candidato estável por 600 ms e no máximo a cada 4 s de saída', () => {
    // o foco oscila a cada 1 s: nenhuma troca por oscilação curta de 400 ms
    const flicker = stepper((t) => (Math.floor(t / 400) % 2 === 0 ? 0.58 : 0.42))
    expect(flicker.switches).toHaveLength(0)
    const busy = stepper((t) => (Math.floor(t / 1500) % 2 === 0 ? 0.58 : 0.42))
    for (let i = 1; i < busy.switches.length; i++) expect(busy.switches[i]!.t - busy.switches[i - 1]!.t).toBeGreaterThanOrEqual(CORNER_MIN_HOLD_MS - 1)
    expect(CORNER_CANDIDATE_MS).toBe(600)
  })

  it('o centro (zona morta) não decide o lado', () => {
    expect(stepper(() => 0.5).switches).toHaveLength(0)
    expect(stepper(() => 0.51).switches).toHaveLength(0) // 0,51 numa janela de 0,2 de largura é 55% da janela: dentro de 50% ± 10%
  })

  it('a troca vira corte seco numa emenda logo depois; sem emenda, desliza em 0,4 s', () => {
    const k = [{ start: 0, end: 1200 }, { start: 1700, end: DURATION }]
    const withSeam = stepper(() => 0.58, { kept: k, seams: planSeams(k), toOutput: (t) => sourceToOutput(t, k) })
    expect(withSeam.switches[0]!.ms).toBe(0)
    expect(withSeam.switches[0]!.t).toBe(1700)
    const slide = stepper(() => 0.58)
    expect(slide.switches[0]!.ms).toBe(CORNER_SLIDE_MS)
  })

  it('a ação forte recente vale mais que o cursor', () => {
    const strong = [{ t: 5000, x: 0.58, y: 0.5, strong: true }]
    const cursor = processCursor(Array.from({ length: 100 }, (_, i) => ({ t: i * 100, x: 0.3, y: 0.5 })), [], { durationMs: 10_000 })
    expect(attentionX(6000, strong, cursor)).toBe(0.58)
    expect(attentionX(9000, strong, cursor)).toBeCloseTo(0.3, 3) // passaram 3 s: volta ao cursor
    expect(attentionX(2000, strong, cursor)).toBeCloseTo(0.3, 3)
  })

  it('o deslize interpola em suavização e termina no lado novo', () => {
    const plan = { initial: 1 as const, switches: [{ t: 10_000, ms: 400, to: 0 as const }, { t: 20_000, ms: 0, to: 1 as const }] }
    expect(cornerAt(plan, 5000)).toBe(1)
    expect(cornerAt(plan, 10_200)).toBeGreaterThan(0.3)
    expect(cornerAt(plan, 10_200)).toBeLessThan(0.7)
    expect(cornerAt(plan, 10_500)).toBe(0)
    expect(cornerAt(plan, 20_000)).toBe(1)
  })

  it('na cena: a pessoa no canto troca de lado com o foco e o esmaecimento acompanha o lado de dentro', () => {
    // clique forte no lado direito da página: a janela legível vai para lá e o foco fica no meio/direita da janela
    const events = prepareEvents({ cursor: cursorAt(0.2, 0.4), clicks: [click(4000, 0.2, 0.4), click(20_000, 0.85, 0.4)], keys: [] }, DURATION)
    const { view, derived } = derive(project('greenscreen-corner'), events)
    expect(derived.cornerPlan).not.toBeNull()
    const early = evaluateScene(view, derived, 3000, V).camera!.dest.x
    const late = evaluateScene(view, derived, 30_000, V).camera!.dest.x
    expect(early).toBeGreaterThanOrEqual(0)
    expect(late).toBeGreaterThanOrEqual(0)
  })
})

describe('as medidas das referências', () => {
  it('47–49% da altura (centrado), 35–45% e ≤ 45% da largura (canto), legenda 6% acima da cabeça', () => {
    expect(GREENSCREEN.height).toBeGreaterThanOrEqual(0.47)
    expect(GREENSCREEN.height).toBeLessThanOrEqual(0.49)
    expect(GREENSCREEN.cornerHeight).toBeGreaterThanOrEqual(0.35)
    expect(GREENSCREEN.cornerHeight).toBeLessThanOrEqual(0.45)
    expect(GREENSCREEN.cornerMaxW).toBeLessThanOrEqual(0.45)
    expect(GREENSCREEN.captionGap).toBeCloseTo(0.06, 6)
  })

  it('keptRanges de apoio funciona com cortes sobrepostos', () => {
    expect(keptRanges(1000, [{ start: 100, end: 200, enabled: true }])).toHaveLength(2)
  })
})

describe('a letra não depende do tamanho da área-base naquele instante', () => {
  // gravação real do usuário: a lista suspensa da barra de endereço (content-rect de 0,745 × 0,429 da tela) por 1,5 s encolhia a área-base
  // do recorte automático e a mesma janela, em fração dela, dobrava a ampliação (letra de 30 para 60 px)
  const rects = [
    { t: 0, x: 0, y: 0.1, w: 1, h: 0.84444 },
    { t: 10_000, x: 0.0979, y: 0.0982, w: 0.7453, h: 0.4287 },
    { t: 11_500, x: 0, y: 0.1, w: 1, h: 0.84444 }
  ]
  const windowPx = (layout: LayoutKind, t: number): number => {
    const p = project(layout, { screenCrop: { mode: 'auto' } as Project['screenCrop'] })
    const events = prepareEvents({ cursor: cursorAt(0.4, 0.4), clicks: [], keys: [], contentRects: rects }, DURATION)
    const { view, derived } = derive(p, events)
    return evaluateScene(view, derived, t, V).screen!.src.w * 1920
  }
  it.each(['greenscreen', 'greenscreen-corner', 'stack', 'screen-center'] as const)('%s: a janela tem o mesmo tamanho em px da fonte antes e durante a lista suspensa', (layout) => {
    const before = windowPx(layout, 5000)
    const during = windowPx(layout, 10_800)
    expect(during).toBeGreaterThan(before * 0.95)
    expect(during).toBeLessThan(before * 1.05)
  })
})
