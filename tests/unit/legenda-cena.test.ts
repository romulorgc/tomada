import { describe, expect, it } from 'vitest'
import { HOOK_MS, projectForFormat } from '@shared/vertical'
import { createProject } from '@shared/project'
import { HORIZONTAL_1080, VERTICAL_1080, deriveProject, evaluateScene, prepareEvents, type FormatSpec } from '@shared/scene'
import type { CursorSample, Project, Word } from '@shared/types'

const D = 20_000
const WORDS: Word[] = [
  ['Olá,', 400, 883],
  ['pessoal.', 883, 1753],
  ['Hoje', 5000, 5400],
  ['eu', 5400, 5700],
  ['vou', 5700, 6100],
  ['mostrar.', 6100, 6800]
].map(([text, start, end], i) => ({ i, text: text as string, start: start as number, end: end as number, prob: 1, kind: 'word' as const }))

function doc(over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p1',
    title: 't',
    createdAt: '2026-10-05T12:00:00.000Z',
    sources: {
      screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: D },
      camera: { path: 'media/camera.mp4', w: 640, h: 360, fps: 30, durationMs: D }
    }
  })
  return { ...p, ...over }
}

const cursor: CursorSample[] = Array.from({ length: D / 8 + 1 }, (_, i) => ({ t: i * 8, x: 0.5, y: 0.5 }))
const data = prepareEvents({ cursor, clicks: [], keys: [] }, D)

function sceneAt(project: Project, t: number, format: FormatSpec, words: Word[] | null = WORDS) {
  const view = projectForFormat(project, format.kind)
  const derived = deriveProject(view, data, format, words)
  return evaluateScene(view, derived, t, format)
}

describe('a legenda dentro da cena (a mesma evaluateScene da prévia e da exportação)', () => {
  const on = doc({ captions: { enabled: true, style: 'highlight', wordsPerLine: 3, position: 'bottom', box: false, highlightColor: '#FFD93D' } })

  it('mostra a página e a palavra acesa no instante de SAÍDA; nada antes da primeira palavra nem entre as falas', () => {
    expect(sceneAt(on, 100, HORIZONTAL_1080).captions).toBeNull()
    const s = sceneAt(on, 1000, HORIZONTAL_1080).captions!
    expect(s.words).toEqual(['Olá', 'pessoal']) // o Destaque tira a pontuação de frase
    expect(s.active).toBe(1)
    expect(s.alpha).toBe(1)
    expect(sceneAt(on, 3000, HORIZONTAL_1080).captions).toBeNull() // entre as duas frases
    expect(sceneAt(on, 5200, HORIZONTAL_1080).captions!.active).toBe(0)
  })

  it('o "pop" acontece logo depois de a palavra acender e passa em ~0,5 s', () => {
    const t0 = 883 // "pessoal" acende
    expect(sceneAt(on, t0 + 90, HORIZONTAL_1080).captions!.pop).toBeCloseTo(1.08, 3)
    expect(sceneAt(on, t0 + 700, HORIZONTAL_1080).captions!.pop).toBe(1)
  })

  it('a página entra com fade e sobe um pouco; sai com fade', () => {
    const inn = sceneAt(on, 400 - 60 + 30, HORIZONTAL_1080).captions!
    expect(inn.alpha).toBeGreaterThan(0)
    expect(inn.alpha).toBeLessThan(1)
    expect(inn.dy).toBeGreaterThan(0)
    const out = sceneAt(on, 1753 + 320 - 30, HORIZONTAL_1080).captions!
    expect(out.alpha).toBeLessThan(1)
    expect(out.alpha).toBeGreaterThan(0)
  })

  it('desligada, sem palavras ou sem transcrição: nenhuma legenda', () => {
    expect(sceneAt(doc(), 1000, HORIZONTAL_1080).captions).toBeNull() // o 16:9 vem desligado
    expect(sceneAt(on, 1000, HORIZONTAL_1080, null).captions).toBeNull()
    expect(sceneAt(on, 1000, HORIZONTAL_1080, []).captions).toBeNull()
  })

  it('o tempo é de SAÍDA: com um corte antes, a legenda aparece mais cedo (no instante de origem + corte, a mesma palavra)', () => {
    const cutDoc = doc({
      captions: on.captions,
      cuts: [{ id: 'c1', start: 2000, end: 4500, reason: 'manual', enabled: true }]
    })
    // "Hoje" sai em 5000 − 2500 = 2500 de saída; a cena é pedida em tempo de ORIGEM (5000)
    const s = sceneAt(cutDoc, 5000, HORIZONTAL_1080).captions!
    expect(s.words[0]).toBe('Hoje')
    expect(s.active).toBe(0)
  })

  it('palavra cortada não aparece e o texto corrigido vale', () => {
    const fixed = doc({ captions: on.captions, wordFixes: { '5': 'filmar.' }, cuts: [{ id: 'c1', start: 5420, end: 5800, reason: 'manual', enabled: true }] })
    const s = sceneAt(fixed, 6400, HORIZONTAL_1080).captions!
    expect(s.words).toEqual(['Hoje', 'vou', 'filmar']) // "eu" foi cortada; "mostrar" virou "filmar"
  })

  it('o estilo e o tamanho vêm da visão do formato: o vertical usa o dele e o 16:9 o do documento', () => {
    const both = doc({
      captions: { enabled: true, style: 'natural', wordsPerLine: 4, position: 'bottom', box: true, highlightColor: '#FFD93D' },
      vertical: { layout: 'screen-focus', layouts: [], zooms: [], captions: { enabled: true, style: 'highlight', wordsPerLine: 3, size: 1.2 } }
    })
    const h = sceneAt(both, 1000, HORIZONTAL_1080).captions!
    const v = sceneAt(both, 1000, VERTICAL_1080).captions!
    expect(h.style.style).toBe('natural')
    expect(v.style.style).toBe('highlight')
    expect(v.style.safeY).not.toBeNull() // só o vertical tem a caixa segura
    expect(h.style.safeY).toBeNull()
    expect(v.style.fontPx).toBeCloseTo(92 * 1.2, 6)
  })

  it('a chave identifica trilha + página (o cache de layout do texto não mistura páginas)', () => {
    const a = sceneAt(on, 1000, HORIZONTAL_1080).captions!
    const b = sceneAt(on, 5200, HORIZONTAL_1080).captions!
    expect(a.key).not.toBe(b.key)
  })
})

describe('o título de gancho do vertical', () => {
  const withHook = doc({ vertical: { layout: 'screen-focus', layouts: [], zooms: [], hook: '  Grave sua tela em 1 clique  ' } })

  it('aparece só nos 2 primeiros segundos de SAÍDA, com o texto aparado', () => {
    expect(HOOK_MS).toBe(2000)
    const early = sceneAt(withHook, 500, VERTICAL_1080).hook!
    expect(early.text).toBe('Grave sua tela em 1 clique')
    expect(early.alpha).toBeGreaterThan(0)
    expect(sceneAt(withHook, 1000, VERTICAL_1080).hook!.alpha).toBe(1)
    expect(sceneAt(withHook, 2100, VERTICAL_1080).hook).toBeNull()
    expect(sceneAt(withHook, 9000, VERTICAL_1080).hook).toBeNull()
  })

  it('o tempo do gancho é o de SAÍDA: cortar o começo traz o gancho para o que sobrou do começo', () => {
    const cutStart = doc({ vertical: withHook.vertical!, cuts: [{ id: 'c1', start: 0, end: 3000, reason: 'manual', enabled: true }] })
    expect(sceneAt(cutStart, 3500, VERTICAL_1080).hook).not.toBeNull() // saída = 500 ms
    expect(sceneAt(cutStart, 5500, VERTICAL_1080).hook).toBeNull() // saída = 2500 ms
  })

  it('não existe no 16:9, nem sem texto', () => {
    expect(sceneAt(withHook, 500, HORIZONTAL_1080).hook).toBeNull()
    expect(sceneAt(doc({ vertical: { layout: 'screen-focus', layouts: [], zooms: [], hook: '   ' } }), 500, VERTICAL_1080).hook).toBeNull()
    expect(sceneAt(doc(), 500, VERTICAL_1080).hook).toBeNull()
  })

  it('fica na faixa y 280–440 e na fonte Anton', () => {
    const h = sceneAt(withHook, 1000, VERTICAL_1080).hook!
    expect(h.style.bandTop).toBe(280)
    expect(h.style.bandBottom).toBe(440)
    expect(h.style.fontFamily).toContain('Tomada Anton')
  })
})

describe('o recorte do vertical na cena', () => {
  it('V-A: o recorte da tela tem a proporção 9:16 e fica dentro da fonte; V-C mostra a tela toda e leva o fundo desfocado', () => {
    const a = sceneAt(doc({ vertical: { layout: 'screen-focus', layouts: [], zooms: [] } }), 3000, VERTICAL_1080)
    const src = a.screen!.src
    expect((src.w * 1920) / (src.h * 1080)).toBeCloseTo(1080 / 1920, 3)
    expect(src.x).toBeGreaterThanOrEqual(-1e-9)
    expect(src.x + src.w).toBeLessThanOrEqual(1 + 1e-9)
    expect(a.backdrop).toBeNull()

    const c = sceneAt(doc({ vertical: { layout: 'screen-wide', layouts: [], zooms: [] } }), 3000, VERTICAL_1080)
    expect(c.screen!.src).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(c.backdrop).not.toBeNull()
    expect(c.backdrop!.darken).toBeGreaterThan(0.4)
  })

  it('o zoom do vertical (1,4×) fecha o recorte; sem zoom o recorte é o base', () => {
    const zoom = { id: 'z1', start: 1000, end: 9000, scale: 1.4, focus: 'auto' as const, origin: 'auto' as const }
    const flat = sceneAt(doc({ vertical: { layout: 'screen-focus', layouts: [], zooms: [] } }), 5000, VERTICAL_1080).screen!.src
    const zoomed = sceneAt(doc({ vertical: { layout: 'screen-focus', layouts: [], zooms: [zoom] } }), 5000, VERTICAL_1080).screen!.src
    expect(zoomed.w).toBeCloseTo(flat.w / 1.4, 2)
    expect(zoomed.h).toBeCloseTo(flat.h / 1.4, 2)
  })

  it('o vertical não herda os zooms do 16:9', () => {
    const horizontalZoom = { id: 'hz', start: 1000, end: 9000, scale: 2, focus: 'auto' as const, origin: 'auto' as const }
    const d = doc({ zooms: [horizontalZoom] })
    const flat = sceneAt(doc(), 5000, VERTICAL_1080).screen!.src
    const inVertical = sceneAt(d, 5000, VERTICAL_1080).screen!.src
    expect(inVertical.w).toBeCloseTo(flat.w, 6)
    expect(sceneAt(d, 5000, HORIZONTAL_1080).screen!.src.w).toBeLessThan(0.6) // no 16:9 ele vale
  })
})
