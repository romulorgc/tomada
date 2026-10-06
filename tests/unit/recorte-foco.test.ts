/**
 * Revisão da C1, item 5: clicar na prévia para fixar o foco de um zoom, com o recorte ligado. O foco do zoom é lido no espaço do
 * RECORTE (0..1 dentro dele); o desenho usa a tela gravada. A conversão tem de passar pelo recorte, descontar a barra da moldura
 * de navegador, e o marcador (conversão inversa) tem de cair onde a pessoa clicou.
 */
import { describe, expect, it } from 'vitest'
import { createProject } from '@shared/project'
import { HORIZONTAL_1080, VERTICAL_1080, deriveProject, evaluateScene, focusToPreviewPoint, prepareEvents, previewPointToFocus } from '@shared/scene'
import type { CursorSample, Project, Rect, ScreenCrop } from '@shared/types'

const DURATION = 20_000
const CROP: Rect = { x: 0.1, y: 0.2, w: 0.6, h: 0.6 }
const MANUAL: ScreenCrop = { mode: 'manual', manual: CROP }
const still = (x: number, y: number): CursorSample[] => Array.from({ length: Math.floor(DURATION / 8) + 1 }, (_, i) => ({ t: i * 8, x, y }))
const data = prepareEvents({ cursor: still(0.5, 0.5), clicks: [], keys: [] }, DURATION)

function mk(screenCrop: ScreenCrop | undefined, zooms: Project['zooms'] = []): Project {
  const p = createProject({ title: 'foco', sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: DURATION } } })
  return { ...p, zoomPreset: 'off', zooms, ...(screenCrop ? { screenCrop } : {}) }
}

/** O ponto da prévia (px do canvas) na fração (fx, fy) da PÁGINA do cartão (abaixo da barra, se houver). */
function atPage(screen: { dest: Rect; bar?: { h: number } }, fx: number, fy: number): { x: number; y: number } {
  const barH = screen.bar?.h ?? 0
  return { x: screen.dest.x + fx * screen.dest.w, y: screen.dest.y + barH + fy * (screen.dest.h - barH) }
}

describe('clicar na prévia fixa o foco no espaço do recorte', () => {
  const F = HORIZONTAL_1080

  it('sem recorte: a fração do cartão é o foco', () => {
    const p = mk(undefined)
    const screen = evaluateScene(p, deriveProject(p, data, F), 1000, F).screen!
    const f = previewPointToFocus(screen, atPage(screen, 0.3, 0.4))!
    expect(f.x).toBeCloseTo(0.3, 6)
    expect(f.y).toBeCloseTo(0.4, 6)
  })

  it('com recorte e sem zoom: a fração do cartão é a fração DO RECORTE (não da tela gravada)', () => {
    const p = mk(MANUAL)
    const screen = evaluateScene(p, deriveProject(p, data, F), 1000, F).screen!
    const f = previewPointToFocus(screen, atPage(screen, 0.5, 0.75))!
    expect(f.x).toBeCloseTo(0.5, 6) // na tela gravada seria 0,1 + 0,5 × 0,6 = 0,4
    expect(f.y).toBeCloseTo(0.75, 6) // na tela gravada seria 0,2 + 0,75 × 0,6 = 0,65
  })

  it('com recorte e zoom: os cantos e o centro do cartão caem nos pontos certos do recorte', () => {
    const p = mk(MANUAL, [{ id: 'z', start: 2000, end: 9000, scale: 2, focus: { x: 0.5, y: 0.5 }, origin: 'manual' }])
    const screen = evaluateScene(p, deriveProject(p, data, F), 5000, F).screen!
    // zoom 2 centrado: a janela visível é o miolo do recorte (0,25..0,75)
    const tl = previewPointToFocus(screen, atPage(screen, 0, 0))!
    const mid = previewPointToFocus(screen, atPage(screen, 0.5, 0.5))!
    const br = previewPointToFocus(screen, atPage(screen, 1, 1))!
    expect([tl.x, tl.y]).toEqual([expect.closeTo(0.25, 2), expect.closeTo(0.25, 2)])
    expect([mid.x, mid.y]).toEqual([expect.closeTo(0.5, 2), expect.closeTo(0.5, 2)])
    expect([br.x, br.y]).toEqual([expect.closeTo(0.75, 2), expect.closeTo(0.75, 2)])
  })

  it('com a moldura de navegador: clicar na barra não fixa foco; a página abaixo dela é descontada', () => {
    const p = mk({ ...MANUAL, browserFrame: { enabled: true, domain: 'meusistema.com.br' } })
    const screen = evaluateScene(p, deriveProject(p, data, F), 1000, F).screen!
    expect(screen.bar!.h).toBeGreaterThan(10)
    // no meio da barra
    expect(previewPointToFocus(screen, { x: screen.dest.x + screen.dest.w / 2, y: screen.dest.y + screen.bar!.h / 2 })).toBeNull()
    const f = previewPointToFocus(screen, atPage(screen, 0.25, 0.5))!
    expect(f.x).toBeCloseTo(0.25, 6)
    expect(f.y).toBeCloseTo(0.5, 6)
  })

  it('fora do cartão da tela: nada', () => {
    const p = mk(MANUAL)
    const screen = evaluateScene(p, deriveProject(p, data, F), 1000, F).screen!
    expect(previewPointToFocus(screen, { x: screen.dest.x - 5, y: screen.dest.y + 10 })).toBeNull()
    expect(previewPointToFocus(screen, { x: screen.dest.x + 10, y: screen.dest.y + screen.dest.h + 5 })).toBeNull()
  })

  it('o marcador (conversão inversa) cai onde a pessoa clicou, com recorte, zoom e moldura', () => {
    const cases: { label: string; p: Project; t: number; f: typeof HORIZONTAL_1080 }[] = [
      { label: 'sem recorte', p: mk(undefined), t: 1000, f: F },
      { label: 'recorte', p: mk(MANUAL), t: 1000, f: F },
      { label: 'recorte com zoom', p: mk(MANUAL, [{ id: 'z', start: 2000, end: 9000, scale: 2, focus: { x: 0.5, y: 0.5 }, origin: 'manual' }]), t: 5000, f: F },
      { label: 'recorte com moldura', p: mk({ ...MANUAL, browserFrame: { enabled: true } }), t: 1000, f: F },
      { label: 'vertical com recorte', p: mk(MANUAL), t: 1000, f: VERTICAL_1080 }
    ]
    for (const c of cases) {
      const screen = evaluateScene(c.p, deriveProject(c.p, data, c.f), c.t, c.f).screen!
      for (const [fx, fy] of [[0.2, 0.3], [0.5, 0.5], [0.9, 0.8]] as const) {
        const click = atPage(screen, fx, fy)
        const focus = previewPointToFocus(screen, click)!
        expect(focus, c.label).not.toBeNull()
        const back = focusToPreviewPoint(screen, focus)!
        expect(back.x, c.label).toBeCloseTo(click.x, 4)
        expect(back.y, c.label).toBeCloseTo(click.y, 4)
      }
    }
  })

  it('um foco que está fora da janela visível do zoom não tem marcador', () => {
    const p = mk(MANUAL, [{ id: 'z', start: 2000, end: 9000, scale: 2, focus: { x: 0.5, y: 0.5 }, origin: 'manual' }])
    const screen = evaluateScene(p, deriveProject(p, data, F), 5000, F).screen!
    expect(focusToPreviewPoint(screen, { x: 0.05, y: 0.05 })).toBeNull() // o zoom 2 centrado só enxerga 0,25..0,75
    expect(focusToPreviewPoint(screen, { x: 0.5, y: 0.5 })).not.toBeNull()
  })
})
