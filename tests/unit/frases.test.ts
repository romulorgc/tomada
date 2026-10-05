import { describe, expect, it } from 'vitest'
import { buildSentences, countBetween, keptMsBetween, sentenceAtPos, sentenceAtTime, sentenceFromPos } from '../../src/shared/sentences'
import type { Word } from '../../src/shared/types'
import { buildDemo } from '../helpers/demo-script'

/** Palavras a 300 ms cada, com `gap` entre elas; `kind` por posição se quiser. */
function make(tokens: string[], opts: { gap?: number; start?: number; kinds?: Record<number, Word['kind']>; gaps?: Record<number, number> } = {}): Word[] {
  const out: Word[] = []
  let t = opts.start ?? 0
  tokens.forEach((text, i) => {
    out.push({ i, text, start: t, end: t + 300, prob: 0.9, kind: opts.kinds?.[i] ?? 'word' })
    t += 300 + (opts.gaps?.[i] ?? opts.gap ?? 40)
  })
  return out
}

describe('frases: onde uma frase começa e termina', () => {
  it('quebra no ponto, na interrogação e na exclamação, e guarda o texto como foi dito', () => {
    const w = make(['Oi', 'pessoal.', 'Tudo', 'bem?', 'Vamos', 'lá!'])
    const s = buildSentences(w)
    expect(s.map((x) => x.text)).toEqual(['Oi pessoal.', 'Tudo bem?', 'Vamos lá!'])
    expect(s.map((x) => [x.first, x.last])).toEqual([[0, 1], [2, 3], [4, 5]])
    expect(s[0]).toMatchObject({ startMs: 0, endMs: 640, words: 2 })
  })

  it('pausa longa fecha a frase de quem não pontua, mas frase de 3 palavras ou menos não se parte por pausa', () => {
    const w = make(['clica', 'aqui', 'agora', 'depois', 'salva', 'tudo', 'e', 'fecha'], { gaps: { 4: 1200, 1: 1200 } })
    // a pausa de 1,2 s depois de "aqui" (2ª palavra) não parte (frase de 2 palavras); a depois de "salva" (5ª) parte
    expect(buildSentences(w).map((x) => x.text)).toEqual(['clica aqui agora depois salva', 'tudo e fecha'])
  })

  it('frase longa e sem ponto é partida numa vírgula depois de 24 palavras; passando de 40, parte onde estiver', () => {
    const tokens = Array.from({ length: 30 }, (_, k) => (k === 25 ? 'palavra,' : 'palavra'))
    const s = buildSentences(make(tokens))
    expect(s.map((x) => x.words)).toEqual([26, 4])
    const all = buildSentences(make(Array.from({ length: 95 }, () => 'palavra')))
    expect(all.every((x) => x.words <= 40)).toBe(true)
    expect(all.reduce((a, x) => a + x.words, 0)).toBe(95)
  })

  it('hesitação e fala sem palavra não entram no texto, mas os números de palavra seguem os da transcrição', () => {
    const w = make(['Eu', 'abro', 'hã', '…', 'a', 'agenda.'], { kinds: { 2: 'filler', 3: 'gap-speech' } })
    const [s] = buildSentences(w)
    expect(s).toMatchObject({ text: 'Eu abro a agenda.', words: 4, first: 0, last: 5, firstPos: 0, lastPos: 5 })
    // a hesitação no INÍCIO não puxa o começo da frase para trás
    const lead = buildSentences(make(['hã', 'Agora', 'não.'], { kinds: { 0: 'filler' } }))
    expect(lead[0]).toMatchObject({ text: 'Agora não.', first: 1, firstPos: 1 })
  })

  it('conta os cliques e as teclas que caem dentro da frase (com folga curta antes e depois)', () => {
    const w = make(['Clico', 'aqui.', 'Depois', 'digito', 'o', 'nome.'], { start: 1000 })
    const s = buildSentences(w, { clicks: [1100, 9000], keys: [3500, 3600, 3700, 20_000] })
    expect(s[0]).toMatchObject({ clicks: 1, keys: 0 })
    expect(s[1]).toMatchObject({ clicks: 0, keys: 3 })
    expect(countBetween([1, 5, 9], 5, 9)).toBe(2)
    expect(countBetween([], 0, 10)).toBe(0)
  })

  it('o roteiro de demonstração vira 36 frases e a abertura é a primeira', () => {
    const demo = buildDemo()
    const s = buildSentences(demo.words, { clicks: demo.clicks, keys: demo.keys })
    expect(s).toHaveLength(demo.sentences.length)
    expect(s[0]!.text).toBe('Oi pessoal, tudo bem?')
    for (let k = 0; k < s.length; k++) {
      expect(s[k]!.first).toBe(demo.sentences[k]!.firstWord)
      expect(s[k]!.last).toBe(demo.sentences[k]!.lastWord)
    }
    // "Em três cliques o horário está marcado" tem ação na tela; a abertura, não
    expect(s[0]!.clicks + s[0]!.keys).toBe(0)
    expect(s.some((x) => x.clicks > 0)).toBe(true)
  })
})

describe('frases: achar uma frase pela posição ou pelo tempo', () => {
  const w = make(['Um', 'dois.', 'hã', 'Três', 'quatro.'], { kinds: { 2: 'filler' }, gap: 400 })
  const s = buildSentences(w)

  it('sentenceAtPos acha a frase da palavra e devolve null na hesitação entre frases', () => {
    expect(sentenceAtPos(s, 0)).toBe(0)
    expect(sentenceAtPos(s, 1)).toBe(0)
    expect(sentenceAtPos(s, 2)).toBeNull()
    expect(sentenceAtPos(s, 3)).toBe(1)
    expect(sentenceAtPos(s, 99)).toBeNull()
  })

  it('sentenceFromPos devolve a primeira frase que começa daquela posição em diante', () => {
    expect(sentenceFromPos(s, 0)).toBe(0)
    expect(sentenceFromPos(s, 2)).toBe(1)
    expect(sentenceFromPos(s, 4)).toBe(2)
  })

  it('sentenceAtTime: dentro da frase, a frase; no vazio, a seguinte; sem frases, -1', () => {
    expect(sentenceAtTime(s, w[0]!.start + 10)).toBe(0)
    expect(sentenceAtTime(s, s[0]!.endMs + 100)).toBe(1)
    expect(sentenceAtTime(s, 10 ** 9)).toBe(1)
    expect(sentenceAtTime([], 5)).toBe(-1)
  })

  it('keptMsBetween soma só o que sobra dentro dos trechos mantidos', () => {
    const kept = [{ start: 0, end: 1000 }, { start: 2000, end: 3000 }]
    expect(keptMsBetween(kept, 500, 2500)).toBe(1000)
    expect(keptMsBetween(kept, 1000, 2000)).toBe(0)
    expect(keptMsBetween(kept, 0, 10_000)).toBe(2000)
  })
})
