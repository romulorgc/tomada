import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fromFasterWhisper, fromWhisperCpp, parseWhisperCppVad } from '@shared/transcript-engines'
import {
  GAP_SPEECH_TEXT,
  TranscriptFormatError,
  buildTranscript,
  findGapSpeech,
  parseTranscript,
  refineWordsWithVad,
  serializeTranscript,
  transcriptCounts,
  type RawWord
} from '@shared/transcript'
import { checkAgainstGabarito } from '../helpers/gabarito'

const data = (name: string): string => readFileSync(join(__dirname, 'data', name), 'utf8')

const base = {
  engine: 'teste',
  model: 'm',
  language: 'pt',
  durationMs: 10_000,
  segments: [],
  vad: [],
  offsetMs: 0,
  createdAt: '2026-10-05T00:00:00.000Z'
}

describe('parseTranscript', () => {
  it('aceita o formato antigo (confidence, sem i nem kind) e completa o que falta', () => {
    const t = parseTranscript(JSON.stringify({ language: 'pt', words: [{ text: 'hã', start: 500, end: 700, confidence: 0.9 }, { text: 'Olá', start: 100, end: 400, confidence: 0.95 }] }))
    expect(t.words.map((w) => [w.i, w.text, w.start, w.kind, w.prob])).toEqual([
      [0, 'Olá', 100, 'word', 0.95],
      [1, 'hã', 500, 'filler', 0.9]
    ])
    expect(t.engine).toBe('desconhecido')
    expect(t.durationMs).toBe(700)
    expect(t.vad).toEqual([])
  })

  it('ida e volta: o que se grava é o que se lê', () => {
    const built = buildTranscript({ ...base, words: [{ text: 'Olá,', start: 100, end: 500 }, { text: 'mundo.', start: 600, end: 1000 }], segments: [{ start: 100, end: 1000, text: ' Olá, mundo.' }] })
    expect(parseTranscript(serializeTranscript(built))).toEqual(built)
  })

  it('texto que não é JSON, objeto errado e palavra sem tempo viram erro com motivo', () => {
    expect(() => parseTranscript('{ nao é json')).toThrow(TranscriptFormatError)
    expect(() => parseTranscript('[]')).toThrow(/não é um objeto/)
    expect(() => parseTranscript(JSON.stringify({ words: [{ text: 'a' }] }))).toThrow(/transcript.json inválido/)
    expect(() => parseTranscript(JSON.stringify({ words: 'x' }))).toThrow(TranscriptFormatError)
  })

  it('palavra com fim antes do começo fica com duração zero, nunca negativa', () => {
    const t = parseTranscript(JSON.stringify({ words: [{ text: 'a', start: 500, end: 100 }] }))
    expect(t.words[0]).toMatchObject({ start: 500, end: 500 })
  })
})

describe('buildTranscript', () => {
  const w = (text: string, start: number, end: number, prob = 0.9): RawWord => ({ text, start, end, prob })

  it('soma o deslocamento da voz, numera e arredonda', () => {
    const t = buildTranscript({ ...base, offsetMs: 12.4, words: [w('a', 100.4, 200.6), w('b', 300, 400)], vad: [{ start: 90, end: 400 }] })
    expect(t.words.map((x) => [x.i, x.start, x.end])).toEqual([
      [0, 112, 213],
      [1, 312, 412]
    ])
    expect(t.vad).toEqual([{ start: 102, end: 412 }])
  })

  it('palavra que entra na seguinte: a anterior termina onde a próxima começa', () => {
    const t = buildTranscript({ ...base, words: [w('a', 100, 500), w('b', 400, 800)] })
    expect(t.words[0]!.end).toBe(400)
    expect(t.words[1]!.start).toBe(400)
  })

  it('palavra de duração zero ou invertida (o alinhamento do whisper.cpp às vezes entrega) vira de 10 ms, sem sobrepor e sem perder palavra', () => {
    const t = buildTranscript({ ...base, words: [w('a', 1000, 1000), w('b', 1000, 1000), w('c', 1000, 1200), w('d', 3000, 3000), w('e', 3500, 3400)] })
    expect(t.words.map((x) => x.text)).toEqual(['a', 'b', 'c', 'd', 'e'])
    t.words.forEach((x, k) => {
      expect(x.end - x.start, x.text).toBeGreaterThanOrEqual(10)
      if (k > 0) expect(x.start, x.text).toBeGreaterThanOrEqual(t.words[k - 1]!.end)
    })
    // só empurra para a frente, de poucos ms: ninguém se mexe mais que a soma das durações mínimas
    expect(t.words[0]!.start).toBe(1000)
    expect(t.words[3]!.start).toBe(3000)
    expect(t.words[2]!.start).toBeLessThanOrEqual(1030)
  })

  it('palavras já corretas não são tocadas pela ordem forçada', () => {
    const words = [w('a', 100, 400), w('b', 450, 800), w('c', 900, 1200)]
    const t = buildTranscript({ ...base, words })
    expect(t.words.map((x) => [x.start, x.end])).toEqual([[100, 400], [450, 800], [900, 1200]])
  })

  it('ignora texto vazio e ordena por começo', () => {
    const t = buildTranscript({ ...base, words: [w('  ', 0, 10), w('depois', 500, 900), w('antes', 100, 400)] })
    expect(t.words.map((x) => x.text)).toEqual(['antes', 'depois'])
  })

  it('hesitação pura vira filler; "né", "tipo", "é" continuam word', () => {
    const t = buildTranscript({ ...base, words: [w('Hã,', 100, 300), w('tipo,', 400, 700), w('né?', 800, 900), w('É,', 1000, 1100), w('Hum...', 1200, 1500)] })
    expect(t.words.map((x) => x.kind)).toEqual(['filler', 'word', 'word', 'word', 'filler'])
    expect(transcriptCounts(t)).toEqual({ words: 3, fillers: 2, gapSpeech: 0 })
  })

  it('o VAD marca fala onde não há palavra (> 250 ms): vira gap-speech, no lugar certo da ordem', () => {
    const t = buildTranscript({
      ...base,
      words: [w('antes', 100, 600), w('depois', 2000, 2500)],
      vad: [
        { start: 100, end: 600 },
        { start: 1000, end: 1500 }, // 500 ms de fala sem palavra
        { start: 2000, end: 2500 }
      ]
    })
    expect(t.words.map((x) => [x.kind, x.text])).toEqual([
      ['word', 'antes'],
      ['gap-speech', GAP_SPEECH_TEXT],
      ['word', 'depois']
    ])
    expect(t.words[1]).toMatchObject({ start: 1000, end: 1500, i: 1 })
    expect(t.words[2]!.i).toBe(2)
  })

  it('os segmentos apontam para as palavras finais (inclusive com gap-speech no meio)', () => {
    const t = buildTranscript({
      ...base,
      words: [w('a', 100, 300), w('b', 400, 600), w('c', 3000, 3200)],
      segments: [
        { start: 50, end: 700, text: ' a b' },
        { start: 2900, end: 3300, text: ' c' }
      ],
      vad: [{ start: 100, end: 600 }, { start: 1000, end: 1400 }, { start: 3000, end: 3200 }]
    })
    expect(t.segments.map((s) => [s.first, s.last, s.text])).toEqual([
      [0, 1, 'a b'],
      [3, 3, 'c']
    ])
  })
})

describe('findGapSpeech', () => {
  it('só conta a fala sem palavra de pelo menos 250 ms, com tolerância em volta das palavras', () => {
    const words = [{ start: 1000, end: 1500 }]
    // 100 ms antes da palavra (cabe na tolerância de 80 ms + resto de 20): nada
    expect(findGapSpeech(words, [{ start: 900, end: 1500 }])).toEqual([])
    // fala de 200 ms sem palavra: abaixo do mínimo
    expect(findGapSpeech(words, [{ start: 2000, end: 2200 }])).toEqual([])
    // fala de 400 ms sem palavra
    expect(findGapSpeech(words, [{ start: 2000, end: 2400 }])).toEqual([{ start: 2000, end: 2400 }])
  })

  it('fala que atravessa palavras só entrega os buracos', () => {
    const words = [{ start: 1000, end: 1200 }, { start: 2000, end: 2200 }]
    const out = findGapSpeech(words, [{ start: 500, end: 2700 }])
    expect(out).toEqual([
      { start: 500, end: 920 },
      { start: 1280, end: 1920 },
      { start: 2280, end: 2700 }
    ])
  })
})

describe('refineWordsWithVad', () => {
  it('a primeira palavra de um trecho de fala começa onde a fala começa (o Whisper a põe cedo demais)', () => {
    const out = refineWordsWithVad([{ text: 'Olá', start: 20, end: 680 }, { text: 'pessoal', start: 700, end: 900 }], [{ start: 390, end: 930 }])
    expect(out[0]).toMatchObject({ start: 390, end: 680 })
    expect(out[1]!.start).toBe(700)
  })

  it('a última palavra do trecho termina onde a fala termina (se faltar pouco)', () => {
    expect(refineWordsWithVad([{ text: 'fim', start: 1000, end: 1500 }], [{ start: 1000, end: 1800 }])[0]!.end).toBe(1800)
    // faltando mais de 450 ms, não estica (pode ser fala que o Whisper não transcreveu)
    expect(refineWordsWithVad([{ text: 'fim', start: 1000, end: 1500 }], [{ start: 1000, end: 2300 }])[0]!.end).toBe(1500)
  })

  it('palavra que passa do fim da fala é encurtada; nunca invade a vizinha', () => {
    const out = refineWordsWithVad([{ text: 'a', start: 100, end: 900 }, { text: 'b', start: 1000, end: 1100 }], [{ start: 100, end: 600 }, { start: 1000, end: 1100 }])
    expect(out[0]!.end).toBe(600)
    expect(out[1]).toMatchObject({ start: 1000, end: 1100 })
  })

  it('sem VAD, nada muda', () => {
    const words = [{ text: 'a', start: 1, end: 2 }]
    expect(refineWordsWithVad(words, [])).toEqual(words)
  })
})

describe('saída REAL dos motores (voz sintética, gabarito exato)', () => {
  it('faster-whisper: WER < 15%, toda marca a ±150 ms e as 4 muletas achadas', () => {
    const raw = fromFasterWhisper(JSON.parse(data('faster-whisper-voz.json')))
    const t = buildTranscript({ engine: 'faster-whisper', model: raw.model, language: raw.language, durationMs: raw.durationMs, words: raw.words, segments: raw.segments, vad: raw.vad, offsetMs: 0, createdAt: '' })
    const rep = checkAgainstGabarito(t)
    expect(rep.wer).toBeLessThan(0.15)
    expect(rep.worstErrMs).toBeLessThanOrEqual(150)
    expect(rep.fillersFound).toBe(4)
    expect(t.words.every((x, i) => x.i === i && x.end >= x.start)).toBe(true)
  })

  it('o VAD é o que conserta o começo das frases: sem ele o erro passa de 300 ms', () => {
    const raw = fromFasterWhisper(JSON.parse(data('faster-whisper-voz.json')))
    const t = buildTranscript({ engine: 'faster-whisper', model: '', language: 'pt', durationMs: raw.durationMs, words: raw.words, segments: raw.segments, vad: [], offsetMs: 0, createdAt: '' })
    expect(checkAgainstGabarito(t).worstErrMs).toBeGreaterThan(300)
  })

  it('whisper.cpp: lê tokens com DTW, cola pontuação na palavra e acha o texto', () => {
    const raw = fromWhisperCpp(JSON.parse(data('whisper-cpp-voz.json')))
    expect(raw.words.map((x) => x.text).slice(0, 4)).toEqual(['Olá,', 'pessoal.', 'Hoje', 'eu'])
    // o ponto não estica o "pessoal": o fim é o do último token de LETRAS (DTW em centésimos × 10)
    expect(raw.words[1]!.end).toBe(1600)
    const vad = parseWhisperCppVad(data('whisper-cpp-voz-vad.txt'))
    expect(vad[0]).toEqual({ start: 390, end: 1850 })
    expect(vad).toHaveLength(6)
    const t = buildTranscript({ engine: 'whisper.cpp', model: '', language: 'pt', durationMs: 22_693, words: raw.words, segments: raw.segments, vad, offsetMs: 0, createdAt: '' })
    expect(checkAgainstGabarito(t).wer).toBeLessThan(0.15)
  })

  it('whisper.cpp sem DTW usa os tempos de token', () => {
    const raw = fromWhisperCpp(JSON.parse(data('whisper-cpp-voz.json')), { useDtw: false })
    expect(raw.words[0]).toMatchObject({ text: 'Olá,', start: 330 })
  })
})
