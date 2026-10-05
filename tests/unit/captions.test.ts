import { describe, expect, it } from 'vitest'
import {
  LINK_WORDS,
  PAGE_HOLD_MS,
  PAGE_LEAD_MS,
  POP_AMOUNT,
  POP_PEAK_MS,
  buildCaptionPages,
  buildCaptionTrack,
  buildCues,
  captionAt,
  captionWords,
  formatCueTime,
  isDanglingLink,
  pageAlpha,
  popScale,
  shownText,
  splitPhrase,
  toSrt,
  toVtt,
  wordsPerPage,
  type CaptionWord
} from '@shared/captions'
import type { Cut, Mute, Word } from '@shared/types'

/** Palavras de teste: `[texto, início, fim]` em ms de origem. */
const mk = (list: [string, number, number][], kind: Word['kind'] = 'word'): Word[] =>
  list.map(([text, start, end], i) => ({ i, text, start, end, prob: 0.99, kind }))
const cut = (start: number, end: number, enabled = true): Cut => ({ id: `c${start}`, start, end, reason: 'manual', enabled })
const mute = (start: number, end: number): Mute => ({ id: `m${start}`, start, end, reason: 'manual', enabled: true })

/** Fala corrida: uma palavra a cada 400 ms (360 ms de fala). */
const run = (texts: string[], from = 0): Word[] => mk(texts.map((t, k) => [t, from + k * 400, from + k * 400 + 360]))
const cw = (texts: string[], from = 0): CaptionWord[] => captionWords(run(texts, from), { cuts: [], durationMs: 60_000 })

describe('captionWords: as palavras da legenda no tempo de saída', () => {
  it('sem cortes, o tempo de saída é o de origem', () => {
    const out = captionWords(mk([['Olá,', 400, 883], ['pessoal.', 883, 1753]]), { cuts: [], durationMs: 5000 })
    expect(out).toEqual([
      { i: 0, text: 'Olá,', start: 400, end: 883 },
      { i: 1, text: 'pessoal.', start: 883, end: 1753 }
    ])
  })

  it('só palavras de verdade: hesitação ("hã") e fala sem palavra não viram legenda', () => {
    const words: Word[] = [
      { i: 0, text: 'tipo', start: 0, end: 300, prob: 1, kind: 'word' },
      { i: 1, text: 'hã', start: 300, end: 500, prob: 1, kind: 'filler' },
      { i: 2, text: '', start: 500, end: 900, prob: 1, kind: 'gap-speech' },
      { i: 3, text: 'isso', start: 900, end: 1200, prob: 1, kind: 'word' }
    ]
    expect(captionWords(words, { cuts: [], durationMs: 2000 }).map((w) => w.text)).toEqual(['tipo', 'isso'])
  })

  it('palavra cortada (ponto médio dentro de um corte ligado) some; corte desligado não tira nada', () => {
    const words = mk([['a', 0, 400], ['b', 400, 800], ['c', 800, 1200]])
    expect(captionWords(words, { cuts: [cut(400, 800)], durationMs: 2000 }).map((w) => w.text)).toEqual(['a', 'c'])
    expect(captionWords(words, { cuts: [cut(400, 800, false)], durationMs: 2000 }).map((w) => w.text)).toEqual(['a', 'b', 'c'])
  })

  it('depois de um corte, o tempo de saída desloca a palavra para trás (3 s cortados = 3 s mais cedo)', () => {
    const words = mk([['a', 0, 400], ['b', 4000, 4400], ['c', 4400, 4800]])
    const out = captionWords(words, { cuts: [cut(1000, 4000)], durationMs: 6000 })
    expect(out.map((w) => [w.text, w.start, w.end])).toEqual([
      ['a', 0, 400],
      ['b', 1000, 1400],
      ['c', 1400, 1800]
    ])
  })

  it('trecho de voz silenciada (mudo) não vira legenda, mas não desloca o tempo', () => {
    const words = mk([['a', 0, 400], ['b', 400, 800], ['c', 800, 1200]])
    const out = captionWords(words, { cuts: [], mutes: [mute(400, 800)], durationMs: 2000 })
    expect(out.map((w) => [w.text, w.start])).toEqual([['a', 0], ['c', 800]])
  })

  it('a correção de texto (wordFixes) vale; correção vazia é ignorada', () => {
    const words = mk([['Sintomax', 0, 400], ['grava', 400, 800]])
    const out = captionWords(words, { cuts: [], wordFixes: { '0': 'Tomada', '1': '   ' }, durationMs: 2000 })
    expect(out.map((w) => w.text)).toEqual(['Tomada', 'grava'])
  })

  it('sem palavras, ou com tudo cortado: lista vazia', () => {
    expect(captionWords(null, { cuts: [], durationMs: 1000 })).toEqual([])
    expect(captionWords(mk([['a', 0, 100]]), { cuts: [cut(0, 1000)], durationMs: 1000 })).toEqual([])
  })
})

describe('buildCaptionPages: quebra em páginas', () => {
  const opts = { style: 'natural' as const, wordsPerLine: 3 }

  it('o limite é palavras por linha × linhas por página (uma linha por padrão)', () => {
    expect(wordsPerPage(3)).toBe(3)
    expect(wordsPerPage(1)).toBe(1)
    expect(wordsPerPage(0)).toBe(1) // nunca zero
    expect(wordsPerPage(3, 2)).toBe(6)
  })

  it('fim de frase fecha a página', () => {
    const pages = buildCaptionPages(cw(['Olá', 'pessoal.', 'Hoje', 'eu', 'vou']), opts)
    expect(pages.map((p) => p.words.map((w) => w.text))).toEqual([['Olá', 'pessoal.'], ['Hoje', 'eu', 'vou']])
  })

  it('pausa maior que 450 ms fecha a página; 450 ms exatos não', () => {
    const a: CaptionWord[] = [
      { i: 0, text: 'um', start: 0, end: 300 },
      { i: 1, text: 'dois', start: 750, end: 1000 }, // pausa de 450: junta
      { i: 2, text: 'três', start: 1501, end: 1800 } // pausa de 501: quebra
    ]
    const pages = buildCaptionPages(a, opts)
    expect(pages.map((p) => p.words.length)).toEqual([2, 1])
  })

  it('frase longa vira páginas PARELHAS (7 palavras com limite 3 = nenhuma página solta), nunca 3 + 3 + 1', () => {
    const sizes = buildCaptionPages(cw(['a', 'b', 'c', 'd', 'e', 'f', 'g']), opts).map((p) => p.words.length)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(7)
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(2)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3)
  })

  it('quebra em PONTUAÇÃO: a página fecha na vírgula quando ela está ao lado do ponto de partida', () => {
    const pages = buildCaptionPages(cw(['a', 'b', 'c', 'd,', 'e', 'f', 'g']), opts)
    const lasts = pages.map((p) => p.words[p.words.length - 1]!.text)
    expect(lasts).toContain('d,')
    const early = buildCaptionPages(cw(['a', 'b', 'c,', 'd', 'e', 'f', 'g']), opts)
    expect(early.map((p) => p.words[p.words.length - 1]!.text)).toContain('c,')
  })

  it('quebra em PAUSA: a emenda cai onde a pessoa para, mesmo longe do meio', () => {
    // seis palavras, limite 4: sem pausa seria 3 + 3; com 400 ms de pausa depois da segunda a página fecha ali (2 + 4)
    const w: CaptionWord[] = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'].map((text, k) => {
      const start = k * 400 + (k >= 2 ? 400 : 0)
      return { i: k, text, start, end: start + 360 }
    })
    const pages = buildCaptionPages(w, { style: 'natural', wordsPerLine: 4 })
    expect(pages.map((p) => p.words.map((x) => x.text).join(' '))).toEqual(['x1 x2', 'x3 x4 x5 x6'])
  })

  it('a página entra 60 ms antes da primeira palavra e fica 320 ms depois da última, sem passar da seguinte', () => {
    // sem vizinha perto: a página fica 320 ms depois da última palavra (c. termina em 2160)
    const alone = buildCaptionPages(cw(['a', 'b', 'c.'], 1000), opts)
    expect(alone[0]!.start).toBe(1000 - PAGE_LEAD_MS)
    expect(alone[0]!.end).toBe(2160 + PAGE_HOLD_MS)
    // a próxima começa em 2300: a página encolhe para a seguinte entrar 60 ms antes da sua primeira palavra
    const w: CaptionWord[] = [...cw(['a', 'b', 'c.'], 1000), { i: 3, text: 'd', start: 2300, end: 2600 }]
    const pages = buildCaptionPages(w, opts)
    expect(pages[0]!.end).toBe(2300 - PAGE_LEAD_MS)
    expect(pages[1]!.start).toBe(2300 - PAGE_LEAD_MS)
    // a página nunca some antes de a última palavra terminar, mesmo com a vizinha colada (d em 2200)
    const tight = buildCaptionPages([...cw(['a', 'b', 'c.'], 1000), { i: 3, text: 'd', start: 2200, end: 2500 }], opts)
    expect(tight[0]!.end).toBe(2160)
    expect(tight[1]!.start).toBeGreaterThanOrEqual(tight[0]!.end)
  })

  it('páginas nunca sobrepõem nem invertem, em fala corrida longa', () => {
    const texts = Array.from({ length: 80 }, (_, k) => (k % 7 === 6 ? `w${k}.` : `w${k}`))
    const pages = buildCaptionPages(cw(texts), { style: 'highlight', wordsPerLine: 2 })
    for (let k = 0; k < pages.length; k++) {
      expect(pages[k]!.end).toBeGreaterThan(pages[k]!.start)
      if (k > 0) expect(pages[k]!.start).toBeGreaterThanOrEqual(pages[k - 1]!.end)
      expect(pages[k]!.words.length).toBeLessThanOrEqual(wordsPerPage(2) + 3) // além do limite só para não deixar ligação pendurada
    }
    expect(pages.flatMap((p) => p.words).length).toBe(80) // nenhuma palavra se perde
  })

  it('Destaque e Karaokê tiram a pontuação de frase; Natural e Limpa mantêm', () => {
    expect(shownText('pessoal.', 'highlight')).toBe('pessoal')
    expect(shownText('Olá,', 'karaoke')).toBe('Olá')
    expect(shownText('"Então,"', 'highlight')).toBe('Então')
    expect(shownText('certo?', 'highlight')).toBe('certo?') // ? e ! ficam
    expect(shownText('pessoal.', 'natural')).toBe('pessoal.')
    expect(shownText('Olá,', 'clean')).toBe('Olá,')
    expect(shownText('...', 'highlight')).toBe('...') // não deixa a palavra vazia
    const p = buildCaptionPages(cw(['Olá,', 'pessoal.']), { style: 'highlight', wordsPerLine: 3 })
    expect(p[0]!.words.map((w) => w.shown)).toEqual(['Olá', 'pessoal'])
  })
})

describe('quebra de página: nunca termina em palavra de ligação, junta com a seguinte, evita palavra solta (nota §2 da R1)', () => {
  const texts = (pages: { words: { text: string }[] }[]): string[] => pages.map((p) => p.words.map((w) => w.text).join(' '))
  const opts2 = { style: 'natural' as const, wordsPerLine: 2 }

  it('a lista de ligação do pedido está toda lá', () => {
    for (const w of ['e', 'o', 'a', 'os', 'as', 'de', 'da', 'do', 'em', 'no', 'na', 'para', 'por', 'se', 'que', 'um', 'uma', 'com']) {
      expect(LINK_WORDS.has(w), w).toBe(true)
      expect(isDanglingLink(w), w).toBe(true)
    }
    expect(isDanglingLink('Que')).toBe(true) // caixa não importa
    expect(isDanglingLink('serviço')).toBe(false)
    expect(isDanglingLink('de,')).toBe(false) // com vírgula já é uma parada natural
    expect(isDanglingLink('e.')).toBe(false)
  })

  it('"DE E O / SERVIÇO": a ligação vai para a página seguinte, o "serviço" não fica sozinho', () => {
    const pages = buildCaptionPages(cw(['cuida', 'do', 'preço', 'de', 'e', 'o', 'serviço']), opts2)
    const t = texts(pages)
    for (const page of t.slice(0, -1)) expect(isDanglingLink(page.split(' ').pop()!), page).toBe(false)
    expect(t[t.length - 1]!.split(' ').length).toBeGreaterThanOrEqual(2) // a última página não é "serviço" sozinha
  })

  it('"ELE NÃO DEIXA E": a conjunção abre a página seguinte', () => {
    const pages = buildCaptionPages(cw(['ele', 'não', 'deixa', 'e', 'depois', 'muda']), opts2)
    const t = texts(pages)
    expect(t.some((p) => p.endsWith(' e') || p === 'e')).toBe(false)
    expect(t.join(' ')).toBe('ele não deixa e depois muda') // nenhuma palavra se perde nem muda de lugar
  })

  it('"HORÁRIO PARA / OUTRO DIA SE": preposição e "se" não fecham página', () => {
    const pages = buildCaptionPages(cw(['marca', 'o', 'horário', 'para', 'outro', 'dia', 'se', 'precisar', 'mesmo']), opts2)
    const t = texts(pages)
    for (const page of t.slice(0, -1)) expect(isDanglingLink(page.split(' ').pop()!), page).toBe(false)
  })

  it('em fala corrida longa nenhuma página (menos a última de cada frase) termina em ligação, em nenhum limite de 2 a 5', () => {
    const base = 'a gente vai cuidar do cadastro e do pagamento para que o cliente receba um aviso com a data do horário se quiser mudar por outro dia e em seguida'.split(' ')
    for (const wpl of [2, 3, 4, 5]) {
      const long = Array.from({ length: 4 }, () => base).flat().map((t, k) => (k % base.length === base.length - 1 ? t + '.' : t))
      const pages = buildCaptionPages(cw(long), { style: 'natural', wordsPerLine: wpl })
      pages.forEach((p, k) => {
        const last = p.words[p.words.length - 1]!.text
        const sentenceEnd = /[.!?…]$/u.test(last)
        if (!sentenceEnd && k < pages.length - 1) expect(isDanglingLink(last), `wpl ${wpl}: página "${p.words.map((w) => w.text).join(' ')}"`).toBe(false)
        expect(p.words.length).toBeLessThanOrEqual(wpl + 3)
      })
      expect(pages.flatMap((p) => p.words).length).toBe(long.length)
    }
  })

  it('palavra solta só existe quando a frase é de uma palavra (ou a pessoa pediu uma por vez)', () => {
    const pages = buildCaptionPages(cw(['agora', 'vamos', 'ver', 'isto', 'aqui']), opts2)
    expect(pages.every((p) => p.words.length >= 2)).toBe(true)
    const solo = buildCaptionPages(cw(['Pronto.']), opts2)
    expect(texts(solo)).toEqual(['Pronto.'])
    const oneByOne = buildCaptionPages(cw(['de', 'e', 'o']), { style: 'natural', wordsPerLine: 1 })
    expect(texts(oneByOne)).toEqual(['de', 'e', 'o']) // limite 1: nada a decidir
  })

  it('splitPhrase: uma frase que cabe fica inteira; vazia dá nada; o resultado cobre todas as palavras em ordem', () => {
    expect(splitPhrase([], 3)).toEqual([])
    const w = cw(['um', 'dois', 'três'])
    expect(splitPhrase(w, 3)).toEqual([w])
    const longer = cw(Array.from({ length: 11 }, (_, k) => `p${k}`))
    const groups = splitPhrase(longer, 3)
    expect(groups.flat().map((x) => x.text)).toEqual(longer.map((x) => x.text))
    expect(groups.every((g) => g.length >= 2 && g.length <= 4)).toBe(true)
  })
})

describe('buildCaptionTrack e captionAt', () => {
  const words = mk([['Olá,', 400, 883], ['pessoal.', 883, 1753], ['Hoje', 1753, 2236], ['eu', 2236, 2526]])
  const base = { cuts: [], mutes: [], wordFixes: {}, captions: { enabled: true, style: 'natural' as const, wordsPerLine: 3, position: 'bottom' as const, box: true, highlightColor: '#FFD93D' } }

  it('legenda desligada ou sem palavras: sem trilha', () => {
    expect(buildCaptionTrack(words, { ...base, captions: { ...base.captions, enabled: false } }, 5000)).toBeNull()
    expect(buildCaptionTrack(null, base, 5000)).toBeNull()
    expect(buildCaptionTrack([], base, 5000)).toBeNull()
  })

  it('a palavra acesa é a última que já começou; entre páginas não há legenda', () => {
    const track = buildCaptionTrack(words, base, 5000)!
    expect(track.pages).toHaveLength(2)
    expect(captionAt(track, 100)).toBeNull() // antes de tudo
    const m = captionAt(track, 1000)!
    expect(m.page.id).toBe(0)
    expect(m.active).toBe(1) // "pessoal." começou em 883
    expect(m.sinceActive).toBe(117)
    expect(captionAt(track, 450)!.active).toBe(0)
    expect(captionAt(track, 380)!.active).toBe(-1) // a página entrou, a primeira palavra ainda não
    expect(captionAt(track, 4000)).toBeNull() // depois da última página
  })

  it('cada montagem tem identificador próprio (o cache de camadas de texto não mistura)', () => {
    const a = buildCaptionTrack(words, base, 5000)!
    const b = buildCaptionTrack(words, base, 5000)!
    expect(a.id).not.toBe(b.id)
  })

  it('respeita cortes, mudos e correções na trilha', () => {
    const track = buildCaptionTrack(words, { ...base, cuts: [cut(1753, 2236)], mutes: [mute(2236, 2526)], wordFixes: { '0': 'Oi,' } }, 5000)!
    const all = track.pages.flatMap((p) => p.words.map((w) => w.text))
    expect(all).toEqual(['Oi,', 'pessoal.'])
  })
})

describe('popScale e pageAlpha', () => {
  it('sobe a 1 + amount em ~90 ms (pico exato) e volta a 1 sem passar por baixo', () => {
    expect(popScale(0)).toBe(1)
    expect(popScale(-5)).toBe(1)
    expect(popScale(POP_PEAK_MS)).toBeCloseTo(1 + POP_AMOUNT, 6)
    let max = 0
    for (let t = 1; t < 700; t++) {
      const s = popScale(t)
      expect(s).toBeGreaterThanOrEqual(1)
      max = Math.max(max, s)
    }
    expect(max).toBeCloseTo(1 + POP_AMOUNT, 3)
    expect(popScale(1000)).toBe(1)
    expect(popScale(Infinity)).toBe(1)
  })

  it('o pop respeita o amount do estilo (Karaokê é mais sutil)', () => {
    expect(popScale(POP_PEAK_MS, 0.06)).toBeCloseTo(1.06, 6)
  })

  it('a página faz fade de 90 ms na entrada e na saída', () => {
    expect(pageAlpha({ sinceStart: 0, untilEnd: 1000 })).toBe(0)
    expect(pageAlpha({ sinceStart: 45, untilEnd: 1000 })).toBeCloseTo(0.5, 6)
    expect(pageAlpha({ sinceStart: 500, untilEnd: 500 })).toBe(1)
    expect(pageAlpha({ sinceStart: 500, untilEnd: 45 })).toBeCloseTo(0.5, 6)
  })
})

describe('SRT e VTT: legendas de arquivo com o tempo certo depois dos cortes', () => {
  const words = mk([
    ['Olá,', 400, 883],
    ['pessoal.', 883, 1753],
    ['Hoje', 5000, 5400], // depois de 3 s de corte
    ['eu', 5400, 5700],
    ['vou', 5700, 6100],
    ['mostrar.', 6100, 6800]
  ])

  it('formato dos tempos: HH:MM:SS,mmm (SRT) e HH:MM:SS.mmm (VTT)', () => {
    expect(formatCueTime(0, ',')).toBe('00:00:00,000')
    expect(formatCueTime(61_005, ',')).toBe('00:01:01,005')
    expect(formatCueTime(3_723_450, '.')).toBe('01:02:03.450')
    expect(formatCueTime(-10, ',')).toBe('00:00:00,000')
    expect(formatCueTime(999.6, ',')).toBe('00:00:01,000') // arredonda
  })

  it('sem cortes, cada frase é uma legenda com o tempo da fala', () => {
    const cues = buildCues(words, { cuts: [], durationMs: 8000 })
    expect(cues.map((c) => c.text)).toEqual(['Olá, pessoal.', 'Hoje eu vou mostrar.'])
    expect(cues[0]).toMatchObject({ start: 400, end: 1753 })
    expect(cues[1]).toMatchObject({ start: 5000, end: 6800 })
  })

  it('com um corte de 3 s antes da segunda frase, ela começa 3 s mais cedo (no tempo de SAÍDA)', () => {
    const cues = buildCues(words, { cuts: [cut(2000, 5000)], durationMs: 8000 })
    expect(cues).toHaveLength(2)
    expect(cues[1]).toMatchObject({ start: 2000, end: 3800 })
    // a pausa que o corte levou não fica como buraco falso: a 1ª legenda segue igual
    expect(cues[0]).toMatchObject({ start: 400, end: 1753 })
  })

  it('palavra cortada não aparece; legenda inteira cortada some e os números seguem em ordem', () => {
    const cues = buildCues(words, { cuts: [cut(300, 1800)], durationMs: 8000 })
    expect(cues).toHaveLength(1)
    expect(cues[0]!.text).toBe('Hoje eu vou mostrar.')
    expect(cues[0]!.start).toBe(5000 - 1500)
    const srt = toSrt(cues)
    expect(srt.startsWith('1\n')).toBe(true)
  })

  it('o texto corrigido na aba Texto vale no arquivo', () => {
    const cues = buildCues(words, { cuts: [], wordFixes: { '0': 'Oi,' }, durationMs: 8000 })
    expect(cues[0]!.text).toBe('Oi, pessoal.')
  })

  it('SRT: número, tempos com vírgula, texto, linha em branco', () => {
    const srt = toSrt([{ start: 400, end: 1753, text: 'Olá, pessoal.' }, { start: 5000, end: 6800, text: 'Hoje eu vou mostrar.' }])
    expect(srt).toBe('1\n00:00:00,400 --> 00:00:01,753\nOlá, pessoal.\n\n2\n00:00:05,000 --> 00:00:06,800\nHoje eu vou mostrar.\n')
  })

  it('VTT: cabeçalho WEBVTT e tempos com ponto', () => {
    const vtt = toVtt([{ start: 400, end: 1753, text: 'Olá, pessoal.' }])
    expect(vtt).toBe('WEBVTT\n\n00:00:00.400 --> 00:00:01.753\nOlá, pessoal.\n')
  })

  it('legenda curta é esticada a 1 s sem atropelar a seguinte; linhas longas quebram em 2 de até 42 caracteres', () => {
    const quick = buildCues(mk([['Sim.', 0, 300], ['Então', 2000, 2300]]), { cuts: [], durationMs: 5000 })
    expect(quick[0]!.end - quick[0]!.start).toBe(1000)
    const longText = 'esta é uma frase bem comprida que precisa quebrar em duas linhas para caber na tela do celular.'.split(' ')
    const cues = buildCues(run(longText), { cuts: [], durationMs: 60_000 })
    for (const c of cues) {
      const lines = c.text.split('\n')
      expect(lines.length).toBeLessThanOrEqual(2)
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(42)
      expect(c.end - c.start).toBeLessThanOrEqual(6000)
    }
    expect(cues.map((c) => c.text.replace('\n', ' ')).join(' ')).toBe(longText.join(' ')) // nada se perde
  })

  it('sem palavras: nenhuma legenda', () => {
    expect(buildCues(null, { cuts: [], durationMs: 1000 })).toEqual([])
    expect(buildCues([], { cuts: [], durationMs: 1000 })).toEqual([])
  })
})
