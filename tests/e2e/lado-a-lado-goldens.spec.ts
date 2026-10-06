/**
 * GOLDENS do quadro da câmera ao lado da tela (estilo Tella) e do ENQUADRAMENTO DO ROSTO (M4c). Os quadros saem do Chromium do
 * Electron pelo MESMO caminho da exportação e são comparados com os PNG de `tests/goldens/` (pixelmatch, 0,4% de tolerância).
 *
 * A câmera do projeto de exemplo é uma imagem de barras de cor com uma faixa em arco-íris: serve de régua para ver ONDE o recorte
 * cai (vermelho, verde, amarelo, azul, magenta, ciano, da esquerda para a direita). Um rosto sintético em x 0,82 (à direita) leva
 * o recorte para o magenta e o ciano; sem análise o recorte fica no centro (amarelo e azul).
 */
import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import type { Project, SideBySideStyle } from '../../src/shared/types'
import { launchTomada, type Session } from './helpers'
import { compareGolden, openLab, readProject, renderStills, saveScreen, writeFace } from './lab'

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

type Case = { name: string; t: number; format: typeof H | typeof V; face?: number; edit: (p: Project) => void }

const side =
  (sideBySide: SideBySideStyle): ((p: Project) => void) =>
  (p) => {
    p.style.defaultLayout = 'side-by-side'
    p.style.sideBySide = sideBySide
  }

const CASES: Case[] = [
  // --- a câmera ao lado da tela: lado, formato, largura ---------------------------------------------------------------
  { name: 'lado-a-lado-direita-em-pe', t: 3000, format: H, edit: side({ side: 'right', ratio: 'portrait' }) },
  { name: 'lado-a-lado-esquerda-em-pe', t: 3000, format: H, edit: side({ side: 'left', ratio: 'portrait' }) },
  { name: 'lado-a-lado-quadrado-direita', t: 3000, format: H, edit: side({ side: 'right', ratio: 'square' }) },
  { name: 'lado-a-lado-quadrado-esquerda-largo', t: 3000, format: H, edit: side({ side: 'left', ratio: 'square', width: 0.4, gap: 0.06 }) },
  // --- o enquadramento do rosto: o recorte acompanha o rosto (à direita) em cada quadro de câmera ---------------------------
  { name: 'lado-a-lado-rosto-a-direita', t: 3000, format: H, face: 0.82, edit: side({ side: 'right', ratio: 'portrait' }) },
  {
    name: 'bolha-rosto-a-direita',
    t: 3000,
    format: H,
    face: 0.82,
    edit: (p) => {
      p.style.defaultLayout = 'bubble'
      p.style.camera.size = 0.34
    }
  },
  {
    name: 'lado-a-lado-enquadramento-manual',
    t: 3000,
    format: H,
    face: 0.82,
    edit: (p) => {
      side({ side: 'right', ratio: 'portrait' })(p)
      // à mão: sem o automático, aproximado 1,6× e deslocado para a esquerda
      p.style.camera.framing = { auto: false, zoom: 1.6, dx: -0.2, dy: 0 }
    }
  },
  {
    name: 'vertical-b-rosto-a-direita',
    t: 8600,
    format: V,
    face: 0.82,
    edit: (p) => {
      p.vertical = { layout: 'stack', layouts: [], zooms: [], zoomPreset: 'moderate' }
    }
  }
]

test('goldens: lado a lado (esquerda, direita, quadrado, em pé) e o enquadramento do rosto na bolha, no lado a lado e no V-B', async () => {
  test.setTimeout(180_000)
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  const lab = await openLab(s.app)
  const faceUrl = writeFace(s, { cx: 0.82 })

  const results: string[] = []
  for (const c of CASES) {
    const project = readProject(s)
    c.edit(project)
    const [png] = await renderStills(lab, { project, times: [c.t], format: c.format, faceUrl: c.face !== undefined ? faceUrl : null })
    expect(png, c.name).toBeDefined()
    saveScreen(`golden-${c.name}`, png!)
    const r = compareGolden(c.name, png!)
    results.push(`${c.name}: ${r.created ? 'golden criado' : `${(r.ratio * 100).toFixed(3)}% diferente`}`)
    expect(r.ratio, `${c.name} difere do golden em ${(r.ratio * 100).toFixed(3)}% (ver test-results/goldens-diff)`).toBeLessThanOrEqual(0.004)
  }
  console.log(results.join('\n'))
})

test('o enquadramento muda o que a câmera mostra: com o rosto à direita o quadro em pé vê as barras da direita, sem ele vê as do centro', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  const lab = await openLab(s.app)
  const faceUrl = writeFace(s, { cx: 0.82 })
  const project = readProject(s)
  side({ side: 'right', ratio: 'portrait' })(project)
  const [centered] = await renderStills(lab, { project, times: [3000], format: H })
  const [followed] = await renderStills(lab, { project, times: [3000], format: H, faceUrl })

  /** Cor média do meio do cartão da câmera (x 88-92% do quadro, no meio da altura). */
  const camColor = (png: Buffer): [number, number, number] => {
    const img = PNG.sync.read(png)
    const x0 = Math.round(img.width * 0.9)
    const y0 = Math.round(img.height * 0.5)
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (let y = y0 - 20; y < y0 + 20; y++) {
      for (let x = x0 - 20; x < x0 + 20; x++) {
        const i = (img.width * y + x) << 2
        r += img.data[i]!
        g += img.data[i + 1]!
        b += img.data[i + 2]!
        n++
      }
    }
    return [r / n, g / n, b / n]
  }
  const a = camColor(centered!)
  const b = camColor(followed!)
  console.log(`cor no meio da câmera: sem rosto ${a.map(Math.round).join(',')} · com o rosto à direita ${b.map(Math.round).join(',')}`)
  // os dois recortes são diferentes de verdade (não é ruído): a distância entre as cores é grande
  const dist = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  expect(dist).toBeGreaterThan(120)
  expect(saveScreen('lado-a-lado-sem-rosto-x-com-rosto', followed!)).toBeTruthy()
})
