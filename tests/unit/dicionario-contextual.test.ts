import { describe, expect, it } from 'vitest'
import { applyDictionaryCorrections, markManualDictionarySpan, undoDictionaryCorrection } from '../../src/shared/dictionary-corrections'
import { createProject, parseProject } from '../../src/shared/project'
import { reviewDocument } from '../../src/shared/review'
import { buildCaptionTrack, captionSourceOf, captionWords } from '../../src/shared/captions'
import { correctedTranscriptWords } from '../../src/shared/dictionary-corrections'
import { mergeEditorProject } from '../../src/shared/project-merge'
import type { Project, Word } from '../../src/shared/types'

const word: Word = { i: 1, text: 'sintoma.', start: 100, end: 500, prob: .8, kind: 'word' }
const candidate = { i: 1, before: 'sintoma.', term: 'Sintomax', confidence: .99, context: 'product' }
const corrected = () => applyDictionaryCorrections(createProject({ title: 'Teste' }), [word], [candidate], ['Sintomax'])

describe('trocas contextuais reversíveis', () => {
  it('preserva a pontuação e desfaz a troca sem alterar o original da transcrição', () => {
    const doc = corrected()
    expect(doc.wordFixes).toEqual({ '1': 'Sintomax.' })
    const next = undoDictionaryCorrection(doc, 1)
    expect(next.wordFixes).toEqual({})
    expect(next.review?.dictionaryCorrections?.[0]?.undone).toBe(true)
    expect(word.text).toBe('sintoma.')
    expect(applyDictionaryCorrections(next, [word], [candidate], ['Sintomax'])).toEqual(next)
  })

  it('o desfazer conserva uma correção manual posterior', () => {
    const doc: Project = { ...corrected(), wordFixes: { '1': 'Nome revisado pelo usuário.' } }
    const next = undoDictionaryCorrection(doc, 1)
    expect(next.wordFixes).toEqual({ '1': 'Nome revisado pelo usuário.' })
    expect(next.review?.dictionaryCorrections?.[0]?.undone).toBe(true)
  })

  it('a edição por item recebe as novas correções comuns e conserva suas palavras manuais', () => {
    const doc = createProject({ title: 'Teste' })
    doc.review = { items: { youtube: { decision: 'pending', origin: 'manual', edits: { cuts: [], zooms: [], layouts: [], captions: doc.captions, style: doc.style, wordFixes: { '2': 'palavra manual' } } } } }
    const next = applyDictionaryCorrections(doc, [word], [candidate], ['Sintomax'])
    expect(reviewDocument(next, 'youtube').wordFixes).toEqual({ '1': 'Sintomax.', '2': 'palavra manual' })
  })

  it('índice ausente, original divergente e resposta repetida não alteram outra palavra', () => {
    const doc = createProject({ title: 'Teste' })
    const next = applyDictionaryCorrections(doc, [word], [{ ...candidate, i: 999 }, { ...candidate, before: 'outro' }, candidate, candidate], ['Sintomax'])
    expect(next.wordFixes).toEqual({ '1': 'Sintomax.' })
    expect(next.review?.dictionaryCorrections).toHaveLength(1)
  })

  it('junta o nome de produto dividido pelo motor na legenda e no texto, com duração e desfazer intactos', () => {
    const words: Word[] = [{ ...word, i: 1, text: 'Agen', start: 100, end: 400 }, { ...word, i: 2, text: 'daí.', start: 400, end: 900 }]
    const doc = createProject({ title: 'Teste' })
    doc.captions.enabled = true
    const next = applyDictionaryCorrections(doc, words, [{ i: 1, last: 2, before: 'Agen daí.', term: 'Agendaí', confidence: .99, context: 'product' }], ['Agendaí'])
    expect(correctedTranscriptWords(words, next.wordFixes, next.review?.dictionaryCorrections)).toEqual([{ ...words[0], text: 'Agendaí.', end: 900 }])
    const track = buildCaptionTrack(words, next, 1000)
    expect(captionWords(words, captionSourceOf(next, 1000))).toEqual([{ i: 1, text: 'Agendaí.', start: 100, end: 900 }])
    expect(track?.pages.flatMap((page) => page.words).map((w) => w.text)).toEqual(['Agendaí.'])
    const undone = undoDictionaryCorrection(next, 1)
    expect(correctedTranscriptWords(words, undone.wordFixes, undone.review?.dictionaryCorrections)).toEqual(words)
    expect(buildCaptionTrack(words, undone, 1000)?.pages.flatMap((page) => page.words)).toHaveLength(2)
  })

  it('uma palavra editada à mão dentro de um nome composto deixa de ser ocultada pela troca automática', () => {
    const words: Word[] = [{ ...word, i: 1, text: 'Agen', start: 100, end: 400 }, { ...word, i: 2, text: 'daí.', start: 400, end: 900 }]
    const next = applyDictionaryCorrections(createProject({ title: 'Teste' }), words, [{ i: 1, last: 2, before: 'Agen daí.', term: 'Agendaí', confidence: .99, context: 'product' }], ['Agendaí'])
    next.wordFixes!['2'] = 'palavra revisada'
    expect(correctedTranscriptWords(words, next.wordFixes, next.review?.dictionaryCorrections).map((w) => w.text)).toEqual(['Agendaí.', 'palavra revisada'])
  })

  it('uma ocorrência editada manualmente conserva o agrupamento e a legenda mesmo ao desfazer o automático', () => {
    const words: Word[] = [{ ...word, i: 1, text: 'Agen', start: 100, end: 400 }, { ...word, i: 2, text: 'daí.', start: 400, end: 900 }]
    const next = applyDictionaryCorrections(createProject({ title: 'Teste' }), words, [{ i: 1, last: 2, before: 'Agen daí.', term: 'Agendaí', confidence: .99, context: 'product' }], ['Agendaí'])
    next.captions.enabled = true
    next.wordFixes!['1'] = 'Agendaí Pro.'
    const saved = parseProject(JSON.stringify(markManualDictionarySpan(next, 1, 2)))
    expect(correctedTranscriptWords(words, saved.wordFixes, saved.review?.dictionaryCorrections)).toEqual([{ ...words[0], text: 'Agendaí Pro.', end: 900 }])
    expect(captionWords(words, captionSourceOf(saved, 1000))).toEqual([{ i: 1, text: 'Agendaí Pro.', start: 100, end: 900 }])
    expect(buildCaptionTrack(words, saved, 1000)?.pages.flatMap((p) => p.words).map((w) => w.text)).toEqual(['Agendaí Pro.'])
    const undone = undoDictionaryCorrection(saved, 1)
    expect(undone.wordFixes?.['1']).toBe('Agendaí Pro.')
    expect(correctedTranscriptWords(words, undone.wordFixes, undone.review?.dictionaryCorrections)).toEqual([{ ...words[0], text: 'Agendaí Pro.', end: 900 }])
    expect(captionWords(words, captionSourceOf(undone, 1000))).toEqual([{ i: 1, text: 'Agendaí Pro.', start: 100, end: 900 }])
    undone.wordFixes!['2'] = 'original revisado'
    const internalEdit = markManualDictionarySpan(undone, 2)
    expect(internalEdit.review?.dictionaryCorrections?.[0]?.manualSpan).toBe(false)
    expect(correctedTranscriptWords(words, internalEdit.wordFixes, internalEdit.review?.dictionaryCorrections).map((w) => w.text)).toEqual(['Agendaí Pro.', 'original revisado'])
    expect(words.map((w) => w.text)).toEqual(['Agen', 'daí.'])
  })

  it('editar só a primeira palavra depois de desfazer o automático conserva a segunda palavra original', () => {
    const words: Word[] = [{ ...word, i: 1, text: 'Agen', start: 100, end: 400 }, { ...word, i: 2, text: 'daí.', start: 400, end: 900 }]
    const doc = applyDictionaryCorrections(createProject({ title: 'Teste' }), words, [{ i: 1, last: 2, before: 'Agen daí.', term: 'Agendaí', confidence: .99, context: 'product' }], ['Agendaí'])
    const undone = undoDictionaryCorrection(doc, 1)
    undone.wordFixes!['1'] = 'Palavra manual'
    const next = markManualDictionarySpan(undone, 1)
    expect(correctedTranscriptWords(words, next.wordFixes, next.review?.dictionaryCorrections).map((w) => w.text)).toEqual(['Palavra manual', 'daí.'])
    expect(captionWords(words, captionSourceOf(next, 1000)).map((w) => w.text)).toEqual(['Palavra manual', 'daí.'])
  })

  it.each(['Agendaí Pro.', 'Agendaí.'])('o agrupamento manual %s por item persiste e sobrevive ao desfazer comum sem reativar a troca nos demais itens', (manualText) => {
    const words: Word[] = [{ ...word, i: 1, text: 'Agen', start: 100, end: 400 }, { ...word, i: 2, text: 'daí.', start: 400, end: 900 }]
    const doc = applyDictionaryCorrections(createProject({ title: 'Teste' }), words, [{ i: 1, last: 2, before: 'Agen daí.', term: 'Agendaí', confidence: .99, context: 'product' }], ['Agendaí'])
    doc.captions.enabled = true
    const saved = parseProject(JSON.stringify({ ...doc, review: { ...doc.review, items: { youtube: { origin: 'manual', decision: 'pending', edits: { cuts: [], zooms: [], layouts: [], captions: doc.captions, style: doc.style, wordFixes: { '1': manualText }, dictionaryCorrections: doc.review?.dictionaryCorrections?.map((c) => ({ ...c, manualSpan: true })) } } } } }))
    const view = reviewDocument(saved, 'youtube')
    expect(captionWords(words, captionSourceOf(view, 1000))).toEqual([{ i: 1, text: manualText, start: 100, end: 900 }])
    const undone = undoDictionaryCorrection(saved, 1)
    const manualView = reviewDocument(undone, 'youtube')
    expect(captionWords(words, captionSourceOf(manualView, 1000))).toEqual([{ i: 1, text: manualText, start: 100, end: 900 }])
    expect(correctedTranscriptWords(words, undone.wordFixes, undone.review?.dictionaryCorrections)).toEqual(words)
  })

  it('desfazer na Revisão conserva uma troca que terminou enquanto a tela ainda mostrava a fotografia anterior', () => {
    const base = corrected()
    const latest = applyDictionaryCorrections(base, [{ ...word, i: 2 }], [{ ...candidate, i: 2 }], ['Sintomax'])
    const saved = mergeEditorProject(base, undoDictionaryCorrection(base, 1), latest)
    expect(saved.review?.dictionaryCorrections).toHaveLength(2)
    expect(saved.review?.dictionaryCorrections?.find((c) => c.i === 1)?.undone).toBe(true)
    expect(saved.review?.dictionaryCorrections?.find((c) => c.i === 2)?.after).toBe('Sintomax.')
    expect(saved.wordFixes).toEqual({ '2': 'Sintomax.' })
  })
})
