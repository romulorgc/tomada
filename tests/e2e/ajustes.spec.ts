import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { launchTomada, shot, type Session } from './helpers'

let s: Session | undefined

test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

/** A versão que o PRÓPRIO ffmpeg informa, lida por fora do app. */
function ffmpegVersionFromCli(bin: 'ffmpeg' | 'ffprobe'): string {
  const out = execFileSync(bin, ['-version'], { encoding: 'utf8' })
  const m = /version\s+(\S+)/.exec(out.split(/\r?\n/)[0] ?? '')
  if (!m?.[1]) throw new Error(`não consegui ler a versão do ${bin}: ${out}`)
  return m[1]
}

test('Ajustes mostra o ffmpeg detectado, a versão certa e o teste passa de verdade', async () => {
  s = await launchTomada()
  const { page } = s
  await page.getByTestId('nav-settings').click()

  await expect(page.getByTestId('settings-view')).toBeVisible()
  await expect(page.getByTestId('ffmpeg-status')).toContainText('Detectado')
  await expect(page.getByTestId('ffmpeg-version')).toHaveText(ffmpegVersionFromCli('ffmpeg'))
  await expect(page.getByTestId('ffprobe-version')).toHaveText(ffmpegVersionFromCli('ffprobe'))
  await expect(page.getByTestId('ffmpeg-path')).toContainText(/ffmpeg(\.exe)?$/i)
  await expect(page.getByTestId('app-version')).toHaveText('0.1.0')
  await shot(page, '09-ajustes')

  await page.getByTestId('ffmpeg-test').click()
  const result = page.getByTestId('ffmpeg-test-result')
  await expect(result).toBeVisible({ timeout: 60_000 })
  await expect(result).toHaveAttribute('data-ok', 'true')
  await expect(result).toContainText('O ffmpeg passou no teste.')
  await expect(result).toContainText('Codificar H.264 (software, libx264)')
  await shot(page, '10-ajustes-teste-do-ffmpeg')
})

test('Ajustes mostra a pasta dos projetos e avisa quando ela vem da variável de teste', async () => {
  s = await launchTomada()
  const { page } = s
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('projects-dir')).toHaveText(s.projects)
  await expect(page.getByTestId('settings-projects')).toContainText('TOMADA_PROJECTS_DIR')
  await expect(page.getByTestId('choose-projects-dir')).toBeEnabled()
})

test('sem ffmpeg no sistema, Ajustes diz claramente o que houve e o que fazer (não falha em silêncio)', async () => {
  // PATH sem o ffmpeg: o app abre normalmente e a tela de Ajustes explica.
  s = await launchTomada({ env: { PATH: 'C:\\Windows\\System32', Path: 'C:\\Windows\\System32' } })
  const { page } = s
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('ffmpeg-status')).toContainText('Não encontrado')
  await expect(page.getByTestId('ffmpeg-error')).toContainText('Não encontrei o ffmpeg e o ffprobe no PATH')
  await expect(page.getByTestId('ffmpeg-error')).toContainText('Instale o ffmpeg ou escolha a pasta')
  await expect(page.getByTestId('ffmpeg-test')).toBeDisabled()
  await shot(page, '11-ajustes-sem-ffmpeg')
})

test('segurança: contextIsolation ligado, sem Node no renderer, API única em window.tomada, navegação externa barrada', async () => {
  s = await launchTomada()
  const { page } = s
  await expect(page.getByTestId('project-card')).toHaveCount(1)

  const info = await page.evaluate(async () => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    buffer: typeof (window as unknown as { Buffer?: unknown }).Buffer,
    api: Object.keys(window.tomada).sort(),
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null,
    lang: document.documentElement.lang,
    appName: (await window.tomada.app.info()).name
  }))
  expect(info.require).toBe('undefined')
  expect(info.process).toBe('undefined')
  expect(info.buffer).toBe('undefined')
  expect(info.api).toEqual(['app', 'bar', 'bubble', 'countdown', 'ffmpeg', 'log', 'mediaUrl', 'on', 'processing', 'projects', 'record', 'settings'])
  expect(info.csp).toContain("default-src 'self'")
  expect(info.csp).toContain("script-src 'self'")
  expect(info.lang).toBe('pt-BR')
  expect(info.appName).toBe('Tomada') // define %APPDATA%\Tomada como pasta de dados

  // Preferências de segurança da janela, lidas do próprio processo principal.
  const prefs = await s.app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents
    // getLastWebPreferences existe em runtime mas não está nos tipos do Electron 40
    const p = (wc as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences()
    return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox }
  })
  expect(prefs).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true })

  // Navegar para fora e abrir janela nova são barrados.
  const before = page.url()
  await page.evaluate(() => {
    window.location.href = 'https://example.com/'
  })
  await page.waitForTimeout(800)
  expect(page.url()).toBe(before)
  const opened = await page.evaluate(() => window.open('https://example.com/') === null)
  expect(opened).toBe(true)
  expect(await s.app.windows().length).toBe(1)
})

test('o ID de projeto malicioso é recusado pela ponte (nada de sair da raiz)', async () => {
  s = await launchTomada()
  const { page } = s
  await expect(page.getByTestId('project-card')).toHaveCount(1)
  const errors = await page.evaluate(async () => {
    const out: string[] = []
    for (const id of ['..', '../x', 'C:\\Windows', 'a/b']) {
      try {
        await window.tomada.projects.get(id)
        out.push(`ACEITOU ${id}`)
      } catch (e) {
        out.push((e as Error).message)
      }
    }
    return out
  })
  for (const e of errors) expect(e).toContain('Identificador de projeto inválido')
  // IPC que falha é registrado no log do processo principal (consoles do Chromium não mostram nada).
  s.problems.length = 0
})
