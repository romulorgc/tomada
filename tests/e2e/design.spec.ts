/** Passe visual M5b. Fixtures sintéticos, nunca gravacoes/. ANTES não aplica as novas exigências. */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { parseProject } from '../../src/shared/project'
import { newPipeline } from '../../src/shared/autopilot'
import { EXAMPLE_FOLDER, launchTomada, ROOT, setContentSize, waitForAux, type Session } from './helpers'
import { openEditor } from './editor-helpers'
import { copyTree, FIXTURES_DIR } from '../helpers/fs'
import { measureContrast } from './design-contrast'

const phase = process.env.DESIGN_PHASE === 'antes' ? 'antes' : 'depois'
const dir = join(ROOT, 'test-results/design', phase)
let s: Session | undefined
test.afterEach(async () => { if (s) { const problems = s.problems; await s.close(); s = undefined; expect(problems).toEqual([]) } })

async function capture(page: Page, name: string) {
  mkdirSync(dir, { recursive: true })
  await page.mouse.move(2, 2)
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled' })
  const report = await measureContrast(page)
  writeFileSync(join(dir, `${name}-contraste.json`), JSON.stringify(report, null, 2))
  if (phase === 'depois') expect.soft(report.failures, `contraste em ${name}`).toEqual([])
}

async function selected(page: Page) {
  const dialog = page.getByRole('dialog')
  const scope = await dialog.count() && await dialog.first().isVisible() ? dialog.first() : page
  const groups = scope.locator('.seg, .segc, .ratio, .layout-cards, .cap-styles, .corner-grid, .ed-tabs, .preset-cards, .tl-tools, .review-actions')
  for (const group of await groups.all()) {
    if (!await group.isVisible()) continue
    const buttons = group.locator('button[aria-pressed], button[aria-checked], button[aria-selected]')
    for (const button of await buttons.all()) {
      if (!await button.isVisible() || !await button.isEnabled()) continue
      const active = await button.evaluate((el) => ['aria-pressed', 'aria-checked', 'aria-selected'].some((attr) => el.getAttribute(attr) === 'true'))
      const background = () => button.evaluate((el) => getComputedStyle(el).backgroundColor)
      if (active) {
        await expect.poll(background, { message: 'a seleção usa o preenchimento de destaque' }).toBe('rgb(255, 106, 60)')
        await button.hover()
        await expect.poll(background, { message: 'o hover preserva a seleção' }).toBe('rgb(255, 106, 60)')
        const report = await measureContrast(page)
        expect(report.failures, 'o texto selecionado continua legível sob o mouse').toEqual([])
        await page.mouse.move(2, 2)
      }
      else await expect.poll(background, { message: 'a opção neutra não pode parecer selecionada' }).not.toBe('rgb(255, 106, 60)')
    }
  }
}

async function syntheticSources(session: Session) {
  const thumbnail = `data:image/jpeg;base64,${readFileSync(join(ROOT, 'tests/fixtures/projeto-exemplo/media/thumb.jpg')).toString('base64')}`
  // Mantém os IDs reais necessários ao getDisplayMedia falso; não devolve imagem ou título da área de trabalho.
  await session.app.evaluate(({ ipcMain, desktopCapturer }, image) => {
    ipcMain.removeHandler('record:sources')
    ipcMain.handle('record:sources', async () => ({ ok: true, value: (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })).map((source, i) => ({ id: source.id, kind: 'screen', name: `Tela de demonstração ${i + 1}`, thumbnail: image, primary: i === 0, sizePx: { w: 1920, h: 1080 } })) }))
  }, thumbnail)
}

function prepareReview(session: Session) {
  const folder = join(session.projects, EXAMPLE_FOLDER)
  const doc = parseProject(readFileSync(join(folder, 'project.json'), 'utf8'))
  doc.title = 'Agendaí: demonstração do agendamento'
  doc.clips = [{ id: 'demo', title: 'Agende em poucos cliques', hook: 'Organize a agenda em segundos', ranges: [{ start: 1000, end: 18000 }], score: 87, reason: 'Demonstração fictícia para conferir a interface.', format: 'vertical', layoutV: 'screen-focus' }]
  doc.meta = { youtube: { titles: ['Como organizar seus agendamentos', 'Uma agenda simples para o dia a dia', 'Agendamento em poucos cliques'], description: 'Demonstração fictícia da Agendaí. Confira como cadastrar e organizar os horários.', tags: ['agenda', 'demonstração'], chapters: [{ start: 0, title: 'Apresentação' }, { start: 10000, title: 'Novo horário' }, { start: 20000, title: 'Conferência' }] } }
  doc.autopilot = { ...newPipeline(EXAMPLE_FOLDER), status: 'done', steps: newPipeline(EXAMPLE_FOLDER).steps.map((step) => ({ ...step, status: 'done', detail: 'Concluído na demonstração.' })) }
  mkdirSync(join(folder, 'exports'), { recursive: true })
  copyFileSync(join(folder, 'media/screen.mp4'), join(folder, 'exports/demo.mp4'))
  doc.review = { items: { youtube: { decision: 'approved', origin: 'auto', phase: 'ready', exportPath: 'exports/demo.mp4' }, demo: { decision: 'pending', origin: 'auto', phase: 'ready', exportPath: 'exports/demo.mp4' } } }
  writeFileSync(join(folder, 'project.json'), JSON.stringify(doc))
}

test('passe visual: biblioteca, editor completo, exportação, ajustes, guia e revisão', async () => {
  test.setTimeout(240000)
  s = await launchTomada()
  prepareReview(s)
  const { page } = s
  await setContentSize(s, 1440, 900)
  await page.getByTestId('nav-library').click()
  await expect(page.getByTestId('project-card')).toHaveCount(1)
  if (phase === 'depois') {
    await expect(page.getByTestId('card-transcribed')).toHaveText('Transcrito')
    await expect(page.getByTestId('card-clips-ready')).toHaveText('1 corte pronto')
  }
  await capture(page, '01-biblioteca')
  await openEditor(s)
  await expect(page.locator('.tl-thumbs img').first()).toBeVisible({ timeout: 20000 })
  for (const [i, tab] of ['style', 'camera', 'zoom', 'layout', 'text', 'captions', 'clips', 'publish', 'ai', 'blur'].entries()) {
    await page.getByTestId(`tab-${tab}`).click()
    await page.locator('.ed-panel-body').evaluate((el) => el.scrollTop = 0)
    await capture(page, `${String(i + 2).padStart(2, '0')}-editor-${tab}`)
    if (phase === 'depois') await selected(page)
  }
  await page.getByTestId('ratio-9-16').click()
  await page.getByTestId('tab-captions').click()
  await capture(page, '12-editor-vertical')
  await page.getByTestId('export-open').click()
  await capture(page, '13-exportar')
  if (phase === 'depois') await selected(page)
  await page.keyboard.press('Escape')
  await page.getByTestId('back-to-library').click()
  await page.getByTestId('card-review').click()
  await expect(page.getByTestId('review-view')).toBeVisible()
  await capture(page, '14-revisao')
  if (phase === 'depois') await selected(page)
  await page.getByTestId('review-youtube-quick').locator('summary').click()
  await page.getByTestId('review-youtube-quick').scrollIntoViewIfNeeded()
  await capture(page, '15-revisao-ajustes')
  await page.getByRole('button', { name: 'Biblioteca', exact: true }).click()
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('settings-view')).toBeVisible()
  for (const [i, id] of ['settings-view', 'default-format-horizontal', 'settings-shortcuts', 'settings-projects', 'settings-transcription', 'settings-camera-style', 'settings-camera-sync'].entries()) {
    const el = page.getByTestId(id)
    if (await el.count()) await el.scrollIntoViewIfNeeded()
    await capture(page, `16-ajustes-${i + 1}`)
    if (phase === 'depois') await selected(page)
  }
  await page.getByTestId('diagnostics-open').click()
  await expect(page.getByTestId('onboarding-view')).toBeVisible()
  await capture(page, '17-guia')
  await page.getByTestId('onboarding-done').scrollIntoViewIfNeeded()
  await capture(page, '18-guia-concluir')
})

test('passe visual: gravar, opções da câmera, contagem, barra e processamento com erro', async () => {
  test.setTimeout(180000)
  s = await launchTomada({ seed: false, env: { TOMADA_TEST_AUTOSOURCE: 'screen', TOMADA_TEST_STEP_DELAY_MS: '1000', TOMADA_TEST_FAIL_STEP: 'thumb' } })
  const { page } = s
  await setContentSize(s, 1440, 1000)
  await syntheticSources(s)
  await page.getByTestId('nav-record').click()
  await expect(page.getByTestId('camera-preview')).toHaveAttribute('data-live', 'true')
  await expect(page.getByTestId('record-start')).toBeEnabled()
  await capture(page, '19-gravar-quadro')
  await page.getByTestId('camera-style-presenter').click()
  await expect(page.getByTestId('camera-style-presenter')).toHaveAttribute('aria-pressed', 'true')
  await capture(page, '20-gravar-apresentador')
  if (phase === 'depois') await selected(page)
  if (phase === 'depois') {
    for (const prefix of ['mode', 'camera-style', 'fps']) {
      const choices = page.locator(`.seg button[data-testid^="${prefix}-"]`)
      for (const choice of await choices.all()) {
        await choice.click()
        await expect(choice).toHaveAttribute('aria-pressed', 'true')
        await selected(page)
      }
      await choices.first().click()
    }
    await page.getByTestId('mode-screen-camera').click()
    await page.getByTestId('source-tab-windows').click()
    await selected(page)
    await page.getByTestId('source-tab-screens').click()
    await selected(page)
    await page.getByTestId('fps-60').scrollIntoViewIfNeeded()
    await capture(page, '30-gravar-opcoes')
    await page.getByTestId('record-start').scrollIntoViewIfNeeded()
  }
  await page.getByTestId('camera-style-side-by-side').click()
  await page.getByTestId('record-start').click()
  const countdown = await waitForAux(s.app, 'countdown')
  await capture(countdown, '21-contagem')
  const bar = await waitForAux(s.app, 'bar')
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording')
  await capture(bar, '22-barra')
  await bar.getByTestId('bar-pause').click()
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'paused')
  if (phase === 'depois') {
    const pause = bar.getByTestId('bar-pause')
    await pause.hover()
    await expect.poll(() => pause.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 106, 60)')
    expect(await pause.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(28, 10, 3)')
  }
  await capture(bar, '23-barra-pausada')
  await bar.getByTestId('bar-pause').click()
  await page.waitForTimeout(1500)
  await bar.getByTestId('bar-stop').click()
  await expect(page.getByTestId('processing-view')).toBeVisible()
  await capture(page, '24-processamento')
  await expect(page.getByTestId('processing-view')).toHaveAttribute('data-status', 'failed', { timeout: 90000 })
  await capture(page, '25-processamento-erro')
})

test('passe visual: estado vazio e busca/ordenação da biblioteca', async () => {
  s = await launchTomada({ seed: false })
  const { page } = s
  await page.getByTestId('nav-library').click()
  await expect(page.getByTestId('empty-state')).toBeVisible()
  await capture(page, '26-biblioteca-vazia')
  if (phase === 'antes') return
  await expect(page.getByTestId('library-search')).toBeVisible()
  for (const [folder, title, date, duration] of [
    ['demo-antiga', 'Árvore: tutorial', '2026-10-06T09:00:00.000Z', 42000],
    ['demo-nova', 'Zebra: demonstração', '2026-10-06T08:00:00.000-03:00', 23000]
  ] as const) {
    const target = join(s.projects, folder)
    copyTree(join(FIXTURES_DIR, 'projeto-exemplo'), target)
    const doc = parseProject(readFileSync(join(target, 'project.json'), 'utf8'))
    doc.title = title; doc.createdAt = date
    if (doc.sources.screen) doc.sources.screen.durationMs = duration
    writeFileSync(join(target, 'project.json'), JSON.stringify(doc))
  }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByTestId('card-title')).toHaveText(['Zebra: demonstração', 'Árvore: tutorial'])
  await page.getByTestId('library-sort').selectOption('oldest')
  await expect(page.getByTestId('card-title')).toHaveText(['Árvore: tutorial', 'Zebra: demonstração'])
  await page.getByTestId('library-sort').selectOption('title')
  await expect(page.getByTestId('card-title')).toHaveText(['Árvore: tutorial', 'Zebra: demonstração'])
  await page.getByTestId('library-sort').selectOption('duration')
  await expect(page.getByTestId('card-title')).toHaveText(['Árvore: tutorial', 'Zebra: demonstração'])
  await page.getByTestId('library-search').fill('arvore')
  await expect(page.getByTestId('card-title')).toHaveText(['Árvore: tutorial'])
  await capture(page, '27-biblioteca-busca')
  await page.getByTestId('library-search').fill('inexistente')
  await expect(page.getByTestId('library-no-results')).toBeVisible()
  await capture(page, '28-biblioteca-sem-resultados')
  await page.getByRole('button', { name: 'Limpar busca', exact: true }).click()
  await expect(page.getByTestId('project-card')).toHaveCount(2)
  await page.getByTestId('library-search').focus()
  await page.keyboard.press('Tab')
  const focus = page.getByTestId('library-sort')
  await expect(focus).toBeFocused()
  expect(await focus.evaluate((el) => el.matches(':focus-visible'))).toBe(true)
  expect(await focus.evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth) * devicePixelRatio)).toBeGreaterThanOrEqual(2)
  await capture(page, '29-biblioteca-foco')
})

test('seleção inequívoca em cada layout, legenda e formato; foco no fundo e contraste dos cantos', async () => {
  if (phase === 'antes') return
  test.setTimeout(180000)
  s = await launchTomada()
  const { page } = s
  await openEditor(s)
  await page.getByTestId('tl-hide-cuts').click()
  await selected(page)
  await page.getByTestId('tab-style').click()
  const swatch = page.locator('.bg-tile[aria-pressed="true"]')
  await swatch.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  expect(await swatch.evaluate((el) => getComputedStyle(el).outlineColor)).toBe('rgb(255, 201, 168)')
  await capture(page, '31-editor-foco-fundo')
  await page.getByTestId('tab-camera').click()
  const corners = page.locator('.corner-grid button')
  for (const button of await corners.all()) {
    await button.click()
    await selected(page)
  }
  const graphic = await corners.first().evaluate((el) => {
    const lum = (rgb: string) => {
      const values = rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((c) => c / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      return values.reduce((n, c, i) => n + c * [0.2126, 0.7152, 0.0722][i]!, 0)
    }
    const border = getComputedStyle(el).borderColor, background = getComputedStyle(el.parentElement!).backgroundColor
    const a = lum(border), b = lum(background)
    return { border, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
  })
  writeFileSync(join(dir, 'contraste-cantos.json'), JSON.stringify(graphic, null, 2))
  expect(graphic.ratio).toBeGreaterThanOrEqual(3)
  for (const ratio of ['16-9', '9-16']) {
    await page.getByTestId(`ratio-${ratio}`).click()
    await page.getByTestId('tab-layout').click()
    for (const layout of await page.locator('.layout-cards button').all()) {
      if (!await layout.isEnabled()) continue
      await layout.click()
      await expect(layout).toHaveAttribute('aria-pressed', 'true')
      await selected(page)
    }
    await page.getByTestId('tab-captions').click()
    const show = page.getByTestId('captions-show')
    if (await show.getAttribute('aria-checked') === 'false') await show.click()
    for (const style of ['highlight', 'natural', 'clean', 'karaoke']) {
      const button = page.getByTestId(`caption-style-${style}`)
      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'true')
      await selected(page)
    }
  }
  await page.getByTestId('back-to-library').click()
  await page.getByTestId('nav-settings').click()
  for (const format of ['vertical', 'horizontal']) {
    await page.getByTestId(`default-format-${format}`).click()
    await selected(page)
  }
})
