import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { EXAMPLE_FOLDER, launchTomada, shot, waitForAux, type Session } from './helpers'
import { openLab } from './lab'

let session: Session | undefined
test.afterEach(async () => { await session?.close(); session = undefined })

async function expectHidden(s: Session): Promise<void> {
  const windows = await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => ({
    visible: win.isVisible(), throttled: win.webContents.getBackgroundThrottling()
  })))
  expect(windows.length).toBeGreaterThan(0)
  for (const win of windows) expect(win).toEqual({ visible: false, throttled: false })
}

test('janela principal e laboratório pintam ocultos e a segunda abertura preserva isso', async () => {
  expect(process.env.TOMADA_E2E_HIDDEN).toBe('1')
  session = await launchTomada()
  await expect(session.page.getByTestId('project-card')).toHaveCount(1)
  await session.page.getByTestId('card-reveal').click()
  const calls = await session.app.evaluate(() => (globalThis as { __tomadaTestCalls?: { op: string; path: string }[] }).__tomadaTestCalls ?? [])
  expect(calls).toContainEqual({ op: 'open', path: join(session.projects, EXAMPLE_FOLDER) })
  await openLab(session.app)
  await expectHidden(session)
  await session.app.evaluate(({ app }) => app.emit('second-instance', {}, ['.'], process.cwd()))
  await expectHidden(session)
  expect(await session.page.evaluate(() => window.tomada.settings.pickFfmpeg())).toBeNull()
  expect(await session.page.evaluate(() => window.tomada.settings.pickProjectsDir())).toBeNull()
  expect(await session.page.evaluate(() => window.tomada.settings.pickStyleBackground())).toBeNull()
  expect(await session.page.evaluate(() => window.tomada.exporter.pickDir())).toBeNull()
  const frames = await session.page.evaluate(async () => {
    let frames = 0
    const tick = (): void => { frames++; if (frames < 3) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    await new Promise(resolve => setTimeout(resolve, 300))
    return frames
  })
  expect(frames, 'requestAnimationFrame continua pintando a janela oculta').toBe(3)
  await shot(session.page, 'acabamento-janelas-biblioteca-oculta')
})

test('teleprompter, contagem e barra continuam operáveis sem exibir janelas', async () => {
  session = await launchTomada({ seed: false })
  const { page, app } = session
  await page.getByTestId('nav-record').click()
  await page.getByTestId('mode-camera').click()
  await expect(page.getByTestId('record-start')).toBeEnabled()
  await page.evaluate(() => window.tomada.teleprompter.show({ mode: 'topics', speed: 35, script: {
    title: 'Auditoria de janelas', hook: 'As janelas pintam ocultas.', topics: ['Gravar a câmera sintética.', 'Conferir a contagem.', 'Parar pela barra.'], closing: 'Conferência concluída.'
  } }))
  await expect.poll(() => app.windows().some(p => p.url().endsWith('#teleprompter'))).toBe(true)
  await expectHidden(session)
  await page.getByTestId('record-start').click()
  const countdown = await waitForAux(app, 'countdown')
  await expect(countdown.getByTestId('countdown-number')).toBeVisible()
  await expectHidden(session)
  const bar = await waitForAux(app, 'bar', 30_000)
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording')
  await expectHidden(session)
  await bar.getByTestId('bar-pause').click()
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'paused')
  await expectHidden(session)
  await bar.getByTestId('bar-stop').click()
  await expect(page.getByTestId('project-view')).toBeVisible({ timeout: 60_000 })
  await expectHidden(session)
})
