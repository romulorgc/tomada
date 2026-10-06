/**
 * O gancho do começo do vertical e a legenda não repetem o mesmo texto: enquanto o gancho está na tela, a legenda não mostra as palavras
 * que ele já mostra (a primeira frase falada virou o gancho). Antes, durante ~4 s o gancho ("VOU MOSTRAR PRA VOCÊS, PESSOALMENTE.") e a
 * legenda ("Vou mostrar / pra vocês, pessoalmente.") apareciam empilhados com o mesmo texto.
 */
import { describe, expect, it } from 'vitest'
import { HOOK_MS } from '@shared/vertical'
import { buildCues, captionSourceOf, wordsRepeatedByHook, type CaptionWord } from '@shared/captions'
import { createProject } from '@shared/project'
import { VERTICAL_1080, deriveProject, evaluateScene, prepareEvents } from '@shared/scene'
import type { CursorSample, Project, Word } from '@shared/types'
import { projectForFormat } from '@shared/vertical'

const D = 20_000
const FIRST_SENTENCE = 'Vou mostrar pra vocês, pessoalmente.'
const word = (i: number, text: string, start: number, end: number): Word => ({ i, text, start, end, prob: 1, kind: 'word' })
/** A fala do corte: a primeira frase do gancho, uma pausa, e a frase seguinte, que só começa depois de o gancho sair. */
const SPEECH: Word[] = [
  word(0, 'Vou', 200, 500),
  word(1, 'mostrar', 500, 1000),
  word(2, 'pra', 1000, 1200),
  word(3, 'vocês,', 1200, 1700),
  word(4, 'pessoalmente.', 1700, 2600),
  word(5, 'Aqui', 4600, 4900),
  word(6, 'no', 4900, 5000),
  word(7, 'Gmail', 5000, 5600)
]
const cw = (...entries: [string, number, number][]): CaptionWord[] => entries.map(([text, start, end], i) => ({ i, text, start, end }))

function projectWith(hook: string): Project {
  const p = createProject({
    id: 'p1',
    title: 't',
    createdAt: '2026-10-06T12:00:00.000Z',
    sources: {
      screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: D },
      camera: { path: 'media/camera.mp4', w: 3840, h: 2160, fps: 30, durationMs: D }
    }
  })
  p.captions = { ...p.captions, enabled: true }
  p.vertical = { layout: 'stack', layouts: [], zooms: [], zoomPreset: 'off', hook }
  return p
}
const cursor: CursorSample[] = Array.from({ length: D / 8 + 1 }, (_, i) => ({ t: i * 8, x: 0.5, y: 0.5 }))
const data = prepareEvents({ cursor, clicks: [], keys: [] }, D)
function sceneAt(project: Project, t: number, words: Word[] = SPEECH) {
  const view = projectForFormat(project, 'vertical')
  return evaluateScene(view, deriveProject(view, data, VERTICAL_1080, words), t, VERTICAL_1080)
}

describe('que palavras o gancho já mostra', () => {
  const spoken = cw(['Vou', 200, 500], ['mostrar', 500, 1000], ['pra', 1000, 1200], ['vocês,', 1200, 1700], ['pessoalmente.', 1700, 2600], ['Aqui', 4600, 4900])

  it('a primeira frase falada que virou o gancho: sem acento, caixa nem pontuação, as 5 palavras', () => {
    const covered = wordsRepeatedByHook(spoken, { text: 'VOU MOSTRAR PRA VOCÊS, PESSOALMENTE.', untilMs: HOOK_MS })
    expect([...covered].sort()).toEqual([0, 1, 2, 3, 4])
  })

  it('gancho que repete só um pedaço: só esse pedaço sai da legenda', () => {
    expect([...wordsRepeatedByHook(spoken, { text: 'Vou mostrar pra vocês', untilMs: HOOK_MS })].sort()).toEqual([0, 1, 2, 3])
  })

  it('o que o gancho não diz continua na legenda, e uma palavra solta em comum não é repetição', () => {
    expect(wordsRepeatedByHook(spoken, { text: 'Sua página inteira no vídeo', untilMs: HOOK_MS }).size).toBe(0)
    expect(wordsRepeatedByHook(cw(['Eu', 0, 200], ['gosto', 200, 500], ['de', 500, 600], ['vocês', 600, 900]), { text: 'Gente, vocês de novo por aqui', untilMs: HOOK_MS }).size).toBe(0)
  })

  it('gancho de uma palavra só: essa palavra, quando é a primeira dita', () => {
    expect([...wordsRepeatedByHook(cw(['Atenção,', 100, 600], ['isto', 700, 900]), { text: 'ATENÇÃO', untilMs: HOOK_MS })]).toEqual([0])
  })

  it('só vale enquanto o gancho está na tela: a mesma frase dita depois dele continua legenda', () => {
    const later = cw(['Aqui', 100, 400], ['vou', 4300, 4500], ['mostrar', 4500, 4900])
    expect(wordsRepeatedByHook(later, { text: 'Vou mostrar', untilMs: HOOK_MS }).size).toBe(0)
  })

  it('gancho vazio não repete nada', () => {
    expect(wordsRepeatedByHook(spoken, { text: '   ', untilMs: HOOK_MS }).size).toBe(0)
  })
})

describe('na cena do vertical', () => {
  it('gancho = primeira frase: enquanto o gancho está na tela não há legenda por baixo, e a legenda volta com a fala seguinte', () => {
    const p = projectWith(FIRST_SENTENCE)
    for (const t of [400, 1100, 1900, 2500, 3500]) {
      const scene = sceneAt(p, t)
      expect(scene.hook?.text, `gancho em ${t}`).toBe(FIRST_SENTENCE)
      expect(scene.captions, `legenda em ${t}`).toBeNull()
    }
    const after = sceneAt(p, 4800)
    expect(after.hook).toBeNull()
    expect(after.captions!.words.join(' ')).toContain('Aqui')
  })

  it('gancho que não repete a fala: a legenda segue como sempre, junto dele', () => {
    const p = projectWith('Sua página inteira no vídeo')
    const scene = sceneAt(p, 1100)
    expect(scene.hook?.text).toBe('Sua página inteira no vídeo')
    expect(scene.captions!.words.join(' ')).toMatch(/vocês/)
  })

  it('sem gancho nenhuma palavra sai da legenda', () => {
    const p = projectWith('')
    expect(sceneAt(p, 1100).captions!.words.join(' ')).toMatch(/vocês/)
  })

  it('no 16:9 não há gancho e a legenda mostra a fala toda', () => {
    const p = projectWith(FIRST_SENTENCE)
    const derived = deriveProject(p, data, { kind: 'horizontal', w: 1920, h: 1080 }, SPEECH)
    expect(derived.captions!.pages.flatMap((page) => page.words).map((w) => w.text)).toContain('pessoalmente.')
  })

  it('a legenda de arquivo (SRT/VTT) segue com a fala inteira: o gancho só poupa o que se desenha', () => {
    const p = projectWith(FIRST_SENTENCE)
    const cues = buildCues(SPEECH, captionSourceOf(p, D))
    expect(cues.map((c) => c.text).join(' ')).toContain('Vou mostrar pra vocês, pessoalmente.')
  })
})
