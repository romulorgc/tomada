/**
 * Ajudantes do teste real do recorte do navegador (C1): abre um navegador Chromium SEPARADO (perfil temporário numa pasta sem
 * acento; o navegador do usuário nunca é aberto nem fechado) e mede, nos quadros do vídeo, onde a página aparece pintada.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pickChromiumPage } from '../../src/shared/browser'
import { ROOT } from '../helpers/fs'
import type { Rgb } from './frames'
import { childWindowsOf, frameRect, topLevelWindowsOfPid, windowTitle, type Rect } from './win-input'

export type TestBrowser = { name: 'chrome' | 'edge'; exe: string; exeName: string }

export const BROWSERS: TestBrowser[] = [
  { name: 'chrome', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', exeName: 'chrome.exe' },
  { name: 'edge', exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', exeName: 'msedge.exe' }
]

export const MAGENTA: Rgb = { r: 255, g: 0, b: 255 }
export const CYAN: Rgb = { r: 0, g: 255, b: 255 }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type OpenedBrowser = {
  pid: number
  hwnd: number
  /** Pasta temporária (perfil + página); apagada no `close`. */
  base: string
  /** A janela principal (a que o teste grava). */
  frame(): Rect
  /** A página agora, medida pelas janelas-filhas (do mesmo jeito que o rastreador). */
  page(): Rect
  title(): string
  /** Fecha SÓ a árvore de processos que este teste abriu e apaga a pasta temporária. */
  close(): Promise<void>
}

/** Abre o navegador de teste (3 abas da mesma página pintada) numa janela de 1100×700 (DIP) em (120, 80). */
export async function openTestBrowser(b: TestBrowser): Promise<OpenedBrowser> {
  const base = mkdtempSync(join(tmpdir(), `tomada-c1-nav-${b.name}-`))
  const pages = join(base, 'pagina')
  mkdirSync(pages, { recursive: true })
  copyFileSync(join(ROOT, 'tests', 'real', 'navegador-app', 'index.html'), join(pages, 'index.html'))
  const urls = ['A', 'B', 'C'].map((n) => `${pathToFileURL(join(pages, 'index.html')).href}?aba=${n}`)
  const child: ChildProcess = spawn(
    b.exe,
    [`--user-data-dir=${join(base, 'perfil')}`, '--no-first-run', '--no-default-browser-check', '--new-window', '--window-position=120,80', '--window-size=1100,700', ...urls],
    { stdio: 'ignore', windowsHide: false }
  )
  const pid = child.pid
  if (!pid) throw new Error(`Não consegui abrir o ${b.name} de teste.`)

  const closeAll = async (): Promise<void> => {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      // o taskkill reclama dos filhos que já saíram junto com o pai: o que importa é o processo sumir
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
      } catch {
        break
      }
      await sleep(200)
    }
    for (let i = 0; i < 25; i++) {
      try {
        rmSync(base, { recursive: true, force: true })
        if (!existsSync(base)) break
      } catch {
        // arquivo ainda preso pelo navegador que acabou de fechar
      }
      await sleep(300)
    }
  }

  // espera a janela principal aparecer (a de maior moldura, da classe Chrome_WidgetWin_1, com a página já carregada)
  let hwnd = 0
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const wins = topLevelWindowsOfPid(pid).filter((w) => w.className === 'Chrome_WidgetWin_1' && w.title.startsWith('Aba '))
    wins.sort((a, c) => c.frame.w * c.frame.h - a.frame.w * a.frame.h)
    if (wins[0]) {
      hwnd = wins[0].hwnd
      break
    }
    await sleep(250)
  }
  if (!hwnd) {
    await closeAll()
    throw new Error(`A janela do ${b.name} de teste não apareceu.`)
  }
  const page = (): Rect => {
    const p = pickChromiumPage(childWindowsOf(hwnd), frameRect(hwnd))
    if (!p) throw new Error('Não achei a página dentro da janela do navegador de teste.')
    return p
  }
  return { pid, hwnd, base, frame: () => frameRect(hwnd), page, title: () => windowTitle(hwnd), close: closeAll }
}

// ---------------------------------------------------------------------------
// Medidas nos quadros (RGB w×h×3)

const near = (rgb: Buffer, i: number, c: Rgb, tol: number): boolean => Math.hypot(rgb[i]! - c.r, rgb[i + 1]! - c.g, rgb[i + 2]! - c.b) <= tol

/**
 * Onde a cor `c` ocupa o quadro: a caixa das linhas e colunas em que ela aparece com pelo menos `share` do máximo (ignora pixel solto
 * de compressão). `null` se a cor não aparece.
 */
export function colorBox(rgb: Buffer, w: number, h: number, c: Rgb, tol = 48, share = 0.25): Rect | null {
  const rows = new Uint32Array(h)
  const cols = new Uint32Array(w)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (near(rgb, (y * w + x) * 3, c, tol)) {
        rows[y]!++
        cols[x]!++
      }
    }
  }
  const maxR = Math.max(...rows)
  const maxC = Math.max(...cols)
  if (maxR === 0 || maxC === 0) return null
  const edge = (arr: Uint32Array, max: number): [number, number] => {
    let a = 0
    while (a < arr.length && arr[a]! < max * share) a++
    let z = arr.length - 1
    while (z > a && arr[z]! < max * share) z--
    return [a, z]
  }
  const [y0, y1] = edge(rows, maxR)
  const [x0, x1] = edge(cols, maxC)
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/** Fração dos pixels de `region` que NÃO são da página de teste (nem magenta nem ciano): a interface do navegador, se aparecer. */
export function nonPageFraction(rgb: Buffer, w: number, region: Rect, tol = 70): number {
  let off = 0
  let total = 0
  const x0 = Math.max(0, Math.round(region.x))
  const y0 = Math.max(0, Math.round(region.y))
  const x1 = Math.round(region.x + region.w)
  const y1 = Math.round(region.y + region.h)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 3
      total++
      if (!near(rgb, i, MAGENTA, tol) && !near(rgb, i, CYAN, tol)) off++
    }
  }
  return total === 0 ? 0 : off / total
}

/** O maior desvio (px) entre as quatro arestas de duas caixas. */
export function edgeError(a: Rect, b: Rect): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.x + a.w - (b.x + b.w)), Math.abs(a.y + a.h - (b.y + b.h)))
}
