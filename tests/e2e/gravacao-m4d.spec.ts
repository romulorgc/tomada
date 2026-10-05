import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { parseProject } from '../../src/shared/project'
import { PNG } from 'pngjs'
import { launchTomada, shot, waitForAux, SCREENS_DIR, type Session } from './helpers'

let s: Session | undefined
test.afterEach(async () => {
  if (s) { const problems = s.problems; await s.close(); s = undefined; expect(problems, problems.join('\n')).toEqual([]) }
})

async function waitPrompter(session: Session): Promise<Page> {
  await expect.poll(() => session.app.windows().some((p) => p.url().endsWith('#teleprompter') && !p.isClosed())).toBe(true)
  const page = session.app.windows().find((p) => p.url().endsWith('#teleprompter') && !p.isClosed())!
  await expect(page.getByTestId('teleprompter')).toBeVisible()
  return page
}

async function proveCaptureProtection(session: Session): Promise<void> {
  // Fundo sintético cobrindo a tela: a prova nunca registra a área de trabalho do usuário.
  const setup = await session.app.evaluate(async ({ BrowserWindow, screen }) => {
    const display = screen.getPrimaryDisplay()
    const backdrop = new BrowserWindow({ ...display.bounds, frame: false, show: false, alwaysOnTop: true, backgroundColor: '#17b83b', webPreferences: { sandbox: true, nodeIntegration: false } })
    await backdrop.loadURL('data:text/html,<html><body style="margin:0;background:%2317b83b;width:100vw;height:100vh"></body></html>')
    backdrop.showInactive()
    return { id: backdrop.id }
  })
  try {
    const capture = async (protectedContent: boolean) => {
      await session.app.evaluate(({ BrowserWindow }, value) => {
        BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('#teleprompter'))!.setContentProtection(value)
      }, protectedContent)
      await session.page.waitForTimeout(600)
      return session.app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }) => {
        const display = screen.getPrimaryDisplay()
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) } })
        const source = sources.find((v) => v.display_id === String(display.id))!
        const bounds = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('#teleprompter'))!.getBounds()
        return { image: source.thumbnail.toDataURL(), bounds, display: display.bounds }
      })
    }
    const hidden = await capture(true), shown = await capture(false)
    const crop = (sample: typeof hidden, name: string): number => {
      const png = PNG.sync.read(Buffer.from(sample.image.split(',')[1]!, 'base64'))
      const sx = png.width / sample.display.width, sy = png.height / sample.display.height
      const x = Math.round((sample.bounds.x - sample.display.x + 12) * sx), y = Math.round((sample.bounds.y - sample.display.y + 65) * sy)
      const w = Math.round((sample.bounds.width - 24) * sx), h = Math.round((sample.bounds.height - 95) * sy)
      const result = new PNG({ width: w, height: h })
      let green = 0
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const from = ((y + yy) * png.width + x + xx) * 4, to = (yy * w + xx) * 4
        png.data.copy(result.data, to, from, from + 4)
        if (Math.abs(png.data[from]! - 23) < 8 && Math.abs(png.data[from + 1]! - 184) < 8 && Math.abs(png.data[from + 2]! - 59) < 8) green++
      }
      writeFileSync(join(SCREENS_DIR, name), PNG.sync.write(result))
      return green / (w * h)
    }
    expect(crop(hidden, 'm4d-teleprompter-captura-protegida.png')).toBeGreaterThan(0.96)
    expect(crop(shown, 'm4d-teleprompter-controle-sem-protecao.png')).toBeLessThan(0.5)
  } finally {
    await session.app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('#teleprompter'))?.setContentProtection(true)
      BrowserWindow.fromId(id)?.destroy()
    }, setup.id)
  }
}

test('roteiro editável, preflight, teleprompter protegido e marca errei com pausa', async () => {
  test.setTimeout(120_000)
  s = await launchTomada({ seed: false, env: { TOMADA_TEST_AUTOSOURCE: 'screen' } })
  const { page, app } = s
  await page.getByTestId('nav-record').click()
  await expect(page.getByTestId('camera-preview')).toHaveAttribute('data-live', 'true', { timeout: 20_000 })
  await expect(page.getByTestId('preflight-mic')).not.toHaveAttribute('data-status', 'listening', { timeout: 20_000 })
  await expect(page.getByTestId('preflight-mic-values')).toContainText('RMS')
  await shot(page, 'm4d-gravacao-01-preflight')
  await page.getByTestId('script-topic').fill('Demonstração de agenda de clientes')
  await page.getByTestId('script-generate').click()
  await expect(page.getByTestId('script-title')).toHaveValue('Demonstração do sistema')
  await page.getByTestId('script-title').fill('Agenda demonstrada')
  await page.getByTestId('script-hook').fill('Organize a sua agenda em segundos.')
  await page.getByTestId('teleprompter-mode').selectOption('topics')
  await page.getByTestId('teleprompter-open').click()
  let prompter = await waitPrompter(s)
  await expect(prompter.getByTestId('teleprompter-text')).toContainText('Organize a sua agenda em segundos.')
  expect(await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((v) => v.webContents.getURL().endsWith('#teleprompter'))
    return w ? { protected: w.isContentProtected(), top: w.isAlwaysOnTop(), y: w.getBounds().y } : null
  })).toMatchObject({ protected: true, top: true })
  await prompter.getByTestId('teleprompter-pause').click()
  await expect(prompter.getByTestId('teleprompter')).toHaveAttribute('data-paused', 'true')
  await prompter.getByTestId('teleprompter-next').click()
  await expect(prompter.getByTestId('teleprompter-text')).toContainText('Apresentar o problema')
  await shot(prompter, 'm4d-gravacao-02-teleprompter')
  await proveCaptureProtection(s)
  await page.getByText('Ajustes do som e da bolha', { exact: true }).click()
  await page.getByTestId('retake-shortcut').selectOption('Ctrl+Alt+X')
  await page.getByTestId('record-start').click()
  const bar = await waitForAux(app, 'bar', 30_000)
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording')
  expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+X'))).toBe(true)
  prompter = await waitPrompter(s)
  await page.waitForTimeout(1200)
  await bar.getByTestId('bar-retake').click()
  await expect(bar.getByTestId('bar-retake')).toHaveAttribute('data-count', '1')
  await expect(bar.getByTestId('bar-retake')).toHaveAttribute('data-marked', 'true')
  await shot(bar, 'm4d-gravacao-03-errei')
  await bar.getByTestId('bar-pause').click()
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'paused')
  await expect(bar.getByTestId('bar-retake')).toBeDisabled()
  const pausedAt = Number(await bar.getByTestId('bar-time').getAttribute('data-ms'))
  await page.waitForTimeout(1100)
  expect(await page.evaluate(() => window.tomada.record.markRetake())).toBeNull()
  await bar.getByTestId('bar-pause').click()
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording')
  await page.waitForTimeout(800)
  await bar.getByTestId('bar-retake').click()
  await expect(bar.getByTestId('bar-retake')).toHaveAttribute('data-count', '2')
  await bar.getByTestId('bar-stop').click()
  await expect.poll(() => readdirSync(s!.projects).filter((dir) => { try { return Boolean(readFileSync(join(s!.projects, dir, 'project.json'))) } catch { return false } }).length, { timeout: 60_000 }).toBe(1)
  const folder = readdirSync(s.projects)[0]!
  const project = parseProject(readFileSync(join(s.projects, folder, 'project.json'), 'utf8'))
  expect(project.title).toBe('Agenda demonstrada')
  expect(project.script?.hook).toBe('Organize a sua agenda em segundos.')
  expect(project.retakeMarks).toHaveLength(2)
  expect(project.retakeMarks![1]!.t - project.retakeMarks![0]!.t).toBeLessThan(2000)
  expect(project.retakeMarks![1]!.t).toBeGreaterThan(pausedAt)
  expect(readFileSync(join(s.projects, folder, 'events/retakes.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
  expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+X'))).toBe(false)
  await expect.poll(() => app.windows().filter((p) => p.url().endsWith('#teleprompter') && !p.isClosed()).length).toBe(0)
})

test('IA indisponível mostra motivo e deixa gravar', async () => {
  s = await launchTomada({ seed: false, env: { TOMADA_LLM: 'off' } })
  await s.page.getByTestId('nav-record').click()
  await s.page.getByTestId('script-topic').fill('Agenda')
  await s.page.getByTestId('script-generate').click()
  await expect(s.page.getByTestId('script-error')).toContainText('IA')
  await expect(s.page.getByTestId('record-start')).toBeEnabled()
})

test('reabrir o app retoma processamento sem repetir passo pronto', async () => {
  test.setTimeout(120_000)
  s = await launchTomada({ seed: false, env: { TOMADA_TEST_STEP_DELAY_MS: '5000' } })
  await s.page.getByTestId('nav-record').click()
  await s.page.getByTestId('mode-camera').click()
  await expect(s.page.getByTestId('record-start')).toBeEnabled()
  await s.page.getByTestId('record-start').click()
  const bar = await waitForAux(s.app, 'bar', 30_000)
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording')
  await s.page.waitForTimeout(1500)
  await bar.getByTestId('bar-retake').click()
  await expect(bar.getByTestId('bar-retake')).toHaveAttribute('data-count', '1')
  await bar.getByTestId('bar-stop').click()
  await expect.poll(async () => (await s!.page.evaluate(() => window.tomada.record.status())).processing?.steps.find((v) => v.id === 'save')?.status, { timeout: 25_000 }).toBe('done')
  const folder = readdirSync(s.projects)[0]!, base = s.base
  const persisted = JSON.parse(readFileSync(join(s.projects, folder, 'raw/recording.json'), 'utf8')) as { processing: { done: string[] } }
  expect(persisted.processing.done).toEqual(['save'])
  expect(s.problems, s.problems.join('\n')).toEqual([])
  await s.close({ keep: true }); s = undefined
  s = await launchTomada({ base, seed: false })
  await expect.poll(() => { try { return parseProject(readFileSync(join(s!.projects, folder, 'project.json'), 'utf8')).retakeMarks?.length ?? 0 } catch { return 0 } }, { timeout: 60_000 }).toBe(1)
  const completed = JSON.parse(readFileSync(join(s.projects, folder, 'raw/recording.json'), 'utf8')) as { processedAt: string; processing: { done: string[] } }
  expect(completed.processedAt).toBeTruthy()
  expect(completed.processing.done).toContain('camera')
  expect(completed.processing.done).toContain('project')
})
