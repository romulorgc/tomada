import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { processCursor, type CursorGrid } from '@shared/cursor'
import { createEditorStore } from '@shared/editor-store'
import { createProject, parseProject, serializeProject } from '@shared/project'
import { DEFAULT_VERTICAL_ZOOM_PRESET, VERTICAL_ZOOM_MAX_PER_MIN, VERTICAL_ZOOM_SCALE, ZOOM_PRESETS, zoomPresetFor } from '@shared/zoom'
import { keptRanges } from '@shared/timeline'
import { reviewDocument, updateReviewItem } from '@shared/review'
import {
  FORMAT_CAPTION_KEYS,
  MIN_DWELL_MS,
  QUIET_MIN_MS,
  VERTICAL_BUBBLE_SIZE,
  VERTICAL_CAPTION_DEFAULTS,
  autoVerticalLayouts,
  enforceMinDwell,
  ensureVertical,
  mergeFormatView,
  pinVerticalLayout,
  projectForFormat,
  screenActivity,
  speechRanges
} from '@shared/vertical'
import type { ClickEvent, CursorSample, Project, Range, VerticalEdit, Word } from '@shared/types'

const SRC = { w: 1920, h: 1080 }

function doc(over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p1',
    title: 'Teste',
    createdAt: '2026-10-05T12:00:00.000Z',
    sources: {
      screen: { path: 'media/screen.mp4', ...SRC, fps: 30, durationMs: 30_000 },
      camera: { path: 'media/camera.mp4', w: 640, h: 360, fps: 30, durationMs: 30_000 }
    }
  })
  return { ...p, ...over }
}

const grid = (durationMs: number, x = 0.5, y = 0.5): CursorGrid => {
  const samples: CursorSample[] = []
  for (let t = 0; t <= durationMs; t += 8) samples.push({ t, x, y })
  return processCursor(samples, [], { durationMs })
}
const click = (t: number): ClickEvent => ({ t, x: 0.5, y: 0.5, button: 'left' })
const words = (ranges: [number, number][]): Word[] => ranges.map(([start, end], i) => ({ i, text: `p${i}`, start, end, prob: 1, kind: 'word' as const }))
/** Fala corrida em [from, to] (uma palavra a cada 300 ms: pausas curtas, uma só faixa de fala). */
const speech = (from: number, to: number): Word[] => {
  const out: [number, number][] = []
  for (let t = from; t + 300 <= to; t += 300) out.push([t, t + 280])
  return words(out)
}

// ---------------------------------------------------------------------------

describe('projectForFormat: a visão de cada formato', () => {
  it('no 16:9 a visão é o próprio documento (mesmo objeto)', () => {
    const d = doc()
    expect(projectForFormat(d, 'horizontal')).toBe(d)
  })

  it('o vertical sem edição própria parte do padrão: V-A, sem zoom, bolha 250 px no canto superior esquerdo, legenda Natural em caixa mista ligada', () => {
    const v = projectForFormat(doc(), 'vertical')
    expect(v.zooms).toEqual([])
    expect(v.layouts).toEqual([])
    expect(v.style.defaultLayout).toBe('screen-center')
    expect(v.style.camera.corner).toBe('top-left')
    expect(v.style.camera.size).toBeCloseTo(VERTICAL_BUBBLE_SIZE, 9)
    expect(v.captions).toMatchObject({ enabled: true, style: 'natural', wordsPerLine: 2, position: 'bottom', box: false })
    expect(v.zoomPreset).toBeUndefined()
  })

  it('a visão usa o que está em project.vertical e o resto (cortes, texto, fundo, cores) é o do documento', () => {
    const z = { id: 'vz1', start: 1000, end: 3000, scale: 1.4, focus: 'auto' as const, origin: 'auto' as const }
    const d = doc({
      zooms: [{ id: 'hz1', start: 5000, end: 7000, scale: 2, focus: 'auto', origin: 'manual' }],
      cuts: [{ id: 'c1', start: 100, end: 200, reason: 'manual', enabled: true }],
      captions: { enabled: false, style: 'natural', wordsPerLine: 4, position: 'bottom', box: true, highlightColor: '#00FF00', textColor: '#112233' },
      vertical: { layout: 'stack', layouts: [{ id: 'l1', start: 0, end: 1000, layout: 'camera' }], zooms: [z], zoomPreset: 'intense', captions: { style: 'karaoke', size: 1.2 }, hook: 'Olá' }
    })
    const v = projectForFormat(d, 'vertical')
    expect(v.zooms).toEqual([z])
    expect(v.layouts).toHaveLength(1)
    expect(v.style.defaultLayout).toBe('stack')
    expect(v.zoomPreset).toBe('intense')
    expect(v.cuts).toEqual(d.cuts)
    expect(v.captions).toMatchObject({ style: 'karaoke', size: 1.2, enabled: true, highlightColor: '#00FF00', textColor: '#112233' })
    expect(v.vertical?.hook).toBe('Olá') // o gancho viaja na visão
  })

  it('mergeFormatView é o inverso: ida e volta sem mexer em nada do 16:9', () => {
    const d = doc({ zooms: [{ id: 'hz1', start: 5000, end: 7000, scale: 2, focus: 'auto', origin: 'manual' }], zoomPreset: 'moderate' })
    const back = mergeFormatView(d, projectForFormat(d, 'vertical'), 'vertical')
    expect(back.zooms).toEqual(d.zooms)
    expect(back.zoomPreset).toBe('moderate')
    expect(back.style.defaultLayout).toBe(d.style.defaultLayout)
    expect(back.style.camera.corner).toBe(d.style.camera.corner)
    expect(back.style.camera.size).toBe(d.style.camera.size)
    expect(back.captions.style).toBe(d.captions.style)
    expect(back.captions.enabled).toBe(d.captions.enabled)
    expect(back.captions.wordsPerLine).toBe(d.captions.wordsPerLine)
    expect(back.cuts).toEqual(d.cuts)
  })

  it('mudar zooms, layouts, camada de câmera e legenda NA VISÃO do vertical grava em project.vertical e não toca o 16:9', () => {
    const d = doc({ captions: { enabled: false, style: 'natural', wordsPerLine: 4, position: 'bottom', box: true, highlightColor: '#FFD93D' } })
    const view = projectForFormat(d, 'vertical')
    const z = { id: 'vz', start: 0, end: 2000, scale: 1.3, focus: 'auto' as const, origin: 'manual' as const }
    const edited: Project = {
      ...view,
      zooms: [z],
      layouts: [{ id: 'l1', start: 0, end: 500, layout: 'stack' }],
      zoomPreset: 'subtle',
      style: { ...view.style, defaultLayout: 'screen-wide', camera: { ...view.style.camera, corner: 'bottom-right', size: 0.3 } },
      captions: { ...view.captions, style: 'clean', size: 1.1, positionY: 0.6, enabled: false }
    }
    const next = mergeFormatView(d, edited, 'vertical')
    expect(next.zooms).toEqual([]) // o 16:9 não ganhou o zoom do vertical
    expect(next.layouts).toEqual([])
    expect(next.style.defaultLayout).toBe(d.style.defaultLayout)
    expect(next.style.camera.corner).toBe(d.style.camera.corner)
    expect(next.captions).toMatchObject({ style: 'natural', enabled: false, wordsPerLine: 4 }) // legenda do 16:9 intacta
    expect(next.vertical).toMatchObject({
      layout: 'screen-wide',
      zooms: [z],
      layouts: [{ id: 'l1' }],
      zoomPreset: 'subtle',
      camera: { corner: 'bottom-right', size: 0.3 },
      captions: { style: 'clean', size: 1.1, positionY: 0.6, enabled: false }
    })
  })

  it('as cores mudadas no vertical são próprias e não alteram o horizontal', () => {
    const d = doc()
    const view = projectForFormat(d, 'vertical')
    const next = mergeFormatView(d, { ...view, captions: { ...view.captions, highlightColor: '#FF0000', textColor: '#ABCDEF' } }, 'vertical')
    expect(next.captions).toEqual(d.captions)
    expect(projectForFormat(next, 'vertical').captions).toMatchObject({ highlightColor: '#FF0000', textColor: '#ABCDEF' })
    const cleared = mergeFormatView(next, (() => { const v = projectForFormat(next, 'vertical'); const c = { ...v.captions }; delete c.textColor; return { ...v, captions: c } })(), 'vertical')
    expect(cleared.captions).toEqual(d.captions)
    expect(projectForFormat(cleared, 'vertical').captions.textColor).toBeUndefined()
  })

  it('cores explícitas do padrão vertical sobrevivem ao disco e prevalecem na visão', () => {
    const d = doc({ vertical: { layout: 'screen-focus', layouts: [], zooms: [], captions: { highlightColor: '#FF0000', textColor: '#AABBCC' } } })
    const saved = parseProject(serializeProject(d))
    expect(projectForFormat(saved, 'vertical').captions).toMatchObject({ highlightColor: '#FF0000', textColor: '#AABBCC' })
    expect(saved.captions).toEqual(d.captions)
  })

  it('sem cores próprias, o vertical continua herdando cores horizontais após editar outro campo', () => {
    const d = doc({ captions: { ...doc().captions, textColor: '#123456' } })
    const view = projectForFormat(d, 'vertical')
    const saved = mergeFormatView(d, { ...view, captions: { ...view.captions, size: 1.1 } }, 'vertical')
    expect(saved.vertical?.captions?.textColor).toBeUndefined()
    expect(saved.vertical?.captions?.highlightColor).toBeUndefined()
    const changed = { ...saved, captions: { ...saved.captions, textColor: '#ABCDEF', highlightColor: '#112233' } }
    expect(projectForFormat(changed, 'vertical').captions).toMatchObject({ textColor: '#ABCDEF', highlightColor: '#112233' })
  })

  it('o gancho: texto vazio some do documento; o preset "sem zoom" (off) é guardado', () => {
    const d = doc({ vertical: { layout: 'screen-focus', layouts: [], zooms: [], hook: 'Oi' } })
    const view = projectForFormat(d, 'vertical')
    const cleared = mergeFormatView(d, { ...view, vertical: { ...view.vertical!, hook: '' } }, 'vertical')
    expect(cleared.vertical?.hook).toBeUndefined()
    const off = mergeFormatView(d, { ...view, zoomPreset: 'off' }, 'vertical')
    expect(off.vertical?.zoomPreset).toBe('off')
  })

  it('no 16:9 mergeFormatView devolve a visão como está', () => {
    const d = doc()
    const view = { ...d, title: 'Outro' }
    expect(mergeFormatView(d, view, 'horizontal')).toBe(view)
  })

  it('os campos de legenda de cada formato incluem cores próprias opcionais', () => {
    expect([...FORMAT_CAPTION_KEYS]).toEqual(['enabled', 'style', 'wordsPerLine', 'position', 'box', 'size', 'positionY', 'uppercase', 'highlightWord', 'highlightColor', 'textColor'])
    expect(VERTICAL_CAPTION_DEFAULTS).toEqual({ enabled: true, style: 'natural', wordsPerLine: 2, position: 'bottom', box: false })
  })
})

describe('o documento no disco: legendas e edição vertical', () => {
  it('um projeto sem vertical (anterior à M4a) abre igual; "plain" vira "natural"', () => {
    const raw = JSON.parse(serializeProject(doc()))
    delete raw.vertical
    raw.captions.style = 'plain'
    const p = parseProject(JSON.stringify(raw))
    expect(p.vertical).toBeUndefined()
    expect(p.captions.style).toBe('natural')
  })

  it('vertical.captions também aceita o "plain" antigo', () => {
    const raw = JSON.parse(serializeProject(doc({ vertical: { layout: 'stack', layouts: [], zooms: [], captions: { style: 'natural' } } })))
    raw.vertical.captions.style = 'plain'
    expect(parseProject(JSON.stringify(raw)).vertical?.captions?.style).toBe('natural')
  })

  it('o bloco vertical vai e volta pelo disco sem perder nada (e preserva campos desconhecidos)', () => {
    const v: VerticalEdit = {
      layout: 'screen-wide',
      layouts: [{ id: 'l1', start: 100, end: 900, layout: 'stack' }],
      zooms: [{ id: 'z1', start: 0, end: 2000, scale: 1.4, focus: { x: 0.3, y: 0.6 }, origin: 'manual' }],
      zoomPreset: 'intense',
      camera: { corner: 'bottom-left', size: 0.2 },
      hook: 'Grave sua tela',
      captions: { enabled: true, style: 'karaoke', wordsPerLine: 2, position: 'top', box: false, size: 1.3, positionY: 0.3, uppercase: true }
    }
    const raw = JSON.parse(serializeProject(doc({ vertical: v })))
    raw.vertical.campoDeUmaVersaoFutura = 7
    const back = parseProject(JSON.stringify(raw))
    expect(back.vertical).toMatchObject(v)
    expect((back.vertical as Record<string, unknown>).campoDeUmaVersaoFutura).toBe(7)
  })

  it('layout vertical desconhecido é recusado com motivo legível', () => {
    const raw = JSON.parse(serializeProject(doc({ vertical: { layout: 'stack', layouts: [], zooms: [] } })))
    raw.vertical.layout = 'diagonal'
    expect(() => parseProject(JSON.stringify(raw))).toThrow(/project\.json inválido/)
  })
})

describe('zoom do vertical: presets de 1,2 a 1,5× (E1: mediana 1,2× [1,1–1,4])', () => {
  it('o Moderado é o padrão do vertical (1,35×, até 3 por minuto) e as escalas são menores que as do 16:9', () => {
    expect(DEFAULT_VERTICAL_ZOOM_PRESET).toBe('moderate')
    expect(VERTICAL_ZOOM_SCALE).toEqual({ subtle: 1.2, moderate: 1.35, intense: 1.5 })
    expect(VERTICAL_ZOOM_MAX_PER_MIN[DEFAULT_VERTICAL_ZOOM_PRESET]).toBe(3)
    const h = zoomPresetFor('horizontal', 'moderate')
    const v = zoomPresetFor('vertical', 'moderate')
    expect(h).toEqual(ZOOM_PRESETS.moderate)
    expect(v.scale).toBe(1.35)
    expect(v.maxPerMin).toBe(3)
    expect(v.scale).toBeLessThan(h.scale)
    expect(v.maxPerMin).toBeLessThan(h.maxPerMin)
    expect(v.lead).toBe(h.lead) // só a escala e o teto mudam
    expect(v.hold).toBe(h.hold)
  })
})

describe('escolha automática de layout do vertical', () => {
  const D = 30_000
  const input = (o: Partial<Parameters<typeof autoVerticalLayouts>[0]> = {}): Parameters<typeof autoVerticalLayouts>[0] => ({
    durationMs: D,
    hasCamera: true,
    clicks: [],
    keys: [],
    cursor: grid(D),
    speech: [{ start: 0, end: D }],
    ...o
  })

  it('fala sem nada na tela por muito tempo vira "Câmera + tela" (V-B) por inteiro', () => {
    const l = autoVerticalLayouts(input())
    expect(l).toEqual([{ id: 'layout-v1', start: 0, end: D, layout: 'stack' }])
  })

  /** Digitação de `from` a `to` (uma tecla a cada 500 ms): a tela fica em atividade de `from` a `to + 1000`. */
  const typing = (from: number, to: number): { t: number }[] => Array.from({ length: Math.floor((to - from) / 500) + 1 }, (_, k) => ({ t: from + k * 500 }))

  it('atividade longa abre o V-A: o V-B começa 500 ms depois da atividade e termina 400 ms antes da próxima', () => {
    // digitando de 8000 a 15000: atividade [8000, 16000]; a tela fica quieta antes e depois, e cada trecho dura mais que 6 s
    const l = autoVerticalLayouts(input({ keys: typing(8000, 15_000) }))
    expect(l.map((s) => [s.start, s.end])).toEqual([[0, 8000 - 400], [16_000 + 500, D]])
    expect(l.every((s) => s.layout === 'stack')).toBe(true)
    expect(l.map((s) => s.id)).toEqual(['layout-v1', 'layout-v2'])
  })

  it('cliques soltos (1,8 s de atividade cada) NÃO piscam o layout: a folga é curta demais e some', () => {
    const l = autoVerticalLayouts(input({ clicks: [click(5000), click(20_000)] }))
    expect(l).toEqual([{ id: 'layout-v1', start: 0, end: D, layout: 'stack' }])
  })

  it('quieto por menos de 3 s não vira V-B (histerese: entrar pede mais que sair)', () => {
    expect(QUIET_MIN_MS).toBe(3000)
    // cliques a cada 3,5 s: cada pausa de tela é de ~1,7 s
    const clicks = Array.from({ length: 8 }, (_, k) => click(2000 + k * 3500))
    const l = autoVerticalLayouts(input({ clicks, durationMs: 30_000 }))
    expect(l).toEqual([])
  })

  it('PERMANÊNCIA MÍNIMA: um V-A curto entre dois V-B é absorvido; um V-B curto no meio do V-A some', () => {
    expect(MIN_DWELL_MS).toBe(6000)
    // atividade curta no meio de uma fala longa: o V-A (~1,9 s) não dura 6 s, então o V-B continua
    const short = autoVerticalLayouts(input({ keys: [{ t: 12_000 }] })) // atividade [12000, 13000]
    expect(short).toEqual([{ id: 'layout-v1', start: 0, end: D, layout: 'stack' }])
    // pausa de 4 s (≥ 3 s: candidata) no meio de uma atividade contínua: o V-B de 4 s não dura 6 s e some
    const busy = [...typing(0, 8000), ...typing(12_500, 30_000)] // atividade [0, 9000] e [12500, 31000]; quieto [9000, 12500] = 3,5 s
    expect(autoVerticalLayouts(input({ keys: busy }))).toEqual([])
  })

  it('PERMANÊNCIA MÍNIMA em qualquer entrada: nenhum trecho, de nenhum dos dois layouts, dura menos de 6 s (tempo de saída)', () => {
    // 120 s com atividade em rajadas de tamanhos variados, determinístico
    const total = 120_000
    const keys: { t: number }[] = []
    let t = 4000
    let k = 0
    while (t < total - 3000) {
      const burst = 1500 + ((k * 2791) % 9000) // rajadas de 1,5 a 10,5 s
      keys.push(...typing(t, t + burst))
      t += burst + 2500 + ((k * 4673) % 11_000) // e folgas de 2,5 a 13,5 s
      k++
    }
    const kept = keptRanges(total, [
      { start: 30_000, end: 41_000, enabled: true },
      { start: 70_000, end: 72_500, enabled: true }
    ])
    for (const withKept of [false, true]) {
      const l = autoVerticalLayouts(input({ durationMs: total, keys, cursor: grid(total), speech: [{ start: 0, end: total }], ...(withKept ? { kept } : {}) }))
      const bounds: { start: number; end: number; on: boolean }[] = []
      let at = 0
      for (const s of l) {
        if (s.start > at) bounds.push({ start: at, end: s.start, on: false })
        bounds.push({ start: s.start, end: s.end, on: true })
        at = s.end
      }
      if (at < total) bounds.push({ start: at, end: total, on: false })
      expect(bounds.length, 'a entrada tem de produzir trocas para o teste valer').toBeGreaterThan(2)
      for (const b of bounds) {
        const seen = withKept ? keptRanges(total, [{ start: 30_000, end: 41_000, enabled: true }, { start: 70_000, end: 72_500, enabled: true }]).reduce((sum, r) => sum + Math.max(0, Math.min(b.end, r.end) - Math.max(b.start, r.start)), 0) : b.end - b.start
        expect(seen, `${b.on ? 'V-B' : 'V-A'} de ${b.start} a ${b.end} (kept: ${withKept})`).toBeGreaterThanOrEqual(MIN_DWELL_MS)
      }
    }
  })

  it('a permanência conta o tempo de SAÍDA: um V-B de 8 s com 4 s cortados dentro vale 4 s e some', () => {
    const keys = [...typing(0, 8000), ...typing(18_000, 28_000)] // atividade [0, 9000] e [18000, 29000]; quieto [9000, 18000]
    const noCuts = autoVerticalLayouts(input({ keys }))
    expect(noCuts).toHaveLength(1)
    expect(noCuts[0]).toMatchObject({ start: 9500, end: 17_600 }) // 8,1 s de V-B
    const kept = keptRanges(D, [{ start: 11_000, end: 15_000, enabled: true }]) // 4 s cortados DENTRO do V-B
    expect(autoVerticalLayouts(input({ keys, kept }))).toEqual([])
  })

  it('enforceMinDwell: o mais curto troca de estado e se junta aos vizinhos; termina sempre; empate pelo mais cedo', () => {
    const runs = (...r: [number, number, boolean][]) => r.map(([start, end, on]) => ({ start, end, on }))
    // folga curta entre dois V-B: tudo vira V-B
    expect(enforceMinDwell(runs([0, 10_000, true], [10_000, 13_000, false], [13_000, 30_000, true]), 6000)).toEqual(runs([0, 30_000, true]))
    // V-B curto no meio do V-A: tudo vira V-A
    expect(enforceMinDwell(runs([0, 10_000, false], [10_000, 13_000, true], [13_000, 30_000, false]), 6000)).toEqual(runs([0, 30_000, false]))
    // já cumpre: não muda nada (e não mexe no que recebeu)
    const ok = runs([0, 7000, true], [7000, 14_000, false], [14_000, 30_000, true])
    expect(enforceMinDwell(ok, 6000)).toEqual(ok)
    // a ponta curta se junta ao vizinho
    expect(enforceMinDwell(runs([0, 3000, false], [3000, 30_000, true]), 6000)).toEqual(runs([0, 30_000, true]))
    // um trecho só (ou nenhum) devolve como está, mesmo curto
    expect(enforceMinDwell(runs([0, 2000, true]), 6000)).toEqual(runs([0, 2000, true]))
    expect(enforceMinDwell([], 6000)).toEqual([])
    // todos curtos: termina e sobra um só
    expect(enforceMinDwell(runs([0, 2000, true], [2000, 4000, false], [4000, 6000, true], [6000, 8000, false]), 6000)).toHaveLength(1)
    // com o tempo de saída: o trecho de 8 s com 5 s cortados vale 3 s
    expect(enforceMinDwell(runs([0, 20_000, false], [20_000, 28_000, true], [28_000, 40_000, false]), 6000, keptRanges(40_000, [{ start: 21_000, end: 26_000, enabled: true }]))).toEqual(runs([0, 40_000, false]))
  })

  it('o cursor andando conta como atividade; parado, não', () => {
    const samples: CursorSample[] = []
    for (let t = 0; t <= D; t += 8) samples.push({ t, x: t > 10_000 && t < 14_000 ? 0.2 + (t - 10_000) / 20_000 : 0.2, y: 0.5 })
    const moving = processCursor(samples, [], { durationMs: D, antiTremor: false })
    const act = screenActivity({ clicks: [], keys: [], cursor: moving, durationMs: D })
    expect(act.length).toBeGreaterThan(0)
    expect(act[0]!.start).toBeGreaterThan(9500)
    expect(act[act.length - 1]!.end).toBeLessThan(14_800)
    expect(screenActivity({ clicks: [], keys: [], cursor: grid(D), durationMs: D })).toEqual([])
  })

  it('sem fala suficiente no silêncio de tela (< 50%), o layout fica no V-A', () => {
    const l = autoVerticalLayouts(input({ speech: [{ start: 0, end: 5000 }] })) // fala em 17% do vídeo
    expect(l).toEqual([])
  })

  it('sem transcrição (speech = null) supõe fala o tempo todo', () => {
    expect(autoVerticalLayouts(input({ speech: null }))).toHaveLength(1)
  })

  it('sem câmera não há V-B; duração zero não gera nada', () => {
    expect(autoVerticalLayouts(input({ hasCamera: false }))).toEqual([])
    expect(autoVerticalLayouts(input({ durationMs: 0 }))).toEqual([])
  })

  it('os trechos nunca passam da duração, nunca invertem e nunca se sobrepõem', () => {
    const clicks = [3000, 9000, 9500, 15_000, 24_000].map(click)
    const l = autoVerticalLayouts(input({ clicks }))
    for (let k = 0; k < l.length; k++) {
      expect(l[k]!.end).toBeGreaterThan(l[k]!.start)
      expect(l[k]!.start).toBeGreaterThanOrEqual(0)
      expect(l[k]!.end).toBeLessThanOrEqual(D)
      if (k > 0) expect(l[k]!.start).toBeGreaterThanOrEqual(l[k - 1]!.end)
    }
  })

  it('speechRanges junta palavras com pausa curta e ignora o que não é palavra', () => {
    expect(speechRanges(null)).toBeNull()
    expect(speechRanges([])).toBeNull()
    const w = words([[0, 300], [400, 700], [2000, 2300]])
    expect(speechRanges(w)).toEqual([{ start: 0, end: 700 }, { start: 2000, end: 2300 }] satisfies Range[])
    const f: Word[] = [{ i: 0, text: 'hã', start: 0, end: 400, prob: 1, kind: 'filler' }]
    expect(speechRanges(f)).toEqual([])
  })
})

describe('ensureVertical: entrar no 9:16 pela primeira vez', () => {
  const D = 30_000
  const data = { clicks: [click(5000), click(6500), click(20_000)], keys: [], grid: grid(D) }

  it('gera zooms do padrão do vertical (Moderado, 1,35×) e layouts pela atividade, e marca o preset', () => {
    const d = doc()
    const next = ensureVertical(d, data, { durationMs: D, words: speech(0, D) })
    expect(next).not.toBe(d)
    expect(next.vertical?.zoomPreset).toBe('moderate')
    expect(next.vertical!.zooms.length).toBeGreaterThan(0)
    expect(next.vertical!.zooms.every((z) => z.scale === 1.35 && z.origin === 'auto' && z.focus === 'auto')).toBe(true)
    expect(next.vertical!.layouts.length).toBeGreaterThan(0)
    expect(next.vertical!.layout).toBe('screen-center')
    expect(next.zooms).toEqual(d.zooms) // o 16:9 não é tocado
    expect(next.layouts).toEqual(d.layouts)
  })

  it('layout fixo do corte vence os layouts automáticos que o vertical nunca gerado ganha ao exportar', () => {
    const d = doc()
    d.clips = [{ id: 'c1', title: 'Corte', hook: '', ranges: [{ start: 0, end: D }], score: 80, reason: 'x', format: 'vertical', layoutV: 'camera' }]
    const reviewed = reviewDocument(d, 'c1')
    // sem fixar de novo depois do ensure, os segmentos automáticos prevalecem sobre o layout do corte (o defeito)
    const ensured = ensureVertical(reviewed, data, { durationMs: D, words: speech(0, D) })
    expect(ensured.vertical!.layouts.length).toBeGreaterThan(0)
    const pinned = pinVerticalLayout(ensured, 'camera')
    expect(pinned.vertical!.layout).toBe('camera')
    expect(pinned.vertical!.layouts).toEqual([])
    expect(pinned.vertical!.zooms.length).toBeGreaterThan(0) // os zooms do vertical novo continuam
  })

  it('layout escolhido na Revisão (item) também vence os automáticos e preserva os segmentos manuais', () => {
    const d = doc()
    d.clips = [{ id: 'c1', title: 'Corte', hook: '', ranges: [{ start: 0, end: D }], score: 80, reason: 'x', format: 'vertical', layoutV: 'auto' }]
    d.vertical = { layout: 'screen-focus', layouts: [{ id: 'meu', start: 1000, end: 2000, layout: 'stack', origin: 'manual' }, { id: 'auto-velho', start: 5000, end: 6000, layout: 'stack', origin: 'auto' }], zooms: [] }
    const reviewed = reviewDocument(updateReviewItem(d, 'c1', { layout: 'camera' }), 'c1')
    const pinned = pinVerticalLayout(ensureVertical(reviewed, data, { durationMs: D, words: speech(0, D) }), 'camera')
    expect(pinned.vertical!.layout).toBe('camera')
    expect(pinned.vertical!.layouts.map((s) => s.id)).toEqual(['meu'])
  })

  it('só gera uma vez: se o vertical já tem edição, devolve o MESMO documento', () => {
    const d = ensureVertical(doc(), data, { durationMs: D })
    expect(ensureVertical(d, data, { durationMs: D })).toBe(d)
    const manual = doc({ vertical: { layout: 'stack', layouts: [], zooms: [], zoomPreset: 'off' } })
    expect(ensureVertical(manual, data, { durationMs: D })).toBe(manual) // "sem zoom" escolhido pelo usuário vale
  })

  it('um bloco vertical só com ajustes de legenda ainda conta como "nunca gerado"', () => {
    const d = doc({ vertical: { layout: 'screen-focus', layouts: [], zooms: [], captions: { style: 'clean' } } })
    const next = ensureVertical(d, data, { durationMs: D })
    expect(next.vertical!.zooms.length).toBeGreaterThan(0)
    expect(next.vertical!.captions).toEqual({ style: 'clean' }) // o ajuste de legenda foi preservado
  })

  it('sem eventos de cursor não inventa zoom; sem câmera não inventa V-B', () => {
    const noEvents = ensureVertical(doc(), data, { durationMs: D, hasCursorEvents: false })
    expect(noEvents.vertical!.zooms).toEqual([])
    expect(noEvents.vertical!.zoomPreset).toBeUndefined()
    const base = doc()
    const noCamera = ensureVertical({ ...base, sources: { ...base.sources, camera: undefined } }, data, { durationMs: D })
    expect(noCamera.vertical!.layouts).toEqual([])
  })

  it('câmera escondida no estilo também não gera V-B', () => {
    const base = doc()
    const hidden = ensureVertical({ ...base, style: { ...base.style, camera: { ...base.style.camera, hidden: true } } }, data, { durationMs: D })
    expect(hidden.vertical!.layouts).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('o store do editor com os dois formatos', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const make = () => {
    const saved: Project[] = []
    const store = createEditorStore({ project: doc(), save: async (p) => void saved.push(p), onSaveError: () => undefined })
    return { store, saved }
  }
  const zoom = { id: 'vz', start: 0, end: 2000, scale: 1.4, focus: 'auto' as const, origin: 'manual' as const }

  it('começa no 16:9, onde a visão é o próprio documento', () => {
    const { store } = make()
    expect(store.getState().format).toBe('horizontal')
    expect(store.getState().project).toBe(store.getState().doc)
  })

  it('trocar de formato muda a visão e NÃO é um passo de desfazer', () => {
    const { store } = make()
    store.getState().setFormat('vertical')
    expect(store.getState().format).toBe('vertical')
    expect(store.getState().project).not.toBe(store.getState().doc)
    expect(store.getState().project.style.defaultLayout).toBe('screen-center')
    expect(store.getState().undoCount).toBe(0)
    store.getState().setFormat('horizontal')
    expect(store.getState().project).toBe(store.getState().doc)
  })

  it('uma mudança feita no vertical grava em doc.vertical e não toca o 16:9; o desfazer volta o documento inteiro', () => {
    const { store } = make()
    const before = store.getState().doc
    store.getState().setFormat('vertical')
    store.getState().change((p) => ({ ...p, zooms: [zoom] }))
    expect(store.getState().project.zooms).toEqual([zoom])
    expect(store.getState().doc.vertical?.zooms).toEqual([zoom])
    expect(store.getState().doc.zooms).toEqual(before.zooms)
    expect(store.getState().undoCount).toBe(1)
    store.getState().setFormat('horizontal')
    expect(store.getState().project.zooms).toEqual([]) // o 16:9 não ganhou o zoom
    store.getState().setFormat('vertical')
    expect(store.getState().undo()).toBe(true)
    expect(store.getState().project.zooms).toEqual([])
    expect(store.getState().doc.vertical?.zooms ?? []).toEqual([])
    expect(store.getState().redo()).toBe(true)
    expect(store.getState().project.zooms).toEqual([zoom])
  })

  it('uma mudança no 16:9 não aparece no vertical (zooms e layout padrão são de cada formato)', () => {
    const { store } = make()
    store.getState().change((p) => ({ ...p, zooms: [zoom], style: { ...p.style, defaultLayout: 'side-by-side' } }))
    store.getState().setFormat('vertical')
    expect(store.getState().project.zooms).toEqual([])
    expect(store.getState().project.style.defaultLayout).toBe('screen-center')
    // mas o que é comum (título, cortes) aparece nos dois
    store.getState().setFormat('horizontal')
    store.getState().change((p) => ({ ...p, cuts: [{ id: 'c1', start: 0, end: 100, reason: 'manual', enabled: true }] }))
    store.getState().setFormat('vertical')
    expect(store.getState().project.cuts).toHaveLength(1)
  })

  it('a seleção que não existe no outro formato é limpa ao trocar', () => {
    const { store } = make()
    store.getState().change((p) => ({ ...p, zooms: [zoom] }))
    store.getState().setSelection({ kind: 'zoom', id: 'vz' })
    store.getState().setFormat('vertical')
    expect(store.getState().selection).toBeNull()
  })

  it('changeDoc muda o documento inteiro (é como o vertical é gerado na primeira vez) e entra no histórico', () => {
    const { store } = make()
    store.getState().setFormat('vertical')
    store.getState().changeDoc((d) => ({ ...d, vertical: { layout: 'screen-focus', layouts: [], zooms: [zoom], zoomPreset: 'intense' } }))
    expect(store.getState().project.zooms).toEqual([zoom])
    expect(store.getState().undoCount).toBe(1)
    store.getState().undo()
    expect(store.getState().doc.vertical).toBeUndefined()
  })

  it('o que vai para o disco é o documento inteiro, com a edição vertical dentro', async () => {
    const { store, saved } = make()
    store.getState().setFormat('vertical')
    store.getState().change((p) => ({ ...p, vertical: { ...(p.vertical ?? { layout: p.style.defaultLayout, layouts: p.layouts, zooms: p.zooms }), hook: 'Oi' } }))
    await store.getState().flush()
    expect(saved).toHaveLength(1)
    expect(saved[0]!.vertical?.hook).toBe('Oi')
    expect(saved[0]!.zooms).toEqual([])
  })

  it('o guia da caixa segura é só da interface: não entra no documento nem no histórico', () => {
    const { store, saved } = make()
    store.getState().setSafeGuide(true)
    expect(store.getState().safeGuide).toBe(true)
    expect(store.getState().undoCount).toBe(0)
    expect(saved).toHaveLength(0)
  })
})
