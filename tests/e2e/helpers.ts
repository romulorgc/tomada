/**
 * Ajudantes do e2e: abre o Tomada de verdade (Electron), com dados isolados.
 *
 * - `ELECTRON_RUN_AS_NODE` é REMOVIDA do ambiente do app (esta máquina a tem ligada;
 *   com ela `require('electron').app` vem `undefined`).
 * - `TOMADA_PROJECTS_DIR` aponta para uma pasta temporária semeada com o projeto de exemplo.
 * - `TOMADA_USER_DATA_DIR` isola ajustes e logs do app real.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { copyTree, FIXTURES_DIR, ROOT } from '../helpers/fs'

export { ROOT }
export const EXAMPLE_FOLDER = '2026-10-04 1500 Projeto de exemplo'
export const SCREENS_DIR = join(ROOT, 'test-results', 'screens')

export type LaunchOptions = {
  /** Copia o projeto de exemplo para a raiz (padrão: sim). */
  seed?: boolean
  /** Cria também pastas inválidas, para provar que a biblioteca as ignora. */
  junk?: boolean
  /** Reaproveita uma sessão anterior (mesmos dados), para provar persistência. */
  base?: string
  /** Variáveis de ambiente extras (ou sobrescritas) para o app. */
  env?: Record<string, string>
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
  Object.assign(env, opts.env)

  const app = await electron.launch({ args: ['.'], cwd: ROOT, env })
  const page = await app.firstWindow()

  const problems: string[] = []
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`)
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
