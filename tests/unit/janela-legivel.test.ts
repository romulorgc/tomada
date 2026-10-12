/**
 * F2, item 1: o 9:16 legível. O zoom da janela de tela vem da LETRA (28-32 px no quadro final), a janela segue o foco em ease-out de
 * ~0,9 s, fica parada por pelo menos ~4 s (salvo ação forte fora do quadro), não treme, abre para a visão geral por menos de 1 s numa
 * troca de página e a Revisão avisa onde a letra estimada fica abaixo de 22 px.
 */
import { describe, expect, it } from 'vitest'
import { createContentTrack, type ContentSample } from '@shared/content-map'
import { processCursor, type CursorGrid } from '@shared/cursor'
import {
  BODY_TEXT_PX_1080,
  ISSUE_MIN_MS,
  LEGIBLE_MAX_ZOOM,
  LEGIBLE_PROFILES,
  NEAR_CONTENT_MIN,
  OVERVIEW_IN_MS,
  OVERVIEW_OUT_MS,
  TEXT_MIN_PX,
  TEXT_RANGE_PX,
  TEXT_TARGET_PX,
  WINDOW_FORCED_GAP_MS,
  WINDOW_MIN_HOLD_MS,
  WINDOW_MOVE_MS,
  bodyTextPx,
  isFramed,
  legibilityIssues,
  legiblePath,
  legibleStateAt,
  legibleZoom,
  pageChanges,
  placeWindow,
  planLegibleWindow,
  textPxOnFrame,
  type LegibleInput
} from '@shared/legible'
import { createProject } from '@shared/project'
import { VERTICAL_1080, deriveProject, evaluateScene, prepareEvents, projectLegibility } from '@shared/scene'
import { keptRanges, outputToSource, sourceToOutput } from '@shared/timeline'
import type { ClickEvent, LayoutKind } from '@shared/types'
import { projectForFormat } from '@shared/vertical'
import { sampleCameraPath } from '@shared/zoom'

const click = (t: number, x: number, y: number): ClickEvent => ({ t, x, y, button: 'left', upT: t + 80 })
const stillCursor = (x: number, y: number, ms = 60_000): CursorGrid =>
  processCursor(Array.from({ length: Math.floor(ms / 100) + 1 }, (_, i) => ({ t: i * 100, x, y })), [], { durationMs: ms })

/** Página 1920×912: janela da Tela ao centro (quadrado de 912 px), zoom 2,34 → janela de ~21% da largura. */
const SQUARE_VIEW = { w: 912 / 1920, h: 1 }
const base = (over: Partial<LegibleInput> = {}): LegibleInput => ({
  durationMs: 60_000,
  view: SQUARE_VIEW,
  zoom: 2.34,
  overviewZoom: 1,
  profile: LEGIBLE_PROFILES['screen-center']!,
  clicks: [],
  keys: [],
  cursor: stillCursor(0.3, 0.4),
  ...over
})

/** Mapa de conteúdo sintético: uma coluna de texto densa em [x0, x1] × [y0, y1], o resto em branco. */
const sample = (t: number, col: { x0: number; x1: number; y0: number; y1: number } | null, cols = 64, rows = 36): ContentSample => {
  const cells = new Uint8Array(cols * rows)
  if (col) for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (c / cols >= col.x0 && (c + 1) / cols <= col.x1 && r / rows >= col.y0 && (r + 1) / rows <= col.y1) cells[r * cols + c] = 200
  return { t, cols, rows, cells }
}

describe('o tamanho da letra', () => {
  it('estima 13 px por 1080 de altura e a medida do projeto vale mais', () => {
    expect(bodyTextPx({ w: 1920, h: 1080 })).toBe(BODY_TEXT_PX_1080)
    expect(bodyTextPx({ w: 3840, h: 2160 })).toBeCloseTo(26, 5)
    expect(bodyTextPx(null)).toBe(BODY_TEXT_PX_1080)
    expect(bodyTextPx({ w: 1920, h: 1080 }, 17)).toBe(17)
    expect(bodyTextPx({ w: 1920, h: 1080 }, 0)).toBe(BODY_TEXT_PX_1080)
  })

  it('o zoom põe a letra do corpo em 30 px no quadro final (mínimo aceitável 22)', () => {
    // Tela ao centro: 900 px de destino, janela de 912 px de fonte com zoom 1
    const z = legibleZoom({ textSrcPx: 13, destW: 900, baseW: 1920, view: SQUARE_VIEW })
    expect(z).toBeGreaterThan(2)
    expect(textPxOnFrame(13, 900, (SQUARE_VIEW.w * 1920) / z)).toBeCloseTo(TEXT_TARGET_PX, 5)
    expect(TEXT_TARGET_PX).toBeGreaterThanOrEqual(TEXT_RANGE_PX.min)
    expect(TEXT_TARGET_PX).toBeLessThanOrEqual(TEXT_RANGE_PX.max)
    expect(TEXT_MIN_PX).toBe(22)
  })

  it('letra maior na fonte pede menos zoom; o zoom respeita o mínimo do perfil e o teto', () => {
    const small = legibleZoom({ textSrcPx: 13, destW: 900, baseW: 1920, view: SQUARE_VIEW })
    const big = legibleZoom({ textSrcPx: 26, destW: 900, baseW: 3840, view: { w: 912 / 1920 } })
    expect(big).toBeCloseTo(small, 5) // 4K: o dobro de pixels, o dobro de letra: o mesmo zoom
    expect(legibleZoom({ textSrcPx: 60, destW: 900, baseW: 1920, view: SQUARE_VIEW })).toBe(1)
    expect(legibleZoom({ textSrcPx: 60, destW: 900, baseW: 1920, view: SQUARE_VIEW, minZoom: 1.25 })).toBe(1.25)
    expect(legibleZoom({ textSrcPx: 3, destW: 900, baseW: 1920, view: SQUARE_VIEW })).toBe(LEGIBLE_MAX_ZOOM)
  })
})

describe('onde a janela fica', () => {
  const win = { w: SQUARE_VIEW.w / 2.34, h: 1 / 2.34 }
  const profile = LEGIBLE_PROFILES['screen-center']!

  it('o ponto de foco cai dentro da zona segura e a janela cabe na página', () => {
    const c = placeWindow({ x: 0.5, y: 0.5 }, win, profile)
    expect(isFramed({ x: 0.5, y: 0.5 }, { ...c, zoom: 2.34 }, win, profile)).toBe(true)
    const edge = placeWindow({ x: 0.02, y: 0.02 }, win, profile)
    expect(edge.cx).toBeGreaterThanOrEqual(win.w / 2)
    expect(edge.cy).toBeGreaterThanOrEqual(win.h / 2)
    const far = placeWindow({ x: 0.99, y: 0.99 }, win, profile)
    expect(far.cx).toBeLessThanOrEqual(1 - win.w / 2)
    expect(far.cy).toBeLessThanOrEqual(1 - win.h / 2)
  })

  it('com o mapa de conteúdo, a janela vai para onde há texto (dentro do que o ponto permite)', () => {
    const col = sample(0, { x0: 0.5, x1: 0.8, y0: 0, y1: 1 })
    const track = createContentTrack([col], null)!
    const density = (r: { x: number; y: number; w: number; h: number }): number => track.densityIn(0, r)
    const withMap = placeWindow({ x: 0.45, y: 0.5 }, win, profile, density)
    const withoutMap = placeWindow({ x: 0.45, y: 0.5 }, win, profile)
    // o cursor parado na margem em branco, ao lado da coluna: a janela se desloca para ela
    expect(withMap.cx).toBeGreaterThan(withoutMap.cx)
    expect(density({ x: withMap.cx - win.w / 2, y: withMap.cy - win.h / 2, w: win.w, h: win.h })).toBeGreaterThan(0.2)
  })

  it('numa área em branco longe de tudo, a janela migra para o conteúdo mais próximo em vez de mostrar o vazio', () => {
    const track = createContentTrack([sample(0, { x0: 0.1, x1: 0.35, y0: 0.1, y1: 0.9 })], null)!
    const density = (r: { x: number; y: number; w: number; h: number }): number => track.densityIn(0, r)
    const c = placeWindow({ x: 0.85, y: 0.5 }, win, profile, density)
    expect(density({ x: c.cx - win.w / 2, y: c.cy - win.h / 2, w: win.w, h: win.h })).toBeGreaterThan(0.1)
  })

  it('V-E: a parte de cima da janela (acima da cabeça) é a que conta para o conteúdo', () => {
    const ve = LEGIBLE_PROFILES.greenscreen!
    expect(ve.visibleFrac).toBeLessThan(1)
    expect(ve.anchorY).toBeLessThan(0.5)
    expect(ve.safeY[1]).toBeLessThanOrEqual(0.5) // o foco fica acima da cabeça
  })
})

describe('o movimento da janela', () => {
  it('foco já enquadrado: a janela não se mexe (página parada)', () => {
    const plan = planLegibleWindow(base({ clicks: [click(2000, 0.3, 0.4), click(9000, 0.31, 0.41), click(20_000, 0.3, 0.42)] }))
    expect(plan.moves).toBe(0)
    expect(plan.keys).toHaveLength(1)
  })

  it('ação forte fora da janela: move em ease-out de ~0,9 s, começando um pouco antes da ação', () => {
    const plan = planLegibleWindow(base({ clicks: [click(2000, 0.3, 0.4), click(10_000, 0.85, 0.5)] }))
    const move = plan.keys.find((k) => k.reason === 'focus')!
    expect(move).toBeDefined()
    expect(move.t1 - move.t0).toBe(WINDOW_MOVE_MS)
    expect(move.t0).toBeLessThan(10_000)
    expect(move.t0).toBeGreaterThanOrEqual(10_000 - 400)
    // ease-out: na metade do tempo já andou mais de 80% (a curva cúbica de saída)
    const mid = legibleStateAt(plan, move.t0 + (move.t1 - move.t0) / 2)
    const progress = (mid.cx - move.from.cx) / (move.to.cx - move.from.cx)
    expect(progress).toBeGreaterThan(0.8)
    expect(legibleStateAt(plan, move.t1 + 50).cx).toBeCloseTo(move.to.cx, 6)
  })

  it('cliques fortes seguidos respeitam o intervalo mínimo de 1,6 s entre movimentos', () => {
    const plan = planLegibleWindow(base({ clicks: [click(2000, 0.3, 0.4), click(4000, 0.6, 0.4), click(4400, 0.9, 0.4), click(4900, 0.1, 0.4)] }))
    const starts = plan.keys.filter((k) => k.reason !== 'start').map((k) => k.t0)
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(WINDOW_FORCED_GAP_MS - 1)
  })

  it('o cursor parado (ação fraca) só move a janela depois do plateau de ~4 s', () => {
    // clique forte às 5 s à direita; às 6,5 s o cursor pousa e fica parado lá longe, à esquerda (ação fraca): barrada pelo plateau
    const cursor = processCursor(
      Array.from({ length: 400 }, (_, i) => ({ t: i * 100, x: i * 100 < 5000 ? 0.3 : i * 100 < 6400 ? 0.3 : 0.05, y: 0.4 })),
      [],
      { durationMs: 40_000 }
    )
    const plan = planLegibleWindow(base({ clicks: [click(5000, 0.8, 0.4)], cursor }))
    const starts = plan.keys.filter((k) => k.reason !== 'start').map((k) => k.t0)
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(WINDOW_FORCED_GAP_MS - 1)
    // nenhum movimento fraco antes de 4 s depois do forte
    const strong = plan.keys.find((k) => k.t0 > 4000 && k.t0 < 5000)!
    for (const k of plan.keys) if (k !== strong && k.t0 > strong.t0 && k.t0 < strong.t0 + WINDOW_MIN_HOLD_MS - 1) expect.fail(`movimento a ${k.t0 - strong.t0} ms do anterior`)
  })

  it('o plateau conta o tempo de SAÍDA: um corte no meio não encurta a página parada', () => {
    const cuts = [{ start: 3000, end: 9000, enabled: true }]
    const kept = keptRanges(60_000, cuts)
    const plan = planLegibleWindow(
      base({
        kept: undefined,
        clicks: [click(2000, 0.3, 0.4), click(12_000, 0.85, 0.4)],
        toOutput: (t: number) => sourceToOutput(t, kept),
        fromOutput: (o: number) => outputToSource(o, kept)
      } as Partial<LegibleInput>)
    )
    expect(plan.keys.some((k) => k.reason === 'focus')).toBe(true)
  })

  it('não treme: cada movimento é monótono e o caminho nunca sai da página', () => {
    const plan = planLegibleWindow(base({ clicks: [click(2000, 0.3, 0.4), click(10_000, 0.85, 0.5), click(16_000, 0.2, 0.3)] }))
    const path = legiblePath(plan, { durationMs: 40_000, view: SQUARE_VIEW })
    let reversals = 0
    let lastSign = 0
    for (let i = 1; i < path.cx.length; i++) {
      const d = path.cx[i]! - path.cx[i - 1]!
      const sign = Math.abs(d) < 1e-9 ? 0 : Math.sign(d)
      if (sign !== 0 && lastSign !== 0 && sign !== lastSign) reversals++
      if (sign !== 0) lastSign = sign
      const w = SQUARE_VIEW.w / path.scale[i]!
      expect(path.cx[i]!).toBeGreaterThanOrEqual(w / 2 - 1e-9)
      expect(path.cx[i]!).toBeLessThanOrEqual(1 - w / 2 + 1e-9)
    }
    // vai para a direita e depois para a esquerda: uma volta só (nada de vaivém)
    expect(reversals).toBeLessThanOrEqual(1)
  })

  it('o cursor que se afasta e fica fora da janela por muito tempo também move (sem ficar parado)', () => {
    const cursor = processCursor(Array.from({ length: 300 }, (_, i) => ({ t: i * 100, x: i * 100 < 3000 ? 0.3 : 0.3 + Math.min(0.5, (i * 100 - 3000) / 6000), y: 0.4 })), [], { durationMs: 30_000 })
    const plan = planLegibleWindow(base({ cursor, durationMs: 30_000 }))
    expect(plan.keys.some((k) => k.reason === 'focus')).toBe(true)
  })

  it('depois do fim do vídeo de saída nada se move', () => {
    const plan = planLegibleWindow(base({ clicks: [click(2000, 0.3, 0.4), click(50_000, 0.85, 0.5)], endMs: 40_000 }))
    expect(plan.keys.every((k) => k.t0 < 40_000)).toBe(true)
  })
})

describe('troca de página', () => {
  const cols = { x0: 0.1, x1: 0.5, y0: 0.1, y1: 0.9 }
  const map = [sample(0, cols), sample(1000, cols), sample(2000, cols), sample(3000, { x0: 0.5, x1: 0.9, y0: 0.1, y1: 0.9 }), sample(4000, { x0: 0.5, x1: 0.9, y0: 0.1, y1: 0.9 })]

  it('detecta a troca (variação grande do mapa) e uma sequência de variações conta uma vez, quando assenta', () => {
    expect(pageChanges(map)).toEqual([3000])
    const run = [sample(0, cols), sample(1000, { x0: 0.2, x1: 0.6, y0: 0.1, y1: 0.9 }), sample(2000, { x0: 0.4, x1: 0.8, y0: 0.1, y1: 0.9 }), sample(3000, { x0: 0.5, x1: 0.9, y0: 0.1, y1: 0.9 })]
    expect(pageChanges(run)).toHaveLength(1)
    expect(pageChanges([sample(0, cols), sample(1000, cols)])).toEqual([])
    expect(pageChanges(undefined)).toEqual([])
  })

  it('abre para a visão geral por menos de 1 s e volta a aproximar na página nova', () => {
    const bigMap = [sample(0, cols), sample(1000, cols), sample(10_000, { x0: 0.5, x1: 0.9, y0: 0.1, y1: 0.9 })]
    const plan = planLegibleWindow(base({ contentMap: bigMap, content: createContentTrack(bigMap, null), cursor: stillCursor(0.3, 0.5, 30_000), durationMs: 30_000 }))
    expect(plan.overviews).toBe(1)
    const open = plan.keys.find((k) => k.reason === 'overview')!
    const close = plan.keys[plan.keys.indexOf(open) + 1]!
    expect(open.to.zoom).toBe(1)
    expect(close.to.zoom).toBeCloseTo(2.34, 6)
    expect(open.t1 - open.t0).toBe(OVERVIEW_IN_MS)
    expect(close.t1 - close.t0).toBe(OVERVIEW_OUT_MS)
    // o tempo em que a letra fica abaixo do alvo (abertura + segura + volta) é menor que 1,3 s; o aviso ignora o que dura menos que isso
    expect(close.t1 - open.t0).toBeLessThan(1300)
    // a janela nova mostra a coluna da página nova
    expect(close.to.cx).toBeGreaterThan(0.45)
  })

  it('o perfil do V-E, com pouca diferença entre o zoom legível e a visão geral, não abre (não se veria)', () => {
    const bigMap = [sample(0, cols), sample(1000, cols), sample(10_000, { x0: 0.5, x1: 0.9, y0: 0.1, y1: 0.9 })]
    const plan = planLegibleWindow(base({ contentMap: bigMap, content: createContentTrack(bigMap, null), zoom: 1.05, durationMs: 30_000 }))
    expect(plan.overviews).toBe(0)
  })
})

describe('o aviso da Revisão', () => {
  const kept = [{ start: 0, end: 10_000 }]

  it('aponta os trechos com letra < 22 px e ignora o que dura menos de 1,5 s (a visão geral é de propósito)', () => {
    const issues = legibilityIssues({
      kept,
      textPxAt: (t) => ({ textPx: t >= 4000 && t < 8000 ? 14 : 30, layout: 'screen-center' as LayoutKind })
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ startMs: 4000, endMs: 8000, textPx: 14, layout: 'screen-center' })
    const especificação = legibilityIssues({ kept, textPxAt: (t) => ({ textPx: t >= 4000 && t < 4750 ? 12 : 30, layout: 'stack' as LayoutKind }) })
    expect(especificação).toEqual([])
    expect(ISSUE_MIN_MS).toBe(1500)
  })

  it('layouts diferentes viram avisos separados; sem página não há aviso', () => {
    const issues = legibilityIssues({ kept, textPxAt: (t) => (t < 5000 ? { textPx: 10, layout: 'screen-wide' as LayoutKind } : { textPx: 9, layout: 'stack' as LayoutKind }) })
    expect(issues.map((i) => i.layout)).toEqual(['screen-wide', 'stack'])
    expect(legibilityIssues({ kept, textPxAt: () => null })).toEqual([])
  })

  it('na cena: V-C (tela inteira, ~7 px) é apontado e Tela ao centro e V-E não', () => {
    const durationMs = 12_000
    const data = prepareEvents({ cursor: Array.from({ length: 121 }, (_, i) => ({ t: i * 100, x: 0.5, y: 0.5 })), clicks: [], keys: [] }, durationMs)
    const mk = (layout: LayoutKind) => {
      const p = createProject({ title: 'x', sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs }, camera: { path: 'media/camera.mp4', w: 1920, h: 1080, fps: 30, durationMs } } })
      p.vertical = { layout, layouts: [], zooms: [], zoomPreset: 'off' }
      const view = projectForFormat(p, 'vertical')
      return { view, derived: deriveProject(view, data, VERTICAL_1080) }
    }
    const wide = mk('screen-wide')
    const issues = projectLegibility(wide.view, wide.derived)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.textPx).toBeLessThan(TEXT_MIN_PX)
    expect(issues[0]!.layout).toBe('screen-wide')
    for (const layout of ['screen-center', 'stack', 'greenscreen', 'greenscreen-corner'] as const) {
      const m = mk(layout)
      expect(projectLegibility(m.view, m.derived), layout).toEqual([])
    }
  })
})

describe('mesma regra na prévia e na exportação', () => {
  it('a cena do V-E e da Tela ao centro lê o MESMO caminho que o plano (a prévia e o exportador chamam deriveProject + evaluateScene)', () => {
    const durationMs = 20_000
    const data = prepareEvents({ cursor: Array.from({ length: 201 }, (_, i) => ({ t: i * 100, x: 0.3, y: 0.4 })), clicks: [click(3000, 0.3, 0.4), click(12_000, 0.85, 0.5)], keys: [] }, durationMs)
    const p = createProject({ title: 'x', sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs }, camera: { path: 'media/camera.mp4', w: 1920, h: 1080, fps: 30, durationMs } } })
    p.vertical = { layout: 'screen-center', layouts: [], zooms: [], zoomPreset: 'off' }
    const view = projectForFormat(p, 'vertical')
    const a = deriveProject(view, data, VERTICAL_1080)
    const b = deriveProject(view, data, VERTICAL_1080)
    for (const t of [1000, 12_500, 13_000, 19_000]) {
      expect(evaluateScene(view, a, t, VERTICAL_1080).screen!.src).toEqual(evaluateScene(view, b, t, VERTICAL_1080).screen!.src)
      const s = sampleCameraPath(a.paths['screen-center']!.path, t)
      expect(s.scale).toBeGreaterThan(2)
    }
  })
})

describe('constantes das referências', () => {
  it('as constantes são as medidas', () => {
    expect(WINDOW_MOVE_MS).toBeGreaterThanOrEqual(800) // 0,89 s do Screen Studio
    expect(WINDOW_MOVE_MS).toBeLessThanOrEqual(1000)
    expect(WINDOW_MIN_HOLD_MS).toBe(4000)
    expect(NEAR_CONTENT_MIN).toBeGreaterThan(0)
  })
})

describe('a janela prefere ter as bordas num vão entre colunas (não corta o texto ao meio)', () => {
  // duas colunas de texto, [0,15 .. 0,40] e [0,55 .. 0,80], com vãos entre elas e nas pontas
  const COLUMNS: [number, number][] = [
    [0.15, 0.4],
    [0.55, 0.8]
  ]
  const density = (r: { x: number; w: number }): number => {
    let covered = 0
    for (const [a, b] of COLUMNS) covered += Math.max(0, Math.min(r.x + r.w, b) - Math.max(r.x, a))
    return (0.8 * covered) / r.w
  }
  const profile = LEGIBLE_PROFILES.stack!
  const edgesDense = (cx: number, w: number): number => {
    const strip = w * 0.04
    return density({ x: cx - w / 2, w: strip }) + density({ x: cx + w / 2 - strip, w: strip })
  }

  it('com o foco dentro da primeira coluna, a janela cobre a coluna inteira com as duas bordas no vão', () => {
    const win = { w: 0.3, h: 1 }
    const placed = placeWindow({ x: 0.3, y: 0.5 }, win, profile, density)
    // a janela centrada no foco (0,30) teria a borda esquerda em cima do começo da coluna (cortando a primeira letra de cada linha)
    expect(edgesDense(0.3, win.w)).toBeGreaterThan(0)
    expect(edgesDense(placed.cx, win.w)).toBe(0)
    expect(placed.cx - win.w / 2).toBeLessThan(0.15)
    expect(placed.cx + win.w / 2).toBeGreaterThan(0.4)
  })

  it('o desconto das bordas tem teto: uma janela com conteúdo nunca perde para uma vazia', () => {
    // texto ralo (0,15) e contínuo de 0,30 a 0,60: toda janela de dentro tem texto nas bordas, a de fora é vazia
    const sparse = (r: { x: number; w: number }): number => (0.15 * Math.max(0, Math.min(r.x + r.w, 0.6) - Math.max(r.x, 0.3))) / r.w
    const win = { w: 0.2, h: 1 }
    const placed = placeWindow({ x: 0.45, y: 0.5 }, win, LEGIBLE_PROFILES.stack!, sparse)
    expect(sparse({ x: placed.cx - win.w / 2, w: win.w })).toBeGreaterThan(0.1)
  })

  it('sem mapa de conteúdo nada muda: a janela fica centrada no foco', () => {
    const win = { w: 0.3, h: 1 }
    const placed = placeWindow({ x: 0.3, y: 0.5 }, win, profile, null)
    expect(placed.cx).toBeCloseTo(0.3, 6)
  })
})
