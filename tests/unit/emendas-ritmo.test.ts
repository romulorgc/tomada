/**
 * F1 · emendas: ritmo dos cortes, bordas no vale de energia, perfil da voz, tela ativa. Os números dos casos reais (G1, G2) são
 * os do diagnóstico de 12/10/2026, reproduzidos com dados SINTÉTICOS (nada do usuário entra aqui).
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_CLEAN, computeClean, pacingOf, silenceItems, type CleanInput, type CleanOptions, type Levels } from '@shared/clean'
import { EDGE_AFTER_MS, EDGE_BEFORE_MS, EDGE_MIN_PAUSE_MS, cutRangeAround, snapToValley } from '@shared/edges'
import { MIN_SPEECH_KEEP_MS, PACING, SLIVER_MS, countSeams, shapeCuts, type ShapeCut } from '@shared/pacing'
import { contentChangesOf, mergeRanges, screenActivity } from '@shared/screen-activity'
import { GAP_SPEECH_BELOW_VOICE_DB, MIN_SNR_DB, buildVoiceProfile, isLoudGapSpeech, levelAt, meanLevel } from '@shared/voice-profile'
import type { Word } from '@shared/types'

const w = (spec: [string, number, number, Word['kind']?][]): Word[] => spec.map(([text, start, end, kind], i) => ({ i, text, start, end, prob: 0.9, kind: kind ?? 'word' }))

/** Níveis de 10 ms: `voice` dB onde há palavra (ou o nível dado), `floor` fora. */
function levelsFor(words: readonly Pick<Word, 'start' | 'end'>[], durationMs: number, voice: number, floor: number, extra: { range: [number, number]; db: number }[] = []): Levels {
  const n = Math.ceil(durationMs / 10)
  const mic: number[] = new Array<number>(n).fill(floor)
  for (const x of words) for (let k = Math.floor(x.start / 10); k < Math.ceil(x.end / 10); k++) mic[k] = voice
  for (const e of extra) for (let k = Math.floor(e.range[0] / 10); k < Math.ceil(e.range[1] / 10); k++) mic[k] = e.db
  return { frameMs: 10, startMs: 0, mic, system: null }
}

const cut = (id: number, start: number, end: number, gain = end - start, fixed = false): ShapeCut => ({ id, start, end, gain, fixed })

describe('perfil da voz (item 7): decide pelo nível RELATIVO', () => {
  const words = w([['a', 0, 400], ['b', 600, 1000], ['c', 1200, 1600], ['d', 1800, 2200], ['e', 2400, 2800], ['f', 3000, 3400]])

  it('voz forte e voz fraca dão o mesmo veredito: a referência é a mediana das palavras', () => {
    const strong = buildVoiceProfile(levelsFor(words, 4000, -25, -58), words)!
    const weak = buildVoiceProfile(levelsFor(words, 4000, -48, -78), words)!
    expect(strong.ok).toBe(true)
    expect(weak.ok).toBe(true)
    expect(strong.refDb).toBeCloseTo(-25, 5)
    expect(weak.refDb).toBeCloseTo(-48, 5)
    // o teto de "pausa" fica 12 dB abaixo da voz nos dois
    expect(strong.ceilingDb - strong.refDb).toBeCloseTo(weak.ceilingDb - weak.refDb, 5)
    // o ganho que levaria a voz a −20 dBFS vai para o aviso
    expect(weak.gainDb).toBeCloseTo(28, 5)
    expect(strong.gainDb).toBeCloseTo(5, 5)
  })

  it('voz perto demais do chiado (G1: 8,3 dB) não é ok e diz o porquê; sem faixa de microfone não há perfil', () => {
    const g1 = buildVoiceProfile(levelsFor(words, 4000, -48.7, -57), words)!
    expect(g1.ok).toBe(false)
    expect(g1.reason).toContain(`${MIN_SNR_DB} dB`)
    expect(buildVoiceProfile(null, words)).toBeNull()
    expect(buildVoiceProfile({ frameMs: 10, startMs: 0, mic: null, system: null }, words)).toBeNull()
    const few = buildVoiceProfile(levelsFor(words.slice(0, 2), 4000, -25, -58), words.slice(0, 2))!
    expect(few.ok).toBe(false)
    expect(few.reason).toContain('poucas palavras')
  })

  it('levelAt e meanLevel leem o quadro certo, com o deslocamento da voz', () => {
    const p = buildVoiceProfile({ frameMs: 10, startMs: 50, mic: [-60, -50, -40, -30], system: null }, [])!
    expect(levelAt(p, 49)).toBeNull()
    expect(levelAt(p, 50)).toBe(-60)
    expect(levelAt(p, 69)).toBe(-50)
    expect(levelAt(p, 75)).toBe(-40)
    expect(levelAt(p, 89)).toBe(-30)
    expect(levelAt(p, 90)).toBeNull()
    expect(meanLevel(p, 60, 80)).toBe(-45)
  })

  it('"fala sem palavra": limiar de 10 dB abaixo da voz; os 17 trechos reais (−3,6 a +1,6 dB) ficam como fala, ruído de sala não', () => {
    const base = w([['a', 0, 400], ['b', 600, 1000], ['c', 1200, 1600], ['d', 1800, 2200], ['e', 2400, 2800], ['f', 3000, 3400]])
    const extra = [
      { range: [3600, 4000] as [number, number], db: -25 - 3.6 }, // o mais baixo de G1/G2 em relação à voz
      { range: [4200, 4600] as [number, number], db: -25 + 1.6 }, // o mais alto
      { range: [4800, 5200] as [number, number], db: -25 - GAP_SPEECH_BELOW_VOICE_DB - 3 }, // respiração/ruído de boca
      { range: [5400, 5800] as [number, number], db: -58 } // sala
    ]
    const p = buildVoiceProfile(levelsFor(base, 6000, -25, -58, extra), base)!
    expect(isLoudGapSpeech(p, { start: 3600, end: 4000 })).toBe(true)
    expect(isLoudGapSpeech(p, { start: 4200, end: 4600 })).toBe(true)
    expect(isLoudGapSpeech(p, { start: 4800, end: 5200 })).toBe(false)
    expect(isLoudGapSpeech(p, { start: 5400, end: 5800 })).toBe(false)
    expect(isLoudGapSpeech(null, { start: 3600, end: 4000 })).toBe(false)
  })

  it('G1 (voz −49, chiado −57): a comparação é relativa e vale mesmo com perfil não ok', () => {
    const base = w([['a', 0, 400], ['b', 600, 1000], ['c', 1200, 1600], ['d', 1800, 2200], ['e', 2400, 2800], ['f', 3000, 3400]])
    const p = buildVoiceProfile(levelsFor(base, 6000, -48.7, -57, [{ range: [3600, 4000], db: -52.3 }, { range: [4200, 4600], db: -57 }]), base)!
    expect(p.ok).toBe(false)
    expect(isLoudGapSpeech(p, { start: 3600, end: 4000 })).toBe(true) // −52,3: acima do chão + 3 dB
    expect(isLoudGapSpeech(p, { start: 4200, end: 4600 })).toBe(false) // chiado puro
  })
})

describe('borda do corte (item 2)', () => {
  it('folga: ~100 ms depois da palavra que fica e ~50 ms antes da seguinte (150 ms de pausa na emenda)', () => {
    const words = w([['a', 0, 1000], ['hã', 1600, 1800], ['b', 2400, 3000]])
    const r = cutRangeAround(words, 1, 1, 4000, { profile: null })
    expect(r.start).toBe(1000 + EDGE_AFTER_MS)
    expect(r.end).toBe(2400 - EDGE_BEFORE_MS)
    expect(r.ok).toBe(true)
    expect(EDGE_AFTER_MS + EDGE_BEFORE_MS).toBe(150)
  })

  it('palavras encostadas (pausa 0 ms): sem nível, o corte não é feito; com pausa de pelo menos 40 ms, é', () => {
    const touching = w([['a', 0, 1000], ['hã', 1000, 1200], ['b', 1200, 1800]])
    expect(cutRangeAround(touching, 1, 1, 2500, { profile: null }).ok).toBe(false)
    const near = w([['a', 0, 1000], ['hã', 1000 + EDGE_MIN_PAUSE_MS, 1200], ['b', 1200 + EDGE_MIN_PAUSE_MS, 1800]])
    const r = cutRangeAround(near, 1, 1, 2500, { profile: null })
    expect(r.ok).toBe(true)
    expect(r.start).toBe(1000 + EDGE_MIN_PAUSE_MS) // a pausa toda, que é menor que os 100 ms
  })

  it('o erro de tempo do Whisper (palavra marcada 70 ms tarde) é compensado pelo vale de energia', () => {
    // o "hã" de verdade começa em 1500, mas o motor disse 1570; a pausa de verdade é 1000-1500
    const spoken = w([['a', 0, 1000], ['hã', 1500, 1700], ['b', 2200, 3000]])
    const reported = w([['a', 0, 1000], ['hã', 1570, 1770], ['b', 2200, 3000]])
    const levels = levelsFor(spoken, 3500, -25, -60)
    const profile = buildVoiceProfile(levels, spoken.concat(w([['x', 100, 300], ['y', 200, 400], ['z', 300, 500], ['u', 400, 600]])))!
    expect(profile.ok).toBe(true)
    const r = cutRangeAround(reported, 1, 1, 3500, { profile })
    expect(r.ok).toBe(true)
    // a borda do começo cai na pausa (1000-1500), nunca dentro do "hã" real
    expect(levelAt(profile, r.start + 1)).toBeLessThanOrEqual(profile.ceilingDb)
    expect(r.start).toBeLessThan(1500)
    expect(r.start).toBeGreaterThanOrEqual(1000)
  })

  it('borda que só cai em fala é recusada (ok: false), em vez de cortar a palavra', () => {
    // fala contínua: não há pausa nenhuma em ±80 ms
    const words = w([['a', 0, 1000], ['hã', 1000, 1300], ['b', 1300, 2000]])
    const levels = levelsFor([{ start: 0, end: 2200 }], 2500, -25, -60)
    const profile = buildVoiceProfile(levels, w([['a', 0, 400], ['b', 400, 800], ['c', 800, 1200], ['d', 1200, 1600], ['e', 1600, 2000]]))!
    const r = cutRangeAround(words, 1, 1, 2500, { profile })
    expect(r.ok).toBe(false)
  })

  it('snapToValley não mexe na borda que já é pausa (histerese) e escolhe o vale mais perto', () => {
    const levels: Levels = { frameMs: 10, startMs: 0, mic: Array.from({ length: 100 }, (_, k) => (k >= 40 && k < 60 ? -60 : -20)), system: null }
    const words = w([['a', 0, 100], ['b', 100, 200], ['c', 200, 300], ['d', 300, 400], ['e', 400, 500]])
    const profile = buildVoiceProfile(levels, words)!
    expect(snapToValley(500, 400, 600, profile)).toMatchObject({ t: 500, snapped: false, ok: true })
    const moved = snapToValley(700, 600, 800, profile)
    expect(moved.ok).toBe(false) // a janela de 80 ms em 700 não alcança a pausa de 400–600
    const near = snapToValley(660, 500, 800, profile)
    expect(near.snapped).toBe(true)
    expect(near.ok).toBe(true)
    expect(near.t).toBeLessThanOrEqual(600)
    expect(near.t).toBeGreaterThanOrEqual(580)
  })

  it('começo e fim do vídeo vão até a ponta e sempre são ok', () => {
    const words = w([['hã', 0, 300], ['a', 900, 1500], ['hã', 1500, 1700]])
    const head = cutRangeAround(words, 0, 0, 2000, { profile: null })
    expect(head).toMatchObject({ start: 0, ok: true })
    const tail = cutRangeAround(words, 2, 2, 2000, { profile: null })
    expect(tail.end).toBe(2000)
  })
})

describe('ritmo (item 3): lasca, fala curta, orçamento', () => {
  const D = 60_000
  const pacing = PACING.horizontal

  it('(a) lasca sem palavra entre dois cortes: os dois viram um só e a lasca sai junto', () => {
    const r = shapeCuts({ durationMs: D, cuts: [cut(0, 10_000, 11_000), cut(1, 11_170, 12_500)], speech: [], pacing })
    expect([...r.keep].sort()).toEqual([0, 1])
    expect(r.fill).toEqual([{ start: 11_000, end: 11_170 }])
    expect(r.dropped).toEqual({ sliver: 0, speech: 0, budget: 0 })
  })

  it('(a) lasca com palavra: desfaz o corte vizinho de MENOR ganho', () => {
    const r = shapeCuts({ durationMs: D, cuts: [cut(0, 10_000, 10_300), cut(1, 10_500, 12_000)], speech: [{ start: 10_300, end: 10_500 }], pacing })
    expect([...r.keep]).toEqual([1])
    expect(r.dropped.sliver).toBe(1)
  })

  it('(a) lasca de ruído no fim do vídeo (G1: 190 ms) entra no corte final; no começo também', () => {
    const tail = shapeCuts({ durationMs: D, cuts: [cut(0, 40_000, 59_810)], speech: [], pacing })
    expect(tail.fill).toEqual([{ start: 59_810, end: 60_000 }])
    const head = shapeCuts({ durationMs: D, cuts: [cut(0, 250, 3000)], speech: [], pacing })
    expect(head.fill).toEqual([{ start: 0, end: 250 }])
  })

  it('(b) trecho com fala < 1,2 s entre dois cortes: desfaz o vizinho de menor ganho, até todos respeitarem', () => {
    // fala de 0,9 s entre um silêncio de 2 s e outro de 0,7 s; depois 0,8 s de fala e um corte de 3 s
    const speech = [{ start: 12_000, end: 12_900 }, { start: 13_600, end: 14_400 }]
    const r = shapeCuts({ durationMs: D, cuts: [cut(0, 10_000, 12_000), cut(1, 12_900, 13_600), cut(2, 14_400, 17_400)], speech, pacing })
    // o de 0,7 s (id 1) é o menor vizinho dos dois trechos curtos: sai; sobra uma fala contínua de 12 000 a 14 400 (2,4 s)
    expect([...r.keep].sort()).toEqual([0, 2])
    expect(r.dropped.speech).toBe(1)
    expect(MIN_SPEECH_KEEP_MS).toBe(1200)
  })

  it('(b) o recomeço ("errei") tem ganho de sobra: perde o silêncio, nunca o recomeço', () => {
    const speech = [{ start: 20_300, end: 21_000 }]
    const r = shapeCuts({ durationMs: D, cuts: [cut(0, 18_000, 20_300, 2300), cut(1, 21_000, 23_000, 2000 + 5000)], speech, pacing })
    expect([...r.keep]).toEqual([1])
  })

  it('(c) orçamento: acima de 6 emendas/min no horizontal, ficam as de maior ganho', () => {
    // 10 cortes de ganhos 1..10 s, espaçados de 5 s, vídeo de 120 s: 10 emendas em ~110 s (5,5/min) cabem; em 60 s não
    const cuts = Array.from({ length: 10 }, (_, i) => cut(i, 5000 + i * 5000, 5000 + i * 5000 + (i + 1) * 100))
    const roomy = shapeCuts({ durationMs: 120_000, cuts, speech: [], pacing })
    expect(roomy.keep.size).toBe(10)
    const tight = shapeCuts({ durationMs: 60_000, cuts, speech: [], pacing })
    const out = 60_000 - [...tight.keep].reduce((a, id) => a + cuts[id]!.end - cuts[id]!.start, 0)
    expect((tight.keep.size / out) * 60_000).toBeLessThanOrEqual(pacing.maxSeamsPerMin + 1e-9)
    // ficaram os maiores
    expect(Math.min(...tight.keep)).toBeGreaterThanOrEqual(10 - tight.keep.size)
    expect(tight.dropped.budget).toBe(10 - tight.keep.size)
  })

  it('(c) vertical aceita 12/min e horizontal 6/min', () => {
    expect(PACING.horizontal.maxSeamsPerMin).toBe(6)
    expect(PACING.vertical.maxSeamsPerMin).toBe(12)
    const cuts = Array.from({ length: 10 }, (_, i) => cut(i, 3000 + i * 5000, 3600 + i * 5000))
    const v = shapeCuts({ durationMs: 60_000, cuts, speech: [], pacing: PACING.vertical })
    const h = shapeCuts({ durationMs: 60_000, cuts, speech: [], pacing: PACING.horizontal })
    expect(v.keep.size).toBeGreaterThan(h.keep.size)
  })

  it('cortes fixos (manuais, "errei") contam como emenda mas nunca são desfeitos', () => {
    const cuts = [cut(0, 10_000, 10_300, 300, true), ...Array.from({ length: 6 }, (_, i) => cut(i + 1, 15_000 + i * 5000, 15_300 + i * 5000))]
    const r = shapeCuts({ durationMs: 60_000, cuts, speech: [], pacing })
    expect(r.keep.has(0)).toBe(true)
  })

  it('cortes nas pontas não são emendas', () => {
    expect(countSeams([{ start: 0, end: 2000 }, { start: 5000, end: 6000 }, { start: 58_000, end: 60_000 }], 60_000)).toBe(1)
    expect(SLIVER_MS).toBe(400)
  })
})

describe('tela ativa (item 5)', () => {
  it('clique, tecla, mudança do mapa de conteúdo e cursor andando viram trechos; a referência (t = 0) não conta', () => {
    const act = screenActivity(
      {
        clicks: [{ t: 10_000, upT: 10_080 }],
        keys: [{ t: 20_000 }, { t: 20_200 }],
        contentChanges: [{ t: 30_000, magnitude: 0.2 }, { t: 31_000, magnitude: 0.08 }, { t: 33_000, magnitude: 0.01 }, { t: 50_000, magnitude: 0.05 }],
        useCursor: true,
        cursor: [
          { t: 40_000, x: 0.1, y: 0.1 },
          { t: 40_100, x: 0.3, y: 0.3 },
          { t: 40_200, x: 0.5, y: 0.5 },
          { t: 41_000, x: 0.5, y: 0.5 },
          { t: 41_100, x: 0.5, y: 0.5 }
        ]
      },
      60_000
    )
    expect(act).toContainEqual({ start: 9_600, end: 10_880 })
    expect(act).toContainEqual({ start: 19_700, end: 20_800 })
    // 30 000 e 31 000 = mudou nos segundos 29-30 e 30-31; a de 0,01 (cursor piscando) não conta
    expect(act).toContainEqual({ start: 29_000, end: 31_000 })
    expect(act.some((r) => r.start <= 32_500 && r.end >= 33_000)).toBe(false)
    expect(act).toContainEqual({ start: 49_000, end: 50_000 })
    expect(act.some((r) => r.start <= 40_100 && r.end >= 40_200)).toBe(true)
    expect(act.some((r) => r.start < 1000)).toBe(false)
    // o cursor parado em 0,5, 0,5 não gera atividade
    expect(act.some((r) => r.start >= 41_000 && r.end <= 41_500)).toBe(false)
  })

  it('o cursor só entra se pedido: por padrão o ponteiro andando não segura o corte', () => {
    const cursor = [{ t: 1000, x: 0.1, y: 0.1 }, { t: 1100, x: 0.5, y: 0.5 }, { t: 1200, x: 0.9, y: 0.9 }]
    expect(screenActivity({ cursor }, 5000)).toEqual([])
    expect(screenActivity({ cursor, useCursor: true }, 5000)).toHaveLength(1)
  })

  it('contentChangesOf mede a variação média da grade; a primeira amostra é só a referência', () => {
    const c = contentChangesOf([
      { t: 0, cells: new Uint8Array([0, 0, 0, 0]) },
      { t: 1000, cells: new Uint8Array([255, 0, 0, 0]) },
      { t: 2000, cells: new Uint8Array([255, 51, 0, 0]) }
    ])
    expect(c).toEqual([{ t: 1000, magnitude: 0.25 }, { t: 2000, magnitude: 0.05 }])
  })

  it('o silêncio com tela ativa não é cortado; só o miolo parado sai', () => {
    const words = w([['a', 0, 1000], ['b', 9000, 10_000]])
    const input: CleanInput = { words, durationMs: 10_000, screenActive: [{ start: 3000, end: 5500 }] }
    let held = 0
    const items = silenceItems(input, 'tutorial', { split: 'lead', onHeld: (ms) => { held = ms } })
    // pausa de 8 s (1000-9000) menos a tela ativa (3000-5500): sobram 1000-3000 (2 s) e 5500-9000 (3,5 s)
    expect(items.map((i) => [i.start, i.end])).toEqual([
      [1000 + 187, 3000 - 93],
      [5500 + 187, 9000 - 93]
    ])
    expect(held).toBe(2500)
    // sem tela ativa o silêncio inteiro sai
    expect(silenceItems({ words, durationMs: 10_000 }, 'tutorial', { split: 'lead' })).toHaveLength(1)
  })

  it('o miolo parado que sobra menor que o mínimo (0,6 s) também fica', () => {
    const words = w([['a', 0, 1000], ['b', 9000, 10_000]])
    const items = silenceItems({ words, durationMs: 10_000, screenActive: [{ start: 1500, end: 8700 }] }, 'tutorial', { split: 'lead' })
    expect(items).toEqual([])
  })

  it('mergeRanges junta trechos que se tocam', () => {
    expect(mergeRanges([{ start: 5, end: 10 }, { start: 0, end: 6 }, { start: 20, end: 30 }])).toEqual([{ start: 0, end: 10 }, { start: 20, end: 30 }])
  })
})

describe('limpeza com ritmo (computeClean)', () => {
  const D = 40_000
  // fala em frases de ~1,5 s com pausas de 0,8 s: 18 frases; pausas viram cortes de silêncio
  const spec: [string, number, number][] = []
  for (let i = 0; i < 12; i++) spec.push([`p${i}`, i * 2300 + 200, i * 2300 + 1500])
  const words = w(spec)
  const levels = levelsFor(words, D, -25, -60)

  const base: CleanOptions = { ...DEFAULT_CLEAN, retakes: false }

  it('o padrão é o ritmo de tutorial (horizontal): pausa ≥ 0,6 s sai e deixa 0,28 s, repartida ~2/3 + ~1/3', () => {
    expect(DEFAULT_CLEAN.silence).toBe('tutorial')
    expect(pacingOf(DEFAULT_CLEAN)).toBe('horizontal')
    expect(pacingOf({ silence: 'fast' })).toBe('vertical')
    expect(pacingOf({ silence: 'fast', pacing: null })).toBeNull()
    const two = w([['p0', 200, 6200], ['p1', 7200, 13_200]])
    const r = computeClean({ words: two, durationMs: 13_500, levels: levelsFor(two, 13_500, -25, -60) }, base)
    const first = r.items.find((i) => i.reason === 'silence')!
    // a pausa 6200-7200 (1 s): fica 187 ms depois da palavra e 93 antes da seguinte → corte de 6387 a 7107
    expect(first.start).toBe(6200 + 187)
    expect(first.end).toBe(7200 - 93)
    expect(7200 - first.end + (first.start - 6200)).toBe(PACING.horizontal.keepMs)
    expect(r.pacing?.seamsPerMin).toBeLessThanOrEqual(PACING.horizontal.maxSeamsPerMin + 1e-9)
  })

  it('o resultado nunca passa do teto de emendas por minuto nem deixa trecho com fala < 1,2 s entre cortes', () => {
    for (const mode of ['tutorial', 'natural', 'fast', 'faster'] as const) {
      const r = computeClean({ words, durationMs: D, levels }, { ...base, silence: mode })
      const p = r.pacing!
      expect(p.seamsPerMin, mode).toBeLessThanOrEqual(PACING[p.id].maxSeamsPerMin + 1e-9)
      const cuts = r.items.filter((i) => i.kind === 'cut').sort((a, b) => a.start - b.start)
      for (let k = 0; k + 1 < cuts.length; k++) {
        const len = cuts[k + 1]!.start - cuts[k]!.end
        if (len <= 0) continue
        const talks = words.some((x) => Math.min(x.end, cuts[k + 1]!.start) - Math.max(x.start, cuts[k]!.end) >= 40)
        expect(len < 400 || (talks && len < MIN_SPEECH_KEEP_MS), `${mode}: trecho de ${len} ms entre ${cuts[k]!.end} e ${cuts[k + 1]!.start}`).toBe(false)
      }
    }
  })

  it('com pacing: null a limpeza volta a ser a de antes (sem relatório de ritmo)', () => {
    const r = computeClean({ words, durationMs: D, levels }, { ...base, silence: 'fast', pacing: null })
    expect(r.pacing).toBeUndefined()
    expect(r.items.find((i) => i.reason === 'silence')!.start).toBe(1500 + 75)
  })

  it('"fala sem palavra" alta não é cortada (item 4); baixa continua sendo hesitação', () => {
    const ws = w([['a', 0, 1000], ['b', 1200, 2200], ['c', 2400, 3400], ['d', 3600, 4600], ['e', 4800, 5800], ['…', 7000, 7600, 'gap-speech'], ['f', 9000, 10_000], ['…', 11_000, 11_500, 'gap-speech'], ['g', 12_500, 13_500]])
    const lv = levelsFor(ws.filter((x) => x.kind === 'word'), 14_000, -25, -60, [{ range: [7000, 7600], db: -27 }, { range: [11_000, 11_500], db: -55 }])
    const r = computeClean({ words: ws, durationMs: 14_000, levels: lv }, { ...base, silence: null })
    const gaps = r.items.filter((i) => i.category === 'gap-speech')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.start).toBeGreaterThan(10_000) // só o de 11 000 (nível de sala) é cortado
    expect(r.pacing!.keptGapSpeech).toBe(1)
    expect(r.pacing!.notices.join(' ')).toContain('fala sem palavra')
  })

  it('cortes que cairiam em fala contínua são recusados e contados (item 2)', () => {
    const ws = w([['a', 0, 1000], ['hã', 1000, 1300], ['b', 1300, 2000], ['c', 2000, 2600], ['d', 2600, 3200], ['e', 3200, 3800], ['f', 3800, 4400]])
    const lv = levelsFor([{ start: 0, end: 4400 }], 5000, -25, -60)
    const r = computeClean({ words: ws, durationMs: 5000, levels: lv }, { ...base, silence: null })
    expect(r.items.filter((i) => i.category === 'hesitation')).toHaveLength(0)
    expect(r.pacing!.unsafeEdges).toBe(1)
  })

  it('sem nível ou com a voz perto do chiado, avisa e decide só pelos tempos das palavras', () => {
    const none = computeClean({ words, durationMs: D }, base)
    expect(none.pacing!.voice).toBeNull()
    expect(none.pacing!.notices.join(' ')).toContain('Sem o nível do microfone')
    const noisy = computeClean({ words, durationMs: D, levels: levelsFor(words, D, -48.7, -57) }, base)
    expect(noisy.pacing!.voice!.ok).toBe(false)
    expect(noisy.pacing!.notices.join(' ')).toContain('Voz baixa demais')
  })

  it('a lasca de ruído entre duas pausas é preenchida e os pedaços viram UM item de pausa na lista', () => {
    // pausa de 2000 a 4700 interrompida por 100 ms de estalo (sem palavra): os dois cortes deixariam 380 ms no meio
    const ws = w([['a', 0, 2000], ['b', 4700, 8000], ['c', 8300, 12_000]])
    const lv = levelsFor(ws, 12_500, -25, -60, [{ range: [3000, 3100], db: -30 }])
    const r = computeClean({ words: ws, durationMs: 12_500, levels: lv }, { ...base, silence: 'tutorial' })
    const pausas = r.items.filter((i) => i.category === 'silence' && i.start < 5000)
    expect(pausas).toHaveLength(1)
    expect(pausas[0]).toMatchObject({ start: 2187, end: 4607 })
    expect(pausas[0]!.label).toBe('pausa de 2,4 s')
    expect(r.pacing!.filled).toBe(1)
    expect(r.counts.silence).toBe(r.items.filter((i) => i.category === 'silence').length)
  })

  it('cortes fixos (marcas de "errei") entram na conta de emendas', () => {
    const fixed = Array.from({ length: 3 }, (_, i) => ({ start: 5000 + i * 9000, end: 5400 + i * 9000 }))
    const r = computeClean({ words, durationMs: D, levels, fixedCuts: fixed }, base)
    expect(r.pacing!.seams).toBeGreaterThanOrEqual(3)
  })
})
