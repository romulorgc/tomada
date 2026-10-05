import { describe, expect, it } from 'vitest'
import { keptRanges } from '@shared/timeline'
import {
  PARAGRAPH_MAX_WORDS,
  buildParagraphs,
  carveOut,
  cutWords,
  durationAfter,
  findMatches,
  foldText,
  pauseAfter,
  restoreWords,
  struckWords,
  togglePause,
  wordCutRange,
  wordIndexAt
} from '@shared/text-edit'
import type { Cut, Word } from '@shared/types'

function words(spec: [string, number, number, Word['kind']?][]): Word[] {
  return spec.map(([text, start, end, kind], i) => ({ i, text, start, end, prob: 0.9, kind: kind ?? 'word' }))
}

/** 10 palavras de 400 ms com pausas de 100 ms entre elas, começando em 1000. */
const line = (n = 10, text = 'p'): Word[] => words(Array.from({ length: n }, (_, k): [string, number, number] => [`${text}${k}`, 1000 + k * 500, 1000 + k * 500 + 400]))

const cut = (id: string, start: number, end: number, reason: Cut['reason'] = 'manual', enabled = true): Cut => ({ id, start, end, reason, enabled })

describe('parágrafos', () => {
  it('pausa maior que 1,2 s quebra', () => {
    const w = words([['a', 0, 300], ['b', 400, 700], ['c', 2200, 2500], ['d', 2600, 2900]])
    expect(buildParagraphs(w).map((p) => [p.first, p.last])).toEqual([[0, 1], [2, 3]])
    // 1,2 s exatos não quebram
    const eq = words([['a', 0, 300], ['b', 1500, 1800]])
    expect(buildParagraphs(eq)).toHaveLength(1)
  })

  it('fim de frase quebra quando o parágrafo já tem corpo (12 palavras); antes disso, não', () => {
    const short = line(5)
    short[2]!.text = 'fim.'
    expect(buildParagraphs(short)).toHaveLength(1)
    const long = line(30)
    long[13]!.text = 'fim.'
    expect(buildParagraphs(long).map((p) => [p.first, p.last])).toEqual([[0, 13], [14, 29]])
  })

  it('nenhum parágrafo passa do máximo, e todas as palavras estão em algum parágrafo, em ordem', () => {
    const w = line(500)
    const ps = buildParagraphs(w)
    expect(ps.every((p) => p.last - p.first + 1 <= PARAGRAPH_MAX_WORDS)).toBe(true)
    expect(ps[0]!.first).toBe(0)
    expect(ps[ps.length - 1]!.last).toBe(499)
    for (let k = 1; k < ps.length; k++) expect(ps[k]!.first).toBe(ps[k - 1]!.last + 1)
    expect(buildParagraphs([])).toEqual([])
  })

  it('pauseAfter mede a pausa entre duas palavras (0 na última)', () => {
    const w = words([['a', 0, 300], ['b', 1500, 1800]])
    expect(pauseAfter(w, 0)).toBe(1200)
    expect(pauseAfter(w, 1)).toBe(0)
  })
})

describe('palavras cortadas', () => {
  it('o ponto médio dentro de um corte LIGADO risca a palavra; desligado não', () => {
    const w = line(6) // p0 1000–1400, p1 1500–1900, p2 2000–2400…
    const s = struckWords(w, [cut('c1', 1450, 2450), cut('c2', 3000, 3600, 'silence', false)])
    expect(s).toEqual([false, true, true, false, false, false])
  })

  it('corte que pega só a borda da palavra não a risca', () => {
    const w = line(3)
    expect(struckWords(w, [cut('c', 1300, 1500)])).toEqual([false, false, false]) // pega 100 ms de p0 (mid 1200) e nada de p1
  })

  it('aguenta cortes sobrepostos e fora de ordem', () => {
    const w = line(10)
    const s = struckWords(w, [cut('b', 3000, 4000), cut('a', 1000, 1900), cut('c', 1500, 3200)])
    expect(s.filter(Boolean).length).toBe(6) // p0..p5 menos o que cai fora: de 1000 a 4000
    expect(s[0]).toBe(true)
    expect(s[6]).toBe(false)
  })

  it('9.000 palavras em poucos milissegundos', () => {
    const w = line(9000)
    const cuts = Array.from({ length: 300 }, (_, k) => cut(`c${k}`, 1000 + k * 14_000, 1000 + k * 14_000 + 3000))
    const t0 = performance.now()
    const s = struckWords(w, cuts)
    expect(performance.now() - t0).toBeLessThan(100)
    expect(s.filter(Boolean).length).toBeGreaterThan(1000)
  })

  it('wordIndexAt: a última palavra que já começou', () => {
    const w = line(5)
    expect(wordIndexAt(w, 500)).toBe(-1)
    expect(wordIndexAt(w, 1000)).toBe(0)
    expect(wordIndexAt(w, 1499)).toBe(0)
    expect(wordIndexAt(w, 1500)).toBe(1)
    expect(wordIndexAt(w, 99_999)).toBe(4)
    expect(wordIndexAt([], 10)).toBe(-1)
  })
})

describe('apagar e restaurar palavras', () => {
  const w = line(8) // 400 ms por palavra, 100 ms de pausa
  const D = 6000

  it('apagar uma palavra corta ela e a pausa em volta, deixando 60 ms de cada lado', () => {
    const cuts = cutWords([], w, 3, 3, D)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]).toMatchObject({ reason: 'manual', enabled: true })
    // p2 termina em 2900, p3 vai de 2500 a 2900? (conferir pela função): a borda fica 60 ms depois do fim de p2
    const r = wordCutRange(w, 3, 3, D)
    expect(r.start).toBe(w[2]!.end + 60 - 0)
    expect(r.end).toBe(w[4]!.start - 60)
    // os trechos mantidos NÃO têm nenhuma palavra cortada ao meio
    const kept = keptRanges(D, cuts)
    for (const word of w) {
      if (word.i === 3) continue
      expect(kept.some((k) => k.start <= word.start && k.end >= word.end), word.text).toBe(true)
    }
  })

  it('apagar palavras seguidas funde num corte só; apagar de trás para frente dá o mesmo', () => {
    const a = cutWords(cutWords([], w, 2, 3, D), w, 4, 5, D)
    const b = cutWords([], w, 5, 2, D)
    expect(a).toHaveLength(1)
    expect(a[0]!.start).toBe(b[0]!.start)
    expect(a[0]!.end).toBe(b[0]!.end)
  })

  it('restaurar tira do corte o trecho das palavras: manual é recortado, o resto fica', () => {
    const cuts = cutWords([], w, 2, 6, D)
    const restored = restoreWords(cuts, w, 4, 4, D)
    expect(restored.filter((c) => c.enabled)).toHaveLength(2)
    const struck = struckWords(w, restored)
    expect(struck).toEqual([false, false, true, true, false, true, true, false])
  })

  it('restaurar tudo o que está cortado zera os cortes manuais', () => {
    const cuts = cutWords([], w, 2, 6, D)
    expect(restoreWords(cuts, w, 2, 6, D)).toEqual([])
  })

  it('corte automático restaurado só é desligado (dá para religar); o pedaço de fora continua ligado', () => {
    const auto = [cut('cut-1', 2000, 3000, 'filler')]
    const out = restoreWords(auto, w, 3, 3, D)
    expect(out.filter((c) => !c.enabled)).toHaveLength(1)
    expect(out.find((c) => !c.enabled)!.reason).toBe('filler')
    expect(out.filter((c) => c.enabled).every((c) => c.reason === 'filler')).toBe(true)
    expect(new Set(out.map((c) => c.id)).size).toBe(out.length)
  })

  it('carveOut: pedaços menores que o corte mínimo somem em vez de virar lasca', () => {
    const out = carveOut([cut('c', 1000, 2000)], 1010, 2000)
    expect(out).toEqual([])
  })

  it('apagar e restaurar nas pontas do vídeo', () => {
    const first = cutWords([], w, 0, 0, D)
    expect(first[0]!.start).toBe(0)
    const last = cutWords([], w, 7, 7, D)
    expect(last[0]!.end).toBe(D)
    expect(restoreWords(last, w, 7, 7, D)).toEqual([])
  })

  it('o corte de palavra é desfazível por quem usa: a duração cai e volta', () => {
    const cuts = cutWords([], w, 3, 4, D)
    expect(durationAfter(D, cuts)).toBeLessThan(D)
    expect(durationAfter(D, [])).toBe(D)
    expect(durationAfter(D, restoreWords(cuts, w, 3, 4, D))).toBe(D)
  })
})

describe('pausas clicáveis', () => {
  const w = words([['a', 0, 400], ['b', 2000, 2400], ['c', 2450, 2800]])
  it('clicar corta a pausa (com folga); clicar de novo restaura', () => {
    const once = togglePause([], w, 0, 5000)
    expect(once).toHaveLength(1)
    expect(once[0]).toMatchObject({ start: 460, end: 1940, reason: 'manual' })
    expect(togglePause(once, w, 0, 5000)).toEqual([])
  })
  it('pausa mais curta que as duas folgas não vira corte', () => {
    expect(togglePause([], w, 1, 5000)).toEqual([])
  })
})

describe('busca', () => {
  const w = words([['Olá,', 0, 300], ['pessoal.', 400, 800], ['Hoje', 900, 1200], ['eu', 1300, 1400], ['vou', 1500, 1700], ['mostrar', 1800, 2200], ['…', 2300, 2600, 'gap-speech'], ['Hoje', 2700, 3000], ['não', 3100, 3400]])

  it('palavra: sem ligar para acento, caixa e pontuação', () => {
    expect(findMatches(w, 'ola')).toEqual([{ first: 0, last: 0 }])
    expect(findMatches(w, 'HOJE')).toEqual([{ first: 2, last: 2 }, { first: 7, last: 7 }])
    expect(findMatches(w, 'nao')).toEqual([{ first: 8, last: 8 }])
  })

  it('frase de várias palavras', () => {
    expect(findMatches(w, 'eu vou mostrar')).toEqual([{ first: 3, last: 5 }])
    expect(findMatches(w, 'pessoal hoje')).toEqual([{ first: 1, last: 2 }])
    expect(findMatches(w, 'vou eu')).toEqual([])
  })

  it('pedaço de palavra também acha; vazio e fala sem palavra não', () => {
    expect(findMatches(w, 'most')).toEqual([{ first: 5, last: 5 }])
    expect(findMatches(w, '')).toEqual([])
    expect(findMatches(w, '   ')).toEqual([])
    expect(findMatches(w, '…')).toEqual([])
  })

  it('foldText', () => {
    expect(foldText('  Olá,  Pessoal! ')).toBe('ola pessoal')
    expect(foldText('AÇÃO')).toBe('acao')
  })
})
