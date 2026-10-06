/**
 * GOLDENS do motor de render. Os quadros saem do Chromium do Electron, pelo MESMO caminho da
 * exportação (mediabunny decodifica → evaluateScene → renderFrame num OffscreenCanvas), e são
 * comparados com os PNG de `tests/goldens/` (pixelmatch, 0,4% de tolerância). Sem o golden (ou com
 * UPDATE_GOLDENS=1) o PNG é gravado para conferência a olho. Cópias vão para `test-results/screens/`.
 *
 * O projeto de exemplo tem cliques em 2740, 7800 e 13780 ms e 23 s de duração.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import { eventsFromText } from '../../src/shared/events'
import { deriveProject, evaluateScene, prepareEvents } from '../../src/shared/scene'
import { backgroundFromPreset } from '../../src/shared/styles'
import type { Project } from '../../src/shared/types'
import { copyTree } from '../helpers/fs'
import { E2E_HIDDEN, launchTomada, type Session } from './helpers'
import { compareGolden, GOLDENS_DIR, openLab, readProject, renderStills, saveScreen } from './lab'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

type Scene = { name: string; edit?: (p: Project) => void; t: number; format?: { kind: 'horizontal' | 'vertical'; w: number; h: number } }

const SCENES: Scene[] = [
  { name: 'layout-bolha', t: 1000 },
  {
    name: 'layout-lado-a-lado',
    t: 1000,
    edit: (p) => {
      p.style.defaultLayout = 'side-by-side'
    }
  },
  {
    name: 'layout-so-tela',
    t: 1000,
    edit: (p) => {
      p.style.defaultLayout = 'screen'
    }
  },
  {
    name: 'layout-so-camera',
    t: 1000,
    edit: (p) => {
      p.style.defaultLayout = 'camera'
    }
  },
  {
    name: 'zoom-em-movimento',
    t: 7620,
    edit: (p) => {
      p.zooms = [{ id: 'z1', start: 7300, end: 9200, scale: 1.7, focus: 'auto', origin: 'auto' }]
    }
  },
  {
    name: 'zoom-assentado',
    t: 8600,
    edit: (p) => {
      p.zooms = [{ id: 'z1', start: 7300, end: 9200, scale: 1.7, focus: 'auto', origin: 'auto' }]
    }
  },
  {
    name: 'transicao-de-layout',
    t: 5200,
    edit: (p) => {
      p.layouts = [{ id: 'l1', start: 5000, end: 12_000, layout: 'side-by-side' }]
    }
  },
  { name: 'ripple-inicio', t: 2740 + 70 },
  { name: 'ripple-meio', t: 2740 + 200 },
  {
    name: 'cursor-sintetico',
    t: 2740 + 60,
    edit: (p) => {
      p.style.cursor.mode = 'synthetic'
    }
  },
  {
    name: 'halo-no-cursor-real',
    t: 4200,
    edit: (p) => {
      p.style.cursor.halo = true
    }
  },
  {
    name: 'fundo-violeta-camera-retangulo',
    t: 1000,
    edit: (p) => {
      p.style.background = backgroundFromPreset('violeta')
      p.style.camera.shape = 'rounded'
      p.style.camera.corner = 'top-left'
      p.style.camera.mirror = true
      p.style.radius = 26
    }
  },
  {
    name: 'vertical-recorte-que-segue-o-cursor',
    t: 8600,
    format: { kind: 'vertical', w: 1080, h: 1920 },
    edit: (p) => {
      // o vertical tem a edição PRÓPRIA (M4a): zooms de vertical (1,4×) sobre o recorte que segue o cursor
      p.vertical = { layout: 'screen-focus', layouts: [], zooms: [{ id: 'z1', start: 7300, end: 9200, scale: 1.4, focus: 'auto', origin: 'auto' }], zoomPreset: 'intense' }
    }
  }
]

test('goldens: cada layout, zoom em movimento e assentado, transição, ripple, cursor sintético, halo, estilos e recorte vertical', async () => {
  test.setTimeout(180_000)
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  const lab = await openLab(s.app)

  const results: string[] = []
  for (const scene of SCENES) {
    const project = readProject(s)
    scene.edit?.(project)
    const [png] = await renderStills(lab, { project, times: [scene.t], ...(scene.format ? { format: scene.format } : {}) })
    expect(png, scene.name).toBeDefined()
    saveScreen(`golden-${scene.name}`, png!)
    const r = compareGolden(scene.name, png!)
    results.push(`${scene.name}: ${r.created ? 'golden criado' : `${(r.ratio * 100).toFixed(3)}% diferente`}`)
    expect(r.ratio, `${scene.name} difere do golden em ${(r.ratio * 100).toFixed(3)}% (ver test-results/goldens-diff)`).toBeLessThanOrEqual(0.004)
  }
  console.log(results.join('\n'))
})

test('o render é estável: o mesmo quadro, em ordens e execuções diferentes, sai igual (no máximo ruído de 1 nível em poucos pixels)', async () => {
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  const lab = await openLab(s.app)
  const project = readProject(s)
  project.zooms = [{ id: 'z1', start: 2000, end: 9000, scale: 1.7, focus: 'auto', origin: 'auto' }]
  const a = await renderStills(lab, { project, times: [3000, 4321.5] })
  const b = await renderStills(lab, { project, times: [4321.5, 3000] })
  // Na GPU o gradiente do ripple pode variar 1 nível em meia dúzia de pixels entre execuções (medido: 7 de 2 milhões
  // na placa dedicada; na integrada saía idêntico byte a byte). Mais que isso é estado vazando entre quadros.
  const noise = (x: Buffer, y: Buffer): { pixels: number; max: number } => {
    const p = PNG.sync.read(x)
    const q = PNG.sync.read(y)
    let pixels = 0
    let max = 0
    for (let i = 0; i < p.data.length; i += 4) {
      const d = Math.max(Math.abs(p.data[i]! - q.data[i]!), Math.abs(p.data[i + 1]! - q.data[i + 1]!), Math.abs(p.data[i + 2]! - q.data[i + 2]!))
      if (d > 0) pixels++
      if (d > max) max = d
    }
    return { pixels, max }
  }
  for (const [x, y] of [
    [a[0]!, b[1]!],
    [a[1]!, b[0]!]
  ] as const) {
    const n = noise(x, y)
    expect(n.max).toBeLessThanOrEqual(2)
    expect(n.pixels).toBeLessThan(200) // 0,01% do quadro
  }
})

test('qualidade do desenho: cantos com antialiasing, sombra por baixo, fundo sem faixas, ripple visível', async () => {
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  const lab = await openLab(s.app)
  const project = readProject(s)
  project.style.defaultLayout = 'screen'
  const [still, rippled] = await renderStills(lab, { project, times: [1000, 2740 + 120] })
  const img = PNG.sync.read(still!)
  const px = (x: number, y: number): number[] => {
    const i = (y * img.width + x) * 4
    return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]
  }
  const lum = (c: number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!

  // retângulo da tela: margem de 6% de 1080 (65 px); 16:9 numa altura de 950 px → largura 1689
  const cardH = 1080 - 130
  const cardW = Math.round(cardH * (16 / 9))
  const left = Math.round((1920 - cardW) / 2)
  const top = 65
  const bgCorner = px(left, top)
  const inside = px(left + 40, top + 40)
  expect(Math.abs(lum(bgCorner) - lum(inside))).toBeGreaterThan(3) // fundo e tela são diferentes
  // sombra: logo abaixo da borda inferior fica mais escuro que o fundo na mesma altura, longe da tela
  const underCard = lum(px(960, top + cardH + 10))
  const sameRowFar = lum(px(8, top + cardH + 10))
  expect(underCard).toBeLessThan(sameRowFar)
  // dither: o fundo não tem faixas (nenhuma sequência de 40 px idênticos numa linha do gradiente)
  let longestRun = 1
  let run = 1
  for (let x = 1; x < 60; x++) {
    const a = px(x, 10)
    const b = px(x - 1, 10)
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) run++
    else run = 1
    longestRun = Math.max(longestRun, run)
  }
  expect(longestRun).toBeLessThan(40)

  // ripple: o que muda entre o quadro com e sem ripple fica dentro de 45 px do ponto do clique (0,5 · 0,5)
  const noRipple = readProject(s)
  noRipple.style.defaultLayout = 'screen'
  noRipple.style.cursor.ripple = false
  const [plain] = await renderStills(lab, { project: noRipple, times: [2740 + 120] })
  const withR = PNG.sync.read(rippled!)
  const without = PNG.sync.read(plain!)
  const cx = left + Math.round(0.5 * cardW)
  const cy = top + Math.round(0.5 * cardH)
  let near = 0
  let far = 0
  for (let y = 0; y < withR.height; y++) {
    for (let x = 0; x < withR.width; x++) {
      const i = (y * withR.width + x) * 4
      const d = Math.abs(withR.data[i]! - without.data[i]!) + Math.abs(withR.data[i + 1]! - without.data[i + 1]!) + Math.abs(withR.data[i + 2]! - without.data[i + 2]!)
      if (d < 12) continue
      if (Math.hypot(x - cx, y - cy) <= 45) near++
      else far++
    }
  }
  expect(near).toBeGreaterThan(150) // o ripple aparece
  expect(far).toBe(0) // e não suja o resto do quadro
})

test('cantos arredondados com antialiasing: o arco tem tons intermediários (clip binário daria serrilhado)', async () => {
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  const lab = await openLab(s.app)
  const project = readProject(s)
  project.style.defaultLayout = 'screen'
  project.style.background = backgroundFromPreset('branco') // fundo claro: contraste máximo com a tela escura
  project.style.shadow.opacity = 0
  const [still] = await renderStills(lab, { project, times: [1000] })
  const img = PNG.sync.read(still!)
  const lum = (x: number, y: number): number => {
    const i = (y * img.width + x) * 4
    return 0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!
  }
  const cardW = Math.round((1080 - 130) * (16 / 9))
  const left = Math.round((1920 - cardW) / 2)
  const top = 65
  let partial = 0
  let white = 0
  let dark = 0
  for (let dy = 0; dy < 22; dy++) {
    for (let dx = 0; dx < 22; dx++) {
      const l = lum(left + dx, top + dy)
      if (l > 245) white++
      else if (l < 80) dark++
      else partial++
    }
  }
  expect(white).toBeGreaterThan(10) // o miolo do canto é fundo
  expect(dark).toBeGreaterThan(200) // e o resto é tela
  expect(partial).toBeGreaterThan(15) // ao longo do arco de raio 18 há dezenas de pixels parcialmente cobertos
  // simetria: os quatro cantos têm contagens parecidas de pixels parciais. A integrada desenha o arco de forma
  // simétrica (±3); a placa dedicada usa outro padrão de amostras (medido 16 a 24), então a trava é ±10.
  const right = left + cardW - 1
  const bottom = top + (1080 - 130) - 1
  const count = (x0: number, y0: number, sx: number, sy: number): number => {
    let n = 0
    for (let dy = 0; dy < 22; dy++) for (let dx = 0; dx < 22; dx++) {
      const l = lum(x0 + sx * dx, y0 + sy * dy)
      if (l >= 80 && l <= 245) n++
    }
    return n
  }
  const corners = [count(left, top, 1, 1), count(right, top, -1, 1), count(left, bottom, 1, -1), count(right, bottom, -1, -1)]
  console.log(`pixels parciais por canto (de cima/esquerda a baixo/direita): ${corners.join(', ')}`)
  expect(Math.min(...corners)).toBeGreaterThan(12) // os quatro cantos têm antialiasing
  expect(Math.max(...corners) - Math.min(...corners)).toBeLessThanOrEqual(10)
})

test('sombra: o sprite é montado uma vez e custa pouco por quadro (na placa integrada é ~6x mais barato que shadowBlur)', async () => {
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  const lab = await openLab(s.app)
  const cost = await lab.evaluate(() =>
    (window as unknown as { tomadaExport: { measureShadowCost(): { spriteMs: number; blurMs: number; builds: number } } }).tomadaExport.measureShadowCost()
  )
  console.log(
    `sombra 1080p por quadro: sprite ${cost.spriteMs.toFixed(3)} ms x shadowBlur ${cost.blurMs.toFixed(3)} ms (${(cost.blurMs / cost.spriteMs).toFixed(0)}x), ${cost.builds} sprite(s) montado(s)`
  )
  expect(cost.builds).toBe(1) // montado UMA vez
  // Medido: placa integrada (Intel UHD) sprite 0,37 ms x shadowBlur 2,39 ms; dedicada (RTX 3050) 1,18 x 0,85. A vantagem
  // depende da GPU, então a trava é o orçamento absoluto: de 16,7 ms de um quadro a 60 qps, a sombra gasta menos de 2 ms.
  // O orçamento é da GPU: o compositor por software das janelas ocultas mede ~4,7 ms. Vale na rodada visível (TOMADA_E2E_HIDDEN=0).
  if (!E2E_HIDDEN) expect(cost.spriteMs).toBeLessThan(2)
})

// ---------------------------------------------------------------------------------------------
// Halo × cursor REAL do vídeo. `tests/goldens/real/gravacao-janela` é uma gravação de verdade da M1b (janela de
// teste, 1132×788 a 30 qps, cursor do sistema no vídeo, `cursorHidden: false`), feita por `npm run test:real`.
// O cursor fica parado em (0,18905 · 0,57234) de 2000 a 2680 ms; o clique é em 2089 ms.

const REAL_DIR = join(GOLDENS_DIR, 'real', 'gravacao-janela')
const REAL_FOLDER = '2026-10-05 0202 Janela real'

test('halo no cursor de uma gravação REAL: o centro do halo cai na ponta da seta que está no vídeo (±6 px)', async () => {
  test.setTimeout(120_000)
  s = await launchTomada({ seed: false })
  copyTree(REAL_DIR, join(s.projects, REAL_FOLDER))
  const lab = await openLab(s.app)
  const T = 2400
  const format = { kind: 'horizontal' as const, w: 1920, h: 1080 }
  const project = readProject(s, REAL_FOLDER)
  project.style.defaultLayout = 'screen'
  project.style.cursor.ripple = false
  project.zooms = []

  // onde o motor põe o halo (mesma conta da exportação)
  const events = eventsFromText({
    cursor: readFileSync(join(REAL_DIR, 'events', 'cursor.jsonl'), 'utf8'),
    clicks: readFileSync(join(REAL_DIR, 'events', 'clicks.jsonl'), 'utf8')
  })
  const haloOn = structuredClone(project)
  haloOn.style.cursor.halo = true
  const scene = evaluateScene(haloOn, deriveProject(haloOn, prepareEvents(events, 12_867), format), T, format)
  expect(scene.halo, 'o halo precisa existir com style.cursor.halo = true').not.toBeNull()
  const { x: hx, y: hy } = scene.halo!

  const [withHalo] = await renderStills(lab, { project: haloOn, times: [T], folder: REAL_FOLDER })
  const [plain] = await renderStills(lab, { project, times: [T], folder: REAL_FOLDER })
  saveScreen('golden-halo-gravacao-real', withHalo!)
  const r = compareGolden('halo-gravacao-real', withHalo!)
  console.log(`halo-gravacao-real: ${r.created ? 'golden criado' : `${(r.ratio * 100).toFixed(3)}% diferente`}; halo em (${hx.toFixed(1)}, ${hy.toFixed(1)})`)
  expect(r.ratio).toBeLessThanOrEqual(0.004)

  // a seta do vídeo (sem halo): pixels que fogem da cor do botão numa janela de 90×90 em volta do ponto esperado
  const img = PNG.sync.read(plain!)
  const x0 = Math.round(hx) - 15
  const y0 = Math.round(hy) - 15
  const size = 90
  const at = (x: number, y: number): number[] => {
    const i = (y * img.width + x) * 4
    return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]
  }
  const channel = (k: number): number => {
    const v: number[] = []
    for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) v.push(at(x, y)[k]!)
    return v.sort((a, b) => a - b)[Math.floor(v.length / 2)]!
  }
  const ref = [channel(0), channel(1), channel(2)]
  let tip: { x: number; y: number } | null = null
  let count = 0
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      const c = at(x, y)
      if (Math.abs(c[0]! - ref[0]!) + Math.abs(c[1]! - ref[1]!) + Math.abs(c[2]! - ref[2]!) < 150) continue
      count++
      if (!tip || x + y < tip.x + tip.y) tip = { x, y }
    }
  }
  expect(count, 'a seta do cursor precisa aparecer no vídeo').toBeGreaterThan(100)
  console.log(`seta do vídeo: ${count} px, ponta em (${tip!.x}, ${tip!.y}); halo em (${hx.toFixed(1)}, ${hy.toFixed(1)}); desvio (${(tip!.x - hx).toFixed(1)}, ${(tip!.y - hy).toFixed(1)}) px`)
  expect(Math.abs(tip!.x - hx)).toBeLessThanOrEqual(6)
  expect(Math.abs(tip!.y - hy)).toBeLessThanOrEqual(6)
})
