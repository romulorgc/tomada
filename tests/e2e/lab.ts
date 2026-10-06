/**
 * Laboratório de render: abre a janela escondida `#export-lab` (o mesmo bundle da exportação, com os
 * ganchos de teste) dentro do app de verdade e renderiza quadros pelo MESMO caminho da exportação
 * (mediabunny → evaluateScene → renderFrame num OffscreenCanvas). Base dos goldens.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { EVENT_FILES } from '../../src/shared/events'
import { FACE_FILE, type FaceTrack } from '../../src/shared/face'
import { mediaUrl } from '../../src/shared/media-url'
import { MATTE_FILE } from '../../src/shared/matte'
import { parseProject } from '../../src/shared/project'
import type { FormatSpec } from '../../src/shared/scene'
import type { Project, Word } from '../../src/shared/types'
import { EXAMPLE_FOLDER, ROOT, SCREENS_DIR, type Session } from './helpers'

export const GOLDENS_DIR = join(ROOT, 'tests', 'goldens')
export const GOLDENS_DIFF_DIR = join(ROOT, 'test-results', 'goldens-diff')

/** Abre a janela do laboratório e espera os ganchos de teste ficarem prontos. */
export async function openLab(app: ElectronApplication): Promise<Page> {
  await app.evaluate(
    ({ BrowserWindow }, { preload, file }) => {
      const win = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        paintWhenInitiallyHidden: true,
        width: 1280,
        height: 720,
        webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: process.env.TOMADA_E2E_HIDDEN === '1' }
      })
      // Electron exige referência forte ao BrowserWindow; só o handle do Page
      // no Playwright não impede a coleta durante carregamento/render assíncrono.
      const globals = globalThis as typeof globalThis & { __tomadaTestLabWindows?: Map<number, InstanceType<typeof BrowserWindow>> }
      const windows = globals.__tomadaTestLabWindows ??= new Map()
      const id = win.id
      const keepPainting = (globalThis as { __tomadaE2eKeepPainting?: (window: InstanceType<typeof BrowserWindow>) => void }).__tomadaE2eKeepPainting
      keepPainting?.(win)
      windows.set(id, win)
      win.once('closed', () => windows.delete(id))
      void win.loadFile(file, { hash: 'export-lab' })
      return id
    },
    { preload: join(ROOT, 'out', 'preload', 'index.js'), file: join(ROOT, 'out', 'renderer', 'index.html') }
  )
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const page = app.windows().find((w) => w.url().endsWith('#export-lab'))
    if (page) {
      await page.waitForFunction(() => Boolean((window as unknown as { tomadaExport?: unknown }).tomadaExport), undefined, { timeout: 20_000 })
      return page
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('A janela do laboratório de render não abriu.')
}

export function readProject(session: Session, folder = EXAMPLE_FOLDER): Project {
  return parseProject(readFileSync(join(session.projects, folder, 'project.json'), 'utf8'))
}

export type StillOptions = {
  project: Project
  times: number[]
  format?: FormatSpec
  folder?: string
  /** As palavras da transcrição (legendas). */
  words?: Word[] | null
  /** A URL da análise do rosto (enquadramento da câmera), se a cena usa (ver `writeFace`). */
  faceUrl?: string | null
  /** A URL do recorte do fundo (a máscara), para o layout Apresentador (ver `writeMatte`). */
  matteUrl?: string | null
}

/** Renderiza os instantes pedidos e devolve os PNGs. */
export async function renderStills(lab: Page, o: StillOptions): Promise<Buffer[]> {
  const folder = o.folder ?? EXAMPLE_FOLDER
  const { project } = o
  const req = {
    projectId: folder,
    project,
    format: o.format ?? { kind: 'horizontal', w: 1920, h: 1080 },
    words: o.words ?? null,
    faceUrl: o.faceUrl ?? null,
    matteUrl: o.matteUrl ?? null,
    times: o.times,
    screenUrl: project.sources.screen ? mediaUrl(folder, project.sources.screen.path) : null,
    cameraUrl: project.sources.camera ? mediaUrl(folder, project.sources.camera.path) : null,
    eventUrls: {
      cursor: mediaUrl(folder, EVENT_FILES.cursor),
      clicks: mediaUrl(folder, EVENT_FILES.clicks),
      keys: mediaUrl(folder, EVENT_FILES.keys)
    }
  }
  const base64s = await lab.evaluate((r) => (window as unknown as { tomadaExport: { renderStills(x: unknown): Promise<string[]> } }).tomadaExport.renderStills(r), req)
  return base64s.map((b) => Buffer.from(b, 'base64'))
}

/**
 * Grava uma análise de rosto SINTÉTICA na pasta do projeto da sessão (`media/camera-face.json`) e devolve a URL para `renderStills`:
 * o rosto fica parado em (`cx`, `cy`) com a caixa `w × h` (fração da imagem da câmera). Serve para os goldens do enquadramento.
 */
export function writeFace(session: Session, face: { cx: number; cy?: number; w?: number; h?: number; durationMs?: number }, folder = EXAMPLE_FOLDER): string {
  const { cx, cy = 0.4, w = 0.14, h = 0.3, durationMs = 23_000 } = face
  const track: FaceTrack = {
    version: 1,
    engine: 'teste',
    frame: { w: 640, h: 360 },
    sampleMs: 200,
    durationMs,
    boxes: Array.from({ length: Math.floor(durationMs / 200) + 1 }, (_, i) => ({ t: i * 200, x: cx - w / 2, y: cy - h / 2, w, h, score: 0.99 })),
    createdAt: '2026-10-05T00:00:00.000Z'
  }
  writeFileSync(join(session.projects, folder, FACE_FILE), JSON.stringify(track))
  return mediaUrl(folder, FACE_FILE)
}

/**
 * Grava um recorte do fundo SINTÉTICO na pasta do projeto da sessão (`media/camera-matte.mp4`) e devolve a URL para `renderStills`: uma
 * silhueta conhecida (cabeça sobre ombros e tronco, branca sobre preto, borda suave) com o tamanho e a taxa da câmera de exemplo
 * (640×360, 30 qps). É a "máscara de gabarito" dos goldens do Apresentador: o modelo de verdade só entra nas medições com a gravação real.
 */
export function writeMatte(session: Session, o: { durationS?: number; cx?: number } = {}, folder = EXAMPLE_FOLDER): string {
  const { durationS = 23, cx = 0.5 } = o
  const e = (c: { cx: number; cy: number; rx: number; ry: number }): string => `lte(pow((X-W*${c.cx})/(W*${c.rx}),2)+pow((Y-H*${c.cy})/(H*${c.ry}),2),1)`
  const head = { cx, cy: 0.3, rx: 0.09, ry: 0.2 }
  const body = { cx, cy: 1.1, rx: 0.3, ry: 0.7 }
  const vf = `geq=lum='255*max(${e(head)},${e(body)})':cb=128:cr=128,gblur=sigma=1.4,format=yuv420p,loop=loop=-1:size=1:start=0,fps=30`
  const out = join(session.projects, folder, MATTE_FILE)
  mkdirSync(join(session.projects, folder, 'media'), { recursive: true })
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=0.0334', '-vf', vf, '-t', String(durationS), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-g', '30', out],
    { stdio: 'pipe' }
  )
  return mediaUrl(folder, MATTE_FILE)
}

export type GoldenResult = { name: string; mismatched: number; ratio: number; created: boolean }

/** Referências próprias do compositor por software (janelas ocultas): só onde o desenho legitimamente difere da GPU. */
export const GOLDENS_SOFTWARE_DIR = join(GOLDENS_DIR, 'software')

/**
 * Compara com `tests/goldens/<name>.png` (pixelmatch). Sem o golden (ou com UPDATE_GOLDENS=1) grava o
 * PNG novo para conferência a olho. Tolerância: 0,4% dos pixels diferentes (variação de GPU).
 *
 * Nas janelas ocultas (TOMADA_E2E_HIDDEN=1) o Chromium desenha por software: o desfoque e o serrilhado de bordas diferem da GPU
 * além da tolerância sem que nada tenha quebrado. Se existir `tests/goldens/software/<name>.png`, ele é a referência desse modo;
 * UPDATE_GOLDENS=1 nesse modo só cria a variante dos goldens que fogem da tolerância e nunca sobrescreve o golden da GPU.
 */
export function compareGolden(name: string, png: Buffer, opts: { maxRatio?: number; threshold?: number } = {}): GoldenResult {
  mkdirSync(GOLDENS_DIR, { recursive: true })
  const hidden = process.env.TOMADA_E2E_HIDDEN === '1'
  const update = process.env.UPDATE_GOLDENS === '1'
  const gpuFile = join(GOLDENS_DIR, `${name}.png`)
  const softwareFile = join(GOLDENS_SOFTWARE_DIR, `${name}.png`)
  if (!existsSync(gpuFile) || (update && !hidden)) {
    writeFileSync(gpuFile, png)
    return { name, mismatched: 0, ratio: 0, created: true }
  }
  const file = hidden && existsSync(softwareFile) ? softwareFile : gpuFile
  const a = PNG.sync.read(readFileSync(file))
  const b = PNG.sync.read(png)
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`Golden ${name}: tamanho ${b.width}×${b.height} difere do golden ${a.width}×${a.height}.`)
  }
  const diff = new PNG({ width: a.width, height: a.height })
  const mismatched = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: opts.threshold ?? 0.1 })
  const ratio = mismatched / (a.width * a.height)
  if (ratio > (opts.maxRatio ?? 0.004)) {
    if (hidden && update) {
      mkdirSync(GOLDENS_SOFTWARE_DIR, { recursive: true })
      writeFileSync(softwareFile, png)
      return { name, mismatched: 0, ratio: 0, created: true }
    }
    mkdirSync(GOLDENS_DIFF_DIR, { recursive: true })
    writeFileSync(join(GOLDENS_DIFF_DIR, `${name}.diff.png`), PNG.sync.write(diff))
    writeFileSync(join(GOLDENS_DIFF_DIR, `${name}.atual.png`), png)
  }
  return { name, mismatched, ratio, created: false }
}

/** Salva um PNG nas capturas de tela (para conferência a olho). */
export function saveScreen(name: string, png: Buffer): string {
  mkdirSync(SCREENS_DIR, { recursive: true })
  const file = join(SCREENS_DIR, `${name}.png`)
  writeFileSync(file, png)
  return file
}
