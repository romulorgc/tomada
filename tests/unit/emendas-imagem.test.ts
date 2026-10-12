/**
 * F1 · emenda na imagem: punch-in alternado centrado no rosto e dissolve curto quando o cortado tem ≥ 1 s e a tela mudou.
 * A cena é a MESMA da prévia e da exportação (`evaluateScene`), então estes testes valem para as duas.
 */
import { describe, expect, it } from 'vitest'
import { createProject } from '@shared/project'
import { HORIZONTAL_1080, VERTICAL_1080, deriveProject, evaluateScene, prepareEvents, type FormatSpec } from '@shared/scene'
import {
  DISSOLVE_MIN_REMOVED_MS,
  DISSOLVE_MS,
  MIN_CROP_W,
  PUNCH_SCALE,
  PUNCH_SCALE_RANGE,
  contentDifference,
  dissolveFlags,
  dissolveSnapFrames,
  dissolveWeight,
  punchCrop,
  punchScales
} from '@shared/punch-in'
import { equalPowerGains, handlesOf, keptIndexOf, planSeams, seamsPerMinute } from '@shared/seams'
import { keptRanges } from '@shared/timeline'
import type { FaceTrack } from '@shared/face'
import type { Cut, LayoutKind, Project, Range } from '@shared/types'

const kept = (...pairs: [number, number][]): Range[] => pairs.map(([start, end]) => ({ start, end }))

describe('emendas (plano compartilhado)', () => {
  it('cada emenda sabe onde cai na saída, quanto foi cortado e a alça real de cada lado', () => {
    const seams = planSeams(kept([0, 2000], [3500, 6000], [6800, 10_000]))
    expect(seams).toEqual([
      { index: 0, outMs: 2000, leftEnd: 2000, rightStart: 3500, removedMs: 1500, halfMs: 35 },
      { index: 1, outMs: 4500, leftEnd: 6000, rightStart: 6800, removedMs: 800, halfMs: 35 }
    ])
    expect(handlesOf(seams, 0)).toEqual({ head: 0, tail: 35 })
    expect(handlesOf(seams, 1)).toEqual({ head: 35, tail: 35 })
    expect(handlesOf(seams, 2)).toEqual({ head: 35, tail: 0 })
  })

  it('curva de potência igual (qsin): a soma dos quadrados é 1 em todo o cruzamento e o meio vale −3 dB para cada lado', () => {
    for (let u = 0; u <= 1; u += 0.05) {
      const g = equalPowerGains(u)
      expect(g.in * g.in + g.out * g.out).toBeCloseTo(1, 10)
    }
    expect(equalPowerGains(0)).toEqual({ out: 1, in: 0 })
    expect(equalPowerGains(1).in).toBeCloseTo(1, 10)
    expect(equalPowerGains(0.5).in).toBeCloseTo(Math.SQRT1_2, 10)
  })

  it('emendas por minuto e busca do trecho de um instante', () => {
    expect(seamsPerMinute(6, 60_000)).toBe(6)
    expect(seamsPerMinute(3, 0)).toBe(0)
    const k = kept([0, 1000], [2000, 3000])
    expect(keptIndexOf(k, 500)).toBe(0)
    expect(keptIndexOf(k, 1000)).toBe(-1)
    expect(keptIndexOf(k, 2500)).toBe(1)
    expect(keptIndexOf(k, 3000)).toBe(-1)
  })
})

describe('punch-in alternado (item 6)', () => {
  it('alterna 1,00 ↔ 1,28 a cada emenda quando os trechos são curtos (< 3 s): nunca duas seguidas iguais', () => {
    const s = punchScales(kept([0, 1500], [3000, 4600], [6000, 7400], [9000, 10_800], [12_000, 13_500]))
    expect(s).toEqual([1, PUNCH_SCALE, 1, PUNCH_SCALE, 1])
    for (let i = 1; i < s.length; i++) expect(s[i]).not.toBe(s[i - 1])
  })

  it('entre trechos longos (≥ 3 s) troca uma emenda sim e outra não, sempre igual para o mesmo vídeo', () => {
    const longKept = kept([0, 6000], [8000, 14_000], [16_000, 22_000], [24_000, 30_000], [32_000, 38_000])
    const a = punchScales(longKept)
    expect(a).toEqual(punchScales(longKept))
    expect(a[0]).toBe(1)
    const changes = a.slice(1).filter((v, i) => v !== a[i]).length
    expect(changes).toBe(2) // 4 emendas, trocam a 1ª e a 3ª
  })

  it('a razão fica na faixa 1,25–1,35 (e o pedido fora dela é preso)', () => {
    expect(PUNCH_SCALE).toBeGreaterThanOrEqual(PUNCH_SCALE_RANGE.min)
    expect(PUNCH_SCALE).toBeLessThanOrEqual(PUNCH_SCALE_RANGE.max)
    expect(Math.max(...punchScales(kept([0, 1000], [2000, 3000]), 2))).toBe(PUNCH_SCALE_RANGE.max)
    expect(Math.max(...punchScales(kept([0, 1000], [2000, 3000]), 1.05))).toBe(PUNCH_SCALE_RANGE.min)
  })

  it('o recorte aproxima em volta do rosto, que fica no mesmo lugar da janela, e nunca sai da imagem', () => {
    const base = { x: 0.2, y: 0.1, w: 0.5, h: 0.5 }
    const face = { cx: 0.4, cy: 0.3 } // no meio horizontal da janela, a 40% da altura
    const r = punchCrop(base, 1.28, face)
    expect(r.w).toBeCloseTo(0.5 / 1.28, 10)
    expect(r.h).toBeCloseTo(0.5 / 1.28, 10)
    // o rosto continua a 40% da largura e 40% da altura da janela nova
    expect((face.cx - r.x) / r.w).toBeCloseTo((face.cx - base.x) / base.w, 10)
    expect((face.cy - r.y) / r.h).toBeCloseTo((face.cy - base.y) / base.h, 10)
    // rosto na borda: o recorte é preso à imagem
    const edge = punchCrop({ x: 0.5, y: 0, w: 0.5, h: 0.5 }, 1.35, { cx: 0.98, cy: 0.05 })
    expect(edge.x).toBeGreaterThanOrEqual(0)
    expect(edge.y).toBeGreaterThanOrEqual(0)
    expect(edge.x + edge.w).toBeLessThanOrEqual(1 + 1e-12)
    expect(edge.y + edge.h).toBeLessThanOrEqual(1 + 1e-12)
    // sem rosto, aproxima pelo centro
    const c = punchCrop(base, 1.28, null)
    expect(c.x + c.w / 2).toBeCloseTo(base.x + base.w / 2, 10)
    expect(c.y + c.h / 2).toBeCloseTo(base.y + base.h / 2, 10)
  })

  it('imagem já muito ampliada: o punch-in é limitado para o recorte não passar de 1/0,15 da imagem', () => {
    const tight = { x: 0.3, y: 0.3, w: 0.18, h: 0.18 }
    const r = punchCrop(tight, 1.35, { cx: 0.4, cy: 0.4 })
    expect(r.w).toBeGreaterThanOrEqual(MIN_CROP_W - 1e-12)
    expect(punchCrop({ x: 0.3, y: 0.3, w: MIN_CROP_W, h: MIN_CROP_W }, 1.35, null)).toEqual({ x: 0.3, y: 0.3, w: MIN_CROP_W, h: MIN_CROP_W })
    expect(punchCrop(tight, 1, null)).toBe(tight)
  })
})

describe('dissolve de emenda (item 6)', () => {
  const seams = planSeams(kept([0, 2000], [3500, 6000], [6800, 10_000]))

  it('só quando o cortado tem ≥ 1 s E a tela mudou; senão corte seco', () => {
    expect(DISSOLVE_MIN_REMOVED_MS).toBe(1000)
    // a emenda 0 cortou 1,5 s; a 1 cortou 0,8 s
    expect(dissolveFlags(seams, () => true)).toEqual([true, false])
    expect(dissolveFlags(seams, () => false)).toEqual([false, false])
    expect(dissolveFlags(seams, (a, b) => a === 2000 && b === 3500)).toEqual([true, false])
  })

  it('o quadro que sai pesa 1 na emenda e 0 depois de 200 ms; fora de uma emenda que dissolve é 0', () => {
    const flags = [true, false]
    const k = kept([0, 2000], [3500, 6000], [6800, 10_000])
    expect(dissolveWeight(seams, flags, k, 1999)).toBe(0)
    expect(dissolveWeight(seams, flags, k, 2000)).toBe(1)
    expect(dissolveWeight(seams, flags, k, 2000 + DISSOLVE_MS / 2)).toBeCloseTo(0.5, 5)
    expect(dissolveWeight(seams, flags, k, 2000 + DISSOLVE_MS)).toBe(0)
    expect(dissolveWeight(seams, flags, k, 4500)).toBe(0) // a emenda 1 não dissolve
    expect(dissolveWeight([], [], k, 100)).toBe(0)
    // 150-250 ms
    expect(DISSOLVE_MS).toBeGreaterThanOrEqual(150)
    expect(DISSOLVE_MS).toBeLessThanOrEqual(250)
  })

  it('o quadro guardado é o último do trecho que antecede a emenda (30 qps: emenda em 2000 ms → quadro 59)', () => {
    expect([...dissolveSnapFrames(seams, [true, false], 30)]).toEqual([59])
    // emenda fora do quadro: o último quadro com instante de saída < 4500 ms é o 134 (4466,7 ms)
    expect([...dissolveSnapFrames(seams, [true, true], 30)].sort((a, b) => a - b)).toEqual([59, 134])
    expect(dissolveSnapFrames(seams, [false, false], 30).size).toBe(0)
  })

  it('a diferença do conteúdo mede a variação da grade nos dois instantes', () => {
    const map = [
      { t: 0, cells: new Uint8Array([0, 0, 0, 0]) },
      { t: 5000, cells: new Uint8Array([255, 255, 0, 0]) }
    ]
    expect(contentDifference(map, 1000, 4000)).toBe(0)
    expect(contentDifference(map, 1000, 6000)).toBeCloseTo(0.5, 10)
    expect(contentDifference([], 0, 1)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// A cena: prévia = exportação

const SCREEN = { w: 1920, h: 1080 }
const CAMERA = { w: 1920, h: 1080 }
const DURATION = 40_000
const FACE: FaceTrack = { version: 1, frame: CAMERA, boxes: Array.from({ length: 41 }, (_, i) => ({ t: i * 1000, x: 0.6, y: 0.2, w: 0.1, h: 0.2, score: 0.9 })) } as unknown as FaceTrack

function scene(cuts: Cut[], layout: LayoutKind, opts: { format?: FormatSpec; face?: boolean; punchIn?: boolean; map?: { t: number; cells: Uint8Array }[] } = {}): { project: Project; derived: ReturnType<typeof deriveProject>; at: (t: number) => ReturnType<typeof evaluateScene> } {
  const base = createProject({
    title: 't',
    sources: {
      screen: { path: 'media/screen.mp4', w: SCREEN.w, h: SCREEN.h, fps: 30, durationMs: DURATION },
      camera: { path: 'media/camera.mp4', w: CAMERA.w, h: CAMERA.h, fps: 30, durationMs: DURATION }
    }
  })
  const project: Project = { ...base, cuts, zoomPreset: 'off', style: { ...base.style, defaultLayout: layout, camera: { ...base.style.camera, ...(opts.punchIn === false ? { punchIn: false } : {}) } } }
  const data = prepareEvents({ cursor: [{ t: 0, x: 0.5, y: 0.5 }], clicks: [], keys: [], ...(opts.map ? { contentMap: opts.map.map((s) => ({ t: s.t, cols: 2, rows: 2, cells: s.cells })) } : {}) } as never, DURATION)
  const format = opts.format ?? HORIZONTAL_1080
  const derived = deriveProject(project, data, format, null, opts.face === false ? null : (FACE as FaceTrack))
  return { project, derived, at: (t) => evaluateScene(project, derived, t, format) }
}

const cut = (id: number, start: number, end: number): Cut => ({ id: `c${id}`, start, end, reason: 'silence', enabled: true })
const CUTS = [cut(0, 5000, 5800), cut(1, 12_000, 14_000), cut(2, 20_000, 20_900)]

describe('cena: punch-in no rosto (prévia = exportação)', () => {
  it('lado a lado: o trecho 0 fica em 1,00× e o 1 aproxima 1,28× em volta do rosto; entre trechos longos a próxima emenda mantém e a seguinte volta a 1,00×', () => {
    const { derived, at } = scene(CUTS, 'side-by-side')
    expect(derived.punch.slice(0, 4)).toEqual([1, PUNCH_SCALE, PUNCH_SCALE, 1])
    const a = at(2000).camera!
    const b = at(8000).camera!
    const c = at(25_000).camera!
    expect(at(2000).punchIn).toBe(1)
    expect(at(8000).punchIn).toBeCloseTo(PUNCH_SCALE, 10)
    expect(b.src.w).toBeCloseTo(a.src.w / PUNCH_SCALE, 10)
    expect(b.src.h).toBeCloseTo(a.src.h / PUNCH_SCALE, 10)
    expect(c.src.w).toBeCloseTo(a.src.w, 10)
    // o rosto (cx 0,65, cy 0,3) está dentro da janela aproximada e a janela cabe na imagem
    const faceCx = 0.65
    const faceCy = 0.3
    expect(b.src.x).toBeLessThanOrEqual(faceCx)
    expect(b.src.x + b.src.w).toBeGreaterThanOrEqual(faceCx)
    expect(b.src.y).toBeLessThanOrEqual(faceCy)
    expect(b.src.y + b.src.h).toBeGreaterThanOrEqual(faceCy)
    for (const x of [a, b, c]) {
      expect(x.src.x).toBeGreaterThanOrEqual(0)
      expect(x.src.y).toBeGreaterThanOrEqual(0)
      expect(x.src.x + x.src.w).toBeLessThanOrEqual(1 + 1e-9)
      expect(x.src.y + x.src.h).toBeLessThanOrEqual(1 + 1e-9)
    }
    // o destino da câmera não muda: só a imagem dentro dele
    expect(b.dest).toEqual(a.dest)
  })

  it('a troca é um corte seco: o recorte muda de uma vez na emenda, sem animação', () => {
    const { at } = scene(CUTS, 'side-by-side')
    expect(at(4999).camera!.src).toEqual(at(100).camera!.src)
    expect(at(5800).camera!.src.w).toBeCloseTo(at(5800 + 900).camera!.src.w, 10)
    expect(at(5800).camera!.src.w).toBeLessThan(at(4999).camera!.src.w)
  })

  it('apresentador, V-B (stack) e só câmera também aproximam; a bolha (rosto pequeno) e a tela sozinha não', () => {
    for (const layout of ['presenter', 'camera'] as const) expect(scene(CUTS, layout).at(8000).punchIn, layout).toBeCloseTo(PUNCH_SCALE, 10)
    expect(scene(CUTS, 'stack', { format: VERTICAL_1080 }).at(8000).punchIn).toBeCloseTo(PUNCH_SCALE, 10)
    for (const layout of ['bubble', 'screen'] as const) expect(scene(CUTS, layout).at(8000).punchIn, layout).toBe(1)
    expect(scene(CUTS, 'screen-focus', { format: VERTICAL_1080 }).at(8000).punchIn).toBe(1)
  })

  it('sem análise do rosto aproxima pelo centro; desligado no estilo da câmera, nunca aproxima', () => {
    expect(scene(CUTS, 'side-by-side', { face: false }).at(8000).punchIn).toBeCloseTo(PUNCH_SCALE, 10)
    const off = scene(CUTS, 'side-by-side', { punchIn: false })
    expect(off.derived.punch.every((v) => v === 1)).toBe(true)
    expect(off.at(8000).punchIn).toBe(1)
  })

  it('o zoom da tela do 16:9 não empilha: a imagem da câmera continua dentro da câmera e a tela dentro da fonte', () => {
    const base = scene(CUTS, 'side-by-side')
    const withZoom = createProject({ title: 'z', sources: base.project.sources })
    const project: Project = { ...base.project, zooms: [{ id: 'z1', start: 7000, end: 11_000, scale: 2, focus: { x: 0.9, y: 0.9 }, origin: 'manual' } as never], zoomPreset: 'off' }
    void withZoom
    const data = prepareEvents({ cursor: [{ t: 0, x: 0.5, y: 0.5 }], clicks: [], keys: [] }, DURATION)
    const derived = deriveProject(project, data, HORIZONTAL_1080, null, FACE)
    const s = evaluateScene(project, derived, 9000, HORIZONTAL_1080)
    expect(s.punchIn).toBeCloseTo(PUNCH_SCALE, 10)
    const cam = s.camera!.src
    expect(cam.x).toBeGreaterThanOrEqual(0)
    expect(cam.x + cam.w).toBeLessThanOrEqual(1 + 1e-9)
    expect(cam.y + cam.h).toBeLessThanOrEqual(1 + 1e-9)
    const scr = s.screen!.src
    expect(scr.x).toBeGreaterThanOrEqual(-1e-9)
    expect(scr.x + scr.w).toBeLessThanOrEqual(1 + 1e-9)
  })
})

describe('cena: dissolve só com ≥ 1 s cortado e a tela mudada', () => {
  const changed = [
    { t: 0, cells: new Uint8Array([0, 0, 0, 0]) },
    { t: 12_500, cells: new Uint8Array([255, 255, 255, 255]) }
  ]

  it('corte de 2 s com a página diferente dissolve por 200 ms; corte de 0,8 s e corte de 2 s com a página igual ficam secos', () => {
    const s = scene(CUTS, 'side-by-side', { map: changed })
    // saída: seg0 0-5000 (5000), seg1 5800-12 000 (6200) → emenda da 2ª em 11 200 de saída; ela cortou 2 s e a página mudou
    expect(s.derived.dissolves).toEqual([false, true, false])
    expect(s.at(14_000).dissolve).toBeCloseTo(1, 1) // logo na emenda (origem 14 000 = início do trecho seguinte)
    expect(s.at(14_000 + DISSOLVE_MS / 2).dissolve).toBeGreaterThan(0.3)
    expect(s.at(14_000 + DISSOLVE_MS / 2).dissolve).toBeLessThan(0.7)
    expect(s.at(14_000 + DISSOLVE_MS + 10).dissolve).toBe(0)
    expect(s.at(5800).dissolve).toBe(0) // 0,8 s: seco
    const same = scene(CUTS, 'side-by-side', { map: [{ t: 0, cells: new Uint8Array([9, 9, 9, 9]) }] })
    expect(same.derived.dissolves).toEqual([false, false, false])
    expect(same.at(14_000).dissolve).toBe(0)
    expect(scene(CUTS, 'side-by-side').derived.dissolves.every((v) => !v)).toBe(true) // sem mapa de conteúdo: seco
  })

  it('o dissolve não depende do layout nem do formato (mesmo plano no 16:9 e no 9:16)', () => {
    const h = scene(CUTS, 'side-by-side', { map: changed })
    const v = scene(CUTS, 'screen-center', { map: changed, format: VERTICAL_1080 })
    expect(v.derived.dissolves).toEqual(h.derived.dissolves)
    expect(v.derived.seams).toEqual(h.derived.seams)
    expect(keptRanges(DURATION, CUTS)).toEqual(h.derived.kept)
  })
})
