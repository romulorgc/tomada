import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { EXAMPLE_FOLDER, launchTomada, ROOT, shot, type Session } from './helpers'
import { openEditor, waitSaved } from './editor-helpers'
import { parseProject, serializeProject } from '../../src/shared/project'

let s: Session | undefined
test.afterEach(async () => { const problems = s?.problems ?? []; await s?.close(); s = undefined; expect(problems).toEqual([]) })
for (const route of ['horizontal', 'fila', 'revisão'] as const) {
  test(`save da proteção falha e nada é exportado pelo ${route}`, async () => {
    s = await launchTomada()
    const file = join(s.projects, EXAMPLE_FOLDER, 'project.json')
    const p = parseProject(readFileSync(file, 'utf8'))
    p.zoomPreset = 'off'
    p.review = { items: { youtube: { decision: 'pending', phase: 'error', origin: 'manual' } } }
    p.clips = [{ id: 'c', title: 'Corte sintético', hook: '', ranges: [{ start: 0, end: 2000 }], score: 80, reason: 'Teste', format: 'vertical', layoutV: 'screen-focus' }]
    writeFileSync(file, serializeProject(p))
    if (route === 'revisão') {
      await s.page.reload()
      await s.page.getByTestId('card-review').click()
      await s.page.getByTestId('review-item-youtube').getByRole('button', { name: 'Abrir no editor' }).click()
    } else await openEditor(s)
    await waitSaved(s)
    await expect(s.page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true')
    await s.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('projects:save')
      ipcMain.handle('projects:save', async () => { throw new Error('EPERM: falha simulada ao salvar proteção') })
    })
    const page = s.page
    await page.getByTestId('tab-blur').click(); await page.getByTestId('blur-draw').click()
    const b = (await page.getByTestId('preview-canvas').boundingBox())!
    await page.mouse.move(b.x + b.width * .3, b.y + b.height * .3); await page.mouse.down()
    await page.mouse.move(b.x + b.width * .6, b.y + b.height * .6); await page.mouse.up()
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'error')
    if (route === 'fila') {
      await page.getByTestId('tab-clips').click(); await page.getByTestId('clip-select').check()
      await page.getByTestId('clips-export-selected').click()
      await expect(page.getByTestId('clip-queue-message')).toContainText('Não consegui salvar o projeto; nada foi exportado')
    } else {
      await page.getByTestId('export-open').click(); await page.getByTestId('export-start').click()
      await expect(page.getByTestId('export-dialog')).toContainText('Não consegui salvar o projeto; nada foi exportado')
    }
    expect(await page.evaluate(() => window.tomada.exporter.status())).toBeNull()
    const exports = join(s.projects, EXAMPLE_FOLDER, 'exports')
    let files: string[] = []; try { files = readdirSync(exports, { recursive: true }) as string[] } catch {}
    expect(files.filter(f => f.endsWith('.mp4'))).toEqual([])
    await shot(page, `m5a-consertos-save-${route}`)
  })
}
test('segunda abertura sai e restaura a janela da instância existente', async () => {
  s = await launchTomada()
  await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize())
  const env: NodeJS.ProcessEnv = { ...process.env, TOMADA_PROJECTS_DIR: s.projects, TOMADA_USER_DATA_DIR: s.userData }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(join(ROOT, 'node_modules/electron/dist/electron.exe'), ['.'], { cwd: ROOT, env, windowsHide: true, stdio: 'ignore' })
  try {
    const ended = new Promise<number | null>(resolve => child.once('exit', resolve))
    const result = await Promise.race([ended, new Promise<string>(r => setTimeout(() => r('continua aberta'), 8000))])
    expect(result).toBe(0)
    await expect.poll(() => s!.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized())).toBe(false)
  } finally { if (child.exitCode === null) child.kill() }
})
test('painel de proteção explica que fala e textos continuam expostos', async () => {
  s = await launchTomada(); await openEditor(s)
  await s.page.getByTestId('tab-blur').click()
  await expect(s.page.getByText('Fala, legenda e texto de publicação não são protegidos.', { exact: true })).toBeVisible()
  await shot(s.page, 'm5a-consertos-limite-protecao')
})
test('queda recente volta à oferta após a espera e informa eventos ausentes antes da decisão', async () => {
  s = await launchTomada({ seed: false })
  const id = 'Bruto recém interrompido', dir = join(s.projects, id)
  mkdirSync(join(dir, 'raw'), { recursive: true }); writeFileSync(join(dir, 'raw/camera.webm'), new Uint8Array([1, 2, 3]))
  writeFileSync(join(dir, 'raw/recording.json'), JSON.stringify({ version: 1, sessionId: id, folder: id, title: id, createdAt: '2026-10-05T12:00:00Z', mode: 'camera', fps: 30, screen: null, camera: { file: 'raw/camera.webm', mime: 'video/webm', hasVideo: true, hasAudio: true, size: { w: 640, h: 360 } }, clock: { t0: 100000, screenStartAt: null, cameraStartAt: 100000, offsetMs: 0, rttMs: 1 }, pauses: [], endedAt: null, stopReason: null, recordedMs: null, notes: [], saved: null, processedAt: null }))
  await s.page.reload()
  await expect(s.page.getByTestId('recovery-prompt')).not.toBeVisible()
  await expect(s.page.getByTestId('recovery-prompt')).toBeVisible({ timeout: 12000 })
  await expect(s.page.getByTestId('recovery-item')).toContainText('cursor, cliques e teclas')
  await shot(s.page, 'm5a-consertos-recuperacao-eventos')
})
test('manifesto ilegível conserva o bruto visível na oferta com o motivo', async () => {
  s = await launchTomada({ seed: false })
  const dir = join(s.projects, 'Bruto ilegível')
  mkdirSync(join(dir, 'raw'), { recursive: true }); writeFileSync(join(dir, 'raw/camera.webm'), new Uint8Array([1, 2, 3]))
  const old = new Date(Date.now() - 20000); utimesSync(join(dir, 'raw/camera.webm'), old, old)
  writeFileSync(join(dir, 'raw/recording.json'), '{ inválido')
  await s.page.reload()
  await expect(s.page.getByTestId('recovery-item')).toContainText('Existe um bruto que não consegui ler')
  await shot(s.page, 'm5a-consertos-recuperacao-ilegivel')
})
