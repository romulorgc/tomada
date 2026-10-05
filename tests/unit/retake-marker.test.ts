import { describe, expect, it } from 'vitest'
import { deriveRetakeCuts, markRecordingTime } from '../../src/shared/retake-marker'
import type { Word } from '../../src/shared/types'

const word = (i: number, text: string, start: number, end: number): Word => ({ i, text, start, end, prob: 1, kind: 'word' })

describe('marca errei', () => {
  it('desconta pausas fechadas e ignora a pausa atual', () => {
    expect(markRecordingTime(12_000, 1000, [{ start: 5000, end: 7000 }], null)).toEqual({ t: 9000 })
    expect(markRecordingTime(12_000, 1000, [], 10_000)).toBeNull()
    expect(markRecordingTime(500, 1000, [], null)).toBeNull()
  })
  it('corta a última frase antes da marca e inclui silêncio até a retomada', () => {
    const words = [word(0, 'Pronto.', 0, 500), word(1, 'Abra', 800, 1100), word(2, 'o', 1100, 1200), word(3, 'cadastro', 1200, 1700), word(4, 'Abra', 2400, 2700), word(5, 'o', 2700, 2800), word(6, 'cadastro.', 2800, 3300)]
    const result = deriveRetakeCuts({ words, marks: [{ t: 2000 }], durationMs: 4000 })
    expect(result.cuts).toMatchObject([{ start: 500, end: 2400, reason: 'retake', enabled: true }])
    expect(result.decisions).toMatchObject([{ t: 2000, confirmed: true, fallback: false }])
  })
  it('encontra fronteira por pausa sem pontuação e não exige repetição para a marca explícita', () => {
    const words = [word(0, 'Introdução', 0, 500), word(1, 'Texto', 1400, 1900), word(2, 'errado', 1900, 2300), word(3, 'Corrigido.', 2900, 3500)]
    const result = deriveRetakeCuts({ words, marks: [{ t: 2500 }], durationMs: 4000 })
    expect(result.cuts[0]).toMatchObject({ start: 500, end: 2900 })
    expect(result.decisions[0]).toMatchObject({ confirmed: false, fallback: false })
  })
  it('sem fronteira limita o fallback aos últimos seis segundos e sinaliza revisão', () => {
    const result = deriveRetakeCuts({ words: [], marks: [{ t: 10_000 }, { t: 1000 }], durationMs: 12_000 })
    expect(result.cuts.map(({ start, end }) => ({ start, end }))).toEqual([{ start: 0, end: 1000 }, { start: 4000, end: 10_000 }])
    expect(result.decisions.every((d) => d.fallback)).toBe(true)
  })
  it('ignora marcas inválidas ou fora da duração e não duplica uma marca', () => {
    expect(deriveRetakeCuts({ words: [], marks: [{ t: NaN }, { t: -1 }, { t: 9000 }, { t: 2000 }, { t: 2000 }], durationMs: 3000 }).cuts).toHaveLength(1)
  })
})
