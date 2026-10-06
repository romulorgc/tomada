import { describe, expect, it } from 'vitest'
import { applyDictionaryCorrections, undoDictionaryCorrection } from '../../src/shared/dictionary-corrections'
import { createProject } from '../../src/shared/project'
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
    const words: Word[] = [{ ...word, i: 1, text: 'Jus', start: 100, end: 400 }, { ...word, i: 2, text: 'pronto.', start: 400, end: 900 }]
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
    const words: Word[] = [{ ...word, i: 1, text: 'Jus', start: 100, end: 400 }, { ...word, i: 2, text: 'pronto.', start: 400, end: 900 }]
    const next = applyDictionaryCorrections(createProject({ title: 'Teste' }), words, [{ i: 1, last: 2, before: 'Agen daí.', term: 'Agendaí', confidence: .99, context: 'product' }], ['Agendaí'])
    next.wordFixes!['2'] = 'palavra revisada'
    expect(correctedTranscriptWords(words, next.wordFixes, next.review?.dictionaryCorrections).map((w) => w.text)).toEqual(['Agendaí.', 'palavra revisada'])
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
