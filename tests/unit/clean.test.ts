import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CLEAN,
  GUARD_MAX_MS,
  GUARD_MIN_MS,
  SILENCE_MODES,
  applyCleanup,
  computeClean,
  cutAround,
  muteAround,
  quietThreshold,
  retakeCutMs,
  retakesNeedConfirmation,
  scopeOf,
  silenceItems,
  suggestedCrutchIndexes,
  unionLength,
  validateRetakes,
  type CleanOptions,
  type Levels
} from '@shared/clean'
import { isHesitation, isSoftCrutch, normalizeToken } from '@shared/fillers'
import type { Cut, Word } from '@shared/types'

/** Palavras a partir de [texto, início, fim]; `kind` segue o léxico, como o `buildTranscript` faz. */
function words(spec: [string, number, number, Word['kind']?][]): Word[] {
  return spec.map(([text, start, end, kind], i) => ({ i, text, start, end, prob: 0.9, kind: kind ?? (isHesitation(text) ? 'filler' : 'word') }))
}

const OPT = (over: Partial<CleanOptions> = {}): CleanOptions => ({ ...DEFAULT_CLEAN, ...over })

describe('léxico das muletas', () => {
  it('hesitações puras: hã, hum, ahn, éé, eh (com pontuação e caixa) — e só elas', () => {
    for (const t of ['hã', 'Hã,', 'hãã', 'hum', 'Hum...', 'hmm', 'mmm', 'ahn', 'Ahn.', 'ãh', 'éé', 'é-é', 'ééé', 'eh', 'Eh,', 'uh', 'uhm']) expect(isHesitation(t), t).toBe(true)
    for (const t of ['é', 'né', 'tipo', 'então', 'ah', 'um', 'uma', 'hoje', 'ele', 'há', 'a', 'oh', '', '...']) expect(isHesitation(t), t).toBe(false)
  })

  it('muletas que podem ter sentido: né, tipo, então, é', () => {
    for (const t of ['né', 'Né?', 'tipo,', 'Então', 'é', 'É,']) expect(isSoftCrutch(t), t).toBe(true)
    for (const t of ['hã', 'ne', 'tipos', 'entao', 'era']) expect(isSoftCrutch(t), t).toBe(false)
    expect(normalizeToken('Hum...')).toBe('hum')
    expect(normalizeToken('é-é')).toBe('éé')
  })
})

describe('cutAround: a borda cai entre palavras, com folga', () => {
  const w = words([
    ['a', 0, 400],
    ['b', 500, 900],
    ['hã', 1000, 1200],
    ['c', 1300, 1700],
    ['d', 3000, 3400]
  ])

  it('corta a palavra e a pausa em volta, deixando a folga de cada lado', () => {
    const r = cutAround(w, 2, 2, 5000, 60)
    // pausa de 100 ms antes e 100 ms depois: a folga de 60 ms fica de cada lado
    expect(r).toEqual({ start: 900 + 60, end: 1300 - 60 })
  })

  it('pausa menor que a folga: o corte para na palavra (nunca entra na vizinha)', () => {
    const near = words([['a', 0, 400], ['hã', 420, 600], ['b', 640, 900]])
    expect(cutAround(near, 1, 1, 2000, 60)).toEqual({ start: 420, end: 600 })
  })

  it('a folga fica entre 30 e 200 ms, qualquer que seja o pedido', () => {
    expect(cutAround(w, 2, 2, 5000, 5).start).toBe(900 + GUARD_MIN_MS)
    expect(cutAround(w, 2, 2, 5000, 5000).start).toBe(900 + 100) // a pausa só tem 100 ms
    const wide = words([['a', 0, 400], ['b', 2000, 2400], ['c', 4000, 4400]])
    expect(cutAround(wide, 1, 1, 5000, 5000).start).toBe(400 + GUARD_MAX_MS)
  })

  it('no começo e no fim do vídeo o corte vai até a ponta', () => {
    expect(cutAround(w, 0, 0, 5000).start).toBe(0)
    expect(cutAround(w, 4, 4, 5000).end).toBe(5000)
  })

  it('várias palavras: cobre todas, com as pausas de dentro', () => {
    expect(cutAround(w, 1, 3, 5000, 60)).toEqual({ start: 400 + 60, end: 3000 - 60 })
  })

  it('índice fora da lista lança', () => {
    expect(() => cutAround(w, 3, 9, 5000)).toThrow(RangeError)
    expect(() => cutAround(w, 3, 2, 5000)).toThrow(RangeError)
  })

  it('muteAround fica dentro das pausas vizinhas', () => {
    expect(muteAround(w, 2, 5000)).toEqual({ start: 970, end: 1230 })
    const near = words([['a', 0, 400], ['hã', 410, 600], ['b', 610, 900]])
    expect(muteAround(near, 1, 2000)).toEqual({ start: 400, end: 610 })
  })
})

describe('silêncio', () => {
  // pausas: 300 ms, 600 ms, 1500 ms (e 200 ms de silêncio no começo, 800 ms no fim)
  const w = words([
    ['um', 200, 700],
    ['dois', 1000, 1500],
    ['três', 2100, 2600],
    ['quatro', 4100, 4600]
  ])
  const D = 5400

  it('Natural corta > 0,7 s e deixa 0,25 s (metade de cada lado); Rápido > 0,4 s deixa 0,15 s; Mais rápido > 0,25 s deixa 0,10 s', () => {
    const natural = silenceItems({ words: w, durationMs: D }, 'natural')
    expect(natural.map((i) => [i.start, i.end])).toEqual([
      [2600 + 125, 4100 - 125], // a pausa de 1,5 s
      [4600 + 125, D] // o silêncio final de 0,8 s vai até a ponta
    ])
    const fast = silenceItems({ words: w, durationMs: D }, 'fast')
    expect(fast.map((i) => [i.start, i.end])).toEqual([
      [1500 + 75, 2100 - 75], // 0,6 s
      [2600 + 75, 4100 - 75],
      [4600 + 75, D]
    ])
    const faster = silenceItems({ words: w, durationMs: D }, 'faster')
    expect(faster.map((i) => [i.start, i.end])).toEqual([
      [700 + 50, 1000 - 50], // 0,3 s
      [1500 + 50, 2100 - 50],
      [2600 + 50, 4100 - 50],
      [4600 + 50, D]
    ])
    expect(SILENCE_MODES.fast).toEqual({ minMs: 400, keepMs: 150 })
  })

  it('cada corte deixa exatamente `keep` de pausa entre as palavras que ficam', () => {
    for (const mode of ['natural', 'fast', 'faster'] as const) {
      const items = silenceItems({ words: w, durationMs: D }, mode)
      const between = items.find((i) => i.start > 2600 && i.end < 4100)!
      expect(4100 - 2600 - (between.end - between.start)).toBe(SILENCE_MODES[mode].keepMs)
    }
  })

  it('silêncio no começo vai até 0 e no fim até o fim do vídeo', () => {
    const lead = words([['oi', 1500, 2000]])
    const items = silenceItems({ words: lead, durationMs: 4000 }, 'fast')
    expect(items.map((i) => [i.start, i.end])).toEqual([
      [0, 1500 - 75],
      [2000 + 75, 4000]
    ])
  })

  it('sem palavras não corta nada (sem fala não dá para julgar)', () => {
    expect(silenceItems({ words: [], durationMs: 10_000 }, 'faster')).toEqual([])
  })

  it('fala que o VAD marcou numa pausa NÃO é silêncio: a pausa se divide', () => {
    const items = silenceItems({ words: w, durationMs: D, vad: [{ start: 3000, end: 3500 }] }, 'natural')
    // a pausa de 2600 a 4100 fica partida em volta dos 500 ms de fala: [2600,3000) e [3500,4100) < 0,7 s: nada a cortar ali
    expect(items.every((i) => i.end <= 3000 || i.start >= 3500)).toBe(true)
    expect(items.find((i) => i.start > 2600 && i.end < 4100)).toBeUndefined()
  })

  describe('nível do áudio', () => {
    // 20 ms por quadro, 270 quadros (5,4 s); tudo quieto (-90) exceto onde se disser
    const quiet = (): number[] => new Array<number>(270).fill(-90)
    const loud = (arr: number[], from: number, to: number, db = -20): number[] => {
      for (let k = Math.floor(from / 20); k < Math.floor(to / 20); k++) arr[k] = db
      return arr
    }
    const speech = (arr: number[]): number[] => {
      for (const [a, b] of [[200, 700], [1000, 1500], [2100, 2600], [4100, 4600]] as const) loud(arr, a, b)
      return arr
    }

    it('com o microfone e o som do computador quietos, corta normalmente', () => {
      const levels: Levels = { frameMs: 20, startMs: 0, mic: speech(quiet()), system: quiet() }
      const items = silenceItems({ words: w, durationMs: D, levels }, 'natural')
      expect(items.map((i) => [i.start, i.end])).toEqual([
        [2725, 3975],
        [4725, D]
      ])
    })

    it('som do computador tocando numa pausa: NÃO corta ali (microfone E som do computador quietos)', () => {
      const system = loud(quiet(), 2800, 3800, -25) // música no meio da pausa de 1,5 s
      const levels: Levels = { frameMs: 20, startMs: 0, mic: speech(quiet()), system }
      const items = silenceItems({ words: w, durationMs: D, levels }, 'natural')
      expect(items.find((i) => i.start > 2600 && i.end < 4100)).toBeUndefined()
      // o silêncio final (0,8 s) continua cortável
      expect(items.some((i) => i.end === D)).toBe(true)
    })

    it('barulho no microfone no meio de uma pausa a parte em duas (e só corta o que sobra comprido)', () => {
      const mic = speech(quiet())
      loud(mic, 3000, 3200, -30) // um estalo de 200 ms
      const levels: Levels = { frameMs: 20, startMs: 0, mic, system: null }
      const items = silenceItems({ words: w, durationMs: D, levels }, 'fast')
      const inside = items.filter((i) => i.start > 2600 && i.end < 4100)
      expect(inside.map((i) => [i.start, i.end])).toEqual([
        [2600 + 75, 3000 - 75], // 400 ms quietos
        [3200 + 75, 4100 - 75] // 900 ms quietos
      ])
    })

    it('o deslocamento da voz (startMs) vale: os quadros acompanham o tempo de origem', () => {
      const shifted = new Array<number>(270).fill(-90)
      for (const [a, b] of [[1200, 1700], [2000, 2500], [3100, 3600], [5100, 5600]] as const) loud(shifted, a - 1000, b - 1000)
      loud(shifted, 3000 - 1000, 3400 - 1000) // fala no mesmo lugar (3000–3400 de origem) que no teste do VAD
      const levels: Levels = { frameMs: 20, startMs: 1000, mic: shifted, system: null }
      const w2 = words([['a', 1200, 1700], ['b', 2000, 2500], ['c', 3100, 3600], ['d', 5100, 5600]])
      const items = silenceItems({ words: w2, durationMs: 6400, levels }, 'natural')
      expect(items.some((i) => i.start > 3000 && i.end < 3400)).toBe(false)
    })

    it('quietThreshold: chão de ruído + um terço até a fala, entre -60 e -35 dBFS', () => {
      expect(quietThreshold(new Array<number>(100).fill(-120))).toBe(-60)
      const mixed = [...new Array<number>(80).fill(-60), ...new Array<number>(20).fill(-20)]
      expect(quietThreshold(mixed)).toBeCloseTo(-60 + 40 / 3, 5)
      expect(quietThreshold([...new Array<number>(50).fill(-10), ...new Array<number>(50).fill(-5)])).toBe(-35)
    })
  })
})

describe('muletas', () => {
  it('hesitações puras e fala sem palavra entram por padrão; muleta com sentido só como sugestão', () => {
    const w = words([
      ['olá', 0, 400],
      ['hã', 500, 700],
      ['então', 800, 1200],
      ['né', 1250, 1400],
      ['mundo', 1500, 2000],
      ['…', 2100, 2500, 'gap-speech'],
      ['fim', 2600, 3000]
    ])
    const r = computeClean({ words: w, durationMs: 3200 }, OPT({ silence: null }))
    expect(r.items.map((i) => [i.category, i.words])).toEqual([
      ['hesitation', [1, 1]],
      ['gap-speech', [5, 5]]
    ])
    expect(r.counts).toMatchObject({ hesitation: 1, 'gap-speech': 1, crutch: 0 })
    expect(r.cutMs).toBeGreaterThan(0)
  })

  it('"né" e "é": sugestão quando isoladas por pausa de um lado; "tipo" e "então" só se isoladas dos DOIS lados', () => {
    const w = words([
      ['olá', 0, 400],
      ['é', 1500, 1700], // 1100 ms de pausa antes, 100 ms depois
      ['vamos', 1800, 2200],
      ['então', 3000, 3300], // pausa de 800 antes, mas 100 depois
      ['clicar', 3400, 3800],
      ['tipo', 5000, 5300], // pausa dos dois lados
      ['aqui', 6500, 6900]
    ])
    const idx = suggestedCrutchIndexes(w, 8000)
    expect(idx).toEqual([1, 5])
  })

  it('repetida ou colada numa hesitação vira sugestão', () => {
    const w = words([
      ['olá', 0, 400],
      ['tipo', 450, 700],
      ['tipo', 750, 1000],
      ['assim', 1050, 1400],
      ['hã', 2000, 2200],
      ['né', 2250, 2400],
      ['sim', 2450, 2800]
    ])
    expect(suggestedCrutchIndexes(w, 4000)).toEqual([1, 2, 5])
  })

  it('"é" no meio da frase (verbo) não é sugestão', () => {
    const w = words([['isso', 0, 300], ['é', 350, 450], ['bom', 500, 800]])
    expect(suggestedCrutchIndexes(w, 1000)).toEqual([])
  })

  it('a opção crutches inclui as sugestões; fillerMode decide cortar, silenciar ou misto', () => {
    const w = words([
      ['olá', 0, 400],
      ['hã', 500, 700],
      ['sim', 800, 1200],
      ['né', 2400, 2600],
      ['fim', 2700, 3100]
    ])
    const cut = computeClean({ words: w, durationMs: 4000 }, OPT({ silence: null, crutches: true, fillerMode: 'cut' }))
    expect(cut.items.map((i) => [i.category, i.kind])).toEqual([['hesitation', 'cut'], ['crutch', 'cut']])
    const mute = computeClean({ words: w, durationMs: 4000 }, OPT({ silence: null, crutches: true, fillerMode: 'mute' }))
    expect(mute.items.map((i) => [i.category, i.kind])).toEqual([['hesitation', 'mute'], ['crutch', 'mute']])
    expect(mute.cutMs).toBe(0)
    expect(mute.muteMs).toBeGreaterThan(0)
    const mixed = computeClean({ words: w, durationMs: 4000 }, OPT({ silence: null, crutches: true, fillerMode: 'mixed' }))
    expect(mixed.items.map((i) => [i.category, i.kind])).toEqual([['hesitation', 'cut'], ['crutch', 'mute']])
    // sem a opção, a muleta só é contada como sugestão
    const off = computeClean({ words: w, durationMs: 4000 }, OPT({ silence: null }))
    expect(off.suggestedCrutches).toBe(1)
    expect(off.items.some((i) => i.category === 'crutch')).toBe(false)
  })
})

describe('propriedade: nenhuma borda de corte cai dentro de uma palavra', () => {
  // gerador determinístico (mulberry32)
  const rng = (seed: number) => () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  it('em 200 transcrições aleatórias, com todas as opções ligadas', () => {
    const lexicon = ['olá', 'hã', 'tipo', 'né', 'então', 'é', 'hum', 'casa', 'vou', 'mostrar', 'a', 'tela', 'eh', 'ahn']
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed)
      const n = 5 + Math.floor(r() * 60)
      const spec: [string, number, number, Word['kind']?][] = []
      let t = Math.floor(r() * 800)
      for (let k = 0; k < n; k++) {
        const len = 80 + Math.floor(r() * 500)
        const text = lexicon[Math.floor(r() * lexicon.length)]!
        spec.push([r() < 0.05 ? '…' : text, t, t + len, r() < 0.05 ? 'gap-speech' : undefined])
        t += len + Math.floor(r() < 0.3 ? r() * 2500 : r() * 150)
      }
      const duration = t + Math.floor(r() * 2000)
      const w = words(spec)
      const all: CleanOptions = { silence: 'faster', hesitations: true, crutches: true, fillerMode: 'cut', retakes: true }
      const retakes = [{ from: 1, to: Math.min(n - 1, 4), reason: 'teste' }]
      const out = computeClean({ words: w, durationMs: duration, retakes }, all)
      for (const item of out.items) {
        expect(item.end, `semente ${seed}`).toBeGreaterThan(item.start)
        expect(item.start, `semente ${seed}`).toBeGreaterThanOrEqual(0)
        expect(item.end, `semente ${seed}`).toBeLessThanOrEqual(duration)
        if (item.reason === 'silence') {
          // o silêncio só corta onde não há palavra nenhuma
          for (const word of w) expect(item.end <= word.start || item.start >= word.end, `semente ${seed}: silêncio ${item.start}-${item.end} em cima de ${word.text} ${word.start}-${word.end}`).toBe(true)
        } else {
          // corte de palavras: a borda cai numa pausa (não dentro de uma palavra que FICA)
          const [a, b] = item.words!
          for (const word of w) {
            if (word.i >= a && word.i <= b) continue
            const inside = (x: number): boolean => x > word.start && x < word.end
            expect(inside(item.start) || inside(item.end), `semente ${seed}: ${item.category} ${item.start}-${item.end} corta ${word.text} ${word.start}-${word.end}`).toBe(false)
          }
        }
      }
    }
  })
})

describe('aplicar a limpeza ao documento', () => {
  const w = words([
    ['olá', 200, 700],
    ['hã', 800, 1000],
    ['sim', 1100, 1500],
    ['fim', 4000, 4400]
  ])
  const D = 5000
  const manual: Cut = { id: 'cut-1', start: 4500, end: 4800, reason: 'manual', enabled: true }

  it('substitui os cortes automáticos das categorias do escopo e mantém os manuais', () => {
    const result = computeClean({ words: w, durationMs: D }, OPT())
    const first = applyCleanup({ cuts: [manual] }, result.items, scopeOf(OPT()))
    expect(first.cuts.some((c) => c.reason === 'manual' && c.id === 'cut-1')).toBe(true)
    const reasons = first.cuts.map((c) => c.reason).sort()
    expect(reasons).toEqual(['filler', 'manual', 'silence', 'silence'])
    // aplicar de novo não empilha: o resultado é o mesmo
    const again = applyCleanup({ cuts: first.cuts }, result.items, scopeOf(OPT()))
    expect(again.cuts.map((c) => [c.start, c.end, c.reason])).toEqual(first.cuts.map((c) => [c.start, c.end, c.reason]))
    expect(new Set(again.cuts.map((c) => c.id)).size).toBe(again.cuts.length)
  })

  it('o que a pessoa restaurou (desligou) continua desligado ao aplicar de novo', () => {
    const result = computeClean({ words: w, durationMs: D }, OPT())
    const first = applyCleanup({ cuts: [] }, result.items, scopeOf(OPT()))
    const filler = first.cuts.find((c) => c.reason === 'filler')!
    const restored = first.cuts.map((c) => (c.id === filler.id ? { ...c, enabled: false } : c))
    const again = applyCleanup({ cuts: restored }, result.items, scopeOf(OPT()))
    expect(again.cuts.find((c) => c.reason === 'filler')!.enabled).toBe(false)
    expect(again.cuts.filter((c) => c.reason === 'silence').every((c) => c.enabled)).toBe(true)
  })

  it('categoria fora do escopo não é mexida; silenciar guarda em mutes', () => {
    const only = OPT({ silence: null, hesitations: true, fillerMode: 'mute' })
    const silent: Cut = { id: 'cut-9', start: 2000, end: 3000, reason: 'silence', enabled: true }
    const result = computeClean({ words: w, durationMs: D }, only)
    const out = applyCleanup({ cuts: [silent] }, result.items, scopeOf(only))
    expect(out.cuts).toEqual([silent])
    expect(out.mutes).toHaveLength(1)
    expect(out.mutes[0]).toMatchObject({ reason: 'filler', enabled: true })
    expect(out.mutes[0]!.start).toBeLessThanOrEqual(800)
    // trocar para "cortar" tira os mutes e põe cortes
    const cutAll = OPT({ silence: null, hesitations: true, fillerMode: 'cut' })
    const back = applyCleanup({ cuts: out.cuts, mutes: out.mutes }, computeClean({ words: w, durationMs: D }, cutAll).items, scopeOf(cutAll))
    expect(back.mutes).toEqual([])
    expect(back.cuts.some((c) => c.reason === 'filler')).toBe(true)
  })

  it('ids novos nunca repetem os que já existem', () => {
    const result = computeClean({ words: w, durationMs: D }, OPT())
    const out = applyCleanup({ cuts: [manual, { id: 'cut-7', start: 4900, end: 4950, reason: 'manual', enabled: true }] }, result.items, scopeOf(OPT()))
    expect(new Set(out.cuts.map((c) => c.id)).size).toBe(out.cuts.length)
  })

  it('unionLength não conta duas vezes o que se sobrepõe', () => {
    expect(unionLength([{ start: 0, end: 100 }, { start: 50, end: 200 }, { start: 300, end: 400 }])).toBe(300)
  })
})

describe('recomeços (IA)', () => {
  const w = words(Array.from({ length: 20 }, (_, k): [string, number, number] => [`p${k}`, k * 500, k * 500 + 400]))

  it('valida os índices: inteiros, dentro da transcrição, de ≤ até; o resto é descartado e contado', () => {
    const r = validateRetakes(
      [
        { from: 2, to: 4, reason: 'repetiu' },
        { from: 5, to: 3 }, // invertido
        { from: -1, to: 2 }, // negativo
        { from: 10, to: 99 }, // fora da faixa
        { from: 1.5, to: 3 }, // não inteiro
        { from: '3', to: '4' }, // texto
        { from: 7, to: 8 }
      ],
      20
    )
    expect(r.retakes.map((x) => [x.from, x.to])).toEqual([[2, 4], [7, 8]])
    expect(r.dropped).toBe(5)
  })

  it('funde trechos que se tocam e junta os motivos', () => {
    const r = validateRetakes([{ from: 2, to: 4, reason: 'a' }, { from: 5, to: 8, reason: 'b' }, { from: 3, to: 6, reason: 'a' }, { from: 12, to: 13 }], 20)
    expect(r.retakes).toEqual([
      { from: 2, to: 8, reason: 'a; b' },
      { from: 12, to: 13, reason: '' }
    ])
  })

  it('vira corte com motivo "retake"; trecho inexistente na lista é ignorado', () => {
    const r = computeClean({ words: w, durationMs: 10_000, retakes: [{ from: 3, to: 5, reason: 'recomeçou' }, { from: 40, to: 41, reason: 'x' }] }, OPT({ silence: null, hesitations: false, retakes: true }))
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ reason: 'retake', category: 'retake', words: [3, 5], label: 'recomeçou' })
    expect(r.items[0]!.start).toBeGreaterThan(w[2]!.end)
    expect(r.items[0]!.end).toBeLessThan(w[6]!.start)
  })

  it('cortar mais de 30% do vídeo pede confirmação', () => {
    expect(retakesNeedConfirmation(w, [{ from: 2, to: 4, reason: '' }], 10_000)).toBe(false)
    expect(retakesNeedConfirmation(w, [{ from: 2, to: 12, reason: '' }], 10_000)).toBe(true)
    expect(retakeCutMs(w, [{ from: 2, to: 4, reason: '' }], 10_000)).toBe(cutAround(w, 2, 4, 10_000).end - cutAround(w, 2, 4, 10_000).start)
    expect(retakesNeedConfirmation(w, [], 10_000)).toBe(false)
  })
})
