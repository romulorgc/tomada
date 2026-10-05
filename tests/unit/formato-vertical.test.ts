import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { processCursor, type CursorGrid } from '@shared/cursor'
import { createEditorStore } from '@shared/editor-store'
import { createProject, parseProject, serializeProject } from '@shared/project'
import { DEFAULT_VERTICAL_ZOOM_PRESET, VERTICAL_ZOOM_SCALE, ZOOM_PRESETS, zoomPresetFor } from '@shared/zoom'
import {
  FORMAT_CAPTION_KEYS,
  QUIET_MIN_MS,
  VERTICAL_BUBBLE_SIZE,
  VERTICAL_CAPTION_DEFAULTS,
  autoVerticalLayouts,
  ensureVertical,
  mergeFormatView,
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

  it('o vertical sem edição própria parte do padrão: V-A, sem zoom, bolha 250 px no canto superior esquerdo, legenda Destaque ligada', () => {
    const v = projectForFormat(doc(), 'vertical')
    expect(v.zooms).toEqual([])
    expect(v.layouts).toEqual([])
    expect(v.style.defaultLayout).toBe('screen-focus')
    expect(v.style.camera.corner).toBe('top-left')
    expect(v.style.camera.size).toBeCloseTo(VERTICAL_BUBBLE_SIZE, 9)
    expect(v.captions).toMatchObject({ enabled: true, style: 'highlight', wordsPerLine: 3, position: 'bottom', box: false })
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

  it('as cores da legenda valem para os dois formatos (mudar no vertical muda no documento)', () => {
    const d = doc()
    const view = projectForFormat(d, 'vertical')
    const next = mergeFormatView(d, { ...view, captions: { ...view.captions, highlightColor: '#FF0000', textColor: '#ABCDEF' } }, 'vertical')
    expect(next.captions.highlightColor).toBe('#FF0000')
    expect(next.captions.textColor).toBe('#ABCDEF')
    const cleared = mergeFormatView(next, (() => { const v = projectForFormat(next, 'vertical'); const c = { ...v.captions }; delete c.textColor; return { ...v, captions: c } })(), 'vertical')
    expect(cleared.captions.textColor).toBeUndefined()
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

  it('os campos de legenda de cada formato são os esperados (as cores ficam de fora)', () => {
    expect([...FORMAT_CAPTION_KEYS]).toEqual(['enabled', 'style', 'wordsPerLine', 'position', 'box', 'size', 'positionY', 'uppercase'])
    expect(VERTICAL_CAPTION_DEFAULTS).toEqual({ enabled: true, style: 'highlight', wordsPerLine: 3, position: 'bottom', box: false })
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

describe('zoom do vertical: presets de 1,2 a 1,4×', () => {
  it('o Intenso é o padrão do vertical e as escalas são menores que as do 16:9', () => {
    expect(DEFAULT_VERTICAL_ZOOM_PRESET).toBe('intense')
    expect(VERTICAL_ZOOM_SCALE).toEqual({ subtle: 1.2, moderate: 1.3, intense: 1.4 })
    const h = zoomPresetFor('horizontal', 'intense')
    const v = zoomPresetFor('vertical', 'intense')
    expect(h).toEqual(ZOOM_PRESETS.intense)
    expect(v.scale).toBe(1.4)
    expect(v.lead).toBe(h.lead) // só a escala muda
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

  it('clique abre atividade: o V-B começa 500 ms depois da atividade e termina 400 ms antes da próxima', () => {
    // clique em 5000: atividade [4700, 6500]; clique em 20000: atividade [19700, 21500]; tela quieta entre as duas
    const l = autoVerticalLayouts(input({ clicks: [click(5000), click(20_000)] }))
    expect(l.map((s) => [s.start, s.end])).toEqual([[0, 4700 - 400], [6500 + 500, 19_700 - 400], [21_500 + 500, D]])
    expect(l.every((s) => s.layout === 'stack')).toBe(true)
    expect(l.map((s) => s.id)).toEqual(['layout-v1', 'layout-v2', 'layout-v3'])
  })

  it('quieto por menos de 2 s não vira V-B (o layout não pisca)', () => {
    expect(QUIET_MIN_MS).toBe(2000)
    // cliques a cada 3,5 s: cada pausa de tela é de ~1,7 s
    const clicks = Array.from({ length: 8 }, (_, k) => click(2000 + k * 3500))
    const l = autoVerticalLayouts(input({ clicks, durationMs: 30_000 }))
    expect(l.filter((s) => s.start > 2000 && s.end < 26_000)).toEqual([])
  })

  it('dois V-B separados por menos de 1,5 s viram um só', () => {
    // atividade curta no meio: dois silêncios de tela separados só pela atividade (~1,8 s de janela de clique)
    const l = autoVerticalLayouts(input({ keys: [{ t: 12_000 }] })) // atividade [12000, 13000]
    expect(l).toHaveLength(2) // 13000+500 − (12000−400) = 1,9 s de intervalo: acima de 1,5, não funde
    const closer = autoVerticalLayouts(input({ keys: [{ t: 12_000 }, { t: 12_600 }] }))
    expect(closer.length).toBeLessThanOrEqual(2)
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

  it('gera zooms Intenso de vertical (1,4×) e layouts pela atividade, e marca o preset', () => {
    const d = doc()
    const next = ensureVertical(d, data, { durationMs: D, words: speech(0, D) })
    expect(next).not.toBe(d)
    expect(next.vertical?.zoomPreset).toBe('intense')
    expect(next.vertical!.zooms.length).toBeGreaterThan(0)
    expect(next.vertical!.zooms.every((z) => z.scale === 1.4 && z.origin === 'auto' && z.focus === 'auto')).toBe(true)
    expect(next.vertical!.layouts.length).toBeGreaterThan(0)
    expect(next.vertical!.layout).toBe('screen-focus')
    expect(next.zooms).toEqual(d.zooms) // o 16:9 não é tocado
    expect(next.layouts).toEqual(d.layouts)
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
    expect(store.getState().project.style.defaultLayout).toBe('screen-focus')
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
    expect(store.getState().project.style.defaultLayout).toBe('screen-focus')
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
