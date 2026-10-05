import { describe, expect, it } from 'vitest'
import {
  CHAPTER_MIN_MS,
  PUBLISH_SYSTEM,
  buildClipText,
  buildPublishPrompt,
  buildYoutubeText,
  chapterLines,
  chaptersText,
  checkChapters,
  cleanChapterTitle,
  cleanDescription,
  descriptionWithChapters,
  fallbackClipMeta,
  fitChapters,
  formatChapterTime,
  heuristicChapters,
  keywordsOf,
  normalizeHashtag,
  normalizeHashtags,
  normalizeTags,
  publishSchema,
  resolveClipMeta,
  validateChapters,
  validatePublish,
  type Chapter
} from '../../src/shared/publish'
import { keptRanges } from '../../src/shared/timeline'
import type { Clip, Cut } from '../../src/shared/types'
import { createProject } from '../../src/shared/project'
import { buildDemo, sentenceRange } from '../helpers/demo-script'

const demo = buildDemo()
const durationMs = demo.durationMs
const NO_CUTS: Cut[] = []
const kept = keptRanges(durationMs, NO_CUTS)

/** Índice da palavra que começa a frase `k` do roteiro. */
const startOf = (k: number): number => sentenceRange(demo, k, k)[0]

describe('publicar: capítulos do YouTube', () => {
  it('formata mm:ss (e h:mm:ss a partir de 1 hora)', () => {
    expect(formatChapterTime(0, false)).toBe('00:00')
    expect(formatChapterTime(65_400, false)).toBe('01:05')
    expect(formatChapterTime(3_725_000, true)).toBe('1:02:05')
  })

  it('o tempo é o de SAÍDA: os cortes de agora puxam os capítulos; o primeiro é sempre 00:00', () => {
    const cuts: Cut[] = [{ id: 'c', start: 10_000, end: 20_000, reason: 'manual', enabled: true }]
    const lines = chapterLines([{ start: 5000, title: 'Começo' }, { start: 15_000, title: 'Dentro do corte' }, { start: 40_000, title: 'Meio' }], keptRanges(60_000, cuts))
    // o capítulo do meio do corte vai para o ponto do corte (10 s de saída); o primeiro é 00:00 mesmo começando a 5 s
    expect(lines.map((l) => [l.time, l.title])).toEqual([['00:00', 'Começo'], ['00:10', 'Dentro do corte'], ['00:30', 'Meio']])
    expect(lines[0]!.outMs).toBe(0)
    // dois no mesmo instante ficam com o primeiro
    const dup = chapterLines([{ start: 0, title: 'A' }, { start: 10_000, title: 'B' }, { start: 15_000, title: 'C' }], keptRanges(60_000, cuts))
    expect(dup.map((l) => l.title)).toEqual(['A', 'B'])
    expect(chapterLines([{ start: 0, title: 'x' }, { start: 3_700_000, title: 'y' }], keptRanges(4_000_000, [])).map((l) => l.time)).toEqual(['0:00:00', '1:01:40'])
  })

  it('as três regras: primeiro em 00:00, pelo menos 3, cada um com pelo menos 10 s', () => {
    const ok = chapterLines([{ start: 0, title: 'A' }, { start: 15_000, title: 'B' }, { start: 40_000, title: 'C' }], keptRanges(60_000, []))
    expect(checkChapters(ok, 60_000)).toEqual({ ok: true, problems: [] })
    const few = checkChapters(chapterLines([{ start: 0, title: 'A' }, { start: 30_000, title: 'B' }], keptRanges(60_000, [])), 60_000)
    expect(few.ok).toBe(false)
    expect(few.problems).toEqual(['o YouTube pede pelo menos 3 capítulos (há 2)'])
    const short = checkChapters(chapterLines([{ start: 0, title: 'A' }, { start: 5000, title: 'B' }, { start: 30_000, title: 'C' }], keptRanges(60_000, [])), 60_000)
    expect(short.problems).toEqual(['o capítulo "A" tem menos de 10 s (5 s)'])
    // o último capítulo também precisa de 10 s até o fim do vídeo
    const tail = checkChapters(chapterLines([{ start: 0, title: 'A' }, { start: 20_000, title: 'B' }, { start: 55_000, title: 'C' }], keptRanges(60_000, [])), 60_000)
    expect(tail.problems).toEqual(['o capítulo "C" tem menos de 10 s (5 s)'])
    expect(checkChapters([], 60_000).ok).toBe(false)
    expect(CHAPTER_MIN_MS).toBe(10_000)
  })

  it('"fitChapters" junta ao anterior o capítulo que ficaria com menos de 10 s, sem tirar o primeiro', () => {
    const lines = chapterLines([{ start: 0, title: 'A' }, { start: 4000, title: 'B' }, { start: 20_000, title: 'C' }, { start: 28_000, title: 'D' }, { start: 55_000, title: 'E' }], keptRanges(60_000, []))
    // B (4 s depois de A) e D (8 s depois de C) ficam curtos e são juntados ao anterior; E fica a 5 s do fim e também sai
    expect(fitChapters(lines, 60_000).map((l) => l.title)).toEqual(['A', 'C'])
    expect(chaptersText(fitChapters(lines, 60_000))).toBe('00:00 A\n00:20 C')
    expect(fitChapters(chapterLines([{ start: 0, title: 'A' }, { start: 15_000, title: 'B' }, { start: 30_000, title: 'C' }], keptRanges(60_000, [])), 60_000)).toHaveLength(3)
  })

  it('o título do capítulo perde o horário e as aspas e cabe em 60 caracteres', () => {
    expect(cleanChapterTitle('00:45 - "Cadastro de clientes".')).toBe('Cadastro de clientes')
    expect(cleanChapterTitle('1:02:03 Relatório')).toBe('Relatório')
    expect(cleanChapterTitle('x'.repeat(10) + ' ' + 'y'.repeat(70)).length).toBeLessThanOrEqual(60)
  })
})

describe('publicar: capítulos pelas pausas (sem IA)', () => {
  it('acha os começos de assunto do roteiro, em frases novas, válidos pelas regras do YouTube', () => {
    const r = heuristicChapters(demo.words, durationMs, NO_CUTS)
    expect(r.why).toBeNull()
    expect(r.chapters.length).toBeGreaterThanOrEqual(3)
    expect(r.chapters[0]).toEqual({ start: 0, title: 'Introdução' })
    const lines = chapterLines(r.chapters, kept)
    expect(checkChapters(lines, durationMs).ok, JSON.stringify(checkChapters(lines, durationMs))).toBe(true)
    // cada capítulo (menos o primeiro) começa perto do começo de uma frase do roteiro, e quase todos são troca de assunto
    const topicStarts = demo.sentences.filter((s, k) => k > 0 && demo.sentences[k - 1]!.topic !== s.topic).map((s) => s.startMs)
    const onTopic = r.chapters.slice(1).filter((c) => topicStarts.some((t) => Math.abs(t - c.start) <= 400))
    expect(onTopic.length, JSON.stringify(r.chapters)).toBeGreaterThanOrEqual(Math.min(3, r.chapters.length - 1))
    for (const c of r.chapters.slice(1)) expect(c.title.split(' ').length).toBeLessThanOrEqual(6)
  })

  it('usa o tempo de saída: com cortes, os capítulos continuam com pelo menos 10 s cada', () => {
    const cuts: Cut[] = [{ id: 'c1', start: 16_000, end: 52_000, reason: 'manual', enabled: true }]
    const r = heuristicChapters(demo.words, durationMs, cuts)
    expect(r.why).toBeNull()
    const lines = chapterLines(r.chapters, keptRanges(durationMs, cuts))
    expect(checkChapters(lines, durationMs - 36_000).ok).toBe(true)
  })

  it('vídeo curto demais (menos de 30 s) ou sem frases: diz por quê, não inventa', () => {
    const short = heuristicChapters(demo.words.slice(0, 20), 20_000, NO_CUTS)
    expect(short.chapters).toEqual([])
    expect(short.why).toMatch(/não cabem 3 capítulos de pelo menos 10 s/)
    expect(heuristicChapters([], 120_000, NO_CUTS).why).toMatch(/frases suficientes/)
  })
})

describe('publicar: hashtags, tags e o texto sem IA', () => {
  it('hashtag: sem espaço, só letras, números e _, de 2 a 30 caracteres, sem repetir', () => {
    expect(normalizeHashtag('agenda online')).toBe('#agendaonline')
    expect(normalizeHashtag('##Barbearia!')).toBe('#Barbearia')
    expect(normalizeHashtag('#a')).toBeNull()
    expect(normalizeHashtag('x'.repeat(40))).toBeNull()
    expect(normalizeHashtag('cliente_novo')).toBe('#cliente_novo')
    expect(normalizeHashtags(['#Agenda', 'agenda', 'AGENDA', 'barbearia', 3, null, 'sistema'], 3)).toEqual(['#Agenda', '#barbearia', '#sistema'])
  })

  it('tags do YouTube: minúsculas, sem #, de 2 a 30 caracteres, até 15 e 500 caracteres no total', () => {
    expect(normalizeTags(['#Agenda online', 'agenda online', 'Barbearia', 'x', 'y'.repeat(40)])).toEqual(['agenda online', 'barbearia'])
    expect(normalizeTags(Array.from({ length: 30 }, (_, k) => `tag${k}`))).toHaveLength(15)
    const big = normalizeTags(Array.from({ length: 40 }, (_, k) => `${'a'.repeat(25)}${k}`), 40)
    expect(big.join(',').length).toBeLessThanOrEqual(500)
  })

  it('sem IA: legenda é o gancho e as hashtags são as palavras que mais aparecem no corte; Shorts leva #Shorts', () => {
    const clip = { title: 'Agende em três cliques', hook: 'Agende em três cliques', ranges: [{ start: demo.sentences[10]!.startMs - 100, end: demo.sentences[16]!.endMs + 300 }] }
    const meta = fallbackClipMeta(clip, demo.words)
    expect(meta.caption).toBe('Agende em três cliques')
    expect(meta.tiktok!.length).toBeGreaterThanOrEqual(2)
    expect(meta.tiktok!.every((h) => /^#[\p{L}\p{N}_]+$/u.test(h))).toBe(true)
    expect(meta.shorts!.at(-1)).toBe('#Shorts')
    expect(keywordsOf('horário horário horário cliente cliente agenda', 2)).toEqual(['horário', 'cliente'])
    expect(keywordsOf('eu vou ver isso aqui agora', 5)).toEqual([])
    expect(fallbackClipMeta({ title: 'T', hook: '', ranges: [] }, null).caption).toBe('T')
  })
})

describe('publicar: o pedido e a resposta da IA', () => {
  const project = createProject({ title: 'Demonstração do Agendaí', sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs } } })
  const clip: Clip = { id: 'clip-1', title: 'Agende em três cliques', hook: 'Agende sem planilha', ranges: [{ start: demo.sentences[10]!.startMs - 100, end: demo.sentences[16]!.endMs + 300 }], score: 80, reason: '', format: 'vertical', layoutV: 'auto' }

  it('o pedido leva o resumo, os cortes e as frases com o tempo do vídeo FINAL; frase cortada não vai; sem nome de fornecedor', () => {
    const cutProject = { ...project, cuts: [{ id: 'c', start: demo.sentences[0]!.startMs, end: demo.sentences[2]!.endMs + 200, reason: 'manual' as const, enabled: true }] }
    const prompt = buildPublishPrompt({ project: cutProject, words: demo.words, durationMs, clips: [clip] })
    expect(prompt).toMatch(/^Vídeo "Demonstração do Agendaí" com \d+ min \d\d s \(depois dos cortes\)\./)
    expect(prompt).toContain('- clip-1: "Agende em três cliques" · gancho "Agende sem planilha" · texto: "Agora vamos agendar um horário.')
    const lines = prompt.split('\n').filter((l) => l.startsWith('['))
    expect(lines).toHaveLength(demo.sentences.length - 3) // as 3 frases da abertura foram cortadas
    expect(lines[0]).toMatch(/^\[\d+-\d+\] 00:0\d–00:0\d · Vamos começar pelo cadastro de clientes\.$/)
    expect(prompt).not.toContain('Oi pessoal')
    expect(PUBLISH_SYSTEM).toMatch(/Responda SOMENTE com um JSON/)
    expect(PUBLISH_SYSTEM).toMatch(/NÃO coloque lista de capítulos/)
    expect(PUBLISH_SYSTEM + prompt).not.toMatch(/claude|anthropic|openai|gpt/i)
    expect(buildPublishPrompt({ project, words: demo.words, durationMs, clips: [] })).not.toContain('Cortes verticais')
  })

  it('uma boa resposta vira títulos, descrição sem horários, tags, capítulos válidos e o texto de cada corte', () => {
    const raw = publishSchema.parse({
      titles: ['Agendaí: agenda para barbearias em 3 minutos', 'Como cadastrar e agendar clientes', 'Sistema de agenda para barbearia', 'quarto título'],
      description: 'Veja o Agendaí.\n\n00:00 Introdução\n\nServe para donos de barbearia.\n03:10 outro horário solto',
      tags: ['#Agenda', 'barbearia', 'agenda'],
      chapters: [
        { from: startOf(3), title: '00:16 Cadastro de clientes' },
        { from: startOf(10), title: 'Agendar um horário' },
        { from: startOf(17), title: 'Lembrete automático' },
        { from: startOf(23), title: 'Relatório de faturamento' }
      ],
      clips: [{ id: 'clip-1', caption: 'Agende sem planilha, sem conflito.', tiktok: ['agenda online', '#barbearia', 'gestao', 'x', 'saas', 'sistema', 'extra'], reels: ['agenda'], shorts: ['#Shorts', 'agendamento', 'barbearia', 'extra'] }, { id: 'clip-9', caption: 'não existe' }]
    })
    const r = validatePublish(raw, { words: demo.words, durationMs, cuts: NO_CUTS, clips: [clip] })
    expect(r.titles).toHaveLength(3)
    expect(r.titles[0]).toBe('Agendaí: agenda para barbearias em 3 minutos')
    expect(r.description).toBe('Veja o Agendaí.\n\nServe para donos de barbearia.')
    expect(r.tags).toEqual(['agenda', 'barbearia'])
    // o primeiro assunto começa a 16 s (mais de 10 s do começo): entra uma Introdução em 00:00
    expect(r.chapters.map((c) => c.title)).toEqual(['Introdução', 'Cadastro de clientes', 'Agendar um horário', 'Lembrete automático', 'Relatório de faturamento'])
    const lines = chapterLines(r.chapters, kept)
    expect(checkChapters(lines, durationMs).ok).toBe(true)
    expect(lines[0]!.time).toBe('00:00')
    expect(r.clips['clip-1']).toEqual({
      caption: 'Agende sem planilha, sem conflito.',
      tiktok: ['#agendaonline', '#barbearia', '#gestao', '#saas', '#sistema'],
      reels: ['#agenda'],
      shorts: ['#agendamento', '#barbearia', '#Shorts']
    })
    expect(r.clips['clip-9']).toBeUndefined()
    expect(r.notes.join(' | ')).toMatch(/mais de 3 títulos/)
    expect(r.notes.join(' | ')).toMatch(/id "clip-9" \(que não existe\)/)
  })

  it('o primeiro assunto logo no começo vira o capítulo 00:00; capítulo curto demais é juntado; índice que não existe é descartado com aviso', () => {
    const early = validateChapters([{ from: startOf(0), title: 'Abertura' }, { from: startOf(1), title: 'Curto' }, { from: startOf(10), title: 'Agenda' }, { from: startOf(17), title: 'Lembrete' }, { from: 99_999, title: 'Fantasma' }, 'lixo'], demo.words, durationMs, NO_CUTS)
    expect(early.chapters.map((c) => c.title)).toEqual(['Abertura', 'Agenda', 'Lembrete'])
    expect(early.chapters[0]!.start).toBe(0)
    expect(early.notes.join(' | ')).toMatch(/Fantasma" aponta uma palavra que não existe/)
    expect(early.notes.join(' | ')).toMatch(/formato inválido/)
    expect(early.notes.join(' | ')).toMatch(/menos de 10 s foram juntados/)
    // começo no meio de uma frase longe da borda: descartado
    const mid = validateChapters([{ from: demo.sentences[12]!.firstWord + 6, title: 'No meio' }], demo.words, durationMs, NO_CUTS)
    expect(mid.chapters.map((c) => c.title)).toEqual(['Introdução'])
    expect(mid.notes[0]).toMatch(/não começa no início de uma frase/)
    // 2 palavras depois do início: corrigido para a frase
    const near = validateChapters([{ from: startOf(10) + 2, title: 'Perto' }], demo.words, durationMs, NO_CUTS)
    expect(near.chapters.map((c) => c.title)).toEqual(['Introdução', 'Perto'])
  })

  it('sem nenhum título a resposta não serve (erro que a interface mostra); sem descrição só avisa', () => {
    expect(() => validatePublish(publishSchema.parse({ titles: [], description: 'x' }), { words: demo.words, durationMs, cuts: NO_CUTS, clips: [] })).toThrow(/nenhum título/)
    const r = validatePublish(publishSchema.parse({ titles: ['Um título'] }), { words: demo.words, durationMs, cuts: NO_CUTS, clips: [] })
    expect(r.description).toBe('')
    expect(r.notes).toContain('a IA não devolveu descrição')
    expect(cleanDescription('a\n\n\n\nb\n  12:30 horário')).toBe('a\n\nb')
  })
})

describe('publicar: os textos que a exportação grava', () => {
  const chapters: Chapter[] = [{ start: 0, title: 'Introdução' }, { start: 20_000, title: 'Cadastro' }, { start: 45_000, title: 'Agenda' }]

  it('o texto do YouTube tem títulos, a descrição com a lista de capítulos no tempo de saída e as tags', () => {
    const text = buildYoutubeText({ title: 'Projeto', titles: ['Primeiro', 'Segundo'], description: 'Texto da descrição.', tags: ['a', 'b'], chapters, kept: keptRanges(90_000, []) })
    expect(text).toBe(
      ['TÍTULOS (escolha um)', '1. Primeiro', '2. Segundo', '', 'DESCRIÇÃO', 'Texto da descrição.', '', '00:00 Introdução', '00:20 Cadastro', '00:45 Agenda', '', 'TAGS', 'a, b', ''].join('\n')
    )
    // com um corte antes do 2º capítulo, os horários andam
    const cut = buildYoutubeText({ title: 'Projeto', titles: [], description: '', tags: [], chapters, kept: keptRanges(90_000, [{ start: 5000, end: 15_000, enabled: true }]) })
    expect(cut).toContain('00:10 Cadastro')
    expect(cut).toContain('1. Projeto') // sem títulos da IA, vale o do projeto
    expect(cut).not.toContain('(sem descrição)') // a descrição é só a lista de capítulos
    expect(buildYoutubeText({ title: 'P', titles: [], description: '', tags: [], chapters: [], kept: keptRanges(90_000, []) })).toContain('(sem descrição)')
  })

  it('capítulos que não cumprem as regras ficam FORA do texto, com o motivo (nunca uma lista inválida)', () => {
    const none = buildYoutubeText({ title: 'P', titles: [], description: 'd', tags: [], chapters: [], kept: keptRanges(90_000, []) })
    expect(none).toContain('Capítulos não incluídos: nenhum foi gerado (aba Publicar).')
    const two = buildYoutubeText({ title: 'P', titles: [], description: 'd', tags: [], chapters: chapters.slice(0, 2), kept: keptRanges(90_000, []) })
    expect(two).toContain('Capítulos não incluídos: o YouTube pede pelo menos 3 capítulos (há 2).')
    expect(two).not.toContain('00:20')
    expect(descriptionWithChapters('x', [], 1000).text).toBe('x')
  })

  it('o texto do corte: título, gancho, legenda e as hashtags de TikTok, Reels e Shorts', () => {
    const text = buildClipText({ title: 'Agende em três cliques', hook: 'Agende sem planilha' }, { caption: 'Sem planilha, sem conflito.', tiktok: ['#agenda', '#barbearia'], reels: ['#agenda'], shorts: ['#Shorts'] })
    expect(text).toBe(['Agende em três cliques', 'Gancho: Agende sem planilha', '', 'Legenda:', 'Sem planilha, sem conflito.', '', 'TikTok: #agenda #barbearia', 'Reels: #agenda', 'Shorts: #Shorts', ''].join('\n'))
    expect(buildClipText({ title: 'T', hook: '' }, {})).toContain('TikTok: (nenhuma)')
  })

  it('o que a pessoa guardou vale; o que faltar vem do texto sem IA', () => {
    const fallback = { caption: 'Gancho', tiktok: ['#a'], reels: ['#b'], shorts: ['#Shorts'] }
    expect(resolveClipMeta(undefined, fallback)).toEqual(fallback)
    expect(resolveClipMeta({ caption: 'Minha legenda', tiktok: ['#meu'] }, fallback)).toEqual({ caption: 'Minha legenda', tiktok: ['#meu'], reels: ['#b'], shorts: ['#Shorts'] })
    expect(resolveClipMeta({ hashtags: ['#geral'] }, fallback)).toEqual({ caption: 'Gancho', tiktok: ['#geral'], reels: ['#geral'], shorts: ['#geral'] })
  })
})
