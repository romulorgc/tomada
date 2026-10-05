import { describe, expect, it } from 'vitest'
import { keptRanges, outputDuration, outputToSource, rangesLength, snapToWord, sourceToOutput } from '@shared/timeline'
import type { Cut } from '@shared/types'

const cut = (start: number, end: number, enabled = true): Pick<Cut, 'start' | 'end' | 'enabled'> => ({
  start,
  end,
  enabled
})

describe('keptRanges', () => {
  it('sem cortes mantém tudo', () => {
    expect(keptRanges(10_000, [])).toEqual([{ start: 0, end: 10_000 }])
  })

  it('um corte no meio parte em dois', () => {
    expect(keptRanges(10_000, [cut(3000, 5000)])).toEqual([
      { start: 0, end: 3000 },
      { start: 5000, end: 10_000 }
    ])
  })

  it('cortes fora de ordem saem ordenados', () => {
    expect(keptRanges(10_000, [cut(7000, 8000), cut(1000, 2000)])).toEqual([
      { start: 0, end: 1000 },
      { start: 2000, end: 7000 },
      { start: 8000, end: 10_000 }
    ])
  })

  it('cortes sobrepostos viram um só', () => {
    expect(keptRanges(10_000, [cut(2000, 5000), cut(4000, 7000), cut(2500, 3000)])).toEqual([
      { start: 0, end: 2000 },
      { start: 7000, end: 10_000 }
    ])
  })

  it('cortes adjacentes não deixam trecho de duração zero entre eles', () => {
    expect(keptRanges(10_000, [cut(2000, 4000), cut(4000, 6000)])).toEqual([
      { start: 0, end: 2000 },
      { start: 6000, end: 10_000 }
    ])
  })

  it('cortes desligados são ignorados', () => {
    expect(keptRanges(10_000, [cut(2000, 4000, false)])).toEqual([{ start: 0, end: 10_000 }])
    expect(keptRanges(10_000, [cut(2000, 4000, false), cut(6000, 7000)])).toEqual([
      { start: 0, end: 6000 },
      { start: 7000, end: 10_000 }
    ])
  })

  it('corte que passa da duração é limitado', () => {
    expect(keptRanges(10_000, [cut(8000, 99_000)])).toEqual([{ start: 0, end: 8000 }])
  })

  it('corte começando antes de zero é limitado', () => {
    expect(keptRanges(10_000, [cut(-500, 1500)])).toEqual([{ start: 1500, end: 10_000 }])
  })

  it('corte inteiro além da duração não corta nada', () => {
    expect(keptRanges(10_000, [cut(10_000, 12_000), cut(20_000, 30_000)])).toEqual([{ start: 0, end: 10_000 }])
  })

  it('corte de duração zero (ou invertido) não corta nada', () => {
    expect(keptRanges(10_000, [cut(3000, 3000)])).toEqual([{ start: 0, end: 10_000 }])
    expect(keptRanges(10_000, [cut(5000, 4000)])).toEqual([{ start: 0, end: 10_000 }])
  })

  it('corte cobrindo tudo deixa nada', () => {
    expect(keptRanges(10_000, [cut(0, 10_000)])).toEqual([])
    expect(keptRanges(10_000, [cut(-1, 99_999)])).toEqual([])
    expect(keptRanges(10_000, [cut(0, 5000), cut(5000, 10_000)])).toEqual([])
  })

  it('corte colado no começo ou no fim', () => {
    expect(keptRanges(10_000, [cut(0, 2000)])).toEqual([{ start: 2000, end: 10_000 }])
    expect(keptRanges(10_000, [cut(8000, 10_000)])).toEqual([{ start: 0, end: 8000 }])
  })

  it('duração zero, negativa ou inválida não tem trechos', () => {
    expect(keptRanges(0, [])).toEqual([])
    expect(keptRanges(-5, [cut(0, 1)])).toEqual([])
    expect(keptRanges(Number.NaN, [])).toEqual([])
  })

  it('não altera os cortes recebidos', () => {
    const cuts = [cut(4000, 6000), cut(1000, 5000)]
    const copy = structuredClone(cuts)
    keptRanges(10_000, cuts)
    expect(cuts).toEqual(copy)
  })
})

describe('outputDuration / rangesLength', () => {
  it('soma o que sobra', () => {
    expect(outputDuration(10_000, [cut(2000, 4000), cut(6000, 7000)])).toBe(7000)
  })
  it('tudo cortado = 0', () => {
    expect(outputDuration(10_000, [cut(0, 10_000)])).toBe(0)
  })
  it('sem cortes = duração inteira', () => {
    expect(outputDuration(10_000, [])).toBe(10_000)
  })
  it('rangesLength soma os intervalos', () => {
    expect(
      rangesLength([
        { start: 0, end: 100 },
        { start: 300, end: 450 }
      ])
    ).toBe(250)
  })
})

describe('sourceToOutput / outputToSource', () => {
  // Origem 0-10 s, cortes 2-4 s e 6-7 s → mantidos: [0,2) [4,6) [7,10); saída = 7 s
  const kept = keptRanges(10_000, [cut(2000, 4000), cut(6000, 7000)])

  it('dentro de um trecho mantido, é o deslocamento acumulado', () => {
    expect(sourceToOutput(0, kept)).toBe(0)
    expect(sourceToOutput(1000, kept)).toBe(1000)
    expect(sourceToOutput(4500, kept)).toBe(2500)
    expect(sourceToOutput(8000, kept)).toBe(5000)
  })

  it('dentro de um corte, vale o ponto de emenda na saída', () => {
    expect(sourceToOutput(3000, kept)).toBe(2000)
    expect(sourceToOutput(6500, kept)).toBe(4000)
  })

  it('exatamente na borda do corte dá o mesmo ponto dos dois lados', () => {
    expect(sourceToOutput(2000, kept)).toBe(2000)
    expect(sourceToOutput(4000, kept)).toBe(2000)
    expect(sourceToOutput(6000, kept)).toBe(4000)
    expect(sourceToOutput(7000, kept)).toBe(4000)
  })

  it('fora dos limites: limita', () => {
    expect(sourceToOutput(-100, kept)).toBe(0)
    expect(sourceToOutput(10_000, kept)).toBe(7000)
    expect(sourceToOutput(99_999, kept)).toBe(7000)
  })

  it('outputToSource devolve o tempo de origem', () => {
    expect(outputToSource(0, kept)).toBe(0)
    expect(outputToSource(1000, kept)).toBe(1000)
    expect(outputToSource(2500, kept)).toBe(4500)
    expect(outputToSource(4000, kept)).toBe(7000)
    expect(outputToSource(6000, kept)).toBe(9000)
  })

  it('na emenda, devolve o início do trecho seguinte', () => {
    expect(outputToSource(2000, kept)).toBe(4000)
    expect(outputToSource(4000, kept)).toBe(7000)
  })

  it('no fim da saída, devolve o fim do último trecho; além disso, limita', () => {
    expect(outputToSource(7000, kept)).toBe(10_000)
    expect(outputToSource(50_000, kept)).toBe(10_000)
    expect(outputToSource(-10, kept)).toBe(0)
  })

  it('ida e volta nos pontos mantidos', () => {
    for (const t of [0, 500, 1999, 4000, 5999, 7000, 9999]) {
      expect(outputToSource(sourceToOutput(t, kept), kept)).toBe(t)
    }
  })

  it('sem trechos mantidos tudo vira 0', () => {
    expect(sourceToOutput(5000, [])).toBe(0)
    expect(outputToSource(5000, [])).toBe(0)
  })

  it('com o primeiro trecho cortado, o início da saída é o fim do corte', () => {
    const k = keptRanges(10_000, [cut(0, 3000)])
    expect(outputToSource(0, k)).toBe(3000)
    expect(sourceToOutput(1000, k)).toBe(0)
  })
})

describe('snapToWord', () => {
  const words = [
    { start: 1000, end: 1400 },
    { start: 1500, end: 2100 },
    { start: 3000, end: 3300 }
  ]

  it('dentro de uma palavra vai para a borda mais próxima', () => {
    expect(snapToWord(1100, words)).toBe(1000) // mais perto do início
    expect(snapToWord(1350, words)).toBe(1400) // mais perto do fim
    expect(snapToWord(1900, words)).toBe(2100)
  })

  it('empate vai para o início', () => {
    expect(snapToWord(1200, words)).toBe(1000)
  })

  it('exatamente na borda da palavra não mexe', () => {
    expect(snapToWord(1000, words)).toBe(1000)
    expect(snapToWord(1400, words)).toBe(1400)
    expect(snapToWord(1500, words)).toBe(1500)
    expect(snapToWord(2100, words)).toBe(2100)
  })

  it('no silêncio fica onde está', () => {
    expect(snapToWord(2500, words)).toBe(2500)
    expect(snapToWord(0, words)).toBe(0)
    expect(snapToWord(9000, words)).toBe(9000)
  })

  it('no silêncio, com gapSnapMs gruda na borda mais próxima dentro do alcance', () => {
    expect(snapToWord(2200, words, { gapSnapMs: 200 })).toBe(2100)
    expect(snapToWord(2900, words, { gapSnapMs: 200 })).toBe(3000)
    expect(snapToWord(2500, words, { gapSnapMs: 200 })).toBe(2500) // longe demais
    expect(snapToWord(500, words, { gapSnapMs: 600 })).toBe(1000) // antes da 1ª palavra
    expect(snapToWord(3500, words, { gapSnapMs: 600 })).toBe(3300) // depois da última
  })

  it('sem palavras devolve o próprio tempo', () => {
    expect(snapToWord(1234, [])).toBe(1234)
  })
})
