import { describe, expect, it } from 'vitest'
import { processCursor, type CursorGrid } from '@shared/cursor'
import { HORIZONTAL_ZOOM_PRESETS, computeCameraPath, easeOutCubic, generateAutoZooms, sampleCameraPath, zoomPresetFor } from '@shared/zoom'
import {
  HORIZONTAL_SHAPING,
  ZOOM_PLATEAU_MIN_MS,
  ZOOM_RAMP_MS,
  ZOOM_SCALE_RANGE,
  ZOOM_SEPARATION_MS,
  insideWord,
  keptOverlap,
  shapeZoomWindows,
  snapZoomEnd,
  snapZoomStart,
  speechBounds,
  zoomBoundaryProblems
} from '@shared/zoom-speech'
import { keptRanges } from '@shared/timeline'
import { planSeams } from '@shared/seams'
import type { ClickEvent, CursorSample, Range, Word, Zoom } from '@shared/types'

const click = (t: number, x = 0.5, y = 0.5): ClickEvent => ({ t, x, y, button: 'left' })
const still = (durationMs: number): CursorGrid => {
  const samples: CursorSample[] = []
  for (let t = 0; t <= durationMs; t += 8) samples.push({ t, x: 0.5, y: 0.5 })
  return processCursor(samples, [], { durationMs })
}

/** Gerador pseudoaleatório determinístico (LCG), para as propriedades. */
const rng = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/**
 * Uma fala de gabarito: frases de 5 a 11 palavras (280-520 ms cada, 40-110 ms entre elas), pausa de 350-1400 ms entre frases e a
 * pontuação que fecha cada frase. Sem dado de ninguém: só o ritmo.
 */
function speech(seed: number, totalMs: number): { words: Word[]; sentences: Range[] } {
  const r = rng(seed)
  const words: Word[] = []
  const sentences: Range[] = []
  let t = 800 + Math.floor(r() * 600)
  let i = 0
  while (t < totalMs - 3000) {
    const n = 5 + Math.floor(r() * 7)
    const first = t
    for (let k = 0; k < n; k++) {
      const len = 280 + Math.floor(r() * 240)
      words.push({ i: i++, text: k === n - 1 ? 'fim.' : 'palavra', start: t, end: t + len, prob: 0.95, kind: 'word' })
      t += len + 40 + Math.floor(r() * 70)
    }
    sentences.push({ start: first, end: words[words.length - 1]!.end })
    t += 350 + Math.floor(r() * 1050)
  }
  return { words, sentences }
}

/** Cortes de gabarito: em metade das pausas entre frases tira a pausa (deixa 120 ms de cada lado), como o F1. */
function cutsOf(sentences: readonly Range[], seed: number): Range[] {
  const r = rng(seed)
  const cuts: Range[] = []
  for (let k = 0; k + 1 < sentences.length; k++) {
    const gap = sentences[k + 1]!.start - sentences[k]!.end
    if (gap >= 700 && r() < 0.5) cuts.push({ start: sentences[k]!.end + 120, end: sentences[k + 1]!.start - 120 })
  }
  return cuts
}

const DURATION = 150_000
const grid = still(DURATION)
const horizontal = (clicks: ClickEvent[], extra: Partial<Parameters<typeof generateAutoZooms>[0]> = {}): Zoom[] =>
  generateAutoZooms({ clicks, keys: [], cursor: grid, duration: DURATION, preset: 'moderate', ...extra })

describe('zoom do 16:9: a tabela calibrada pelas referências (estudo 12/10, seção 2.2)', () => {
  it('escala de 1,5 a 1,8× em todos os presets; abre 0,5 s antes do clique; rampa de 0,9 s; platô de 4 s; 1,5 s de tela larga', () => {
    for (const id of ['subtle', 'moderate', 'intense'] as const) {
      const p = HORIZONTAL_ZOOM_PRESETS[id]
      expect(p.scale).toBeGreaterThanOrEqual(ZOOM_SCALE_RANGE.min)
      expect(p.scale).toBeLessThanOrEqual(ZOOM_SCALE_RANGE.max)
      expect(p.lead).toBe(500)
      expect(p.shaping).toBe(HORIZONTAL_SHAPING)
    }
    expect(ZOOM_RAMP_MS).toBe(900)
    expect(ZOOM_PLATEAU_MIN_MS).toBe(4000)
    expect(ZOOM_SEPARATION_MS).toBe(1500)
    expect(HORIZONTAL_ZOOM_PRESETS.subtle.scale).toBeLessThan(HORIZONTAL_ZOOM_PRESETS.moderate.scale)
    expect(HORIZONTAL_ZOOM_PRESETS.moderate.scale).toBeLessThan(HORIZONTAL_ZOOM_PRESETS.intense.scale)
  })

  it('o vertical NÃO mudou: sem a forma do 16:9, a janela é a de sempre [clique − 600, clique + 1500], com ou sem fala', () => {
    const { words } = speech(3, DURATION)
    const preset = zoomPresetFor('vertical', 'moderate')
    expect(preset.shaping).toBeUndefined()
    const z = generateAutoZooms({ clicks: [click(30_000)], keys: [], cursor: grid, duration: DURATION, preset, words, kept: [{ start: 0, end: DURATION }] })
    expect(z).toHaveLength(1)
    expect(z[0]).toMatchObject({ start: 29_400, end: 31_500, scale: 1.35 })
  })
})

describe('começo e fim do zoom em limites da fala: nunca no meio de uma palavra', () => {
  it('o início vai para o começo da frase que está sendo dita quando ele está perto (até 2,5 s antes do pedido)', () => {
    const b = speechBounds([
      { i: 0, text: 'Agora', start: 9300, end: 9700, prob: 1, kind: 'word' },
      { i: 1, text: 'clique', start: 9780, end: 10_200, prob: 1, kind: 'word' },
      { i: 2, text: 'aqui.', start: 10_260, end: 10_700, prob: 1, kind: 'word' }
    ])
    // o pedido (10 000 − 500 = 9500) cai NO MEIO de "Agora": começa onde a frase começa
    expect(snapZoomStart(b, 9500)).toBe(9300)
    expect(snapZoomStart(b, 9500 + 700)).toBe(9300)
  })

  it('o zoom não abre mais que ~2 s antes da ação: a frase que começou há mais de 1,5 s do pedido não puxa o início para trás', () => {
    const words: Word[] = [
      { i: 0, text: 'vou', start: 7500, end: 7700, prob: 1, kind: 'word' },
      { i: 1, text: 'abrir', start: 7800, end: 8200, prob: 1, kind: 'word' },
      { i: 2, text: 'aqui', start: 8300, end: 8700, prob: 1, kind: 'word' },
      { i: 3, text: 'o', start: 9100, end: 9200, prob: 1, kind: 'word' },
      { i: 4, text: 'sistema.', start: 9250, end: 9900, prob: 1, kind: 'word' }
    ]
    const b = speechBounds(words)
    // pedido em 9500 (clique em 10 000): a frase começou 2,0 s antes; o início vai para uma palavra a menos de 1 s do pedido
    const start = snapZoomStart(b, 9500)
    expect(start).toBeGreaterThanOrEqual(9500 - HORIZONTAL_SHAPING.startBackWordMs)
    expect(start).not.toBe(7500)
    expect(insideWord(words, start)).toBe(false)
    // a 1,4 s do pedido a frase ainda vale
    expect(snapZoomStart(b, 7500 + 1400)).toBe(7500)
  })

  it('sem frase por perto, o início vai para o começo da palavra; sem fala nenhuma fica onde foi pedido', () => {
    const words: Word[] = [
      { i: 0, text: 'um', start: 5000, end: 5400, prob: 1, kind: 'word' },
      { i: 1, text: 'dois', start: 5500, end: 6000, prob: 1, kind: 'word' }
    ]
    const b = speechBounds(words)
    // a frase de 5000 está a mais de 2,5 s do pedido (8000), a palavra também: fica onde foi pedido, que está fora de palavra
    expect(snapZoomStart(b, 8000)).toBe(8000)
    // o pedido cai dentro de "dois": começa em "dois" ou antes (a frase de 5000 está a 0,7 s)
    expect(insideWord(words, 5700)).toBe(true)
    expect(insideWord(words, snapZoomStart(b, 5700))).toBe(false)
    expect(snapZoomStart(speechBounds([]), 5700)).toBe(5700)
  })

  it('o fim espera a palavra acabar e prefere o fim da frase', () => {
    const words: Word[] = [
      { i: 0, text: 'isto', start: 1000, end: 1400, prob: 1, kind: 'word' },
      { i: 1, text: 'é', start: 1460, end: 1600, prob: 1, kind: 'word' },
      { i: 2, text: 'tudo.', start: 1660, end: 2200, prob: 1, kind: 'word' },
      { i: 3, text: 'Depois', start: 3000, end: 3500, prob: 1, kind: 'word' }
    ]
    const b = speechBounds(words)
    expect(snapZoomEnd(b, 1500)).toBe(2200) // no meio de "é"/depois: fim da frase
    expect(snapZoomEnd(b, 3200)).toBe(3500) // dentro de "Depois": espera acabar
    expect(snapZoomEnd(b, 2600)).toBe(2600) // numa pausa, sem palavra por perto: fica
  })

  it('propriedade: 40 gravações de gabarito, cliques aleatórios, SEM cortes: nenhum zoom começa ou termina no meio de uma palavra', () => {
    let total = 0
    for (let seed = 1; seed <= 40; seed++) {
      const { words } = speech(seed, DURATION)
      const r = rng(seed * 7)
      const clicks = Array.from({ length: 14 }, () => click(2000 + Math.floor(r() * (DURATION - 8000))))
      const zooms = horizontal(clicks, { words })
      total += zooms.length
      expect(zoomBoundaryProblems(zooms, words, null, DURATION), `semente ${seed}`).toEqual([])
    }
    expect(total).toBeGreaterThan(40)
  })

  it('propriedade: COM cortes entre as frases, o zoom também não começa nem termina num corte, e a rampa de entrada não atravessa uma emenda', () => {
    let total = 0
    for (let seed = 1; seed <= 40; seed++) {
      const { words, sentences } = speech(seed, DURATION)
      const cuts = cutsOf(sentences, seed + 100)
      const kept = keptRanges(DURATION, cuts.map((c) => ({ ...c, enabled: true })))
      const r = rng(seed * 11)
      const clicks = Array.from({ length: 14 }, () => click(2000 + Math.floor(r() * (DURATION - 8000))))
      const zooms = horizontal(clicks, { words, kept })
      total += zooms.length
      expect(zoomBoundaryProblems(zooms, words, kept, DURATION), `semente ${seed}`).toEqual([])
      const seams = planSeams(kept)
      for (const z of zooms) {
        const straddle = seams.filter((s) => s.leftEnd > z.start && s.leftEnd < z.start + ZOOM_RAMP_MS)
        expect(straddle, `semente ${seed}: ${z.id} começa em ${z.start} e a rampa passa pela emenda de ${straddle[0]?.leftEnd}`).toEqual([])
      }
    }
    expect(total).toBeGreaterThan(40)
  })
})

describe('limites com tempo de palavra fracionado e o fim do vídeo', () => {
  it('os tempos do transcritor vêm com casas decimais: o arredondamento do zoom vai PARA FORA e nunca empurra o limite para dentro da palavra', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const { words } = speech(seed, DURATION)
      const frac = words.map((w, k) => ({ ...w, start: w.start + 0.37 + (k % 3) * 0.2, end: w.end + 0.61 }))
      const r = rng(seed * 5)
      const clicks = Array.from({ length: 14 }, () => click(2000 + Math.floor(r() * (DURATION - 8000))))
      expect(zoomBoundaryProblems(horizontal(clicks, { words: frac }), frac, null, DURATION), `semente ${seed}`).toEqual([])
    }
  })

  it('o zoom que vai até o último quadro termina onde o vídeo termina, mesmo que a última palavra passe do arquivo', () => {
    const words: Word[] = [
      { i: 0, text: 'vamos', start: 9000, end: 9400, prob: 1, kind: 'word' },
      { i: 1, text: 'clicar', start: 9500, end: 10_000, prob: 1, kind: 'word' },
      { i: 2, text: 'aqui', start: 14_200, end: 15_050, prob: 1, kind: 'word' } // acaba 50 ms depois do arquivo
    ]
    const z = generateAutoZooms({ clicks: [click(10_000)], keys: [], cursor: still(15_000), duration: 15_000, preset: 'moderate', words })
    expect(z).toHaveLength(1)
    expect(z[0]!.end).toBe(15_000)
    expect(zoomBoundaryProblems(z, words, null, 15_000)).toEqual([])
    expect(zoomBoundaryProblems(z, words)).toHaveLength(1) // sem a duração, o fim cai dentro de "aqui"
  })
})

describe('forma do zoom: platô de 4 s, 1,5 s entre zooms, escala de 1,5 a 1,8×', () => {
  it('um clique solto vira um zoom com platô de pelo menos 4 s (rampa de 0,9 s + 4 s), mesmo sem transcrição', () => {
    const z = horizontal([click(30_000)])
    expect(z).toHaveLength(1)
    expect(z[0]!.start).toBe(29_500) // sem fala: abre 0,5 s antes do clique
    expect(z[0]!.end - z[0]!.start).toBeGreaterThanOrEqual(ZOOM_RAMP_MS + ZOOM_PLATEAU_MIN_MS)
  })

  it('propriedade: com fala, todo zoom mantém o platô de 4 s e a tela larga entre dois zooms passa de 1,5 s', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { words } = speech(seed, DURATION)
      const r = rng(seed * 13)
      const clicks = Array.from({ length: 16 }, () => click(2000 + Math.floor(r() * (DURATION - 8000))))
      const zooms = horizontal(clicks, { words })
      for (const z of zooms) {
        expect(z.end - z.start - ZOOM_RAMP_MS, `semente ${seed} ${z.id}`).toBeGreaterThanOrEqual(ZOOM_PLATEAU_MIN_MS)
        expect(z.scale).toBeGreaterThanOrEqual(ZOOM_SCALE_RANGE.min)
        expect(z.scale).toBeLessThanOrEqual(ZOOM_SCALE_RANGE.max)
      }
      for (let k = 1; k < zooms.length; k++) expect(zooms[k]!.start - zooms[k - 1]!.end, `semente ${seed}`).toBeGreaterThanOrEqual(ZOOM_SEPARATION_MS)
    }
  })

  it('com cortes o platô conta o tempo de SAÍDA: o que foi cortado dentro do zoom não entra na conta', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { words, sentences } = speech(seed, DURATION)
      const kept = keptRanges(DURATION, cutsOf(sentences, seed + 7).map((c) => ({ ...c, enabled: true })))
      const r = rng(seed * 17)
      const clicks = Array.from({ length: 12 }, () => click(2000 + Math.floor(r() * (DURATION - 8000))))
      for (const z of horizontal(clicks, { words, kept })) {
        expect(keptOverlap(kept, z.start + ZOOM_RAMP_MS, z.end), `semente ${seed} ${z.id}`).toBeGreaterThanOrEqual(ZOOM_PLATEAU_MIN_MS - 1)
      }
    }
  })

  it('dois zooms que ficariam a menos de 1,5 s viram um só (o foco passa a seguir o cursor)', () => {
    const wins = [
      { start: 1000, end: 6000, hits: 1, click: true, focus: { x: 0.2, y: 0.2 } as const },
      { start: 7000, end: 12_000, hits: 1, click: true, focus: { x: 0.8, y: 0.8 } as const }
    ]
    const out = shapeZoomWindows(wins, HORIZONTAL_SHAPING, { words: [], kept: null, durationMs: 60_000 })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ start: 1000, hits: 2, focus: 'auto' })
    expect(out[0]!.end).toBeGreaterThanOrEqual(12_000)
  })

  it('zoom no fim do vídeo, sem espaço para o platô, não é criado', () => {
    // clique a 1,2 s do fim: rampa + platô não cabem
    const z = horizontal([click(DURATION - 1200)])
    expect(z).toEqual([])
  })

  it('o teto por minuto continua valendo depois de moldar', () => {
    const clicks = Array.from({ length: 40 }, (_, k) => click(5000 + k * 3500))
    const z = horizontal(clicks, { preset: 'subtle' })
    for (let k = 0; k + 3 < z.length; k++) expect(z[k + 3]!.start - z[k]!.start).toBeGreaterThanOrEqual(60_000)
  })
})

describe('rampa do zoom do 16:9: 0,9 s em ease-out cúbica (a curva do Screen Studio)', () => {
  const zooms: Zoom[] = [{ id: 'z', start: 3000, end: 9000, scale: 1.6, focus: 'auto', origin: 'manual' }]
  const path = computeCameraPath({ zooms }, grid, { durationMs: 14_000, scaleRamp: { ms: ZOOM_RAMP_MS } })
  const at = (t: number): number => sampleCameraPath(path, t).scale

  it('começa rápido e pousa devagar: 30% do caminho em 0,1 s, 70% em 0,3 s, 91% em 0,5 s e 100% em 0,9 s', () => {
    expect(at(3000)).toBeCloseTo(1, 3)
    const frac = (ms: number): number => (at(3000 + ms) - 1) / 0.6
    expect(frac(100)).toBeCloseTo(easeOutCubic(100 / 900), 2)
    expect(frac(300)).toBeCloseTo(0.704, 2)
    expect(frac(500)).toBeCloseTo(0.912, 2)
    expect(frac(900)).toBeCloseTo(1, 3)
    expect(at(6000)).toBeCloseTo(1.6, 6) // platô
  })

  it('a saída é a mesma rampa de 0,9 s, partindo de `end`', () => {
    const frac = (ms: number): number => (1.6 - at(9000 + ms)) / 0.6
    expect(frac(0)).toBeCloseTo(0, 3)
    expect(frac(300)).toBeCloseTo(0.704, 2)
    expect(frac(900)).toBeCloseTo(1, 3)
    expect(at(10_500)).toBeCloseTo(1, 6)
  })

  it('o erro quadrático médio contra a ease-out de 0,89 s é pequeno (a mola de antes passava de 0,14)', () => {
    let sum = 0
    let n = 0
    for (let ms = 0; ms <= 890; ms += 1000 / 60) {
      const d = (at(3000 + ms) - 1) / 0.6 - easeOutCubic(ms / 890)
      sum += d * d
      n++
    }
    expect(Math.sqrt(sum / n)).toBeLessThan(0.04)
  })

  it('nunca passa da escala pedida e nunca fica abaixo de 1 (sem estouro de mola)', () => {
    for (let t = 0; t <= 14_000; t += 16) {
      const s = at(t)
      expect(s).toBeGreaterThanOrEqual(1 - 1e-9)
      expect(s).toBeLessThanOrEqual(1.6 + 1e-9)
    }
  })

  it('um zoom manual grande em outro ponto do vídeo NÃO encurta a rampa dos outros (a duração parte da escala de cada zoom)', () => {
    const mixed: Zoom[] = [
      { id: 'a', start: 3000, end: 9000, scale: 1.6, focus: 'auto', origin: 'auto' },
      { id: 'm', start: 20_000, end: 26_000, scale: 4, focus: 'auto', origin: 'manual' }
    ]
    const p = computeCameraPath({ zooms: mixed }, grid, { durationMs: 30_000, scaleRamp: { ms: ZOOM_RAMP_MS } })
    const s = (t: number): number => sampleCameraPath(p, t).scale
    expect((s(3300) - 1) / 0.6).toBeCloseTo(0.704, 2) // 1,6× em 0,3 s: a mesma curva de antes
    expect(s(3900)).toBeCloseTo(1.6, 3)
    expect((s(20_300) - 1) / 3).toBeCloseTo(0.704, 2) // o de 4× também leva 0,9 s
    expect(s(20_900)).toBeCloseTo(4, 3)
    expect(s(9900)).toBeCloseTo(1, 3) // e a saída do de 1,6× leva 0,9 s, não 0,36
    expect((1.6 - s(9300)) / 0.6).toBeCloseTo(0.704, 2)
  })

  it('um zoom interrompido (outro alvo no meio da rampa) parte de onde a escala estava, sem pulo', () => {
    const two: Zoom[] = [{ id: 'z', start: 3000, end: 3500, scale: 1.6, focus: 'auto', origin: 'manual' }]
    const p = computeCameraPath({ zooms: two }, grid, { durationMs: 8000, scaleRamp: { ms: ZOOM_RAMP_MS } })
    let prev = sampleCameraPath(p, 0).scale
    for (let t = 16; t <= 8000; t += 16) {
      const s = sampleCameraPath(p, t).scale
      expect(Math.abs(s - prev), `t=${t}`).toBeLessThan(0.05)
      prev = s
    }
    expect(sampleCameraPath(p, 7000).scale).toBeCloseTo(1, 6)
  })
})
