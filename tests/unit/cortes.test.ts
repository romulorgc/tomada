import { describe, expect, it } from 'vitest'
import {
  CLIPS_SYSTEM,
  CLIP_ACCEPT_MAX_MS,
  CLIP_ACCEPT_MIN_MS,
  buildClipPrompts,
  clipCountRange,
  clipDocument,
  clipOutputMs,
  clipText,
  complementRanges,
  heuristicClips,
  heuristicClipCount,
  isWeakStart,
  limitHook,
  limitTitle,
  mergeSuggestedClips,
  normalizeRanges,
  sentenceLine,
  shiftClipEdge,
  titleFromText,
  validateClips,
  withClipLayout
} from '../../src/shared/clips'
import { createProject } from '../../src/shared/project'
import { buildSentences } from '../../src/shared/sentences'
import { keptRanges, outputDuration } from '../../src/shared/timeline'
import type { Clip, Cut, Project, Word } from '../../src/shared/types'
import { buildDemo, sentenceRange, type Demo } from '../helpers/demo-script'

const demo = buildDemo()
const durationMs = demo.durationMs
const ctx = { words: demo.words, durationMs, cuts: [] as Cut[] }

/** Os cortes certos do roteiro: o assunto inteiro, da primeira à última frase dele (índices de frase do roteiro). */
const TOPIC = { cliente: [3, 9], agenda: [10, 16], lembrete: [17, 22], relatorio: [23, 28] } as const

const item = (a: number, b: number, extra: Record<string, unknown> = {}, d: Demo = demo): Record<string, unknown> => ({
  title: 'Cadastre um cliente em segundos',
  hook: 'Cadastre um cliente em 10 segundos',
  ranges: [sentenceRange(d, a, b)],
  score: 80,
  notes: { hook: 85, flow: 80, value: 75 },
  reason: 'Mostra o cadastro de ponta a ponta.',
  ...extra
})

describe('cortes: quantos pedir', () => {
  it('3 a 8 por 10 minutos, proporcional, de 1 a 8', () => {
    expect(clipCountRange(10 * 60_000)).toEqual({ min: 3, max: 8 })
    expect(clipCountRange(4 * 60_000)).toEqual({ min: 1, max: 3 })
    expect(clipCountRange(3.3 * 60_000)).toEqual({ min: 1, max: 3 })
    expect(clipCountRange(60_000)).toEqual({ min: 1, max: 2 })
    expect(clipCountRange(120 * 60_000)).toEqual({ min: 8, max: 8 })
    expect(heuristicClipCount(10 * 60_000)).toBe(5)
    expect(heuristicClipCount(30_000)).toBe(1)
  })
})

describe('cortes: o pedido à IA', () => {
  const sentences = buildSentences(demo.words, { clicks: demo.clicks, keys: demo.keys })

  it('o texto do sistema pede JSON estrito, 30 a 60 s, começo em frase completa, gancho em 3 s e dá exemplos do que é ruim', () => {
    expect(CLIPS_SYSTEM).toMatch(/30 a 60 segundos/)
    expect(CLIPS_SYSTEM).toMatch(/PRIMEIRA palavra de uma frase completa/)
    expect(CLIPS_SYSTEM).toMatch(/3 primeiros segundos/)
    expect(CLIPS_SYSTEM).toMatch(/UM CORTE RUIM|CORTE RUIM/)
    expect(CLIPS_SYSTEM).toMatch(/Oi, pessoal/)
    expect(CLIPS_SYSTEM).toMatch(/NÃO podem se sobrepor/)
    expect(CLIPS_SYSTEM).toMatch(/Responda SOMENTE com um JSON/)
    expect(CLIPS_SYSTEM).toMatch(/"hook":"\.\.\."/)
    // a interface nunca nomeia o fornecedor, e o texto também não
    expect(CLIPS_SYSTEM).not.toMatch(/claude|anthropic|openai|gpt/i)
  })

  it('cada frase vira uma linha com os números das palavras, o tempo e a atividade; só texto da transcrição vai', () => {
    const line = sentenceLine(sentences[4]!)
    expect(line).toMatch(/^\[\d+-\d+\] \d+:\d\d–\d+:\d\d · \d+,\d s · 1 clique · Aqui na tela inicial eu clico em novo cliente\.$/)
    expect(sentenceLine(sentences[0]!)).toContain('sem ação na tela')
    expect(sentenceLine(sentences[6]!)).toMatch(/1 clique, 20 teclas/)
    const [p] = buildClipPrompts(sentences, { durationMs, outputMs: durationMs })
    expect(p!.prompt).toMatch(/^Vídeo com 3 min \d\d s de gravação\. Tempos em minutos:segundos da gravação\. Sugira de 1 a 3 cortes\./)
    expect(p!.prompt).toContain('Frases:\n')
    expect(p!.prompt.split('\n').filter((l) => l.startsWith('[')).length).toBe(sentences.length)
    // a hesitação ("hã") não aparece no texto
    expect(p!.prompt).not.toMatch(/\bhã\b/)
    expect(p!.prompt).not.toMatch(/[A-Za-z]:\\|tomada-media|\.mp4|\.wav/)
  })

  it('transcrição longa vai em janelas que se repetem um pouco na emenda, e cada janela diz de onde a onde vai', () => {
    const many = Array.from({ length: 600 }, (_, k) => ({
      first: k * 20,
      last: k * 20 + 19,
      firstPos: k * 20,
      lastPos: k * 20 + 19,
      startMs: k * 9000,
      endMs: k * 9000 + 8000,
      text: 'frase de teste com bastante palavra para encher a janela',
      words: 20,
      clicks: 0,
      keys: 0
    }))
    const prompts = buildClipPrompts(many, { durationMs: 600 * 9000, outputMs: 600 * 9000 })
    expect(prompts.length).toBeGreaterThan(2)
    expect(prompts[1]!.prompt).toMatch(/esta parte vai de/)
    // a segunda janela repete frases do fim da primeira
    const lastOfFirst = prompts[0]!.prompt.split('\n').filter((l) => l.startsWith('[')).pop()!.split(' ')[0]!
    expect(prompts[1]!.prompt).toContain(lastOfFirst)
    expect(buildClipPrompts([], { durationMs: 0, outputMs: 0 })).toEqual([])
  })
})

describe('cortes: validar o que a IA devolveu', () => {
  it('um corte certo passa, com os trechos em ms que cobrem as frases inteiras e folga curta nas pontas', () => {
    const [a, b] = TOPIC.agenda
    const r = validateClips([item(a, b)], ctx)
    expect(r.dropped).toEqual([])
    expect(r.clips).toHaveLength(1)
    const c = r.clips[0]!
    const first = demo.sentences[a]!
    const last = demo.sentences[b]!
    expect(c.ranges).toHaveLength(1)
    expect(c.ranges[0]!.start).toBeLessThanOrEqual(first.startMs)
    expect(first.startMs - c.ranges[0]!.start).toBeLessThanOrEqual(150)
    expect(c.ranges[0]!.end).toBeGreaterThanOrEqual(last.endMs)
    expect(c.ranges[0]!.end - last.endMs).toBeLessThanOrEqual(350)
    expect(c).toMatchObject({ score: 80, notes: { hook: 85, flow: 80, value: 75 }, source: 'ai' })
    expect(clipOutputMs(c.ranges, [], durationMs)).toBeGreaterThanOrEqual(CLIP_ACCEPT_MIN_MS)
  })

  it('aceita a forma {from,to} e junta até 3 trechos em ordem cronológica (e desordenados, ordena)', () => {
    const [a, b] = TOPIC.agenda
    const split = [sentenceRange(demo, a + 1, a + 3), sentenceRange(demo, a + 5, b)]
    const r = validateClips([item(0, 0, { ranges: [{ from: split[1]![0], to: split[1]![1] }, split[0]] })], ctx)
    expect(r.dropped).toEqual([])
    expect(r.clips[0]!.ranges).toHaveLength(2)
    expect(r.clips[0]!.ranges[0]!.start).toBeLessThan(r.clips[0]!.ranges[1]!.start)
  })

  it('corrige para a borda da frase um começo ou fim errado por poucas palavras, e recusa o que está longe de uma borda', () => {
    const [a, b] = TOPIC.cliente
    const [from, to] = sentenceRange(demo, a, b)
    // 2 palavras depois do início da frase e 2 antes do fim: vira a frase inteira
    const near = validateClips([item(0, 0, { ranges: [[from + 2, to - 2]] })], ctx)
    expect(near.dropped).toEqual([])
    const exact = validateClips([item(a, b)], ctx).clips[0]!.ranges
    expect(near.clips[0]!.ranges).toEqual(exact)
    // no meio de uma frase longa, longe das duas bordas: recusa, com o motivo
    const mid = demo.sentences[b]!
    const far = validateClips([item(0, 0, { ranges: [[mid.firstWord + 5, to]] })], ctx)
    expect(far.clips).toEqual([])
    expect(far.dropped[0]!.why).toMatch(/não começa no início de uma frase/)
  })

  it('recusa índice que não existe, trecho invertido, mais de 3 trechos e formato errado, cada um com o seu motivo', () => {
    const [a, b] = TOPIC.agenda
    const ok = sentenceRange(demo, a, b)
    const cases: [unknown, RegExp][] = [
      [item(0, 0, { ranges: [[ok[0], 99_999]] }), /não existe/],
      [item(0, 0, { ranges: [[ok[1], ok[0]]] }), /termina antes de começar/],
      [item(0, 0, { ranges: [[ok[0], ok[0] + 3], [ok[0] + 10, ok[0] + 12], [ok[0] + 20, ok[0] + 22], [ok[0] + 30, ok[1]]] }), /tem 4 trechos/],
      [item(0, 0, { ranges: [[1.5, 20]] }), /não são inteiros/],
      [{ title: 'sem trechos' }, /o formato não é o pedido/],
      [item(0, 0, { title: '   ' }), /sem título/],
      ['texto solto', /o formato não é o pedido/]
    ]
    for (const [raw, why] of cases) {
      const r = validateClips([raw], ctx)
      expect(r.clips, String(why)).toEqual([])
      expect(r.dropped[0]!.why, String(why)).toMatch(why)
    }
  })

  it('duração fora de 25–65 s é recusada (uma frase só é curta demais; o vídeo todo é longo demais)', () => {
    const short = validateClips([item(4, 5)], ctx)
    expect(short.clips).toEqual([])
    expect(short.dropped[0]!.why).toMatch(/dura .* \(precisa ficar entre 25 e 65 s\)/)
    const long = validateClips([item(3, 28)], ctx)
    expect(long.clips).toEqual([])
    expect(long.dropped[0]!.why).toMatch(/precisa ficar entre 25 e 65 s/)
    expect(CLIP_ACCEPT_MAX_MS).toBe(65_000)
  })

  it('a duração conta o que sobra DEPOIS dos cortes do projeto (a limpeza tira silêncio de dentro do corte)', () => {
    const [a, b] = TOPIC.relatorio
    const cuts: Cut[] = [{ id: 'c1', start: demo.sentences[a + 1]!.startMs, end: demo.sentences[a + 3]!.startMs, reason: 'manual', enabled: true }]
    const r = validateClips([item(a, b)], { ...ctx, cuts })
    expect(r.clips).toEqual([])
    expect(r.dropped[0]!.why).toMatch(/dura/)
    // o mesmo corte com o corte DESLIGADO passa
    const off = validateClips([item(a, b)], { ...ctx, cuts: cuts.map((c) => ({ ...c, enabled: false })) })
    expect(off.clips).toHaveLength(1)
  })

  it('dois cortes que se sobrepõem: fica o de nota maior, e o outro é descartado dizendo qual repete', () => {
    const [a, b] = TOPIC.agenda
    const r = validateClips([item(a, b, { title: 'Pior', score: 55 }), item(a + 1, b, { title: 'Melhor', score: 88 }), item(...TOPIC.lembrete, { title: 'Outro assunto', score: 70 })], ctx)
    expect(r.clips.map((c) => c.title)).toEqual(['Melhor', 'Outro assunto'])
    expect(r.dropped).toEqual([{ title: 'Pior', why: 'repete o corte «Melhor»' }])
  })

  it('não repete um corte que o projeto já tem, e respeita a quantidade pedida', () => {
    const [a, b] = TOPIC.agenda
    const existing = validateClips([item(a, b)], ctx).clips
    const again = validateClips([item(a, b), item(...TOPIC.lembrete)], { ...ctx, existing: existing.map((c) => ({ title: c.title, ranges: c.ranges })) })
    expect(again.clips).toHaveLength(1)
    expect(again.dropped[0]!.why).toMatch(/repete o corte/)
    const capped = validateClips([item(...TOPIC.agenda, { score: 90, title: 'A' }), item(...TOPIC.lembrete, { score: 80, title: 'B' }), item(...TOPIC.relatorio, { score: 70, title: 'C' })], { ...ctx, max: 2 })
    expect(capped.clips.map((c) => c.title)).toEqual(['A', 'B'])
    expect(capped.dropped).toEqual([{ title: 'C', why: 'passa da quantidade pedida' }])
  })

  it('o gancho passa de 8 palavras: é cortado sem deixar conectivo pendurado; título comprido é cortado numa palavra inteira', () => {
    expect(limitHook('Cadastre um cliente em dez segundos sem digitar nada além do nome')).toBe('Cadastre um cliente em dez segundos sem digitar')
    expect(limitHook('Em menos de dez segundos o cliente está cadastrado e já recebe horário')).toBe('Em menos de dez segundos o cliente está')
    expect(limitHook('"Agende em três cliques"')).toBe('Agende em três cliques')
    expect(limitHook('')).toBe('')
    const title = limitTitle('Como cadastrar um cliente novo no sistema de agenda da barbearia e já marcar o primeiro horário dele sem sair da tela')
    expect(title.length).toBeLessThanOrEqual(80)
    expect(title.endsWith(' ')).toBe(false)
    expect(title).toMatch(/^Como cadastrar um cliente novo/)
    // sem gancho na resposta, o título faz as vezes
    const [a, b] = TOPIC.cliente
    const r = validateClips([item(a, b, { hook: undefined, title: 'Cadastro em segundos' })], ctx)
    expect(r.clips[0]!.hook).toBe('Cadastro em segundos')
  })

  it('as notas ficam entre 0 e 100; sem nota geral ela sai da média ponderada; sem notas, repete a geral', () => {
    const [a, b] = TOPIC.lembrete
    const clamp = validateClips([item(a, b, { score: 140, notes: { hook: -5, flow: 250, value: 50.4 } })], ctx).clips[0]!
    expect(clamp.score).toBe(100)
    expect(clamp.notes).toEqual({ hook: 0, flow: 100, value: 50 })
    const calc = validateClips([item(a, b, { score: undefined, notes: { hook: 100, flow: 50, value: 50 } })], ctx).clips[0]!
    expect(calc.score).toBe(70)
    const plain = validateClips([item(a, b, { notes: undefined, score: 66 })], ctx).clips[0]!
    expect(plain.notes).toEqual({ hook: 66, flow: 66, value: 66 })
  })
})

describe('cortes: heurística (sem IA)', () => {
  const clicks = demo.clicks
  const keys = demo.keys
  const result = heuristicClips({ words: demo.words, durationMs, cuts: [], clicks, keys, count: 4 })
  const sentences = buildSentences(demo.words, { clicks, keys })

  it('propõe cortes de 30 a 60 s que começam e terminam em frase, sem se sobrepor, do melhor para o pior', () => {
    expect(result.clips.length).toBeGreaterThanOrEqual(2)
    expect(result.clips.length).toBeLessThanOrEqual(4)
    for (const c of result.clips) {
      const out = clipOutputMs(c.ranges, [], durationMs)
      expect(out, c.title).toBeGreaterThanOrEqual(30_000)
      expect(out, c.title).toBeLessThanOrEqual(60_000)
      expect(c.source).toBe('heuristic')
      expect(c.reason).toMatch(/^Sem IA/)
      expect(c.hook.split(' ').length).toBeLessThanOrEqual(8)
      expect(c.score).toBeGreaterThan(0)
      // a validação da IA aceita o que a heurística propõe (mesmas regras de borda)
      const startSentence = sentences.find((s) => c.ranges[0]!.start <= s.startMs && s.startMs - c.ranges[0]!.start <= 150)
      expect(startSentence, `${c.title}: começa numa frase`).toBeDefined()
      const endSentence = sentences.find((s) => c.ranges[0]!.end >= s.endMs && c.ranges[0]!.end - s.endMs <= 350)
      expect(endSentence, `${c.title}: termina numa frase`).toBeDefined()
    }
    for (let i = 0; i < result.clips.length; i++) {
      for (let j = i + 1; j < result.clips.length; j++) {
        const a = result.clips[i]!.ranges[0]!
        const b = result.clips[j]!.ranges[0]!
        expect(a.end <= b.start || b.end <= a.start, 'sem sobreposição').toBe(true)
      }
    }
    const scores = result.clips.map((c) => c.score)
    expect(scores).toEqual([...scores].sort((x, y) => y - x))
  })

  it('não abre um corte na saudação, na apresentação nem num conectivo', () => {
    for (const c of result.clips) {
      const text = clipText(c.ranges, demo.words)
      expect(isWeakStart(text), `${c.title}: "${text.slice(0, 40)}"`).toBe(false)
      expect(text).not.toMatch(/^(Oi|Hoje eu vou|E |Mas |Então |Bom)/)
    }
    expect(isWeakStart('Oi pessoal, tudo bem?')).toBe(true)
    expect(isWeakStart('Então, aqui na tela')).toBe(true)
    expect(isWeakStart('E se o cliente já existir')).toBe(true)
    expect(isWeakStart('Hoje eu vou mostrar o sistema')).toBe(true)
    expect(isWeakStart('Eu abro o relatório do mês')).toBe(false)
    expect(isWeakStart('Escolho o cliente que acabei de cadastrar')).toBe(false)
  })

  it('o título é o começo da primeira frase, sem conectivo; sem transcrição não há o que propor', () => {
    expect(titleFromText('Então, eu abro o relatório do mês e escolho o período.')).toBe('Eu abro o relatório do mês e escolho')
    expect(titleFromText('aqui na tela inicial eu clico em novo cliente.')).toBe('Aqui na tela inicial eu clico em novo cliente')
    expect(heuristicClips({ words: [], durationMs: 10_000, cuts: [] })).toEqual({ clips: [], dropped: [] })
  })

  it('respeita os cortes do projeto na conta da duração e os cortes que já existem', () => {
    const existing = result.clips.slice(0, 1).map((c) => ({ title: c.title, ranges: c.ranges }))
    const next = heuristicClips({ words: demo.words, durationMs, cuts: [], clicks, keys, count: 4, existing })
    for (const c of next.clips) expect(c.ranges[0]!.start === existing[0]!.ranges[0]!.start && c.ranges[0]!.end === existing[0]!.ranges[0]!.end).toBe(false)
  })
})

describe('cortes: o corte como documento (o que a prévia e a exportação desenham)', () => {
  const doc = (): Project => {
    const p = createProject({
      title: 'Demonstração',
      sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs }, voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs } }
    })
    p.cuts = [
      { id: 'cut-1', start: 5000, end: 5500, reason: 'silence', enabled: true },
      { id: 'cut-2', start: 70_000, end: 70_600, reason: 'silence', enabled: true },
      { id: 'cut-3', start: 71_000, end: 72_000, reason: 'manual', enabled: false }
    ]
    p.mutes = [{ id: 'mute-1', start: 60_000, end: 60_300, reason: 'filler', enabled: true }]
    p.wordFixes = { '3': 'Corrigida' }
    p.vertical = { layout: 'screen-focus', layouts: [{ id: 'layout-v1', start: 56_000, end: 60_000, layout: 'stack' }], zooms: [], hook: 'Gancho do projeto' }
    return p
  }
  const ranges = [{ start: 54_000, end: 96_500 }]
  const clip = { ranges, hook: 'Agende em três cliques', captionStyle: undefined as Clip['captionStyle'] }

  it('tudo fora dos trechos vira corte; os cortes do projeto dentro do corte continuam valendo', () => {
    const base = doc()
    const out = clipDocument(base, clip)
    const kept = keptRanges(durationMs, out.cuts)
    // o que sobra é o trecho do corte menos o corte de silêncio de 70,0-70,6 s (o de 5 s está fora; o desligado não corta)
    expect(kept).toEqual([{ start: 54_000, end: 70_000 }, { start: 70_600, end: 96_500 }])
    expect(outputDuration(durationMs, out.cuts)).toBe(42_500 - 600)
    expect(clipOutputMs(ranges, base.cuts, durationMs)).toBe(42_500 - 600)
    // o documento de origem não foi tocado
    expect(base.cuts).toHaveLength(3)
    expect(base.vertical!.hook).toBe('Gancho do projeto')
  })

  it('o título de gancho é o do corte (o do projeto não aparece num corte); gancho vazio tira o do projeto', () => {
    expect(clipDocument(doc(), clip).vertical!.hook).toBe('Agende em três cliques')
    expect(clipDocument(doc(), { ...clip, hook: '   ' }).vertical!.hook).toBeUndefined()
  })

  it('voz silenciada, texto corrigido, zooms e layouts do vertical são os do projeto', () => {
    const out = clipDocument(doc(), clip)
    expect(out.mutes).toEqual(doc().mutes)
    expect(out.wordFixes).toEqual({ '3': 'Corrigida' })
    expect(out.vertical!.layouts).toHaveLength(1)
    expect(out.vertical!.layout).toBe('screen-focus')
  })

  it('o estilo de legenda do corte liga a legenda com o estilo escolhido e as medidas dele', () => {
    const out = clipDocument(doc(), { ...clip, captionStyle: 'clean' })
    expect(out.vertical!.captions).toMatchObject({ enabled: true, style: 'clean', wordsPerLine: 4, box: true })
    // sem estilo no corte, a legenda do vertical fica como está
    expect(clipDocument(doc(), clip).vertical!.captions).toBeUndefined()
  })

  it('o layout do corte: automático deixa a escolha por atividade; os outros fixam o layout no corte todo', () => {
    const d = clipDocument(doc(), clip)
    expect(withClipLayout(d, 'auto')).toBe(d)
    const fixed = withClipLayout(d, 'screen-wide')
    expect(fixed.vertical).toMatchObject({ layout: 'screen-wide', layouts: [] })
    expect(withClipLayout(d, 'stack').vertical!.layout).toBe('stack')
    // projeto que nunca teve edição vertical ganha uma
    const bare = createProject({ title: 'x', sources: { screen: { path: 'a.mp4', w: 1, h: 1, fps: 30, durationMs: 1000 } } })
    expect(withClipLayout(bare, 'camera').vertical).toMatchObject({ layout: 'camera', layouts: [], zooms: [] })
  })

  it('trechos fora da gravação são limitados; o que sobra fora dos trechos é o complemento', () => {
    expect(normalizeRanges([{ start: -50, end: 100 }, { start: 90, end: 300 }, { start: 5000, end: 6000 }, { start: 400, end: 400 }], 1000)).toEqual([{ start: 0, end: 300 }])
    expect(complementRanges([{ start: 100, end: 200 }, { start: 400, end: 500 }], 1000)).toEqual([{ start: 0, end: 100 }, { start: 200, end: 400 }, { start: 500, end: 1000 }])
    expect(complementRanges([], 1000)).toEqual([{ start: 0, end: 1000 }])
    expect(complementRanges([{ start: 0, end: 1000 }], 1000)).toEqual([])
  })
})

describe('cortes: a lista do projeto e o ajuste pela transcrição', () => {
  const drafts = validateClips([item(...TOPIC.agenda, { title: 'A', score: 90 }), item(...TOPIC.lembrete, { title: 'B', score: 70 })], ctx).clips

  it('os cortes novos entram no fim com id próprio; o que repete um corte existente fica de fora', () => {
    const first = mergeSuggestedClips([], drafts)
    expect(first.added.map((c) => c.id)).toEqual(['clip-1', 'clip-2'])
    expect(first.clips[0]).toMatchObject({ title: 'A', format: 'vertical', layoutV: 'auto', source: 'ai', notes: { hook: 85, flow: 80, value: 75 } })
    const again = mergeSuggestedClips(first.clips, [...drafts, ...validateClips([item(...TOPIC.relatorio, { title: 'C' })], ctx).clips])
    expect(again.skipped).toBe(2)
    expect(again.added.map((c) => [c.id, c.title])).toEqual([['clip-3', 'C']])
    // o corte novo não divide trecho com o antigo: id novo, trechos copiados (não compartilha objeto)
    again.added[0]!.ranges[0]!.start = 0
    expect(drafts[0]!.ranges[0]!.start).not.toBe(0)
  })

  it('o texto do corte são as palavras de verdade dentro dos trechos (sem a hesitação)', () => {
    const c = drafts[0]!
    const text = clipText(c.ranges, demo.words)
    expect(text.startsWith('Agora vamos agendar um horário.')).toBe(true)
    expect(text).toContain('Eu abro a agenda da semana, e clico no horário livre')
    expect(text).not.toMatch(/\bhã\b/)
  })

  it('anda o começo e o fim UMA frase; no limite devolve null; nunca deixa o corte vazio', () => {
    const base = mergeSuggestedClips([], drafts).clips[0]!
    const words: Word[] = demo.words
    const earlier = shiftClipEdge(base, words, 'start', -1, durationMs)!
    expect(earlier.ranges[0]!.start).toBeLessThan(base.ranges[0]!.start)
    expect(earlier.source).toBe('manual')
    expect(clipText(earlier.ranges, words).startsWith('Escolho')).toBe(false)
    expect(clipText(earlier.ranges, words).startsWith('Pronto, em menos de dez segundos')).toBe(true)
    const later = shiftClipEdge(base, words, 'start', 1, durationMs)!
    expect(clipText(later.ranges, words).startsWith('Eu abro a agenda da semana')).toBe(true)
    const shorter = shiftClipEdge(base, words, 'end', -1, durationMs)!
    expect(shorter.ranges[0]!.end).toBeLessThan(base.ranges[0]!.end)
    expect(clipText(shorter.ranges, words).endsWith('sem conflito.')).toBe(false)
    const longer = shiftClipEdge(base, words, 'end', 1, durationMs)!
    expect(longer.ranges[0]!.end).toBeGreaterThan(base.ranges[0]!.end)
    expect(clipText(longer.ranges, words).endsWith('lembrete automático.')).toBe(true)
    // um corte de uma frase só não pode encolher mais
    const one = mergeSuggestedClips([], validateClips([item(4, 5, { score: 50 })], { ...ctx, minMs: 1000 }).clips).clips[0]!
    expect(shiftClipEdge(one, words, 'start', 1, durationMs)?.ranges[0]!.start ?? 0).toBeGreaterThanOrEqual(0)
    const single = mergeSuggestedClips([], validateClips([item(4, 4, { score: 50 })], { ...ctx, minMs: 1000 }).clips).clips[0]!
    expect(shiftClipEdge(single, words, 'start', 1, durationMs)).toBeNull()
    expect(shiftClipEdge(single, words, 'end', -1, durationMs)).toBeNull()
    // no começo da transcrição não há frase antes
    const atStart = mergeSuggestedClips([], validateClips([item(0, 2, { score: 50 })], { ...ctx, minMs: 1000 }).clips).clips[0]!
    expect(shiftClipEdge(atStart, words, 'start', -1, durationMs)).toBeNull()
  })
})
