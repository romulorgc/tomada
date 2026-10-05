/**
 * A prévia do ganho do painel Limpeza (`planClean`): é a MESMA conta que aplica ao documento, então o número que a
 * pessoa vê é o que acontece. E o transcript do projeto de exemplo, que os testes e2e usam, lido pelo código do app.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CLEAN, computeClean, type CleanInput, type CleanOptions } from '@shared/clean'
import { planClean } from '@shared/clean-plan'
import { parseTranscript } from '@shared/transcript'
import { PAUSE_CHIP_MIN_MS, buildParagraphs, pauseAfter, struckWords } from '@shared/text-edit'
import type { Cut, Word } from '@shared/types'
import { FIX } from '../helpers/env'

const word = (i: number, text: string, start: number, end: number, kind: Word['kind'] = 'word'): Word => ({ i, text, start, end, prob: 0.95, kind })
const WORDS = [word(0, 'Olá', 500, 900), word(1, 'hã', 2100, 2300, 'filler'), word(2, 'pessoal', 4100, 4600)]
const D = 6000
const input: CleanInput = { words: WORDS, durationMs: D, vad: [] }
const manual: Cut = { id: 'cut-1', start: 5000, end: 5500, reason: 'manual', enabled: true }

describe('planClean', () => {
  it('mede o que sai: a duração de agora, a de depois e a diferença', () => {
    const options: CleanOptions = { ...DEFAULT_CLEAN, silence: 'fast' }
    const result = computeClean(input, options)
    const plan = planClean({ cuts: [] }, result, options, D)
    expect(plan.changed).toBe(true)
    expect(plan.fromMs).toBe(D)
    expect(plan.toMs).toBe(D - plan.deltaMs)
    expect(plan.deltaMs).toBeGreaterThan(2000)
    expect(plan.cuts.every((c) => c.enabled && (c.reason === 'silence' || c.reason === 'filler'))).toBe(true)
  })

  it('não mexe no documento que recebe', () => {
    const cuts: Cut[] = [manual]
    const options: CleanOptions = { ...DEFAULT_CLEAN }
    planClean({ cuts }, computeClean(input, options), options, D)
    expect(cuts).toEqual([manual])
  })

  it('o corte manual fica; só as categorias desta limpeza são trocadas', () => {
    const options: CleanOptions = { ...DEFAULT_CLEAN }
    const plan = planClean({ cuts: [manual] }, computeClean(input, options), options, D)
    expect(plan.cuts.filter((c) => c.reason === 'manual')).toEqual([manual])
    // duração de "antes" já descontava o manual
    expect(plan.fromMs).toBe(D - 500)
  })

  it('aplicar duas vezes as mesmas escolhas: a segunda não muda nada ("changed" falso)', () => {
    const options: CleanOptions = { ...DEFAULT_CLEAN }
    const result = computeClean(input, options)
    const once = planClean({ cuts: [] }, result, options, D)
    const twice = planClean({ cuts: once.cuts, mutes: once.mutes }, result, options, D)
    expect(twice.changed).toBe(false)
    expect(twice.deltaMs).toBe(0)
  })

  it('trocar o ritmo do silêncio pode devolver tempo (delta negativo)', () => {
    const faster: CleanOptions = { ...DEFAULT_CLEAN, silence: 'faster' }
    const natural: CleanOptions = { ...DEFAULT_CLEAN, silence: 'natural' }
    const first = planClean({ cuts: [] }, computeClean(input, faster), faster, D)
    const back = planClean({ cuts: first.cuts }, computeClean(input, natural), natural, D)
    expect(back.changed).toBe(true)
    expect(back.deltaMs).toBeLessThan(0)
  })

  it('o que a pessoa restaurou não volta a ser cortado pela limpeza', () => {
    const options: CleanOptions = { ...DEFAULT_CLEAN }
    const result = computeClean(input, options)
    const first = planClean({ cuts: [] }, result, options, D)
    const restored = first.cuts.map((c, k) => (k === 0 ? { ...c, enabled: false } : c))
    const again = planClean({ cuts: restored }, result, options, D)
    expect(again.cuts[0]!.enabled).toBe(false)
    expect(again.changed).toBe(false)
  })

  it('modo silenciar: o tempo não muda, mas o documento ganha os silenciamentos', () => {
    const options: CleanOptions = { silence: null, hesitations: true, crutches: false, fillerMode: 'mute', retakes: false }
    const plan = planClean({ cuts: [] }, computeClean(input, options), options, D)
    expect(plan.changed).toBe(true)
    expect(plan.deltaMs).toBe(0)
    expect(plan.cuts).toEqual([])
    expect(plan.mutes).toHaveLength(1)
    expect(plan.mutes[0]).toMatchObject({ reason: 'filler', enabled: true })
  })

  it('sem nada a fazer: "changed" falso e as mesmas durações', () => {
    const options: CleanOptions = { silence: null, hesitations: false, crutches: false, fillerMode: 'cut', retakes: false }
    const plan = planClean({ cuts: [manual] }, computeClean(input, options), options, D)
    expect(plan.changed).toBe(false)
    expect(plan.fromMs).toBe(plan.toMs)
  })
})

describe('transcript do projeto de exemplo (o que os testes e2e leem)', () => {
  const t = parseTranscript(readFileSync(join(FIX.exemplo, 'transcript.json'), 'utf8'))

  it('o formato do app: 36 palavras numeradas, segmentos, VAD e createdAt vazio (não dispara a limpeza automática)', () => {
    expect(t.engine).toBe('teste')
    expect(t.words).toHaveLength(36)
    expect(t.words.every((w, k) => w.i === k && w.end > w.start && w.prob > 0)).toBe(true)
    expect(t.words.filter((w) => w.kind === 'filler').map((w) => w.text)).toEqual(['hã'])
    expect(t.segments.length).toBeGreaterThanOrEqual(5)
    expect(t.vad.length).toBeGreaterThanOrEqual(5)
    expect(t.createdAt).toBe('')
  })

  it('3 parágrafos e 3 fichas de pausa (as pausas de 1,5 s, 0,7 s e 1,5 s)', () => {
    const ps = buildParagraphs(t.words)
    expect(ps).toHaveLength(3)
    const chips = t.words.map((_, k) => pauseAfter(t.words, k)).filter((p) => p >= PAUSE_CHIP_MIN_MS)
    expect(chips).toHaveLength(3)
    expect(chips.map((p) => Math.round(p / 100) / 10)).toEqual([1.5, 0.7, 1.5])
  })

  it('limpeza padrão no exemplo: 3 pausas, as duas pontas e o "hã"', () => {
    const r = computeClean({ words: t.words, durationMs: 22_693, vad: t.vad }, DEFAULT_CLEAN)
    expect(r.counts).toMatchObject({ silence: 5, hesitation: 1, 'gap-speech': 0 })
    expect(r.cutMs).toBeGreaterThan(3500)
    const plan = planClean({ cuts: [] }, r, DEFAULT_CLEAN, 22_693)
    expect(struckWords(t.words, plan.cuts)[19]).toBe(true) // o "hã"
    expect(struckWords(t.words, plan.cuts).filter(Boolean)).toHaveLength(1) // e nenhuma outra palavra riscada
  })
})
