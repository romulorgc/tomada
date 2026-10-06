import { describe, expect, it } from 'vitest'
import { createMockProvider } from '../../src/main/llm/mock'
import { generatePublish } from '../../src/main/llm/publish'
import { migrate } from '../../src/shared/project'
import { pilotWorld } from '../helpers/autopilot-acabamento'
import type { Word } from '../../src/shared/types'

const words: Word[] = ['No', 'sintoma', 'cadastro', 'clientes.', 'Um', 'sintoma', 'de', 'febre.'].map((text, i) => ({ i, text, start: i * 500, end: (i + 1) * 500, prob: .8, kind: 'word' }))
const correction = (i: number, confidence = .99, context = 'product', term = 'Sintomax') => ({ i, before: words[i]?.text, term, confidence, context })

describe('dicionário contextual nos textos e no piloto', () => {
  it('a publicação envia a grafia e a regra contextual à IA e recebe títulos com nome correto', async () => {
    let prompt = ''
    const provider = createMockProvider({ onAsk: (r) => { prompt = r.prompt }, recorded: [{ task: 'publish', match: 'Grafias do dicionário', response: { titles: ['Sintomax: cadastro de clientes'], description: 'Veja o cadastro no Sintomax. A palavra sintoma também aparece em contexto de saúde.', tags: ['sintomax'], chapters: [], clips: [] } }] })
    const w = await pilotWorld({ words })
    const result = await generatePublish({ provider, project: w.project(), words, durationMs: 108_000, clips: [], dictionary: ['Sintomax'] })
    expect(result.titles).toEqual(['Sintomax: cadastro de clientes'])
    expect(result.description).toContain('palavra sintoma também aparece')
    expect(prompt).toContain('"Sintomax"')
    expect(prompt).toContain('contexto de produto')
    expect(prompt).toContain('Um sintoma de febre.')
    expect(words[1]?.text).toBe('sintoma')
  })

  it('o piloto corrige só menção de produto de alta confiança e guarda troca visível reversível', async () => {
    const provider = createMockProvider({ recorded: [{ task: 'dictionary', match: 'Sintomax', response: { corrections: [correction(1), correction(5, .99, 'common')] } }] })
    const w = await pilotWorld({ provider, words, steps: ['dictionary'], vocabulary: ['Sintomax'] })
    await w.service.start('acabamento')
    const doc = migrate(w.project())
    expect(doc.wordFixes).toEqual({ '1': 'Sintomax' })
    expect(doc.review?.dictionaryCorrections).toEqual([{ id: 'dictionary-word-1', i: 1, before: 'sintoma', after: 'Sintomax', confidence: .99 }])
    expect(doc.autopilot?.steps.find((s) => s.id === 'dictionary')?.detail).toContain('1 troca')
    expect(w.transcript.words[1]?.text).toBe('sintoma')
  })

  it('baixa confiança, nome fora da lista e edição manual ficam preservados', async () => {
    const provider = createMockProvider({ recorded: [{ task: 'dictionary', match: '', response: { corrections: [correction(1, .89), correction(5, .99, 'product', 'Inventado'), correction(3)] } }] })
    const w = await pilotWorld({ provider, words, steps: ['dictionary'], vocabulary: ['Sintomax'], initial: { wordFixes: { '3': 'Clientes revisados.' } } })
    await w.service.start('acabamento')
    expect(w.project().wordFixes).toEqual({ '3': 'Clientes revisados.' })
    expect(w.project().review?.dictionaryCorrections ?? []).toEqual([])
  })

  it('sem IA o piloto conserva todas as palavras e correções', async () => {
    const w = await pilotWorld({ words, steps: ['dictionary'], vocabulary: ['Sintomax'], initial: { wordFixes: { '3': 'Clientes revisados.' } } })
    await w.service.start('acabamento')
    expect(w.project().wordFixes).toEqual({ '3': 'Clientes revisados.' })
    expect(w.project().review?.dictionaryCorrections).toBeUndefined()
    expect(w.project().autopilot?.steps.find((s) => s.id === 'dictionary')?.detail).toContain('Sem IA')
  })
})
