/**
 * O ENQUADRAMENTO DO ROSTO e a câmera AO LADO da tela (M4c), no Electron de verdade com o motor de teste da análise
 * (`TOMADA_CAMERA=mock`: um rosto sintético que anda de 0,32 a 0,68 da imagem). Cobre: o rosto procurado ao abrir (estado visível,
 * arquivo na pasta do projeto), o recorte que acompanha o rosto, o ajuste à mão (aproximação, deslocamento, arrastar dentro da
 * câmera, restaurar, desfazer), os controles do lado a lado, a preparação (do zero, com falha e "tentar de novo") e a EXPORTAÇÃO com o
 * mesmo enquadramento da prévia (um pixel de cor conhecida no cartão da câmera).
 *
 * A câmera do projeto de exemplo tem barras de cor (vermelho, verde, amarelo, azul, magenta, ciano, da esquerda para a direita):
 * `data-camera-src` do canvas diz qual recorte da imagem da câmera está aparecendo.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { cameraCropRect, sideBySideTarget } from '../../src/shared/face'
import { HORIZONTAL_1080, layoutGeometry } from '../../src/shared/scene'
import { frameRgb } from '../helpers/media'
import { EXAMPLE_FOLDER, launchTomada, shot, type Session } from './helpers'
import { editProject, exportProject } from './export-helpers'
import { openEditor, readSaved, seekTo, waitSaved } from './editor-helpers'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

const MOCK = { TOMADA_CAMERA: 'mock', TOMADA_TEST_CAMERA_DELAY_MS: '700' }
const sideBySide = (p: import('../../src/shared/types').Project): void => {
  p.style.defaultLayout = 'side-by-side'
  p.zoomPreset = 'off'
  p.zooms = []
}

type Box = { x: number; y: number; w: number; h: number }
/** O recorte da imagem da câmera (frações) que a prévia mostra agora. */
async function cropNow(page: Page): Promise<Box> {
  const [x, y, w, h] = ((await page.getByTestId('preview-canvas').getAttribute('data-camera-src')) ?? '').split(',').map(Number)
  return { x: x!, y: y!, w: w!, h: h! }
}
/** Onde a câmera está no quadro da prévia (px do canvas). */
async function cameraDest(page: Page): Promise<Box> {
  const [x, y, w, h] = ((await page.getByTestId('preview-canvas').getAttribute('data-camera-dest')) ?? '').split(',').map(Number)
  return { x: x!, y: y!, w: w!, h: h! }
}
const centerX = (b: Box): number => b.x + b.w / 2

test('o rosto é procurado ao abrir a gravação, o estado aparece, o arquivo fica no projeto e o recorte da câmera acompanha o rosto', async () => {
  test.setTimeout(120_000)
  // o motor de teste demora 4 s (com 0,7 s o Electron, sob carga, abria o painel depois do fim e o teste nunca via "procurando")
  s = await launchTomada({ env: { ...MOCK, TOMADA_TEST_CAMERA_DELAY_MS: '4000' } })
  editProject(s, sideBySide)
  await openEditor(s)
  const { page } = s
  await page.getByTestId('tab-camera').click()

  // enquanto procura, o estado diz isso; depois diz quanto da gravação tem rosto
  await expect(page.getByTestId('face-status')).toHaveAttribute('data-state', /queued|running/, { timeout: 15_000 })
  await expect(page.getByTestId('face-status')).toHaveAttribute('data-state', 'found', { timeout: 15_000 })
  await expect(page.getByTestId('face-status')).toContainText('Rosto achado em 100% da gravação')
  expect(existsSync(join(s.projects, EXAMPLE_FOLDER, 'media', 'camera-face.json'))).toBe(true)
  await shot(page, 'camera-01-rosto-achado')

  // o rosto anda de 0,32 a 0,68: o recorte (uma faixa em pé, 3:4) o acompanha, sem sair da imagem
  await seekTo(page, 1000)
  const early = await cropNow(page)
  await seekTo(page, 21_000)
  const late = await cropNow(page)
  console.log(`centro do recorte: ${centerX(early).toFixed(3)} em 1 s · ${centerX(late).toFixed(3)} em 21 s`)
  expect(centerX(late) - centerX(early)).toBeGreaterThan(0.2)
  for (const c of [early, late]) {
    expect(c.x).toBeGreaterThanOrEqual(-1e-4)
    expect(c.x + c.w).toBeLessThanOrEqual(1.0001)
    expect(c.w / c.h).toBeCloseTo((0.75 * 360) / 640, 2) // a proporção do cartão: 3:4 em uma imagem 16:9
  }

  // desligar "Centralizar no rosto" volta ao centro nos dois instantes
  await page.getByTestId('framing-auto').click()
  await expect(page.getByTestId('framing-auto')).toHaveAttribute('aria-checked', 'false')
  await expect.poll(async () => centerX(await cropNow(page))).toBeCloseTo(0.5, 2)
  await seekTo(page, 1000)
  await expect.poll(async () => centerX(await cropNow(page))).toBeCloseTo(0.5, 2)
  await waitSaved(s)
  expect(readSaved(s).style.camera.framing).toEqual({ auto: false })

  // ligar de novo volta ao rosto
  await page.getByTestId('framing-auto').click()
  await expect(page.getByTestId('framing-auto')).toHaveAttribute('aria-checked', 'true')
})

test('ajuste à mão: aproximação, deslocamento, restaurar e desfazer; tudo no project.json', async () => {
  test.setTimeout(120_000)
  s = await launchTomada({ env: { ...MOCK, TOMADA_TEST_CAMERA_FROM: '0.5', TOMADA_TEST_CAMERA_TO: '0.5' } })
  editProject(s, sideBySide)
  await openEditor(s)
  const { page } = s
  await page.getByTestId('tab-camera').click()
  await expect(page.getByTestId('face-status')).toHaveAttribute('data-state', 'found', { timeout: 20_000 })
  await expect(page.getByTestId('framing-reset')).toBeDisabled() // nada ajustado ainda
  // "achado" chega antes de o editor ler o arquivo e redesenhar: espera o recorte automático (aproximado, pois o rosto é pequeno) aparecer na prévia
  await expect.poll(async () => (await cropNow(page)).w).toBeLessThan(0.4)

  const base = await cropNow(page)
  await page.getByTestId('framing-zoom').fill('2')
  await expect(page.getByTestId('framing-zoom-value')).toHaveText('2×')
  await expect.poll(async () => (await cropNow(page)).w).toBeCloseTo(base.w / 2, 3)
  await page.getByTestId('framing-dx').fill('0.2')
  await expect.poll(async () => centerX(await cropNow(page))).toBeCloseTo(centerX(base) + 0.2, 2)
  await expect(page.getByTestId('framing-reset')).toBeEnabled()
  await waitSaved(s)
  expect(readSaved(s).style.camera.framing).toMatchObject({ zoom: 2, dx: 0.2 })

  // restaurar apaga o ajuste (o enquadramento volta a ser o do app) e o Ctrl+Z o devolve, tudo de uma vez
  await page.getByTestId('framing-reset').click()
  await expect.poll(async () => (await cropNow(page)).w).toBeCloseTo(base.w, 3)
  await waitSaved(s)
  expect(readSaved(s).style.camera.framing).toBeUndefined()
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await cropNow(page)).w).toBeCloseTo(base.w / 2, 3)
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(async () => (await cropNow(page)).w).toBeCloseTo(base.w, 3)
  await shot(page, 'camera-02-enquadramento-manual')
})

test('arrastar DENTRO da câmera na prévia move a imagem (um passo de desfazer); na bolha, só com Alt', async () => {
  test.setTimeout(120_000)
  s = await launchTomada({ env: { ...MOCK, TOMADA_TEST_CAMERA_FROM: '0.5', TOMADA_TEST_CAMERA_TO: '0.5' } })
  editProject(s, sideBySide)
  await openEditor(s)
  const { page } = s
  await page.getByTestId('tab-camera').click()
  await expect(page.getByTestId('face-status')).toHaveAttribute('data-state', 'found', { timeout: 20_000 })
  await page.waitForTimeout(300)

  const frame = (await page.getByTestId('preview-frame').boundingBox())!
  const canvasW = await page.getByTestId('preview-canvas').evaluate((el) => (el as HTMLCanvasElement).width)
  const toScreen = (b: Box): { x: number; y: number } => ({ x: frame.x + ((b.x + b.w / 2) / canvasW) * frame.width, y: frame.y + ((b.y + b.h / 2) / (canvasW * 0.5625)) * frame.height })

  // o padrão é a câmera ESPELHADA (33b7e5f): na imagem espelhada, arrastar para a direita leva o recorte para o outro lado
  const mirrored = readSaved(s).style.camera.mirror
  expect(mirrored).toBe(true)
  const dest = await cameraDest(page)
  const before = await cropNow(page)
  const at = toScreen(dest)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 24, at.y, { steps: 4 })
  await page.mouse.move(at.x + 48, at.y + 10, { steps: 4 })
  await page.mouse.up()
  await waitSaved(s)
  const dragged = readSaved(s).style.camera.framing
  // a imagem foi para a direita: o recorte andou para a esquerda (dx < 0), ou para a direita se a imagem está espelhada, e um pouco para cima (a imagem desceu)
  if (mirrored) expect(dragged?.dx).toBeGreaterThan(0)
  else expect(dragged?.dx).toBeLessThan(0)
  expect(dragged?.dy).toBeLessThan(0)
  if (mirrored) expect(centerX(await cropNow(page))).toBeGreaterThan(centerX(before))
  else expect(centerX(await cropNow(page))).toBeLessThan(centerX(before))
  // o arraste inteiro é UM passo de desfazer
  await page.keyboard.press('Control+z')
  await waitSaved(s)
  expect(readSaved(s).style.camera.framing).toBeUndefined()
  await page.keyboard.press('Control+Shift+z')
  await waitSaved(s)
  if (mirrored) expect(readSaved(s).style.camera.framing?.dx).toBeGreaterThan(0)
  else expect(readSaved(s).style.camera.framing?.dx).toBeLessThan(0)

  // na bolha o arraste normal ANDA com a bolha (corner); com Alt, move a imagem
  await page.getByTestId('tab-layout').click()
  await page.getByTestId('layout-bubble').click()
  await page.getByTestId('tab-camera').click()
  await page.getByTestId('framing-reset').click()
  await waitSaved(s)
  await page.waitForTimeout(300)
  const bubble = await cameraDest(page)
  const b = toScreen(bubble)
  await page.keyboard.down('Alt')
  await page.mouse.move(b.x, b.y)
  await page.mouse.down()
  await page.mouse.move(b.x - 14, b.y, { steps: 3 })
  await page.mouse.move(b.x - 28, b.y, { steps: 3 })
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await waitSaved(s)
  const alt = readSaved(s).style.camera
  // a imagem foi para a esquerda: o recorte, para a direita (para a esquerda se a imagem está espelhada)
  if (mirrored) expect(alt.framing?.dx).toBeLessThan(0)
  else expect(alt.framing?.dx).toBeGreaterThan(0)
  expect(alt.corner).toBe('bottom-right') // a bolha NÃO mudou de canto
})

test('câmera ao lado da tela: lado, formato, largura e espaço, no painel e na prévia; persistem no project.json', async () => {
  test.setTimeout(120_000)
  s = await launchTomada({ env: MOCK })
  editProject(s, sideBySide)
  await openEditor(s)
  const { page } = s
  await page.getByTestId('tab-camera').click()
  await expect(page.getByTestId('side-inactive')).toHaveCount(0) // o layout padrão É o lado a lado
  await page.waitForTimeout(300)

  let d = await cameraDest(page)
  const W = await page.getByTestId('preview-canvas').evaluate((el) => (el as HTMLCanvasElement).width)
  expect(d.x).toBeGreaterThan(W * 0.6) // padrão: à direita
  expect(d.w / d.h).toBeCloseTo(0.75, 1) // em pé 3:4

  await page.getByTestId('side-left').click()
  await expect.poll(async () => (await cameraDest(page)).x).toBeLessThan(W * 0.2)
  await page.getByTestId('side-square').click()
  await expect.poll(async () => {
    const q = await cameraDest(page)
    return Math.abs(q.w - q.h)
  }).toBeLessThanOrEqual(2)
  await page.getByTestId('side-width').fill('0.4')
  await expect.poll(async () => (await cameraDest(page)).w / W).toBeCloseTo(0.4, 1)
  await page.getByTestId('side-gap').fill('0')
  d = await cameraDest(page)
  await waitSaved(s)
  expect(readSaved(s).style.sideBySide).toMatchObject({ side: 'left', ratio: 'square', width: 0.4, gap: 0 })
  await shot(page, 'camera-03-lado-a-lado-esquerda-quadrado')

  // trocar o layout para a bolha avisa que estes ajustes valem para o "Lado a lado"
  await page.getByTestId('tab-layout').click()
  await page.getByTestId('layout-bubble').click()
  await page.getByTestId('tab-camera').click()
  await expect(page.getByTestId('side-inactive')).toBeVisible()
})

test('sem o motor preparado: o painel oferece preparar; a preparação mostra o progresso, falha num passo, "tentar de novo" termina e o rosto é procurado sozinho', async () => {
  test.setTimeout(150_000)
  s = await launchTomada({ env: { TOMADA_CAMERA: 'mock-unprepared', TOMADA_TEST_PREPARE_STEP_MS: '600', TOMADA_TEST_PREPARE_FAIL: 'model', TOMADA_TEST_CAMERA_DELAY_MS: '300' } })
  editProject(s, sideBySide)
  await openEditor(s)
  const { page } = s
  await page.getByTestId('tab-camera').click()
  await expect(page.getByTestId('camera-prepare')).toHaveAttribute('data-state', 'missing')
  await expect(page.getByTestId('camera-prepare-start')).toBeVisible()
  await shot(page, 'camera-04-preparar')

  await page.getByTestId('camera-prepare-start').click()
  await expect(page.getByTestId('camera-prepare')).toHaveAttribute('data-state', 'running')
  await expect(page.getByTestId('camera-prepare-progress')).toBeVisible()
  // falha simulada (uma vez) no passo do modelo: erro à vista, com o passo, e o botão de tentar de novo
  await expect(page.getByTestId('camera-prepare-error')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('camera-prepare-error')).toContainText('Modelo do rosto')
  await page.getByTestId('camera-prepare-retry').click()
  // terminou: o cartão de preparação some e o rosto é procurado sozinho (o editor estava aberto)
  await expect(page.getByTestId('camera-prepare')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('face-status')).toHaveAttribute('data-state', 'found', { timeout: 20_000 })
  expect(existsSync(join(s.projects, EXAMPLE_FOLDER, 'media', 'camera-face.json'))).toBe(true)
})

test('o motor desligado (padrão dos testes): o painel funciona e oferece preparar, sem erro na interface', async () => {
  s = await launchTomada()
  await openEditor(s)
  const { page } = s
  await page.getByTestId('tab-camera').click()
  await expect(page.getByTestId('camera-prepare')).toBeVisible() // uma só caixa: o recorte do fundo usa o mesmo preparo
  await expect(page.getByTestId('camera-prepare')).toContainText('desligada')
  await expect(page.getByTestId('matte-needs-prepare')).toBeVisible()
  // o resto do painel (aproximação, deslocamento) funciona sem a análise: recorte do centro + ajuste à mão
  await page.getByTestId('framing-zoom').fill('1.5')
  await expect.poll(async () => (await cropNow(page)).w).toBeGreaterThan(0)
  await waitSaved(s)
  expect(readSaved(s).style.camera.framing).toMatchObject({ zoom: 1.5 })
})

test('gravação sem rosto: o estado diz isso e o recorte fica no centro', async () => {
  test.setTimeout(90_000)
  s = await launchTomada({ env: { ...MOCK, TOMADA_TEST_CAMERA_NOFACE: '1' } })
  editProject(s, sideBySide)
  await openEditor(s)
  const { page } = s
  await page.getByTestId('tab-camera').click()
  await expect(page.getByTestId('face-status')).toHaveAttribute('data-state', 'none', { timeout: 20_000 })
  await expect(page.getByTestId('face-status')).toContainText('Não achei um rosto')
  await expect.poll(async () => centerX(await cropNow(page))).toBeCloseTo(0.5, 2)
})

test('EXPORTAÇÃO 16:9 com o enquadramento: o cartão da câmera mostra o mesmo recorte da prévia (um pixel de cor conhecida)', async () => {
  test.setTimeout(240_000)
  // o rosto fica parado em x = 0,8: o recorte em pé cai nas barras magenta e ciano
  s = await launchTomada({ env: { TOMADA_CAMERA: 'mock', TOMADA_TEST_CAMERA_FROM: '0.8', TOMADA_TEST_CAMERA_TO: '0.8' } })
  editProject(s, (p) => {
    sideBySide(p)
    p.style.sideBySide = { side: 'left', ratio: 'portrait' }
    p.cuts = [{ id: 'c1', start: 4000, end: 23_000, reason: 'manual', enabled: true }] // só os 4 primeiros segundos: exporta rápido
  })
  await openEditor(s)
  const { page } = s
  await page.getByTestId('tab-camera').click()
  await expect(page.getByTestId('face-status')).toHaveAttribute('data-state', 'found', { timeout: 20_000 })
  await waitSaved(s)

  // o que a prévia mostra num instante (o recorte) e o que a exportação mostra no mesmo instante
  await seekTo(page, 2000)
  const crop = await cropNow(page)
  const project = readSaved(s)
  const geo = layoutGeometry('side-by-side', project.style, HORIZONTAL_1080, { screen: { w: 1920, h: 1080 }, camera: { w: 640, h: 360 } })
  const card = geo.camera!.rect
  expect(card.x).toBeLessThan(960) // à esquerda
  // o cálculo puro bate com a prévia (mesma função)
  const pure = cameraCropRect({ w: 640, h: 360 }, card.w / card.h, { cx: 0.8, cy: 0.4, faceW: 0.14, faceH: 0.3 }, project.style.camera.framing, sideBySideTarget(1080, card.h))
  expect(centerX(crop)).toBeCloseTo(centerX(pure), 2)

  const done = await exportProject(page, EXAMPLE_FOLDER, { resolution: '1080p', fps: 30 })
  expect(done.message ?? '').toBe('')
  expect(done.phase).toBe('done')
  // quadro de 2 s (n = 60): amostra o meio da altura do cartão (nessa altura só há barras: sem o contador, a faixa em arco-íris e o xadrez)
  const W = 960
  const H = 540
  const frame = frameRgb(done.outputPath!, 60, W, H)
  const px = (relX: number): [number, number, number] => {
    const nx = (card.x + card.w * relX) / 1920
    const ny = (card.y + card.h * 0.5) / 1080
    const i = (Math.round(ny * H) * W + Math.round(nx * W)) * 3
    return [frame[i]!, frame[i + 1]!, frame[i + 2]!]
  }
  // o meio do cartão corresponde ao x = 0,8 da imagem da câmera (a barra magenta, 255·0·255) e a borda direita, ao x ≈ 0,93 (ciano, 0·255·255)
  // a câmera sai ESPELHADA por padrão (33b7e5f): a borda direita do recorte (ciano) aparece na borda ESQUERDA do cartão
  const mirrored = project.style.camera.mirror
  expect(mirrored).toBe(true)
  const mid = px(0.5)
  const right = px(mirrored ? 0.1 : 0.9)
  console.log(`na exportação: meio do cartão ${mid.join(',')} (magenta esperado) · à direita ${right.join(',')} (ciano esperado) · recorte ${crop.x.toFixed(3)}–${(crop.x + crop.w).toFixed(3)}`)
  expect(mid[0]).toBeGreaterThan(170)
  expect(mid[2]).toBeGreaterThan(170)
  expect(mid[1]).toBeLessThan(90)
  expect(right[0]).toBeLessThan(90)
  expect(right[1]).toBeGreaterThan(170)
  expect(right[2]).toBeGreaterThan(170)
  // e a leitura do arquivo do disco confirma que não foi só a prévia
  expect(JSON.parse(readFileSync(join(s.projects, EXAMPLE_FOLDER, 'media', 'camera-face.json'), 'utf8')).engine).toBe('teste')
})
