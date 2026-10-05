/**
 * Laboratório de render: abre a janela escondida `#export-lab` (o mesmo bundle da exportação, com os
 * ganchos de teste) dentro do app de verdade e renderiza quadros pelo MESMO caminho da exportação
 * (mediabunny → evaluateScene → renderFrame num OffscreenCanvas). Base dos goldens.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { EVENT_FILES } from '../../src/shared/events'
import { FACE_FILE, type FaceTrack } from '../../src/shared/face'
import { mediaUrl } from '../../src/shared/media-url'
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
        width: 1280,
        height: 720,
        webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
      })
      void win.loadFile(file, { hash: 'export-lab' })
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

export type GoldenResult = { name: string; mismatched: number; ratio: number; created: boolean }

/**
 * Compara com `tests/goldens/<name>.png` (pixelmatch). Sem o golden (ou com UPDATE_GOLDENS=1) grava o
 * PNG novo para conferência a olho. Tolerância: 0,4% dos pixels diferentes (variação de GPU).
 */
export function compareGolden(name: string, png: Buffer, opts: { maxRatio?: number; threshold?: number } = {}): GoldenResult {
  mkdirSync(GOLDENS_DIR, { recursive: true })
  const file = join(GOLDENS_DIR, `${name}.png`)
  if (!existsSync(file) || process.env.UPDATE_GOLDENS === '1') {
    writeFileSync(file, png)
    return { name, mismatched: 0, ratio: 0, created: true }
  }
  const a = PNG.sync.read(readFileSync(file))
  const b = PNG.sync.read(png)
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`Golden ${name}: tamanho ${b.width}×${b.height} difere do golden ${a.width}×${a.height}.`)
  }
  const diff = new PNG({ width: a.width, height: a.height })
  const mismatched = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: opts.threshold ?? 0.1 })
  const ratio = mismatched / (a.width * a.height)
  if (ratio > (opts.maxRatio ?? 0.004)) {
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
