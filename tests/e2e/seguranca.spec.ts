/**
 * Segurança (revisão de 05/10), com o Electron de verdade: projeto "de terceiros" que aponta para a rede ou para fora
 * da pasta, a ponte (IPC) que recusa o que não deve, a rede cortada no processo principal e a CSP do build.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ROOT } from '../helpers/fs'
import { editProject } from './export-helpers'
import { EXAMPLE_FOLDER, launchTomada, type Session } from './helpers'

let s: Session | undefined
let server: Server | undefined
let hits: string[] = []
let foreignNetworkSession: Session | undefined
const foreignNetworkError = /^console\.error \(janela\): Failed to load resource: net::ERR_BLOCKED_BY_CLIENT$/

test.afterEach(async () => {
  const closed = s
  const expectsForeignNetworkErrors = closed !== undefined && closed === foreignNetworkSession
  if (closed) {
    await closed.close()
    s = undefined
  }
  if (server) {
    await new Promise((r) => server!.close(r))
    server = undefined
  }
  foreignNetworkSession = undefined
  if (closed) {
    // close() conclui também os eventos tardios da janela destruída; nunca limpar antes disso.
    const problems = closed.problems
    if (expectsForeignNetworkErrors) {
      expect(problems.length, 'o Chromium deve registrar os bloqueios provocados na janela externa').toBeGreaterThan(0)
      expect(problems.filter((problem) => !foreignNetworkError.test(problem)), `erros inesperados na interface:\n${problems.join('\n')}`).toEqual([])
      expect(hits, 'nenhuma requisição pode chegar, inclusive durante o fechamento').toEqual([])
    } else {
      expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
    }
  }
})

/** Servidor HTTP local que conta cada requisição que chega (se chegar alguma, algo vazou para a rede). */
async function listen(): Promise<number> {
  hits = []
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' })
    res.end(Buffer.from('89504e470d0a1a0a', 'hex'))
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return (server.address() as AddressInfo).port
}

test('projeto de terceiros com imagem de fundo da rede ou de fora da pasta: não abre, diz por quê e NENHUMA requisição sai', async () => {
  test.setTimeout(120_000)
  const port = await listen()
  const cases = [
    `http://127.0.0.1:${port}/fundo.png`,
    `https://127.0.0.1:${port}/fundo.png`,
    'file:///C:/Windows/win.ini',
    'data:image/png;base64,iVBORw0KGgo=',
    'C:\\Windows\\Web\\Wallpaper\\Windows\\img0.jpg',
    '..\\..\\fora.png'
  ]
  for (const path of cases) {
    s = await launchTomada()
    const { page } = s
    editProject(s, (p) => {
      p.style.background = { type: 'image', path }
    })
    await expect(page.getByTestId('project-card')).toHaveCount(1)
    await page.getByTestId('card-open').click()
    const panel = page.getByTestId('error-panel')
    await expect(panel, path).toBeVisible({ timeout: 15_000 })
    await expect(panel, path).toContainText('Este projeto aponta para um arquivo fora da pasta dele')
    await expect(page.getByTestId('editor')).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(s.problems, `${path}: erros na interface`).toEqual([])
    await s.close()
    s = undefined
  }
  expect(hits, 'requisições que chegaram ao servidor local').toEqual([])
})

test('projeto de terceiros com mídia fora da pasta: não abre e a exportação também recusa, com a mesma frase', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.sources.voice!.path = '..\\..\\..\\Windows\\win.ini'
  })
  await expect(page.getByTestId('project-card')).toHaveCount(1)
  await page.getByTestId('card-open').click()
  await expect(page.getByTestId('error-panel')).toContainText('Este projeto aponta para um arquivo fora da pasta dele')
  const result = await page.evaluate(async (id) => {
    try {
      await window.tomada.exporter.start({ projectId: id, resolution: '1080p', fps: 30 })
      return 'aceitou'
    } catch (e) {
      return (e as Error).message
    }
  }, EXAMPLE_FOLDER)
  expect(result).toContain('Este projeto aponta para um arquivo fora da pasta dele')
  expect(existsSync(join(s.projects, EXAMPLE_FOLDER, 'exports'))).toBe(false)
})

test('a ponte (IPC) recusa abrir executável, exportar para pasta não escolhida, trocar o ffmpeg por um programa qualquer e id que foge da raiz', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  const { page } = s
  await expect(page.getByTestId('project-card')).toHaveCount(1)
  const script = join(s.projects, EXAMPLE_FOLDER, 'malvado.bat')
  writeFileSync(script, 'echo oi')
  const intrusa = join(mkdtempSync(join(tmpdir(), 'tomada-intrusa-')), 'sub')
  const media = join(s.projects, EXAMPLE_FOLDER, 'media', 'screen.mp4')

  const out = await page.evaluate(
    async ({ script, intrusa, media, id }) => {
      const fail = async (fn: () => Promise<unknown>): Promise<string> => {
        try {
          await fn()
          return 'ACEITOU'
        } catch (e) {
          return (e as Error).message
        }
      }
      return {
        exe: await fail(() => window.tomada.files.open('C:\\Windows\\System32\\calc.exe')),
        bat: await fail(() => window.tomada.files.open(script)),
        fora: await fail(() => window.tomada.files.open('C:\\Windows\\Media\\tada.wav')),
        revelar: await fail(() => window.tomada.files.reveal('C:\\Windows\\System32')),
        pasta: await fail(() => window.tomada.exporter.start({ projectId: id, resolution: '1080p', fps: 30, dir: intrusa })),
        ffmpeg: await fail(() => window.tomada.settings.update({ ffmpegPath: 'C:\\Windows\\System32\\cmd.exe' })),
        raiz: await fail(() => window.tomada.settings.update({ projectsDir: 'C:\\' })),
        id1: await fail(() => window.tomada.projects.get('..\\..\\x')),
        id2: await fail(() => window.tomada.projects.get('...')),
        id3: await fail(() => window.tomada.projects.trash('..')),
        ok: await fail(async () => {
          await window.tomada.files.open(media)
          return 'x'
        })
      }
    },
    { script, intrusa, media, id: EXAMPLE_FOLDER }
  )
  expect(out.exe).toContain('Só abro arquivos de mídia')
  expect(out.bat).toContain('Só abro arquivos de mídia')
  expect(out.fora).toContain('não está na pasta dos projetos')
  expect(out.revelar).toContain('não vou mostrá-lo')
  expect(out.pasta).toContain('não foi escolhida por você nesta sessão')
  expect(out.ffmpeg).toContain('não foi escolhido por você nesta sessão')
  expect(out.raiz).toContain('não foi escolhido por você nesta sessão')
  for (const id of [out.id1, out.id2, out.id3]) expect(id).toContain('Identificador de projeto inválido')
  expect(out.ok).toBe('ACEITOU') // a mídia do projeto abre (o app em teste só registra o pedido)
  expect(existsSync(intrusa)).toBe(false)
  const calls = await s.app.evaluate(() => (globalThis as { __tomadaTestCalls?: { op: string; path: string }[] }).__tomadaTestCalls ?? [])
  expect(calls).toEqual([{ op: 'open', path: media }]) // só a mídia do projeto: nem o .exe nem o .bat
  rmSync(join(intrusa, '..'), { recursive: true, force: true })
})

test('só as páginas do app falam com o processo principal, e a rede é cortada na camada de rede (mesmo numa página sem CSP)', async () => {
  test.setTimeout(90_000)
  const port = await listen()
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  expect(s.problems, 'a interface deve estar sem erros antes do cenário de bloqueio').toEqual([])
  foreignNetworkSession = s
  const preload = join(ROOT, 'out', 'preload', 'index.js')

  const foreign = await s.app.evaluate(
    async ({ BrowserWindow }, args) => {
      // uma janela com a mesma ponte, mas numa página que NÃO é a do app (e sem CSP)
      const win = new BrowserWindow({ show: false, webPreferences: { preload: args.preload, contextIsolation: true, sandbox: true } })
      await win.loadURL('data:text/html,<p>pagina de fora</p>')
      const run = (code: string): Promise<string> => win.webContents.executeJavaScript(code)
      const ipc = await run(`window.tomada.app.info().then(() => 'respondeu', (e) => e.message)`)
      const list = await run(`window.tomada.projects.list().then((l) => 'listou ' + l.length, (e) => e.message)`)
      const net = await run(`fetch(${JSON.stringify(args.url)}, { mode: 'no-cors' }).then(() => 'passou', (e) => 'barrou: ' + e.message)`)
      const img = await run(
        `new Promise((resolve) => { const i = new Image(); i.onload = () => resolve('carregou'); i.onerror = () => resolve('barrou'); i.src = ${JSON.stringify(args.url + '/img.png')} })`
      )
      win.destroy()
      return { ipc, list, net, img }
    },
    { preload, url: `http://127.0.0.1:${port}/segredo` }
  )
  expect(foreign.ipc).toContain('Origem não confiável')
  expect(foreign.list).toContain('Origem não confiável')
  expect(foreign.net).toMatch(/^barrou/)
  expect(foreign.img).toBe('barrou')
  expect(hits, 'requisições que chegaram ao servidor local').toEqual([])
  // O afterEach valida o padrão exato da janela de fora após close(), incluindo eventos tardios.
})

test('navegação para fora do app é barrada: file:, https:, janela nova', async () => {
  test.setTimeout(60_000)
  s = await launchTomada()
  const { page } = s
  await expect(page.getByTestId('project-card')).toHaveCount(1)
  const before = page.url()
  for (const target of ['file:///C:/Windows/win.ini', 'https://example.com/', 'file:///C:/Windows/']) {
    await page.evaluate((url) => {
      window.location.href = url
    }, target)
    await page.waitForTimeout(500)
    expect(page.url(), target).toBe(before)
  }
  const opened = await page.evaluate(() => [window.open('file:///C:/Windows/win.ini'), window.open('https://example.com/'), window.open('about:blank')].map((w) => w === null))
  expect(opened).toEqual([true, true, true])
  expect(s.app.windows().length).toBe(1)
  // o app continua de pé (conferido pela página, sem esperar "fim de navegação": a navegação barrada nunca começa)
  expect(await page.evaluate(() => document.querySelectorAll('[data-testid=project-card]').length)).toBe(1)
})

test('CSP do build: imagem, mídia e conexão só do app e de tomada-media:, sem http:, https: nem curinga', async () => {
  s = await launchTomada()
  const { page } = s
  const csp = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '')
  const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]))
  expect(directives['img-src']).toEqual(["'self'", 'data:', 'tomada-media:'])
  expect(directives['media-src']).toEqual(["'self'", 'blob:', 'tomada-media:'])
  expect(directives['connect-src']).toEqual(["'self'", 'tomada-media:'])
  expect(directives['frame-src']).toEqual(["'none'"])
  expect(directives['form-action']).toEqual(["'none'"])
  expect(csp).not.toMatch(/https?:|wss?:|\*|unsafe-eval/)
  // e a página obedece: fetch e imagem para a rede morrem na própria CSP (nenhum evento de rede sai)
  const port = await listen()
  const outcome = await page.evaluate(async (url) => {
    const f = await fetch(url, { mode: 'no-cors' }).then(() => 'passou', () => 'barrou')
    const i = await new Promise<string>((resolve) => {
      const img = new Image()
      img.onload = () => resolve('carregou')
      img.onerror = () => resolve('barrou')
      img.src = `${url}/img.png`
    })
    return { f, i }
  }, `http://127.0.0.1:${port}/x`)
  expect(outcome).toEqual({ f: 'barrou', i: 'barrou' })
  expect(hits).toEqual([])
  // a CSP barrou: o console da página registra a violação, e isso é o esperado neste teste
  s.problems.length = 0
})
