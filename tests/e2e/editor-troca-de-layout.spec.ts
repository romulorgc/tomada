/**
 * A TROCA RÁPIDA DE LAYOUT sob a prévia (F2), no Electron de verdade: a barra com a miniatura de cada layout, nos dois formatos, valendo pelo vídeo
 * e pelo corte em prévia; os layouts do green screen só no 9:16 e com o nome que o usuário vê ("Green screen", "Você sem fundo"); e, sem o recorte do
 * fundo (o motor da câmera está desligado nos e2e), o aviso na tela em vez do silêncio, com a prévia desenhando o layout que não precisa dele.
 */
import { expect, test } from '@playwright/test'
import { CLIPS_RESPONSES, cleanupLong, launchLong, readLong } from './cortes-helpers'
import { openEditor, waitSaved } from './editor-helpers'
import { shot, type Session } from './helpers'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    cleanupLong()
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

const VERTICAL = ['greenscreen-corner', 'greenscreen', 'screen-center', 'screen-focus', 'stack', 'presenter', 'screen-wide', 'camera']
const HORIZONTAL = ['bubble', 'side-by-side', 'presenter', 'screen', 'camera']

test('a barra de troca de layout: miniatura de cada layout, valendo pelo vídeo e pelo corte, e o aviso do recorte que ainda não existe', async () => {
  test.setTimeout(240_000)
  s = await launchLong({ responses: CLIPS_RESPONSES, camera: true, solidScreen: false })
  const { page } = s
  await openEditor(s)

  // 16:9: os layouts do formato, sem os do green screen; "Você sem fundo" é o antigo "Apresentador recortado"
  const quick = page.getByTestId('layout-quick')
  await expect(quick).toBeVisible()
  await expect(quick).toHaveAttribute('data-scope', 'video')
  for (const k of HORIZONTAL) await expect(page.getByTestId(`layout-quick-${k}`)).toBeVisible()
  await expect(page.getByTestId('layout-quick-greenscreen')).toHaveCount(0)
  await expect(page.getByTestId('layout-quick-presenter')).toContainText('Você sem fundo')

  // 9:16: os layouts do vertical, com o Green screen no canto (o padrão) à frente e uma miniatura (SVG) em cada botão
  await page.getByTestId('ratio-9-16').click()
  await expect(page.getByTestId('preview-frame')).toHaveAttribute('data-format', 'vertical')
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
  const buttons = quick.locator('button.lq-btn')
  await expect(buttons).toHaveCount(VERTICAL.length)
  expect(await buttons.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid))).toEqual(VERTICAL.map((k) => `layout-quick-${k}`))
  for (const k of VERTICAL) await expect(page.getByTestId(`layout-quick-${k}`).locator('svg')).toHaveCount(1)
  await expect(page.getByTestId('layout-quick-greenscreen')).toContainText('Green screen')
  await expect(page.getByTestId('layout-quick-greenscreen-corner')).toContainText('Green screen no canto')

  // pelo vídeo: escolher o Green screen grava o layout do vertical e, sem recorte, o aviso aparece (o motor da câmera está desligado)
  await page.getByTestId('layout-quick-greenscreen').click()
  await expect(page.getByTestId('layout-quick-greenscreen')).toHaveAttribute('aria-pressed', 'true')
  await waitSaved(s)
  expect(readLong(s).vertical?.layout).toBe('greenscreen')
  const notice = page.getByTestId('matte-notice')
  await expect(notice).toBeVisible()
  await expect(notice).toHaveAttribute('data-state', 'needs-engine')
  await expect(notice).toContainText('recorte do fundo')
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true') // a prévia continua desenhando (o layout anterior)
  await shot(page, 'troca-de-layout-green-screen-sem-recorte')

  await page.getByTestId('layout-quick-greenscreen-corner').click()
  await expect(page.getByTestId('layout-quick-greenscreen-corner')).toHaveAttribute('aria-pressed', 'true')
  await waitSaved(s)
  expect(readLong(s).vertical?.layout).toBe('greenscreen-corner')

  // um layout que não usa o recorte tira o aviso
  await page.getByTestId('layout-quick-stack').click()
  await waitSaved(s)
  expect(readLong(s).vertical?.layout).toBe('stack')
  await expect(page.getByTestId('matte-notice')).toHaveCount(0)

  // por corte: com a prévia de um corte aberta, a barra passa a valer pelo corte
  await page.getByTestId('tab-clips').click()
  await page.getByTestId('clips-suggest').click()
  await expect(page.getByTestId('clip-card')).toHaveCount(2)
  await page.getByTestId('clip-card').nth(0).getByTestId('clip-preview').click()
  await expect(page.getByTestId('preview-clip-banner')).toBeVisible()
  await expect(page.getByTestId('layout-quick')).toHaveAttribute('data-scope', 'clip')
  await page.getByTestId('layout-quick-greenscreen').click()
  await expect(page.getByTestId('layout-quick-greenscreen')).toHaveAttribute('aria-pressed', 'true')
  await waitSaved(s)
  const saved = readLong(s)
  expect(saved.clips[0]!.layoutV).toBe('greenscreen')
  expect(saved.vertical?.layout).toBe('stack') // o do vídeo inteiro não mudou
  await shot(page, 'troca-de-layout-por-corte')
  await page.getByTestId('preview-clip-exit').click()
  await expect(page.getByTestId('layout-quick')).toHaveAttribute('data-scope', 'video')
  await expect(page.getByTestId('layout-quick-stack')).toHaveAttribute('aria-pressed', 'true')
})
