/**
 * Enquadramento da janela quadrada do 9:16 com o MAPA DE CONTEÚDO da imagem: numa página tipo webmail (barra de ícones à esquerda, barra
 * lateral, coluna central de texto, abas e barra de tarefas), com poucos cliques e o cursor parado na borda esquerda da coluna, a coluna
 * inteira fica dentro da janela (antes saía cortada na borda direita). Vale na Tela ao centro, no V-B e no fundo do V-D.
 */
import { describe, expect, it } from 'vitest'
import { FOCUS_SAFE, actionFocusAt, buildActionFocus } from '@shared/action-focus'
import { createContentTrack, type ContentSample } from '@shared/content-map'
import { processCursor } from '@shared/cursor'
import { createProject } from '@shared/project'
import { VERTICAL_1080, deriveProject, evaluateScene, prepareEvents } from '@shared/scene'
import type { ClickEvent, CursorSample, LayoutKind, Project } from '@shared/types'
import { projectForFormat } from '@shared/vertical'
import { COLUMN, pageSample } from '../helpers/pagina-webmail'

// A tela gravada (1920×1080) e a página do navegador dentro dela (1920×912, como na gravação real): é o recorte que o piloto faz.
const SW = 1920, SH = 1080
const PAGE_RECT = { x: 0, y: 0.1, w: 1, h: 0.844 }
const PW = SW * PAGE_RECT.w, PH = SH * PAGE_RECT.h
const VIEW = { w: PH / PW, h: 1 } // a janela quadrada enxerga 47,5% da largura da página
const DURATION = 12_000
const MARGIN = 0.02

const crop = { at: () => PAGE_RECT }
/** O ponto da página (0-1) no espaço da tela gravada. */
const onScreen = (px: number, py: number) => ({ x: PAGE_RECT.x + px * PAGE_RECT.w, y: PAGE_RECT.y + py * PAGE_RECT.h })
const clickAt = (t: number, px: number, py: number): ClickEvent => ({ t, ...onScreen(px, py), button: 'left', upT: t + 80 })
const parked = (px: number, py: number, ms = DURATION): CursorSample[] => Array.from({ length: Math.floor(ms / 50) + 1 }, (_, i) => ({ t: i * 50, ...onScreen(px, py) }))
const wandering: CursorSample[] = Array.from({ length: DURATION / 50 + 1 }, (_, i) => ({ t: i * 50, x: 0.15 + 0.7 * Math.abs(Math.sin(i / 40)), y: 0.5 }))
/** Um passeio sem pausa: nem cursor parado. */
const drift: CursorSample[] = Array.from({ length: DURATION / 50 + 1 }, (_, i) => ({ t: i * 50, x: 0.1 + (0.8 * i) / (DURATION / 50), y: 0.5 }))

/** O mapa em coordenadas da página: a coluna de e-mail dela vai de COLUMN.start a COLUMN.end da TELA, que como o recorte é de largura cheia é o mesmo. */
const columnMap: ContentSample[] = [pageSample(0)]
const track = (map: ContentSample[] = columnMap) => createContentTrack(map, crop)
const grid = (samples: CursorSample[]) => processCursor(samples.map((s) => ({ ...s, x: (s.x - PAGE_RECT.x) / PAGE_RECT.w, y: (s.y - PAGE_RECT.y) / PAGE_RECT.h })), [], { durationMs: DURATION })
const pageClick = (c: ClickEvent): ClickEvent => ({ ...c, x: (c.x - PAGE_RECT.x) / PAGE_RECT.w, y: (c.y - PAGE_RECT.y) / PAGE_RECT.h })

/** O que a janela mostra de lado a lado (0-1 da página) quando o centro é `cx`. */
const frame = (cx: number) => ({ left: cx - VIEW.w / 2, right: cx + VIEW.w / 2 })
const contains = (cx: number, a: number, b: number, margin = MARGIN) => frame(cx).left <= a - margin + 1e-9 && frame(cx).right >= b + margin - 1e-9

describe('a coluna do e-mail fica inteira na janela', () => {
  // poucos cliques, todos na metade esquerda da coluna, e o cursor parado na borda esquerda dela
  const clicks = [clickAt(1500, 0.44, 0.35), clickAt(3500, 0.47, 0.5), clickAt(7000, 0.43, 0.7)].map(pageClick)
  const cursor = grid(parked(0.42, 0.4))

  it('sem o mapa de conteúdo a janela segue só as ações e corta a coluna na borda direita (o defeito)', () => {
    const steps = buildActionFocus({ clicks, keys: [], cursor, view: VIEW })!
    for (const t of [500, 4000, 9000]) expect(contains(actionFocusAt(steps, t).cx, COLUMN.start, COLUMN.end, 0), `sem mapa, t=${t}`).toBe(false)
  })

  it('com o mapa a coluna inteira, com folga dos dois lados, fica dentro o tempo todo, sem a janela sair do lugar', () => {
    const steps = buildActionFocus({ clicks, keys: [], cursor, view: VIEW, content: track() })!
    expect(steps).toHaveLength(1)
    for (const t of [0, 500, 1500, 4000, 7000, 11_000]) {
      const { cx } = actionFocusAt(steps, t)
      expect(contains(cx, COLUMN.start, COLUMN.end), `t=${t} cx=${cx.toFixed(3)}`).toBe(true)
      // e as ações ficam dentro da faixa central, como sempre
      for (const c of clicks) if (Math.abs(c.t - t) < 600) expect(Math.abs(c.x - cx)).toBeLessThanOrEqual((VIEW.w / 2) * FOCUS_SAFE + 1e-9)
    }
  })

  it('o bloco fica centrado na janela (não só dentro dela)', () => {
    const { cx } = actionFocusAt(buildActionFocus({ clicks, keys: [], cursor, view: VIEW, content: track() })!, 4000)
    expect(Math.abs(cx - (COLUMN.start + COLUMN.end) / 2)).toBeLessThan(0.03)
  })
})

describe('sem ação forte a janela fica no bloco principal', () => {
  it('só passeio do cursor: antes seguia o cursor (null), agora centra na coluna', () => {
    const cursor = grid(drift)
    expect(buildActionFocus({ clicks: [], keys: [], cursor, view: VIEW })).toBeNull()
    const steps = buildActionFocus({ clicks: [], keys: [], cursor, view: VIEW, content: track() })!
    expect(steps).toHaveLength(1)
    expect(Math.abs(steps[0]!.cx - (COLUMN.start + COLUMN.end) / 2)).toBeLessThan(0.03)
  })

  it('cursor parado na barra lateral (ação fraca) não puxa a janela para ela', () => {
    const cursor = grid(parked(0.12, 0.4))
    const steps = buildActionFocus({ clicks: [], keys: [], cursor, view: VIEW, content: track() })!
    expect(steps).toHaveLength(1)
    expect(contains(steps[0]!.cx, COLUMN.start, COLUMN.end)).toBe(true)
  })

  it('tela sem nada (página lisa) e sem ação: nada a enquadrar', () => {
    const blank: ContentSample = { t: 0, cols: 64, rows: 36, cells: new Uint8Array(64 * 36) }
    expect(buildActionFocus({ clicks: [], keys: [], cursor: grid(drift), view: VIEW, content: track([blank]) })).toBeNull()
  })
})

describe('a ação forte manda quando está fora do bloco', () => {
  it('um clique na barra lateral enquadra o clique; o clique seguinte na coluna traz a coluna de volta', () => {
    const clicks = [clickAt(1500, 0.5, 0.4), clickAt(6000, 0.12, 0.4), clickAt(10_000, 0.5, 0.6)].map(pageClick)
    const steps = buildActionFocus({ clicks, keys: [], cursor: grid(parked(0.5, 0.4)), view: VIEW, content: track() })!
    expect(contains(actionFocusAt(steps, 3000).cx, COLUMN.start, COLUMN.end)).toBe(true)
    const atSidebar = actionFocusAt(steps, 7500).cx
    expect(Math.abs(clicks[1]!.x - atSidebar)).toBeLessThanOrEqual((VIEW.w / 2) * FOCUS_SAFE + 1e-9)
    expect(contains(actionFocusAt(steps, 11_500).cx, COLUMN.start, COLUMN.end)).toBe(true)
  })
})

describe('a imagem muda', () => {
  it('da lista de e-mails (larga) para a coluna de um e-mail aberto: a janela se ajusta à coluna, sem esperar outro clique', () => {
    const map = [pageSample(0, { column: null }), pageSample(5000)]
    const clicks = [clickAt(1500, 0.5, 0.3), clickAt(3000, 0.55, 0.4)].map(pageClick)
    const steps = buildActionFocus({ clicks, keys: [], cursor: grid(parked(0.5, 0.4)), view: VIEW, content: track(map) })!
    expect(contains(actionFocusAt(steps, 9000).cx, COLUMN.start, COLUMN.end)).toBe(true)
    // a janela não anda antes da imagem mudar (o bloco largo não cabe e não há ação a seguir)
    expect(actionFocusAt(steps, 3500).cx).toBeCloseTo(actionFocusAt(steps, 1000).cx, 6)
  })

  it('a página ainda em branco no começo: enquadra pelas ações como antes e, quando o conteúdo aparece, ajusta a coluna', () => {
    const blank: ContentSample = { t: 0, cols: 64, rows: 36, cells: new Uint8Array(64 * 36) }
    const clicks = [clickAt(1000, 0.44, 0.35), clickAt(2500, 0.47, 0.5)].map(pageClick)
    const input = { clicks, keys: [], cursor: grid(parked(0.42, 0.4)), view: VIEW }
    const withMap = buildActionFocus({ ...input, content: track([blank, pageSample(3000)]) })!
    const legacy = buildActionFocus(input)!
    expect(withMap[0]!.cx).toBeCloseTo(legacy[0]!.cx, 6)
    expect(contains(actionFocusAt(withMap, 6000).cx, COLUMN.start, COLUMN.end)).toBe(true)
  })

  it('a janela só anda quando ganha bastante e respeita a permanência mínima', () => {
    const map = [pageSample(0), pageSample(1000, { column: { x0: 0.46, x1: 0.78, y0: 0.12, y1: 0.9 } }), pageSample(2000)]
    const steps = buildActionFocus({ clicks: [], keys: [], cursor: grid(wandering), view: VIEW, content: track(map) })!
    for (let i = 1; i < steps.length; i++) expect(steps[i]!.t - steps[i - 1]!.t).toBeGreaterThanOrEqual(1600 - 1e-6)
  })
})

describe('na cena: Tela ao centro, V-B e o fundo do V-D', () => {
  const screen = { path: 'media/screen.mp4', w: SW, h: SH, fps: 30, durationMs: DURATION }
  const camera = { path: 'media/camera.mp4', w: 3840, h: 2160, fps: 30, durationMs: DURATION }
  const raw = { cursor: parked(0.42, 0.4), clicks: [clickAt(1500, 0.44, 0.35), clickAt(3500, 0.47, 0.5), clickAt(7000, 0.43, 0.7)] }
  const mk = (layout: LayoutKind): Project => {
    const p = createProject({ title: 'Webmail', sources: { screen, camera } })
    p.zoomPreset = 'off'
    p.screenCrop = { mode: 'manual', manual: PAGE_RECT }
    p.style.defaultLayout = layout
    p.vertical = { layout, layouts: [], zooms: [], zoomPreset: 'off' }
    return p
  }
  /** O recorte da fonte que a cena mostra em `t`: de onde a onde, na largura da página (0-1). */
  const shown = (layout: LayoutKind, withMap: boolean, t: number) => {
    const p = projectForFormat(mk(layout), 'vertical')
    const data = prepareEvents({ ...raw, keys: [], ...(withMap ? { contentMap: columnMap } : {}) }, DURATION)
    const src = evaluateScene(p, deriveProject(p, data, VERTICAL_1080), t, VERTICAL_1080).screen!.src
    return { left: (src.x - PAGE_RECT.x) / PAGE_RECT.w, right: (src.x + src.w - PAGE_RECT.x) / PAGE_RECT.w }
  }

  it.each(['screen-center', 'stack', 'presenter'] as const)('%s: com o mapa a coluna inteira fica dentro em todos os instantes; sem ele ela é cortada', (layout) => {
    for (const t of [500, 2500, 5000, 9000]) {
      const withMap = shown(layout, true, t)
      expect(withMap.left, `${layout} t=${t}`).toBeLessThanOrEqual(COLUMN.start - MARGIN + 1e-3)
      expect(withMap.right, `${layout} t=${t}`).toBeGreaterThanOrEqual(COLUMN.end + MARGIN - 1e-3)
    }
    expect(shown(layout, false, 5000).right, `${layout} sem o mapa`).toBeLessThan(COLUMN.end)
  })
})
