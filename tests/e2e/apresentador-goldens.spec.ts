/**
 * GOLDENS do APRESENTADOR RECORTADO (M4c): a webcam SEM o fundo, ancorada na borda de baixo, na frente da tela. Os quadros saem do
 * Chromium do Electron pelo MESMO caminho da exportação e são comparados com os PNG de `tests/goldens/` (pixelmatch, 0,4% de tolerância).
 *
 * O recorte do fundo aqui é SINTÉTICO (`writeMatte`: uma silhueta conhecida em branco sobre preto, com o tamanho e a taxa da câmera de
 * exemplo): serve de gabarito para a COMPOSIÇÃO (janela, canto, contorno, sombra, transição, legenda), que é do render. A qualidade do
 * recorte do modelo de verdade se mede com a gravação real, em `test-results/matte/` (ver README).
 *
 * A câmera de exemplo é uma imagem de barras de cor: onde a silhueta cobre, aparecem as barras; fora dela, aparece a tela.
 */
import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import type { Project, Word } from '../../src/shared/types'
import { presenterWindow, resolvePresenter } from '../../src/shared/styles'
import { launchTomada, type Session } from './helpers'
import { compareGolden, openLab, readProject, renderStills, saveScreen, writeFace, writeMatte } from './lab'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

const H = { kind: 'horizontal' as const, w: 1920, h: 1080 }
const V = { kind: 'vertical' as const, w: 1080, h: 1920 }

type Case = { name: string; t: number; format: typeof H | typeof V; face?: boolean; words?: boolean; edit: (p: Project) => void }

const presenter = (p: Project, style: Project['style']['presenter'] = {}): void => {
  p.style.defaultLayout = 'presenter'
  p.style.presenter = style
}

const verticalPresenter = (p: Project, style: Project['style']['presenter'] = {}): void => {
  p.style.presenter = style
  p.vertical = { layout: 'presenter', layouts: [], zooms: [], zoomPreset: 'moderate' }
}

/** Uma legenda no instante t = 3000 ms (as palavras do exemplo caem fora do trecho renderizado). */
const WORDS: Word[] = ['Veja', 'como', 'ficou', 'o', 'recorte', 'do', 'apresentador'].map((text, i) => ({ i, text, start: 2600 + i * 220, end: 2800 + i * 220, prob: 0.99, kind: 'word' as const }))

const CASES: Case[] = [
  // --- 16:9: a pessoa ancorada embaixo, no canto, passando um pouco da borda ----------------------------------------------
  { name: 'apresentador-16x9-direita', t: 3000, format: H, edit: (p) => presenter(p) },
  { name: 'apresentador-16x9-esquerda', t: 3000, format: H, edit: (p) => presenter(p, { side: 'left' }) },
  { name: 'apresentador-16x9-alto', t: 3000, format: H, edit: (p) => presenter(p, { height: 0.7 }) },
  { name: 'apresentador-16x9-baixo', t: 3000, format: H, edit: (p) => presenter(p, { height: 0.46 }) },
  { name: 'apresentador-16x9-contorno-sombra', t: 3000, format: H, edit: (p) => presenter(p, { outline: true, outlineWidth: 10, shadow: true }) },
  { name: 'apresentador-16x9-sem-sombra', t: 3000, format: H, edit: (p) => presenter(p, { shadow: false }) },
  // --- 9:16 (V-D): o recorte da tela em cima, a pessoa embaixo, a legenda logo acima da cabeça -----------------------------
  { name: 'apresentador-vd', t: 8600, format: V, edit: (p) => verticalPresenter(p) },
  { name: 'apresentador-vd-contorno', t: 8600, format: V, edit: (p) => verticalPresenter(p, { outline: true, outlineWidth: 8 }) },
  {
    name: 'apresentador-vd-legenda',
    t: 3000,
    format: V,
    words: true,
    edit: (p) => {
      verticalPresenter(p)
      p.captions.enabled = true
    }
  }
]

test('goldens: apresentador recortado no 16:9 (canto, altura, contorno, sombra) e no V-D (9:16)', async () => {
  test.setTimeout(240_000)
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  const lab = await openLab(s.app)
  const matteUrl = writeMatte(s)
  const faceUrl = writeFace(s, { cx: 0.5 })

  const results: string[] = []
  for (const c of CASES) {
    const project = readProject(s)
    c.edit(project)
    const [png] = await renderStills(lab, { project, times: [c.t], format: c.format, matteUrl, faceUrl: c.face === false ? null : faceUrl, words: c.words ? WORDS : null })
    expect(png, c.name).toBeDefined()
    saveScreen(`golden-${c.name}`, png!)
    const r = compareGolden(c.name, png!)
    results.push(`${c.name}: ${r.created ? 'golden criado' : `${(r.ratio * 100).toFixed(3)}% diferente`}`)
    expect(r.ratio, `${c.name} difere do golden em ${(r.ratio * 100).toFixed(3)}% (ver test-results/goldens-diff)`).toBeLessThanOrEqual(0.004)
  }
  console.log(results.join('\n'))
})

type Rgb = [number, number, number]

function pixel(png: Buffer, fx: number, fy: number): Rgb {
  const img = PNG.sync.read(png)
  const x = Math.round(img.width * fx)
  const y = Math.round(img.height * fy)
  const i = (img.width * y + x) << 2
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]
}

const dist = (a: Rgb, b: Rgb): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

test('a máscara decide o que se vê: dentro da silhueta a webcam, fora dela a tela (sem o fundo da webcam)', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  const lab = await openLab(s.app)
  const matteUrl = writeMatte(s)
  const withMatte = readProject(s)
  presenter(withMatte, { shadow: false })
  const [presented] = await renderStills(lab, { project: withMatte, times: [3000], format: H, matteUrl })
  // a mesma cena SEM o layout (a tela em tela cheia): é o que está atrás da pessoa
  const plain = readProject(s)
  plain.style.defaultLayout = 'screen'
  const [screen] = await renderStills(lab, { project: plain, times: [3000], format: H })

  // a janela da pessoa (a mesma conta do render): ancorada embaixo, no canto direito
  const win = presenterWindow(resolvePresenter({ shadow: false }), H, false)
  const [winW, winH, winLeft, winTop] = [win.w / H.w, win.h / H.h, win.x / H.w, win.y / H.h]
  const at = (u: number, v: number): [number, number] => [winLeft + winW * u, winTop + winH * v]

  // o canto de cima da janela (fundo da webcam): tem de ser a TELA, igual à cena sem o layout
  const [bgX, bgY] = at(0.04, 0.06)
  const outside = dist(pixel(presented!, bgX, bgY), pixel(screen!, bgX, bgY))
  expect(outside, 'fora da silhueta o pixel é o da tela').toBeLessThan(12)
  // o meio do tronco (dentro da silhueta): tem de ser a WEBCAM, bem diferente da tela
  const [bodyX, bodyY] = at(0.5, 0.92)
  const inside = dist(pixel(presented!, bodyX, bodyY), pixel(screen!, bodyX, bodyY))
  expect(inside, 'dentro da silhueta o pixel é o da webcam').toBeGreaterThan(40)
  console.log(`diferença para a tela: fora da silhueta ${outside.toFixed(1)} · dentro ${inside.toFixed(1)}`)
  saveScreen('apresentador-mascara-decide', presented!)
})

test('o espelho do canto: trocar o canto leva a pessoa para o outro lado do quadro', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  const lab = await openLab(s.app)
  const matteUrl = writeMatte(s)
  const right = readProject(s)
  presenter(right, { shadow: false, side: 'right' })
  const left = readProject(s)
  presenter(left, { shadow: false, side: 'left' })
  const plain = readProject(s)
  plain.style.defaultLayout = 'screen'
  const [r] = await renderStills(lab, { project: right, times: [3000], format: H, matteUrl })
  const [l] = await renderStills(lab, { project: left, times: [3000], format: H, matteUrl })
  const [base] = await renderStills(lab, { project: plain, times: [3000], format: H })
  // a base do tronco: à direita no canto direito; à esquerda no canto esquerdo (o outro lado é só a tela)
  const rightEdge = (png: Buffer): number => dist(pixel(png, 0.93, 0.97), pixel(base!, 0.93, 0.97))
  const leftEdge = (png: Buffer): number => dist(pixel(png, 0.07, 0.97), pixel(base!, 0.07, 0.97))
  expect(rightEdge(r!)).toBeGreaterThan(40)
  expect(leftEdge(r!)).toBeLessThan(12)
  expect(leftEdge(l!)).toBeGreaterThan(40)
  expect(rightEdge(l!)).toBeLessThan(12)
})

test('a transição de 400 ms: no meio dela a pessoa está entre os dois layouts; antes e depois, nos extremos', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  const lab = await openLab(s.app)
  const matteUrl = writeMatte(s)
  const project = readProject(s)
  project.style.defaultLayout = 'screen'
  project.style.presenter = { shadow: false }
  // o apresentador entra aos 4000 ms (antes: só a tela)
  project.layouts = [{ id: 'layout-t1', start: 4000, end: 9000, layout: 'presenter' }]
  const times = [3500, 4000, 4200, 4400, 4800]
  const stills = await renderStills(lab, { project, times, format: H, matteUrl })
  // o meio do tronco no canto direito: a pessoa aparece de pouco a pouco
  const base = pixel(stills[0]!, 0.93, 0.97)
  const d = stills.map((png) => dist(pixel(png, 0.93, 0.97), base))
  console.log(`diferença do tronco para a tela, em ${times.join('/')} ms: ${d.map((x) => x.toFixed(0)).join(' / ')}`)
  expect(d[0]).toBeLessThan(2)
  expect(d[4]).toBeGreaterThan(40)
  // monotônica e, no meio, nem zero nem cheia
  expect(d[2]!).toBeGreaterThan(d[0]!)
  expect(d[2]!).toBeLessThan(d[4]! - 2)
  expect(d[3]!).toBeGreaterThanOrEqual(d[2]! - 1)
  saveScreen('apresentador-transicao-meio', stills[2]!)
})

test('sem o recorte do fundo a exportação falha com o que fazer (nunca sai um vídeo diferente da prévia)', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  const lab = await openLab(s.app)
  const project = readProject(s)
  presenter(project)
  await expect(renderStills(lab, { project, times: [3000], format: H })).rejects.toThrow(/recorte do fundo/)
})
