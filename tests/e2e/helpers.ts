/**
 * Ajudantes do e2e: abre o Tomada de verdade (Electron), com dados isolados.
 *
 * - `ELECTRON_RUN_AS_NODE` é REMOVIDA do ambiente do app (esta máquina a tem ligada;
 *   com ela `require('electron').app` vem `undefined`).
 * - `TOMADA_PROJECTS_DIR` aponta para uma pasta temporária semeada com o projeto de exemplo.
 * - `TOMADA_USER_DATA_DIR` isola ajustes e logs do app real.
 * - `TOMADA_TRANSCRIBER=mock`, `TOMADA_LLM=mock`, `TOMADA_CAMERA=off` e `TOMADA_TOOLS_DIR` (pasta da sessão): nenhum teste e2e toca na
 *   placa, no Python, na rede nem na IA de verdade (cada teste pode sobrescrever pelo `env`).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { copyTree, FIXTURES_DIR, ROOT } from '../helpers/fs'

export { ROOT }
export const EXAMPLE_FOLDER = '2026-10-04 1500 Projeto de exemplo'
export const SCREENS_DIR = join(ROOT, 'test-results', 'screens')

export type LaunchOptions = {
  /** Testes das etapas anteriores ficam no editor; os do piloto usam o padrão do produto. */
  autopilot?: boolean
  /** Copia o projeto de exemplo para a raiz (padrão: sim). */
  seed?: boolean
  /** Cria também pastas inválidas, para provar que a biblioteca as ignora. */
  junk?: boolean
  /** Reaproveita uma sessão anterior (mesmos dados), para provar persistência. */
  base?: string
  /** Variáveis de ambiente extras (ou sobrescritas) para o app. */
  env?: Record<string, string>
  /** Argumentos extras para o Chromium/Electron. */
  args?: string[]
  /** Usa a câmera e o microfone REAIS desta máquina (padrão: dispositivos falsos). */
  realDevices?: boolean
}

/**
 * Câmera e microfone falsos do Chromium: o vídeo vem de `fake-camera.y4m` e o áudio de
 * `voz.wav`. Os arquivos são copiados para uma pasta temporária SEM acento (o Chrome pode
 * errar caminho com "ô").
 */
export function fakeDeviceArgs(): string[] {
  const dir = join(tmpdir(), 'tomada-fakes')
  mkdirSync(dir, { recursive: true })
  const wav = join(dir, 'voz.wav')
  const y4m = join(dir, 'fake-camera.y4m')
  if (!existsSync(wav)) copyFileSync(join(FIXTURES_DIR, 'voz.wav'), wav)
  if (!existsSync(y4m)) copyFileSync(join(FIXTURES_DIR, 'fake-camera.y4m'), y4m)
  return [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`,
    `--use-file-for-fake-video-capture=${y4m}`
  ]
}

export type Session = {
  app: ElectronApplication
  page: Page
  /** Pasta temporária da sessão (projetos + userData). */
  base: string
  projects: string
  userData: string
  /** Erros de console e de página vistos até agora. */
  problems: string[]
  /** Fecha o app e (se `keep` não for pedido) apaga a pasta temporária. */
  close(opts?: { keep?: boolean }): Promise<void>
}

export async function launchTomada(opts: LaunchOptions = {}): Promise<Session> {
  const base = opts.base ?? mkdtempSync(join(tmpdir(), 'tomada-e2e-'))
  const projects = join(base, 'projetos')
  const userData = join(base, 'userdata')
  if (!opts.base) {
    mkdirSync(projects, { recursive: true })
    mkdirSync(userData, { recursive: true })
    if (!opts.autopilot) writeFileSync(join(userData,'settings.json'), JSON.stringify({autopilot:{mode:'nothing'}}))
    if (opts.seed !== false) copyTree(join(FIXTURES_DIR, 'projeto-exemplo'), join(projects, EXAMPLE_FOLDER))
    if (opts.junk) {
      mkdirSync(join(projects, 'pasta-quebrada'))
      writeFileSync(join(projects, 'pasta-quebrada', 'project.json'), '{ isto não é json')
      mkdirSync(join(projects, 'pasta-sem-projeto'))
      writeFileSync(join(projects, 'arquivo-solto.txt'), 'oi')
    }
  }

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env.TOMADA_PROJECTS_DIR = projects
  env.TOMADA_USER_DATA_DIR = userData
  env.TOMADA_TEST_SILENT = '1' // nada de bipe nos alto-falantes durante os testes
  env.TOMADA_TRANSCRIBER = 'mock'
  env.TOMADA_LLM = 'mock'
  env.TOMADA_CAMERA = 'off' // a análise do rosto (M4c) é desligada por padrão; os testes dela ligam `mock`
  env.TOMADA_TOOLS_DIR = join(base, 'ferramentas')
  Object.assign(env, opts.env)

  const args = ['.', ...(opts.realDevices ? [] : fakeDeviceArgs()), ...(opts.args ?? [])]
  const app = await electron.launch({ args, cwd: ROOT, env })
  const page = await app.firstWindow()

  const problems: string[] = []
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`)
  })

  // Janelas auxiliares (barra, contagem, bolha) também não podem registrar erros.
  app.on('window', (win) => {
    win.on('pageerror', (err) => problems.push(`pageerror (${win.url().split('#')[1] ?? 'janela'}): ${err.message}`))
    win.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`console.error (${win.url().split('#')[1] ?? 'janela'}): ${msg.text()}`)
    })
  })

  await page.waitForLoadState('domcontentloaded')

  return {
    app,
    page,
    base,
    projects,
    userData,
    problems,
    async close({ keep = false } = {}) {
      await app.close().catch(() => undefined)
      if (!keep) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
}

/** Redimensiona a área de conteúdo da janela e confirma o tamanho que a página enxerga. */
export async function setContentSize(session: Session, width: number, height: number): Promise<void> {
  await session.app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('sem janela')
      win.setContentSize(size.width, size.height)
    },
    { width, height }
  )
  await expect
    .poll(() => session.page.evaluate(() => window.innerWidth), { message: `largura da janela ${width}` })
    .toBe(width)
}

export async function shot(page: Page, name: string): Promise<string> {
  mkdirSync(SCREENS_DIR, { recursive: true })
  const path = join(SCREENS_DIR, `${name}.png`)
  await page.screenshot({ path })
  return path
}

/** Leitura de estado do <video> para as asserções. */
export async function videoState(page: Page, testId: string): Promise<{ currentTime: number; readyState: number; paused: boolean; duration: number; error: string | null }> {
  return page.getByTestId(testId).evaluate((el) => {
    const v = el as HTMLVideoElement
    return { currentTime: v.currentTime, readyState: v.readyState, paused: v.paused, duration: v.duration, error: v.error ? `${v.error.code}: ${v.error.message}` : null }
  })
}

/** A página de uma janela auxiliar (`bar`, `countdown`, `bubble`), se já estiver aberta. */
export function auxPage(app: ElectronApplication, name: 'bar' | 'countdown' | 'bubble'): Page | undefined {
  return app.windows().find((w) => w.url().endsWith(`#${name}`))
}

/** Espera uma janela auxiliar abrir e carregar. */
export async function waitForAux(app: ElectronApplication, name: 'bar' | 'countdown' | 'bubble', timeout = 20_000): Promise<Page> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const p = auxPage(app, name)
    if (p && !p.isClosed()) {
      await p.waitForLoadState('domcontentloaded').catch(() => undefined)
      return p
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`A janela "${name}" não abriu em ${timeout} ms.`)
}
