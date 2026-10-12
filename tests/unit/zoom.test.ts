import { describe, expect, it } from 'vitest'
import { processCursor, type CursorGrid } from '@shared/cursor'
import {
  DEAD_ZONE,
  MAX_ZOOM_SCALE,
  VERTICAL_ZOOM_MAX_PER_MIN,
  ZOOM_CAP_WINDOW_MS,
  ZOOM_PRESETS,
  computeCameraPath,
  findDwells,
  findTypingBursts,
  generateAutoZooms,
  isSweeping,
  limitPerMinute,
  mergeAutoZooms,
  sampleCameraPath,
  visibleRect,
  zoomPresetFor,
  type CameraPath
} from '@shared/zoom'
import { ZOOM_MOTION_MS, ZOOM_SCALE_SPRING } from '@shared/spring'
import { cropView } from '@shared/vertical'
import type { ClickEvent, CursorSample, KeyEvent, Zoom } from '@shared/types'

const click = (t: number, x = 0.5, y = 0.5, out = false): ClickEvent => ({ t, x, y, button: 'left', ...(out ? { out: true } : {}) })
/** Trajetória linear por partes, amostrada a ~120 Hz como o rastreador real. */
const cur = (points: [number, number, number][], durationMs: number): CursorGrid => {
  const samples: CursorSample[] = []
  for (let t = 0; t <= durationMs; t += 8) {
    let i = 0
    while (i + 1 < points.length - 1 && points[i + 1]![0] <= t) i++
    const [t0, x0, y0] = points[i]!
    const [t1, x1, y1] = points[Math.min(i + 1, points.length - 1)]!
    const u = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0
    samples.push({ t, x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u })
  }
  return processCursor(samples, [], { durationMs })
}
const still = (x: number, y: number, durationMs: number): CursorGrid => {
  const samples: CursorSample[] = []
  for (let t = 0; t <= durationMs; t += 8) samples.push({ t, x, y })
  return processCursor(samples, [], { durationMs })
}
const keysAt = (start: number, n: number, gap: number): KeyEvent[] => Array.from({ length: n }, (_, i) => ({ t: start + i * gap }))

describe('generateAutoZooms: presets e cliques de gabarito', () => {
  const grid = still(0.5, 0.5, 60_000)

  it('um clique abre [t − lead, t + hold] com a escala do preset (cada preset)', () => {
    for (const id of ['subtle', 'moderate', 'intense'] as const) {
      const p = ZOOM_PRESETS[id]
      const z = generateAutoZooms({ clicks: [click(10_000)], keys: [], cursor: grid, duration: 60_000, preset: ZOOM_PRESETS[id] })
      expect(z).toHaveLength(1)
      expect(z[0]).toMatchObject({ start: 10_000 - p.lead, end: 10_000 + p.hold, scale: p.scale, focus: 'auto', origin: 'auto' })
    }
  })

  it('a tabela está em ms e vem dos vídeos reais medidos (E1): 1,5×, intervalo mínimo de 6 s no padrão, teto de 5 por minuto', () => {
    expect(ZOOM_PRESETS.subtle).toEqual({ lead: 800, hold: 2000, mergeGap: 6000, scale: 1.3, minGap: 8000, maxPerMin: 3 })
    expect(ZOOM_PRESETS.moderate).toEqual({ lead: 600, hold: 1500, mergeGap: 6000, scale: 1.5, minGap: 6000, maxPerMin: 5 })
    expect(ZOOM_PRESETS.intense).toEqual({ lead: 500, hold: 1200, mergeGap: 3500, scale: 1.8, minGap: 3500, maxPerMin: 8 })
    // o Sutil < Moderado < Intenso em escala, em frequência e na pressa
    expect(ZOOM_PRESETS.subtle.scale).toBeLessThan(ZOOM_PRESETS.moderate.scale)
    expect(ZOOM_PRESETS.moderate.scale).toBeLessThan(ZOOM_PRESETS.intense.scale)
    expect(ZOOM_PRESETS.subtle.maxPerMin).toBeLessThan(ZOOM_PRESETS.moderate.maxPerMin)
    expect(ZOOM_PRESETS.moderate.maxPerMin).toBeLessThan(ZOOM_PRESETS.intense.maxPerMin)
    expect(ZOOM_PRESETS.moderate.minGap).toBeGreaterThan(ZOOM_PRESETS.intense.minGap)
  })

  it('fusão: janelas separadas por menos que o intervalo viram um zoom só (moderado: 6 s)', () => {
    // janelas [4400,6500] e [N-600, N+1500]: intervalo = N − 600 − 6500
    const merged = generateAutoZooms({ clicks: [click(5000), click(12_000)], keys: [], cursor: grid, duration: 60_000, preset: ZOOM_PRESETS.moderate })
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ start: 4400, end: 13_500 })
    const apart = generateAutoZooms({ clicks: [click(5000), click(13_100)], keys: [], cursor: grid, duration: 60_000, preset: ZOOM_PRESETS.moderate })
    expect(apart).toHaveLength(2) // intervalo exatamente 6000: não funde
    expect(apart[1]).toMatchObject({ start: 12_500, end: 14_600 })
  })

  it('cadeia de cliques vira um único segmento que segue o cursor', () => {
    const clicks = [5000, 6500, 8000, 9500].map((t) => click(t))
    const z = generateAutoZooms({ clicks, keys: [], cursor: grid, duration: 60_000, preset: ZOOM_PRESETS.moderate })
    expect(z).toHaveLength(1)
    expect(z[0]).toMatchObject({ start: 4400, end: 11_000, focus: 'auto' })
  })

  it('intervalo mínimo entre zooms: o que passa de mergeGap mas fica abaixo de minGap também funde', () => {
    const preset = { lead: 500, hold: 1400, mergeGap: 500, scale: 1.7, minGap: 3000, maxPerMin: 99 }
    const z = generateAutoZooms({ clicks: [click(5000), click(9800)], keys: [], cursor: grid, duration: 60_000, preset })
    expect(z).toHaveLength(1) // intervalo 2900 < 3000
    const far = generateAutoZooms({ clicks: [click(5000), click(10_300)], keys: [], cursor: grid, duration: 60_000, preset })
    expect(far).toHaveLength(2)
  })

  it('cliques fora da área e antes do início não abrem zoom; as bordas são limitadas à gravação', () => {
    const z = generateAutoZooms({ clicks: [click(30_000, 0.5, 0.5, true)], keys: [], cursor: grid, duration: 60_000, preset: ZOOM_PRESETS.moderate })
    expect(z).toEqual([])
    const edge = generateAutoZooms({ clicks: [click(100), click(59_900)], keys: [], cursor: grid, duration: 60_000, preset: ZOOM_PRESETS.moderate })
    expect(edge[0]!.start).toBe(0)
    expect(edge[edge.length - 1]!.end).toBe(60_000)
  })

  it('rajada de digitação (≥ 3 teclas com intervalos < 0,8 s) abre janela no ponto do último clique', () => {
    const keys = keysAt(30_000, 8, 140)
    const z = generateAutoZooms({ clicks: [click(10_000, 0.25, 0.7)], keys, cursor: grid, duration: 60_000, preset: ZOOM_PRESETS.moderate })
    expect(z).toHaveLength(2)
    expect(z[1]).toMatchObject({ start: 29_400, end: 30_980 + 1500, focus: { x: 0.25, y: 0.7 } })
  })

  it('digitação logo depois de um clique funde com ele (o foco passa a seguir o cursor)', () => {
    const z = generateAutoZooms({ clicks: [click(29_000, 0.4, 0.4)], keys: keysAt(30_000, 6, 200), cursor: grid, duration: 60_000, preset: ZOOM_PRESETS.moderate })
    expect(z).toHaveLength(1)
    expect(z[0]!.focus).toBe('auto')
    expect(z[0]!.start).toBe(28_400)
  })

  it('poucas teclas ou muito espaçadas não são rajada', () => {
    expect(findTypingBursts(keysAt(1000, 2, 100))).toEqual([])
    expect(findTypingBursts(keysAt(1000, 5, 800))).toEqual([]) // intervalo = 800 (não < 800)
    expect(findTypingBursts(keysAt(1000, 5, 799))).toHaveLength(1)
    const two = [...keysAt(1000, 4, 100), ...keysAt(9000, 3, 100)]
    expect(findTypingBursts(two)).toEqual([
      { first: 1000, last: 1300 },
      { first: 9000, last: 9200 }
    ])
    const z = generateAutoZooms({ clicks: [], keys: keysAt(20_000, 2, 100), cursor: grid, duration: 60_000, preset: ZOOM_PRESETS.moderate })
    expect(z).toEqual([])
  })

  it('dwell: só quando a gravação não tem nenhum clique', () => {
    // cursor passa por 2 s e para 1,5 s em (0,3, 0,4), depois vai embora
    const grid2 = cur(
      [
        [0, 0.9, 0.9],
        [3000, 0.3, 0.4],
        [4500, 0.3, 0.4],
        [5000, 0.8, 0.2],
        [10_000, 0.8, 0.2]
      ],
      10_000
    )
    const dwellOnly = generateAutoZooms({ clicks: [], keys: [], cursor: grid2, duration: 10_000, preset: ZOOM_PRESETS.moderate })
    expect(dwellOnly.length).toBeGreaterThanOrEqual(1)
    const first = dwellOnly[0]!
    expect(first.focus).toMatchObject({ x: expect.closeTo(0.3, 1), y: expect.closeTo(0.4, 1) })
    expect(first.start).toBeLessThan(3200)
    expect(first.end).toBeGreaterThan(3000)

    const withClick = generateAutoZooms({ clicks: [click(8000, 0.8, 0.2)], keys: [], cursor: grid2, duration: 10_000, preset: ZOOM_PRESETS.moderate })
    expect(withClick).toHaveLength(1)
    expect(withClick[0]!.start).toBe(7400) // só o zoom do clique; o dwell não entra
  })

  it('dwell mede 450–2600 ms, raio 0,02, e ignora o cursor estacionado desde o começo', () => {
    expect(findDwells(still(0.5, 0.5, 400))).toEqual([]) // curto demais
    const long = findDwells(cur([[0, 0.1, 0.1], [1000, 0.6, 0.6], [6000, 0.6, 0.6]], 6000))
    expect(long).toHaveLength(1)
    expect(long[0]!.end - long[0]!.start).toBeLessThanOrEqual(2600)
    // parado desde o primeiro instante: ignorado
    expect(findDwells(still(0.5, 0.5, 5000))).toEqual([])
    // movimento dentro do raio conta como parado
    const jitter = processCursor(
      [
        ...Array.from({ length: 125 }, (_, i): CursorSample => ({ t: i * 8, x: 0.9 - (0.5 * i) / 125, y: 0.4 })),
        ...Array.from({ length: 200 }, (_, i): CursorSample => ({ t: 1000 + i * 8, x: 0.4 + 0.01 * Math.sin(i), y: 0.4 }))
      ],
      [],
      { durationMs: 3000, antiTremor: false }
    )
    expect(findDwells(jitter).length).toBeGreaterThanOrEqual(1)
  })

  it('ids únicos, ordem por início e mergeAutoZooms preserva os manuais', () => {
    const clicks = [3000, 12_000, 25_000].map((t) => click(t))
    const z = generateAutoZooms({ clicks, keys: [], cursor: grid, duration: 60_000, preset: ZOOM_PRESETS.moderate })
    expect(new Set(z.map((x) => x.id)).size).toBe(z.length)
    expect([...z].sort((a, b) => a.start - b.start)).toEqual(z)
    const manual: Zoom = { id: 'm1', start: 40_000, end: 42_000, scale: 2, focus: { x: 0.1, y: 0.1 }, origin: 'manual' }
    const merged = mergeAutoZooms([manual, ...z], generateAutoZooms({ clicks: [click(50_000)], keys: [], cursor: grid, duration: 60_000, preset: ZOOM_PRESETS.subtle }))
    expect(merged.map((m) => m.origin)).toEqual(['manual', 'auto'])
    expect(merged[0]).toEqual(manual)
  })

  it('TETO por minuto: em nenhuma janela de 60 s começam mais zooms que o teto do preset', () => {
    // um clique a cada 10 s durante 4 min: sem o teto seriam 24 zooms (as janelas ficam 7,9 s separadas, acima do intervalo mínimo)
    const clicks = Array.from({ length: 24 }, (_, k) => click(5000 + k * 10_000))
    const long = still(0.5, 0.5, 250_000)
    for (const id of ['subtle', 'moderate', 'intense'] as const) {
      const cap = ZOOM_PRESETS[id].maxPerMin
      const z = generateAutoZooms({ clicks, keys: [], cursor: long, duration: 250_000, preset: ZOOM_PRESETS[id] })
      expect(z.length, id).toBeGreaterThan(0)
      for (let i = 0; i + cap < z.length; i++) expect(z[i + cap]!.start - z[i]!.start, `${id}: janela a partir do zoom ${i}`).toBeGreaterThanOrEqual(ZOOM_CAP_WINDOW_MS)
    }
    const moderate = generateAutoZooms({ clicks, keys: [], cursor: long, duration: 250_000, preset: ZOOM_PRESETS.moderate })
    expect(moderate.length).toBeLessThan(24) // o teto tirou alguns dos 24 cliques
    expect(moderate.length).toBeGreaterThanOrEqual(15) // mas não esvaziou: ~5 por minuto
  })

  it('o teto do vertical é 3 por minuto no padrão (2 no Sutil, 5 no Intenso) e a escala é 1,35×', () => {
    expect(VERTICAL_ZOOM_MAX_PER_MIN).toEqual({ subtle: 2, moderate: 3, intense: 5 })
    const v = zoomPresetFor('vertical', 'moderate')
    expect(v).toMatchObject({ scale: 1.35, maxPerMin: 3, lead: ZOOM_PRESETS.moderate.lead, hold: ZOOM_PRESETS.moderate.hold })
    const clicks = Array.from({ length: 12 }, (_, k) => click(5000 + k * 10_000))
    const z = generateAutoZooms({ clicks, keys: [], cursor: still(0.5, 0.5, 130_000), duration: 130_000, preset: v })
    expect(z.every((x) => x.scale === 1.35)).toBe(true)
    for (let i = 0; i + 3 < z.length; i++) expect(z[i + 3]!.start - z[i]!.start).toBeGreaterThanOrEqual(ZOOM_CAP_WINDOW_MS)
    expect(z.length).toBeLessThanOrEqual(9) // 130 s = 3 janelas de 60 s a 3 por janela, no máximo
  })

  it('limitPerMinute: sai o zoom de MENOS peso; no empate, o mais curto e depois o mais tardio; sem teto não limita', () => {
    const w = (start: number, end: number, hits: number) => ({ start, end, hits })
    const three = [w(0, 3000, 1), w(10_000, 13_000, 4), w(20_000, 23_000, 1)]
    expect(limitPerMinute(three, 2)).toEqual([w(0, 3000, 1), w(10_000, 13_000, 4)]) // empate de peso: sai o mais tardio
    expect(limitPerMinute([w(0, 3000, 1), w(10_000, 12_000, 1), w(20_000, 23_000, 3)], 2)).toEqual([w(0, 3000, 1), w(20_000, 23_000, 3)]) // peso igual: sai o mais curto
    expect(limitPerMinute([w(0, 3000, 2), w(10_000, 13_000, 1), w(20_000, 23_000, 5)], 2)).toEqual([w(0, 3000, 2), w(20_000, 23_000, 5)]) // sai o mais leve
    expect(limitPerMinute(three, 3)).toEqual(three)
    for (const none of [0, Infinity, NaN, -1]) expect(limitPerMinute(three, none)).toEqual(three)
    // zooms a 60 s de distância não contam na mesma janela
    expect(limitPerMinute([w(0, 3000, 1), w(60_000, 63_000, 1)], 1)).toHaveLength(2)
  })

  it('duração zero ou sem eventos não gera zoom', () => {
    expect(generateAutoZooms({ clicks: [click(0)], keys: [], cursor: grid, duration: 0, preset: ZOOM_PRESETS.moderate })).toEqual([])
    expect(generateAutoZooms({ clicks: [], keys: [], cursor: grid, duration: 60_000, preset: ZOOM_PRESETS.moderate })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Caminho da câmera

const zoom = (start: number, end: number, scale = 1.7, focus: Zoom['focus'] = 'auto', id = `z${start}`): Zoom => ({ id, start, end, scale, focus, origin: 'auto' })

const maxAbsDiff = (arr: number[]): number => {
  let m = 0
  for (let i = 1; i < arr.length; i++) m = Math.max(m, Math.abs(arr[i]! - arr[i - 1]!))
  return m
}
const maxAbs2nd = (arr: number[]): number => {
  let m = 0
  for (let i = 2; i < arr.length; i++) m = Math.max(m, Math.abs(arr[i]! - 2 * arr[i - 1]! + arr[i - 2]!))
  return m
}

/** Cursor que passeia pela tela de forma suave e determinística. */
function wander(durationMs: number): CursorGrid {
  const samples: CursorSample[] = []
  for (let t = 0; t <= durationMs; t += 8) {
    samples.push({ t, x: 0.5 + 0.4 * Math.sin(t / 2300), y: 0.5 + 0.35 * Math.sin(t / 1700 + 1) })
  }
  return processCursor(samples, [], { durationMs })
}

describe('computeCameraPath', () => {
  const D = 20_000
  const grid = wander(D)
  const zooms = [zoom(2000, 5000), zoom(8000, 9500, 2), zoom(9800, 12_000, 1.5), zoom(15_000, 16_000, 1.7, { x: 0.02, y: 0.98 })]

  it('é determinístico: a mesma entrada dá exatamente o mesmo caminho', () => {
    const a = computeCameraPath({ zooms }, grid, { durationMs: D })
    const b = computeCameraPath({ zooms }, grid, { durationMs: D })
    expect(a).toEqual(b)
    expect(a.t).toHaveLength(Math.floor(D / (1000 / 60)) + 1)
  })

  it('escala sempre em [1, máx] e o retângulo visível sempre dentro da fonte', () => {
    const path = computeCameraPath({ zooms }, grid, { durationMs: D })
    expect(path.maxScale).toBe(2)
    for (let i = 0; i < path.t.length; i++) {
      const sc = path.scale[i]!
      expect(sc).toBeGreaterThanOrEqual(1)
      expect(sc).toBeLessThanOrEqual(2 + 1e-12)
      const r = visibleRect({ scale: sc, cx: path.cx[i]!, cy: path.cy[i]! })
      expect(r.x).toBeGreaterThanOrEqual(-1e-9)
      expect(r.y).toBeGreaterThanOrEqual(-1e-9)
      expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9)
      expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('escala absurda no documento é limitada', () => {
    const path = computeCameraPath({ zooms: [zoom(1000, 9000, 1e9)] }, still(0.5, 0.5, 10_000), { durationMs: 10_000 })
    expect(path.maxScale).toBe(MAX_ZOOM_SCALE)
    expect(Math.max(...path.scale)).toBeLessThanOrEqual(MAX_ZOOM_SCALE)
  })

  it('salto máximo por quadro limitado e SEM degrau de velocidade quando o alvo muda', () => {
    const path = computeCameraPath({ zooms }, grid, { durationMs: D })
    // física da mola: a velocidade máxima de um degrau Δ vale ~Δ·ω0/e ≈ 3,5·Δ por segundo
    expect(maxAbsDiff(path.scale)).toBeLessThan(0.07) // por quadro de 1/60 s (degrau de 1 → 2 em escala)
    expect(maxAbsDiff(path.cx)).toBeLessThan(0.05)
    expect(maxAbsDiff(path.cy)).toBeLessThan(0.05)
    // segunda diferença = variação da velocidade por quadro. Num degrau de alvo Δ a mola acelera
    // (k/m)·Δ/3600 por quadro² (0,025·Δ); um degrau de VELOCIDADE (mola reiniciada) daria ≥ 0,05.
    expect(maxAbs2nd(path.scale)).toBeLessThan(0.03)
    expect(maxAbs2nd(path.cx)).toBeLessThan(0.03)
    expect(maxAbs2nd(path.cy)).toBeLessThan(0.03)
  })

  it('a velocidade é carregada na troca de segmento (escala não reinicia no meio do movimento)', () => {
    // segundo zoom começa 200 ms depois do primeiro com escala maior: a subida continua suave
    const path = computeCameraPath({ zooms: [zoom(1000, 4000, 1.5), zoom(1200, 4000, 2, 'auto', 'b')] }, still(0.5, 0.5, 6000), { durationMs: 6000 })
    for (let i = 1; i < path.scale.length; i++) {
      if (path.t[i]! < 4000) expect(path.scale[i]!).toBeGreaterThanOrEqual(path.scale[i - 1]! - 1e-6)
    }
    expect(maxAbs2nd(path.scale)).toBeLessThan(0.03)
  })

  it('o MOVIMENTO do zoom dura 1,0 s no 16:9 e 0,6 s no vertical (E1): a escala chega a 95% nesse tempo', () => {
    const tt95 = (spring?: Parameters<typeof computeCameraPath>[2]['scaleSpring']): number => {
      const path = computeCameraPath({ zooms: [zoom(2000, 9000, 2)] }, still(0.5, 0.5, 10_000), { durationMs: 10_000, ...(spring ? { scaleSpring: spring } : {}) })
      const i = path.t.findIndex((t, k) => t >= 2000 && path.scale[k]! >= 1.95)
      return path.t[i]! - 2000
    }
    expect(Math.abs(tt95(ZOOM_SCALE_SPRING.horizontal) - ZOOM_MOTION_MS.horizontal)).toBeLessThanOrEqual(25) // passo de 16,7 ms
    expect(Math.abs(tt95(ZOOM_SCALE_SPRING.vertical) - ZOOM_MOTION_MS.vertical)).toBeLessThanOrEqual(25)
    expect(tt95()).toBeLessThan(600) // a mola padrão da câmera continua rápida (o foco segue o cursor)
    expect(tt95(ZOOM_SCALE_SPRING.vertical)).toBeLessThan(tt95(ZOOM_SCALE_SPRING.horizontal))
  })

  it('o movimento mais lento não derruba o resto: segue sem degrau de velocidade e determinístico', () => {
    const o = { durationMs: 20_000, scaleSpring: ZOOM_SCALE_SPRING.horizontal }
    const zs = [zoom(2000, 5000), zoom(8000, 9500, 1.5), zoom(9800, 12_000, 1.5)]
    const a = computeCameraPath({ zooms: zs }, wander(20_000), o)
    expect(computeCameraPath({ zooms: zs }, wander(20_000), o)).toEqual(a)
    expect(maxAbs2nd(a.scale)).toBeLessThan(0.03)
    expect(Math.max(...a.scale)).toBeLessThanOrEqual(1.7 + 1e-9)
  })

  it('a câmera assenta em ~0,4 s: 95% da escala em menos de 0,6 s', () => {
    const path = computeCameraPath({ zooms: [zoom(2000, 8000, 2)] }, still(0.5, 0.5, 10_000), { durationMs: 10_000 })
    let t95 = -1
    for (let i = 0; i < path.t.length; i++) {
      if (path.t[i]! >= 2000 && path.scale[i]! >= 1.95) {
        t95 = path.t[i]! - 2000
        break
      }
    }
    expect(t95).toBeGreaterThan(150)
    expect(t95).toBeLessThan(600)
    // e volta a 1 depois do fim
    expect(sampleCameraPath(path, 9500).scale).toBeCloseTo(1, 2)
  })

  it('zona morta: o cursor dentro da caixa de 50% × 70% da área visível NÃO mexe a câmera', () => {
    // zoom 2: área visível 0,5; zona morta 0,25 × 0,35. Cursor oscila ±0,06 em x e ±0,08 em y em torno de (0,5, 0,5)
    const samples: CursorSample[] = []
    for (let t = 0; t <= 8000; t += 8) samples.push({ t, x: 0.5 + 0.06 * Math.sin(t / 400), y: 0.5 + 0.08 * Math.sin(t / 530) })
    const g = processCursor(samples, [], { durationMs: 8000, antiTremor: false })
    const path = computeCameraPath({ zooms: [zoom(500, 8000, 2)] }, g, { durationMs: 8000 })
    const a = sampleCameraPath(path, 2000)
    const b = sampleCameraPath(path, 7000)
    // o foco inicial é onde o cursor estava quando o zoom abriu; depois ele não sai da caixa
    expect(Math.abs(b.cx - a.cx)).toBeLessThan(0.02)
    expect(Math.abs(b.cy - a.cy)).toBeLessThan(0.02)
  })

  it('o cursor que sai da zona morta puxa a câmera, e o foco volta ao cursor', () => {
    // cursor parado no centro e depois vai para a direita (0,5 → 0,7)
    const g = cur(
      [
        [0, 0.5, 0.5],
        [3000, 0.5, 0.5],
        [3600, 0.7, 0.5],
        [9000, 0.7, 0.5]
      ],
      9000
    )
    const path = computeCameraPath({ zooms: [zoom(500, 9000, 2)] }, g, { durationMs: 9000 })
    expect(sampleCameraPath(path, 2500).cx).toBeCloseTo(0.5, 1)
    const late = sampleCameraPath(path, 8500)
    // o cursor (0,7) tem de ficar dentro da zona morta da câmera: |0,7 − cx| ≤ 0,25 × 0,5 / 2 + folga
    expect(Math.abs(0.7 - late.cx)).toBeLessThanOrEqual(DEAD_ZONE.w * 0.25 + 0.01)
    expect(late.cx).toBeGreaterThan(0.55)
  })

  it('antecipação: com o cursor correndo, a câmera vai à frente do que iria sem ela', () => {
    const g = cur([[0, 0.3, 0.5], [2000, 0.3, 0.5], [3000, 0.8, 0.5], [8000, 0.8, 0.5]], 8000)
    const withLook = computeCameraPath({ zooms: [zoom(500, 8000, 2)] }, g, { durationMs: 8000, lookaheadMs: 200 })
    const without = computeCameraPath({ zooms: [zoom(500, 8000, 2)] }, g, { durationMs: 8000, lookaheadMs: 0 })
    const t = 2700
    expect(sampleCameraPath(withLook, t).cx).toBeGreaterThan(sampleCameraPath(without, t).cx)
  })

  it('anti-enjoo: varredura de mais de 35% da largura em 0,4 s tira o zoom, e ele volta depois', () => {
    // cursor atravessa 0,1 → 0,9 em 300 ms no meio de um zoom de 6 s
    const g = cur([[0, 0.1, 0.5], [3000, 0.1, 0.5], [3300, 0.9, 0.5], [9000, 0.9, 0.5]], 9000)
    expect(isSweeping(g, 3150)).toBe(true)
    expect(isSweeping(g, 1000)).toBe(false)
    const path = computeCameraPath({ zooms: [zoom(500, 9000, 2)] }, g, { durationMs: 9000 })
    expect(sampleCameraPath(path, 2900).scale).toBeGreaterThan(1.9) // antes: no zoom
    const during = Math.min(...path.scale.filter((_, i) => path.t[i]! > 3000 && path.t[i]! < 4200))
    expect(during).toBeLessThan(1.7) // saiu do zoom
    expect(sampleCameraPath(path, 8500).scale).toBeGreaterThan(1.9) // voltou
  })

  it('zoom com foco manual usa o ponto fixo e ignora o cursor e a varredura', () => {
    const g = cur([[0, 0.1, 0.5], [3000, 0.1, 0.5], [3300, 0.9, 0.5], [9000, 0.9, 0.5]], 9000)
    const path = computeCameraPath({ zooms: [zoom(500, 9000, 2, { x: 0.3, y: 0.6 })] }, g, { durationMs: 9000 })
    const s = sampleCameraPath(path, 8000)
    expect(s.scale).toBeCloseTo(2, 2)
    expect(s.cx).toBeCloseTo(0.3, 2)
    expect(s.cy).toBeCloseTo(0.6, 2)
    expect(Math.min(...path.scale.filter((_, i) => path.t[i]! > 2000))).toBeGreaterThan(1.9) // sem anti-enjoo
  })

  it('foco manual perto da borda é limitado para o retângulo caber na fonte', () => {
    const path = computeCameraPath({ zooms: [zoom(500, 9000, 2, { x: 0, y: 1 })] }, still(0.5, 0.5, 10_000), { durationMs: 10_000 })
    const s = sampleCameraPath(path, 8000)
    expect(s.cx).toBeCloseTo(0.25, 2)
    expect(s.cy).toBeCloseTo(0.75, 2)
  })

  it('o recorte vertical (view estreita) respeita os limites da fonte', () => {
    const view = { w: 0.3164, h: 1 } // 9:16 sobre 16:9
    const path = computeCameraPath({ zooms: [zoom(500, 9000, 1.5, { x: 0.99, y: 0.5 })] }, still(0.5, 0.5, 10_000), { durationMs: 10_000, view })
    for (let i = 0; i < path.t.length; i++) {
      const r = visibleRect({ scale: path.scale[i]!, cx: path.cx[i]!, cy: path.cy[i]! }, view)
      expect(r.x).toBeGreaterThanOrEqual(-1e-9)
      expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9)
      expect(r.y).toBeGreaterThanOrEqual(-1e-9)
      expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9)
    }
    // sem zoom, o recorte vertical já enxerga só 31,6% da largura
    const flat = computeCameraPath({ zooms: [] }, still(0.8, 0.5, 2000), { durationMs: 2000, view })
    expect(visibleRect(sampleCameraPath(flat, 1000), view).w).toBeCloseTo(0.3164, 4)
  })

  it('sem zooms a câmera fica parada em escala 1, centro 0,5', () => {
    const path = computeCameraPath({ zooms: [] }, wander(3000), { durationMs: 3000 })
    expect(path.scale.every((v) => v === 1)).toBe(true)
    expect(path.cx.every((v) => v === 0.5) && path.cy.every((v) => v === 0.5)).toBe(true)
  })

  it('sampleCameraPath interpola entre as amostras e limita nas pontas', () => {
    const path: CameraPath = { hz: 60, t: [0, 1000 / 60, 2000 / 60], scale: [1, 2, 3], cx: [0.5, 0.6, 0.7], cy: [0.5, 0.5, 0.5], maxScale: 3 }
    expect(sampleCameraPath(path, 1000 / 120).scale).toBeCloseTo(1.5, 9)
    expect(sampleCameraPath(path, -50).scale).toBe(1)
    expect(sampleCameraPath(path, 99_999).cx).toBe(0.7)
    expect(sampleCameraPath({ ...path, t: [], scale: [], cx: [], cy: [] }, 5)).toEqual({ scale: 1, cx: 0.5, cy: 0.5 })
  })
})

describe('caminho da câmera com proporção genérica (M4a: 9:16, 1:1, 4:5 sobre uma tela qualquer)', () => {
  const SRC = { w: 1920, h: 1080 }
  const RATIOS: [string, number][] = [['9:16', 9 / 16], ['1:1', 1], ['4:5', 4 / 5], ['3:4', 3 / 4]]
  const aspectOf = (r: { w: number; h: number }): number => (r.w * SRC.w) / (r.h * SRC.h)

  it('em qualquer proporção o retângulo visível tem a proporção do destino e cabe dentro da fonte, em todo quadro', () => {
    const D = 12_000
    const g = wander(D)
    for (const [name, dest] of RATIOS) {
      const view = cropView(dest, SRC)
      const path = computeCameraPath({ zooms: [zoom(2000, 6000, 1.4), zoom(8000, 11_000, 1.3, { x: 0.97, y: 0.04 })] }, g, { durationMs: D, view })
      for (let i = 0; i < path.t.length; i++) {
        const r = visibleRect({ scale: path.scale[i]!, cx: path.cx[i]!, cy: path.cy[i]! }, view)
        expect(aspectOf(r), `${name} quadro ${i}`).toBeCloseTo(dest, 6)
        expect(r.x, name).toBeGreaterThanOrEqual(-1e-9)
        expect(r.y, name).toBeGreaterThanOrEqual(-1e-9)
        expect(r.x + r.w, name).toBeLessThanOrEqual(1 + 1e-9)
        expect(r.y + r.h, name).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })

  it('recorte menor que a fonte SEGUE o cursor mesmo sem zoom, e o vídeo já começa enquadrado nele', () => {
    const view = cropView(9 / 16, SRC)
    const D = 8000
    const g = cur([[0, 0.8, 0.5], [3000, 0.8, 0.5], [4000, 0.2, 0.5], [8000, 0.2, 0.5]], D)
    const path = computeCameraPath({ zooms: [] }, g, { durationMs: D, view })
    expect(path.maxScale).toBe(1)
    // começa no cursor (limitado para o recorte caber), não no centro
    const start = visibleRect(sampleCameraPath(path, 0), view)
    expect(start.x + start.w / 2).toBeGreaterThan(0.7)
    // o cursor fica sempre dentro do que se vê (depois de a mola assentar)
    for (const t of [1500, 2800, 6000, 7900]) {
      const r = visibleRect(sampleCameraPath(path, t), view)
      const i = Math.round((t * 60) / 1000)
      expect(g.x[i]!).toBeGreaterThanOrEqual(r.x - 1e-6)
      expect(g.x[i]!).toBeLessThanOrEqual(r.x + r.w + 1e-6)
    }
    // e a câmera foi mesmo para a esquerda quando o cursor foi
    expect(sampleCameraPath(path, 7900).cx).toBeLessThan(0.3)
  })

  it('zona morta no recorte que segue: o cursor inquieto dentro de 50% × 70% do que se vê NÃO mexe a câmera (sem tremer)', () => {
    const view = cropView(9 / 16, SRC) // w = 0,316 → zona morta de 0,158 de largura
    const samples: CursorSample[] = []
    for (let t = 0; t <= 8000; t += 8) samples.push({ t, x: 0.5 + 0.03 * Math.sin(t / 300), y: 0.5 + 0.06 * Math.sin(t / 410) })
    const g = processCursor(samples, [], { durationMs: 8000, antiTremor: false })
    const path = computeCameraPath({ zooms: [] }, g, { durationMs: 8000, view })
    const a = sampleCameraPath(path, 1000)
    const b = sampleCameraPath(path, 7500)
    expect(Math.abs(b.cx - a.cx)).toBeLessThan(0.02)
    expect(maxAbsDiff(path.cx)).toBeLessThan(0.01)
    expect(maxAbs2nd(path.cx)).toBeLessThan(0.01)
  })

  it('o cursor que sai da zona morta arrasta a câmera, com movimento suave (sem degrau de velocidade)', () => {
    const view = cropView(9 / 16, SRC)
    const D = 9000
    const g = cur([[0, 0.3, 0.5], [2000, 0.3, 0.5], [5000, 0.7, 0.5], [9000, 0.7, 0.5]], D)
    const path = computeCameraPath({ zooms: [] }, g, { durationMs: D, view })
    expect(sampleCameraPath(path, 8500).cx).toBeGreaterThan(0.55)
    expect(maxAbsDiff(path.cx)).toBeLessThan(0.02)
    expect(maxAbs2nd(path.cx)).toBeLessThan(0.01)
  })

  it('segmento de zoom sobre o recorte que segue: a escala sobe a partir do recorte base e volta a 1 sem a câmera pular de lugar', () => {
    const view = cropView(9 / 16, SRC)
    const D = 10_000
    const g = still(0.6, 0.5, D)
    const path = computeCameraPath({ zooms: [zoom(2000, 6000, 1.4)] }, g, { durationMs: D, view })
    expect(sampleCameraPath(path, 4500).scale).toBeCloseTo(1.4, 1)
    expect(sampleCameraPath(path, 9500).scale).toBeCloseTo(1, 2)
    // o centro não anda quando o cursor está parado, com zoom ou sem
    const c0 = sampleCameraPath(path, 1000).cx
    expect(Math.abs(sampleCameraPath(path, 4500).cx - c0)).toBeLessThan(0.02)
    expect(Math.abs(sampleCameraPath(path, 9500).cx - c0)).toBeLessThan(0.02)
  })

  it('o recorte 1×1 (16:9 sobre 16:9) NÃO mudou: segue o comportamento de sempre (centro parado sem zoom)', () => {
    const g = wander(6000)
    const plain = computeCameraPath({ zooms: [zoom(1000, 4000, 1.7)] }, g, { durationMs: 6000 })
    const explicit = computeCameraPath({ zooms: [zoom(1000, 4000, 1.7)] }, g, { durationMs: 6000, view: { w: 1, h: 1 } })
    expect(explicit).toEqual(plain)
    const flat = computeCameraPath({ zooms: [] }, g, { durationMs: 6000, view: cropView(16 / 9, SRC) })
    expect(flat.cx.every((v) => v === 0.5) && flat.cy.every((v) => v === 0.5)).toBe(true)
  })

  it('o recorte do V-B (2× sobre a tela, 1080×590) também segue o cursor dentro da fonte', () => {
    const view = cropView(1080 / 590, SRC, 590 / 2 / 1080)
    expect(view.h).toBeCloseTo(0.2731, 3) // 295 px de uma tela de 1080: a base já é um zoom de ~2×
    expect(aspectOf(view)).toBeCloseTo(1080 / 590, 4)
    const D = 6000
    const g = cur([[0, 0.5, 0.2], [2000, 0.5, 0.2], [3000, 0.5, 0.8], [6000, 0.5, 0.8]], D)
    const path = computeCameraPath({ zooms: [] }, g, { durationMs: D, view })
    expect(sampleCameraPath(path, 5800).cy).toBeGreaterThan(0.6)
    for (let i = 0; i < path.t.length; i++) {
      const r = visibleRect({ scale: path.scale[i]!, cx: path.cx[i]!, cy: path.cy[i]! }, view)
      expect(r.y).toBeGreaterThanOrEqual(-1e-9)
      expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9)
    }
  })
})
