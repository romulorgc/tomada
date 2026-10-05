/**
 * GOLDENS das legendas e do vertical (M4a). Os quadros saem do Chromium do Electron pelo MESMO caminho da exportação
 * (`evaluateScene` + `renderFrame` num OffscreenCanvas, com as fontes empacotadas) e são comparados com os PNG de
 * `tests/goldens/` (pixelmatch, 0,4% de tolerância). Sem o golden (ou com UPDATE_GOLDENS=1) o PNG é gravado para conferência
 * a olho; cópias vão para `test-results/screens/`.
 *
 * O projeto de exemplo (23 s, câmera, cliques em 2740, 7800 e 13780 ms) tem transcrição de 36 palavras:
 * "Olá, pessoal." (400-1753), "Hoje eu vou mostrar como gravar a tela." (1753-5617), "Então, vamos clicar aqui no botão de gravar."
 * (7451-11132)…
 *
 * Os números são os da R1 (recalibração pelos 115 vídeos reais do estudo E1): legenda de uma linha de 2 palavras no vertical (5 no
 * 16:9), maiúscula de 58 px no Destaque e 46 px nos estilos de caixa mista, centro em y 70% (na emenda tela/câmera no V-B), V-B sem
 * barras (tela 0-50%, câmera 50-100%), tela na largura com 94% e título de gancho de 46 px em y 15%.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import { parseTranscript } from '../../src/shared/transcript'
import type { Project, Word } from '../../src/shared/types'
import { EXAMPLE_FOLDER, launchTomada, type Session } from './helpers'
import { compareGolden, openLab, readProject, renderStills, saveScreen } from './lab'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

const V = { kind: 'vertical' as const, w: 1080, h: 1920 }
const H = { kind: 'horizontal' as const, w: 1920, h: 1080 }

function words(session: Session): Word[] {
  return parseTranscript(readFileSync(join(session.projects, EXAMPLE_FOLDER, 'transcript.json'), 'utf8')).words
}

type Case = { name: string; t: number; format: typeof V | typeof H; edit: (p: Project) => void }

/** O bloco `vertical` do documento num estado conhecido (os goldens não dependem da escolha automática). */
const vertical = (over: Partial<NonNullable<Project['vertical']>> = {}): NonNullable<Project['vertical']> => ({
  layout: 'screen-focus',
  layouts: [],
  zooms: [],
  zoomPreset: 'moderate',
  ...over
})

const CASES: Case[] = [
  // --- os quatro estilos de legenda (a palavra "mostrar" está acesa em 3200 ms) ---------------------------------------------
  {
    name: 'legenda-natural',
    t: 3200,
    format: H,
    edit: (p) => {
      p.captions = { ...p.captions, enabled: true, style: 'natural', wordsPerLine: 5, box: true }
      p.style.defaultLayout = 'bubble'
    }
  },
  // o padrão do vertical (pt-BR): Natural em caixa mista, sem caixa atrás, 1 linha de 2 palavras, a palavra falada em destaque
  {
    name: 'legenda-natural-vertical',
    t: 3200,
    format: V,
    edit: (p) => {
      p.vertical = vertical({ captions: { enabled: true, style: 'natural', wordsPerLine: 2 } })
    }
  },
  {
    name: 'legenda-destaque',
    t: 3200,
    format: V,
    edit: (p) => {
      p.vertical = vertical({ captions: { enabled: true, style: 'highlight', wordsPerLine: 2 } })
    }
  },
  {
    name: 'legenda-limpa',
    t: 3200,
    format: V,
    edit: (p) => {
      p.vertical = vertical({ captions: { enabled: true, style: 'clean', wordsPerLine: 2 } })
    }
  },
  {
    name: 'legenda-karaoke',
    t: 3200,
    format: V,
    edit: (p) => {
      p.vertical = vertical({ captions: { enabled: true, style: 'karaoke', wordsPerLine: 2 } })
    }
  },
  // --- os layouts verticais, com legenda (e o título de gancho no V-A) -------------------------------------------------------
  {
    name: 'vertical-a-cursor',
    t: 1200,
    format: V,
    edit: (p) => {
      p.vertical = vertical({ hook: 'Grave sua tela em 1 clique', zooms: [{ id: 'z1', start: 600, end: 3000, scale: 1.35, focus: 'auto', origin: 'auto' }] })
    }
  },
  {
    name: 'vertical-b-camera-e-tela',
    t: 8600,
    format: V,
    edit: (p) => {
      p.vertical = vertical({ layout: 'stack', zooms: [{ id: 'z1', start: 7300, end: 9200, scale: 1.35, focus: 'auto', origin: 'auto' }] })
    }
  },
  {
    name: 'vertical-b-camera-em-cima',
    t: 8600,
    format: V,
    edit: (p) => {
      p.vertical = vertical({ layout: 'stack', cameraTop: true, zooms: [{ id: 'z1', start: 7300, end: 9200, scale: 1.35, focus: 'auto', origin: 'auto' }] })
    }
  },
  {
    name: 'vertical-c-tela-na-largura',
    t: 8600,
    format: V,
    edit: (p) => {
      p.vertical = vertical({ layout: 'screen-wide' })
    }
  }
]

test('goldens: os 4 estilos de legenda e os 3 layouts verticais (V-A com título de gancho, V-B, V-C)', async () => {
  test.setTimeout(180_000)
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  const lab = await openLab(s.app)
  const w = words(s)

  const results: string[] = []
  for (const c of CASES) {
    const project = readProject(s)
    c.edit(project)
    const [png] = await renderStills(lab, { project, times: [c.t], format: c.format, words: w })
    expect(png, c.name).toBeDefined()
    saveScreen(`golden-${c.name}`, png!)
    const r = compareGolden(c.name, png!)
    results.push(`${c.name}: ${r.created ? 'golden criado' : `${(r.ratio * 100).toFixed(3)}% diferente`}`)
    expect(r.ratio, `${c.name} difere do golden em ${(r.ratio * 100).toFixed(3)}% (ver test-results/goldens-diff)`).toBeLessThanOrEqual(0.004)
  }
  console.log(results.join('\n'))
})

// ---------------------------------------------------------------------------------------------------------------------
// Fontes: o primeiro quadro de uma janela de exportação RECÉM-ABERTA já sai com a fonte certa

test('a janela de exportação carrega as fontes ANTES do primeiro quadro: o primeiro quadro é igual ao de depois', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  const lab = await openLab(s.app) // janela nova: nenhuma fonte carregada ainda
  const loadedBefore = await lab.evaluate(() => (window as unknown as { tomadaExport: { captionFontsLoaded(): boolean } }).tomadaExport.captionFontsLoaded())
  expect(loadedBefore, 'a janela do laboratório precisa estar fria (sem fontes) para o teste valer').toBe(false)

  const project = readProject(s)
  project.vertical = vertical({ captions: { enabled: true, style: 'highlight', wordsPerLine: 3 } })
  const w = words(s)
  const [first] = await renderStills(lab, { project, times: [3200], format: V, words: w }) // 1ª chamada: o exportador carrega as fontes
  const [again] = await renderStills(lab, { project, times: [3200], format: V, words: w }) // 2ª: fontes com certeza carregadas
  const a = PNG.sync.read(first!)
  const b = PNG.sync.read(again!)
  let diff = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!) > 12) diff++
  }
  expect(diff, 'o primeiro quadro difere do segundo: saiu com a fonte errada').toBeLessThan(200)

  // e as fontes empacotadas são MESMO as que desenham (a de reserva tem outra largura)
  const widths = await lab.evaluate(() => {
    const ctx = new OffscreenCanvas(10, 10).getContext('2d')!
    const text = 'ELES PRECISAM SABER'
    ctx.font = '800 80px "Tomada Montserrat", monospace'
    const real = ctx.measureText(text).width
    ctx.font = '800 80px monospace'
    const fallback = ctx.measureText(text).width
    ctx.font = '400 80px "Tomada Anton", monospace'
    const anton = ctx.measureText(text).width
    return { real, fallback, anton, loaded: (window as unknown as { tomadaExport: { captionFontsLoaded(): boolean } }).tomadaExport.captionFontsLoaded() }
  })
  console.log(`largura de "ELES PRECISAM SABER" a 80 px: Montserrat ExtraBold ${widths.real.toFixed(1)}, reserva ${widths.fallback.toFixed(1)}, Anton ${widths.anton.toFixed(1)}`)
  expect(widths.loaded).toBe(true)
  expect(Math.abs(widths.real - widths.fallback)).toBeGreaterThan(widths.fallback * 0.08)
  expect(Math.abs(widths.anton - widths.real)).toBeGreaterThan(widths.real * 0.08) // Anton é bem mais estreita
})
