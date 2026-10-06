/**
 * O APRESENTADOR RECORTADO com a gravação REAL do usuário (`gravacoes/`, só nesta máquina) e o recorte do fundo DE VERDADE (RVM na placa, o mesmo código
 * do app): um trecho de 6 s da câmera real vira o `media/camera.mp4` do projeto de exemplo, a máscara sai do motor e o laboratório de render desenha, pelo
 * MESMO caminho da exportação, o Apresentador 16:9 (direita e esquerda, com contorno e sombra) e o V-D 9:16. A prancha para olhar fica em
 * `test-results/screens/real-apresentador-prancha.png` (nada disto vai para `tests/`).
 *
 * Exige o motor preparado (`npm run preparar:camera`) e a gravação real: sem eles o teste FALHA dizendo isso (nada de pular). Pela fila pesada (usa a placa).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import { createPythonCamera } from '../../src/main/camera/python-engine'
import { locateFfmpeg } from '../../src/main/ffmpeg'
import { createMemoryLogger } from '../../src/main/logger'
import { ensureToolsDir, toolPaths } from '../../src/main/transcription/tools-dir'
import { MATTE_FILE } from '../../src/shared/matte'
import { mediaUrl } from '../../src/shared/media-url'
import type { Project } from '../../src/shared/types'
import { presenterWindow, resolvePresenter } from '../../src/shared/styles'
import { EXAMPLE_FOLDER, launchTomada, SCREENS_DIR, type Session } from './helpers'
import { openLab, readProject, renderStills, saveScreen } from './lab'
import { ROOT } from '../helpers/fs'

const REAL = join(ROOT, 'gravacoes', '2026-07-26-13-57-59', 'camera.mp4')

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

/** A diferença média de cor entre duas imagens numa região (fração do quadro), em uma grade de 24×24 pontos. */
function regionDiff(a: Buffer, b: Buffer, x0: number, y0: number, x1: number, y1: number): number {
  const A = PNG.sync.read(a)
  const B = PNG.sync.read(b)
  let sum = 0
  let n = 0
  for (let i = 0; i < 24; i++) {
    for (let j = 0; j < 24; j++) {
      const x = Math.round((x0 + ((x1 - x0) * i) / 23) * (A.width - 1))
      const y = Math.round((y0 + ((y1 - y0) * j) / 23) * (A.height - 1))
      const k = (A.width * y + x) << 2
      sum += Math.hypot(A.data[k]! - B.data[k]!, A.data[k + 1]! - B.data[k + 1]!, A.data[k + 2]! - B.data[k + 2]!)
      n++
    }
  }
  return sum / n
}

test('gravação real + recorte de verdade: o fundo do quarto some, a pessoa fica, no 16:9 e no V-D; prancha para olhar', async () => {
  test.setTimeout(240_000)
  expect(existsSync(REAL), 'a gravação real do usuário fica em gravacoes/ (só nesta máquina, fora do git)').toBe(true)
  const tools = toolPaths(ensureToolsDir())
  const ffmpeg = locateFfmpeg()?.ffmpeg ?? null
  const engine = createPythonCamera({ tools, scriptPath: join(ROOT, 'resources', 'camera_tools.py'), logger: createMemoryLogger(), ffmpeg: () => ffmpeg })
  const check = await engine.check()
  expect(check.matte.state, `o recorte do fundo não está preparado (${check.matte.detail ?? ''}). Rode: node scripts/fila-pesada.mjs npm run preparar:camera`).toBe('ready')

  // 6 s do meio da gravação real: ficam numa pasta temporária (some ao fim)
  const work = mkdtempSync(join(tmpdir(), 'tomada-t-real-'))
  try {
    const excerpt = join(work, 'camera.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '8', '-t', '6', '-i', REAL, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', excerpt])
    const matte = join(work, 'camera-matte.mp4')
    const result = await engine.makeMatte({ video: excerpt, out: matte, durationMs: 6000 })
    console.log(`recorte real: ${result.frames} quadros, ${result.msPerFrame.toFixed(1)} ms por quadro, ${result.device}`)

    s = await launchTomada()
    await expect(s.page.getByTestId('project-card')).toHaveCount(1)
    const dir = join(s.projects, EXAMPLE_FOLDER, 'media')
    mkdirSync(dir, { recursive: true })
    copyFileSync(excerpt, join(dir, 'camera.mp4'))
    copyFileSync(matte, join(s.projects, EXAMPLE_FOLDER, MATTE_FILE))
    const lab = await openLab(s.app)

    const base = readProject(s)
    base.sources.camera = { path: 'media/camera.mp4', w: 1920, h: 1080, fps: 56, durationMs: 6000 }
    const matteUrl = mediaUrl(EXAMPLE_FOLDER, MATTE_FILE)
    const H = { kind: 'horizontal' as const, w: 1920, h: 1080 }
    const V = { kind: 'vertical' as const, w: 1080, h: 1920 }
    const edit = (f: (p: Project) => void): Project => {
      const p = structuredClone(base)
      f(p)
      return p
    }

    const right = edit((p) => {
      p.style.defaultLayout = 'presenter'
      p.style.presenter = { shadow: true }
    })
    const left = edit((p) => {
      p.style.defaultLayout = 'presenter'
      p.style.presenter = { side: 'left', outline: true, outlineWidth: 10, shadow: true }
    })
    const vd = edit((p) => {
      p.style.presenter = { outline: true, outlineWidth: 8 }
      p.vertical = { layout: 'presenter', layouts: [], zooms: [], zoomPreset: 'moderate' }
    })
    const screenOnly = edit((p) => {
      p.style.defaultLayout = 'screen'
    })

    const t = 2000
    const [pRight] = await renderStills(lab, { project: right, times: [t], format: H, matteUrl })
    const [pLeft] = await renderStills(lab, { project: left, times: [t], format: H, matteUrl })
    const [pVd] = await renderStills(lab, { project: vd, times: [t], format: V, matteUrl })
    const [plain] = await renderStills(lab, { project: screenOnly, times: [t], format: H })
    for (const [name, png] of [['real-apresentador-16x9-direita', pRight], ['real-apresentador-16x9-esquerda-contorno', pLeft], ['real-apresentador-vd-contorno', pVd]] as const) saveScreen(name, png!)

    // o alto da janela da pessoa (o quarto, atrás dela) tem de ser a TELA, igual à cena sem o layout; o miolo (a pessoa), a webcam: a diferença
    // média numa região, não num pixel (a camisa preta quase não se distingue da tela escura)
    const win = presenterWindow(resolvePresenter({ shadow: true }), H, false)
    const [winW, winH, winLeft, winTop] = [win.w / H.w, win.h / H.h, win.x / H.w, win.y / H.h]
    const room = regionDiff(pRight!, plain!, winLeft + winW * 0.1, winTop + winH * 0.01, winLeft + winW * 0.4, winTop + winH * 0.1)
    const body = regionDiff(pRight!, plain!, winLeft + winW * 0.4, winTop + winH * 0.3, winLeft + winW * 0.85, winTop + winH * 0.95)
    console.log(`16:9 direita: o quarto difere da tela em ${room.toFixed(1)} · o miolo da pessoa em ${body.toFixed(1)}`)
    expect(room, 'atrás da pessoa aparece a tela, não o quarto da webcam').toBeLessThan(20)
    expect(body, 'a pessoa aparece').toBeGreaterThan(30)

    // V-D: a pessoa embaixo, na largura toda (o miolo da metade de baixo é a webcam, e não o recorte da tela do V-A)
    const vA = edit((p) => {
      p.vertical = { layout: 'screen-focus', layouts: [], zooms: [], zoomPreset: 'moderate' }
    })
    const [pVa] = await renderStills(lab, { project: vA, times: [t], format: V })
    const vdBody = regionDiff(pVd!, pVa!, 0.25, 0.6, 0.85, 0.97)
    console.log(`V-D: a metade de baixo difere do V-A em ${vdBody.toFixed(1)}`)
    expect(vdBody, 'no V-D a pessoa ocupa a metade de baixo do quadro').toBeGreaterThan(30)

    // a prancha: 16:9 direita, 16:9 esquerda com contorno e sombra, e o V-D, lado a lado, na mesma altura
    mkdirSync(SCREENS_DIR, { recursive: true })
    const files = ['real-apresentador-16x9-direita', 'real-apresentador-16x9-esquerda-contorno', 'real-apresentador-vd-contorno'].map((n) => join(SCREENS_DIR, `${n}.png`))
    execFileSync('ffmpeg', [
      '-v', 'error', '-y',
      ...files.flatMap((f) => ['-i', f]),
      '-filter_complex', '[0:v]scale=-2:640[a];[1:v]scale=-2:640[b];[2:v]scale=-2:640[c];[a][b][c]hstack=inputs=3',
      '-frames:v', '1', join(SCREENS_DIR, 'real-apresentador-prancha.png')
    ])
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
