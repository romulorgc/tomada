import { describe, expect, it } from 'vitest'
import { processCursor, type CursorGrid } from '@shared/cursor'
import {
  DEAD_ZONE,
  MAX_ZOOM_SCALE,
  ZOOM_PRESETS,
  computeCameraPath,
  findDwells,
  findTypingBursts,
  generateAutoZooms,
  isSweeping,
  mergeAutoZooms,
  sampleCameraPath,
  visibleRect,
  type CameraPath
} from '@shared/zoom'
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
      const z = generateAutoZooms({ clicks: [click(10_000)], keys: [], cursor: grid, duration: 60_000, preset: id })
      expect(z).toHaveLength(1)
      expect(z[0]).toMatchObject({ start: 10_000 - p.lead, end: 10_000 + p.hold, scale: p.scale, focus: 'auto', origin: 'auto' })
    }
  })

  it('a tabela do projeto está em ms', () => {
    expect(ZOOM_PRESETS.subtle).toEqual({ lead: 600, hold: 2000, mergeGap: 2500, scale: 1.4, minGap: 2500 })
    expect(ZOOM_PRESETS.moderate).toEqual({ lead: 500, hold: 1400, mergeGap: 1800, scale: 1.7, minGap: 1800 })
    expect(ZOOM_PRESETS.intense).toEqual({ lead: 400, hold: 900, mergeGap: 1200, scale: 2.0, minGap: 1200 })
  })

  it('fusão: janelas separadas por menos que o intervalo viram um zoom só (moderado: 1,8 s)', () => {
    // janelas [4500,6400] e [N-500, N+1400]: intervalo = N − 500 − 6400
    const merged = generateAutoZooms({ clicks: [click(5000), click(8600)], keys: [], cursor: grid, duration: 60_000, preset: 'moderate' })
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ start: 4500, end: 10_000 })
    const apart = generateAutoZooms({ clicks: [click(5000), click(8700)], keys: [], cursor: grid, duration: 60_000, preset: 'moderate' })
    expect(apart).toHaveLength(2) // intervalo exatamente 1800: não funde
    expect(apart[1]).toMatchObject({ start: 8200, end: 10_100 })
  })

  it('cadeia de cliques vira um único segmento que segue o cursor', () => {
    const clicks = [5000, 6500, 8000, 9500].map((t) => click(t))
    const z = generateAutoZooms({ clicks, keys: [], cursor: grid, duration: 60_000, preset: 'moderate' })
    expect(z).toHaveLength(1)
    expect(z[0]).toMatchObject({ start: 4500, end: 10_900, focus: 'auto' })
  })

  it('intervalo mínimo entre zooms: o que passa de mergeGap mas fica abaixo de minGap também funde', () => {
    const preset = { lead: 500, hold: 1400, mergeGap: 500, scale: 1.7, minGap: 3000 }
    const z = generateAutoZooms({ clicks: [click(5000), click(9800)], keys: [], cursor: grid, duration: 60_000, preset })
    expect(z).toHaveLength(1) // intervalo 2900 < 3000
    const far = generateAutoZooms({ clicks: [click(5000), click(10_300)], keys: [], cursor: grid, duration: 60_000, preset })
    expect(far).toHaveLength(2)
  })

  it('cliques fora da área e antes do início não abrem zoom; as bordas são limitadas à gravação', () => {
    const z = generateAutoZooms({ clicks: [click(30_000, 0.5, 0.5, true)], keys: [], cursor: grid, duration: 60_000, preset: 'moderate' })
    expect(z).toEqual([])
    const edge = generateAutoZooms({ clicks: [click(100), click(59_900)], keys: [], cursor: grid, duration: 60_000, preset: 'moderate' })
    expect(edge[0]!.start).toBe(0)
    expect(edge[edge.length - 1]!.end).toBe(60_000)
  })

  it('rajada de digitação (≥ 3 teclas com intervalos < 0,8 s) abre janela no ponto do último clique', () => {
    const keys = keysAt(30_000, 8, 140)
    const z = generateAutoZooms({ clicks: [click(10_000, 0.25, 0.7)], keys, cursor: grid, duration: 60_000, preset: 'moderate' })
    expect(z).toHaveLength(2)
    expect(z[1]).toMatchObject({ start: 29_500, end: 30_980 + 1400, focus: { x: 0.25, y: 0.7 } })
  })

  it('digitação logo depois de um clique funde com ele (o foco passa a seguir o cursor)', () => {
    const z = generateAutoZooms({ clicks: [click(29_000, 0.4, 0.4)], keys: keysAt(30_000, 6, 200), cursor: grid, duration: 60_000, preset: 'moderate' })
    expect(z).toHaveLength(1)
    expect(z[0]!.focus).toBe('auto')
    expect(z[0]!.start).toBe(28_500)
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
    const z = generateAutoZooms({ clicks: [], keys: keysAt(20_000, 2, 100), cursor: grid, duration: 60_000, preset: 'moderate' })
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
    const dwellOnly = generateAutoZooms({ clicks: [], keys: [], cursor: grid2, duration: 10_000, preset: 'moderate' })
    expect(dwellOnly.length).toBeGreaterThanOrEqual(1)
    const first = dwellOnly[0]!
    expect(first.focus).toMatchObject({ x: expect.closeTo(0.3, 1), y: expect.closeTo(0.4, 1) })
    expect(first.start).toBeLessThan(3200)
    expect(first.end).toBeGreaterThan(3000)

    const withClick = generateAutoZooms({ clicks: [click(8000, 0.8, 0.2)], keys: [], cursor: grid2, duration: 10_000, preset: 'moderate' })
    expect(withClick).toHaveLength(1)
    expect(withClick[0]!.start).toBe(7500) // só o zoom do clique; o dwell não entra
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
    const z = generateAutoZooms({ clicks, keys: [], cursor: grid, duration: 60_000, preset: 'moderate' })
    expect(new Set(z.map((x) => x.id)).size).toBe(z.length)
    expect([...z].sort((a, b) => a.start - b.start)).toEqual(z)
    const manual: Zoom = { id: 'm1', start: 40_000, end: 42_000, scale: 2, focus: { x: 0.1, y: 0.1 }, origin: 'manual' }
    const merged = mergeAutoZooms([manual, ...z], generateAutoZooms({ clicks: [click(50_000)], keys: [], cursor: grid, duration: 60_000, preset: 'subtle' }))
    expect(merged.map((m) => m.origin)).toEqual(['manual', 'auto'])
    expect(merged[0]).toEqual(manual)
  })

  it('duração zero ou sem eventos não gera zoom', () => {
    expect(generateAutoZooms({ clicks: [click(0)], keys: [], cursor: grid, duration: 0, preset: 'moderate' })).toEqual([])
    expect(generateAutoZooms({ clicks: [], keys: [], cursor: grid, duration: 60_000, preset: 'moderate' })).toEqual([])
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
