/**
 * RECORTE DO NAVEGADOR, CAPTURA REAL (C1). O Tomada grava a JANELA de um Chrome e de um Edge de verdade (instância SEPARADA, com
 * perfil temporário; o navegador do usuário nunca é aberto nem fechado) com a página de teste pintada de uma cor única e três abas
 * abertas. Confere, nos quadros do vídeo, que a página medida (`events/content-rect.jsonl`) bate com a área pintada (±4 px), com a
 * janela redimensionada, o DevTools acoplado e a tela cheia, e que o vídeo exportado NÃO tem pixel da barra de abas.
 *
 * Segurança: o único clique é dentro da página de teste e, antes de cada um, a janela em primeiro plano e a janela sob o cursor são
 * conferidas (`safeClick`); a tecla (F11/F12) só sai se a janela de teste for a que está em primeiro plano. No fim, o cursor volta ao
 * centro da tela principal e o navegador de teste é fechado (só a árvore de processos que o teste abriu).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { eventsFromText } from '../../src/shared/events'
import { resolveScreenCrop, stabilizeContentRects, type CropStep } from '../../src/shared/crop'
import { parseProject } from '../../src/shared/project'
import { HORIZONTAL_1080, VERTICAL_1080, deriveProject, evaluateScene, prepareEvents } from '../../src/shared/scene'
import type { ContentRectSample, Project, Rect as NRect } from '../../src/shared/types'
import { exportProject } from '../e2e/export-helpers'
import { launchTomada, SCREENS_DIR, waitForAux, type Session } from '../e2e/helpers'
import { frameRgb, hex, findColorBox } from './frames'
import { BROWSERS, MAGENTA, colorBox, edgeError, nonPageFraction, openTestBrowser, type OpenedBrowser, type TestBrowser } from './navegador'
import {
  VK_F11,
  VK_F12,
  activateByClick,
  keepOnTop,
  parkCursorAtPrimaryCenter,
  moveSmooth,
  pressKeyIn,
  primaryMonitorRect,
  safeClick,
  UnsafeClickError,
  setWindowRect,
  type Pt,
  type Rect
} from './win-input'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const TOL_PX = 4

let session: Session | undefined
let browser: OpenedBrowser | undefined

test.afterEach(async () => {
  try {
    if (session) {
      const problems = session.problems
      await session.close()
      session = undefined
      expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
    }
  } finally {
    await browser?.close()
    browser = undefined
    parkCursorAtPrimaryCenter(primaryMonitorRect())
  }
})

function readJsonl<T>(file: string): T[] {
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T)
  } catch {
    return []
  }
}

/** Escolhe a janela (ou a tela principal) na tela Gravar e começa. */
async function chooseAndRecord(s: Session, source: { window: number } | { screen: true }): Promise<void> {
  const { page } = s
  await page.getByTestId('nav-record').click()
  await expect(page.getByTestId('source-card').first()).toBeVisible()
  await page.getByTestId('mode-screen').click()
  await expect(page.getByTestId('mic-select')).not.toHaveValue('')
  await page.getByTestId('mic-select').selectOption('')
  await expect(page.getByTestId('mic-select')).toHaveValue('')
  if ('window' in source) {
    await page.getByTestId('source-tab-windows').click()
    const card = page.locator(`[data-testid="source-card"][data-source-id="window:${source.window}:0"]`)
    await expect(card).toBeVisible({ timeout: 25_000 })
    // a janela de navegador vem marcada (a página é medida e as abas saem do vídeo sozinhas)
    await expect(card.getByTestId('browser-badge')).toBeVisible()
    await card.click()
    await expect(card).toHaveAttribute('aria-pressed', 'true')
  } else {
    await page.getByTestId('source-tab-screens').click()
    const card = page.locator('[data-testid="source-card"][data-kind="screen"]').first()
    await expect(card).toBeVisible()
    await card.click()
    await expect(card).toHaveAttribute('aria-pressed', 'true')
  }
  await page.getByTestId('record-start').click()
}

/** Clique de verdade no centro da página (no botão ciano); traz a janela ao primeiro plano antes, se preciso. */
async function clickButton(b: OpenedBrowser): Promise<number> {
  const before = b.title()
  const n = Number(/clique (\d+)/.exec(before)?.[1] ?? 0)
  const page = b.page()
  const neutral: Pt = { x: Math.round(page.x + 40), y: Math.round(page.y + page.h - 40) }
  const center: Pt = { x: Math.round(page.x + page.w / 2), y: Math.round(page.y + page.h / 2) }
  // A trava de segurança (`UnsafeClickError`) só deixa o clique sair com a janela de teste em primeiro plano E sob o cursor. Se
  // alguém mexeu no mouse ou numa janela no meio do caminho, nada é clicado: refaz o caminho (até 3 vezes) antes de desistir.
  for (let attempt = 1; ; attempt++) {
    try {
      await activateByClick(b.hwnd, neutral)
      await sleep(300)
      await moveSmooth(center, 600)
      await sleep(150)
      await safeClick(b.hwnd)
      break
    } catch (err) {
      if (!(err instanceof UnsafeClickError) || attempt >= 3) throw err
      console.log(`[clique] tentativa ${attempt} recusada pela trava (${err.message}); refazendo`)
      await sleep(800)
    }
  }
  await expect.poll(() => Number(/clique (\d+)/.exec(b.title())?.[1] ?? 0), { message: 'o clique chegou na página de teste' }).toBe(n + 1)
  return center.x
}

type Done = { dir: string; project: Project; samples: ContentRectSample[]; videoPath: string; W: number; H: number; offsetMs: number; recordedMs: number }

/** Para a gravação e devolve o projeto processado. */
async function stopAndRead(s: Session, bar: Page): Promise<Done> {
  await bar.getByTestId('bar-stop').click()
  await expect(s.page.getByTestId('project-view')).toBeVisible({ timeout: 120_000 })
  const folders = readdirSync(s.projects)
  expect(folders).toHaveLength(1)
  const dir = join(s.projects, folders[0]!)
  if (process.env.KEEP_DIR) copyTreeSafe(dir, join(process.env.KEEP_DIR, `recorte-${browser?.pid ?? 'x'}`))
  const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(dir, 'raw/recording.json'), 'utf8')) as { recordedMs: number }
  const src = project.sources.screen!
  return {
    dir,
    project,
    samples: readJsonl<ContentRectSample>(join(dir, 'events/content-rect.jsonl')),
    videoPath: join(dir, 'media/screen.mp4'),
    W: src.w,
    H: src.h,
    offsetMs: project.sync.screenOffsetMs,
    recordedMs: manifest.recordedMs
  }
}

function copyTreeSafe(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const a = join(from, e.name)
    const b = join(to, e.name)
    if (e.isDirectory()) copyTreeSafe(a, b)
    else copyFileSync(a, b)
  }
}

/** A página como aparece PINTADA no quadro do vídeo em `tMs` (tempo da gravação). */
function paintedBox(d: Done, tMs: number): NRect & { frame: Buffer } {
  const rgb = frameRgb(d.videoPath, Math.max(0, (tMs - d.offsetMs) / 1000), d.W, d.H)
  const box = colorBox(rgb, d.W, d.H, MAGENTA)
  if (!box) throw new Error(`Não achei a página pintada no quadro de ${(tMs / 1000).toFixed(2)} s.`)
  return { ...box, frame: rgb }
}

const px = (d: Done, r: ContentRectSample | NRect): Rect => ({ x: r.x * d.W, y: r.y * d.H, w: r.w * d.W, h: r.h * d.H })

type Check = { step: CropStep; error: number; expected: Rect; painted: Rect; videoMs: number }

/** O vídeo e os eventos não têm o mesmo zero: a troca de tamanho de uma janela chega ao vídeo entre ~0,4 s ANTES e ~1,6 s DEPOIS do instante em que o rastreador a viu. */
const LEAD_MS = 600
const LAG_MS = 1600

/**
 * Precisão da página medida contra o que o vídeo MOSTRA, sem depender de o relógio do vídeo bater com o dos eventos (a janela parada
 * entrega o primeiro quadro tarde e o vídeo reage ao redimensionamento com atraso): amostra o vídeo a cada 0,3 s, acha a área
 * pintada de cada quadro e confere dois lados, com a tolerância de ±4 px:
 *  1. todo estado ESTÁVEL do vídeo (a mesma caixa em dois quadros seguidos) é uma caixa que o rastreador mediu - o vídeo nunca
 *     mostra uma página que a medida não conhece;
 *  2. todo trecho medido de pelo menos 1,5 s aparece no vídeo (dentro da janela de atraso acima) - a medida nunca descreve uma
 *     página que o vídeo não mostrou.
 */
function checkContentRect(d: Done, label: string): { checks: Check[]; states: number } {
  const steps = stabilizeContentRects(d.samples, { w: d.W, h: d.H })
  const times: number[] = []
  for (let t = 300; t < d.recordedMs - 300; t += 300) times.push(t)
  const boxes = times.map((t) => {
    try {
      return paintedBox(d, t)
    } catch {
      return null // quadro de transição sem a cor
    }
  })
  type State = { t: number; box: Rect }
  const states: State[] = []
  boxes.forEach((b, i) => {
    const next = boxes[i + 1]
    if (!b || !next || edgeError(b, next) > 1.5) return
    const last = states[states.length - 1]
    if (last && edgeError(last.box, b) <= 1.5) return // o mesmo estado, só mais um quadro
    states.push({ t: times[i]!, box: { x: b.x, y: b.y, w: b.w, h: b.h } })
  })
  expect(states.length, `${label}: o vídeo tem estados estáveis da página pintada`).toBeGreaterThan(0)

  const expectedOf = (st: CropStep): Rect => px(d, st.rect)
  for (const st of states) {
    const best = Math.min(...steps.map((x) => edgeError(expectedOf(x), st.box)))
    expect(best, `${label}: o vídeo mostra a página ${JSON.stringify(st.box)} aos ${(st.t / 1000).toFixed(1)} s e o rastreador não mediu nada assim (medidos: ${steps.map((x) => JSON.stringify(expectedOf(x))).join(' ')})`).toBeLessThanOrEqual(TOL_PX)
  }

  const checks: Check[] = []
  steps.forEach((step, i) => {
    const end = i + 1 < steps.length ? steps[i + 1]!.t : d.recordedMs
    if (end - step.t < 1500) return
    const expected = expectedOf(step)
    const inWindow = states.filter((st) => st.t >= step.t - LEAD_MS && st.t <= end + LAG_MS)
    const matches = inWindow.map((st) => ({ st, err: edgeError(expected, st.box) })).sort((a, b) => a.err - b.err)
    const best = matches[0]
    expect(best, `${label}: o trecho medido ${step.t.toFixed(0)}–${end.toFixed(0)} ms (${JSON.stringify(expected)}) aparece no vídeo`).toBeDefined()
    expect(best!.err, `${label}: trecho medido ${JSON.stringify(expected)} × pintada mais parecida ${JSON.stringify(best!.st.box)}`).toBeLessThanOrEqual(TOL_PX)
    checks.push({ step, error: best!.err, expected, painted: best!.st.box, videoMs: best!.st.t })
  })
  return { checks, states: states.length }
}

/** Eventos e documento prontos para calcular a cena (a mesma conta do editor e da exportação). */
function sceneOf(d: Done, project: Project) {
  const read = (rel: string): string | undefined => {
    try {
      return readFileSync(join(d.dir, rel), 'utf8')
    } catch {
      return undefined
    }
  }
  const events = eventsFromText({ cursor: read('events/cursor.jsonl'), clicks: read('events/clicks.jsonl'), keys: read('events/keys.jsonl'), contentRect: read('events/content-rect.jsonl') })
  return prepareEvents(events, project.sources.screen!.durationMs)
}

function savePng(video: string, atS: number, out: string): void {
  mkdirSync(SCREENS_DIR, { recursive: true })
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', atS.toFixed(3), '-i', video, '-frames:v', '1', out], { windowsHide: true })
}

async function exportBoth(s: Session, id: string): Promise<{ h: string; v: string }> {
  const h = await exportProject(s.page, id, { resolution: '1080p', fps: 30, format: 'horizontal' })
  expect(h.phase, `exportação 16:9: ${JSON.stringify(h)}`).toBe('done')
  const v = await exportProject(s.page, id, { resolution: '1080p', fps: 30, format: 'vertical' })
  expect(v.phase, `exportação vertical: ${JSON.stringify(v)}`).toBe('done')
  const files = readdirSync(join(s.projects, id, 'exports')).filter((n) => n.endsWith('.mp4'))
  const horizontal = files.find((n) => !n.includes('Vertical'))
  const vertical = files.find((n) => n.includes('Vertical'))
  expect(horizontal, 'o 16:9 saiu').toBeTruthy()
  expect(vertical, 'o vertical saiu').toBeTruthy()
  return { h: join(s.projects, id, 'exports', horizontal!), v: join(s.projects, id, 'exports', vertical!) }
}

/**
 * Exporta com o recorte ligado e com ele desligado e prova a diferença: o recorte nunca mostra pixel da interface do navegador (a
 * fração de pixels que não são da página é desprezível, no 16:9 e no vertical, em vários instantes); sem ele, a barra de abas e a de
 * endereço aparecem (a conferência não é cega).
 */
async function checkExports(s: Session, d: Done, name: string): Promise<{ withCrop: number; without: number }> {
  const id = readdirSync(s.projects)[0]!
  // instantes no MEIO dos três trechos medidos mais longos: longe das trocas de tamanho, que o vídeo mostra com atraso
  const allSteps = stabilizeContentRects(d.samples, { w: d.W, h: d.H })
  const times = allSteps
    .map((st, i) => ({ mid: (st.t + (i + 1 < allSteps.length ? allSteps[i + 1]!.t : d.recordedMs)) / 2, len: (i + 1 < allSteps.length ? allSteps[i + 1]!.t : d.recordedMs) - st.t }))
    .sort((a, b) => b.len - a.len)
    .slice(0, 3)
    .map((x) => Math.round(x.mid))
  const data = sceneOf(d, d.project)

  const measure = (video: string, vertical: boolean, proj: Project, label: string): number => {
    const F = vertical ? VERTICAL_1080 : HORIZONTAL_1080
    const derived = deriveProject(proj, data, F)
    let worst = 0
    let worstAt = times[0]!
    times.forEach((t) => {
      const scene = evaluateScene(proj, derived, t, F)
      const dest = scene.screen!.dest
      const rgb = frameRgb(video, t / 1000, F.w, F.h)
      const frac = nonPageFraction(rgb, F.w, dest)
      if (frac >= worst) {
        worst = frac
        worstAt = t
      }
    })
    // a captura que vai para o usuário é a do PIOR instante (o que mais mostra da interface do navegador)
    savePng(video, worstAt / 1000, join(SCREENS_DIR, `real-navegador-${name}-${vertical ? 'vertical' : '16x9'}-${label}.png`))
    return worst
  }

  const withCrop = await exportBoth(s, id)
  const projCrop = parseProject(readFileSync(join(d.dir, 'project.json'), 'utf8'))
  const h1 = measure(withCrop.h, false, projCrop, 'com-recorte')
  const v1 = measure(withCrop.v, true, projCrop, 'com-recorte')
  console.log(`[${name}] EXPORTAÇÃO COM recorte: pixels que não são da página — 16:9 ${(h1 * 100).toFixed(2)}%, vertical ${(v1 * 100).toFixed(2)}%`)
  expect(h1, '16:9 com recorte: nenhum pixel da barra de abas').toBeLessThan(0.02)
  expect(v1, 'vertical com recorte: nenhum pixel da barra de abas').toBeLessThan(0.02)

  // o mesmo projeto SEM recorte (o gravado pela interface, como o usuário faria em "Desligado")
  await s.page.evaluate(
    async ({ pid, text }) => {
      await window.tomada.projects.save(pid, JSON.parse(text))
    },
    { pid: id, text: JSON.stringify({ ...projCrop, screenCrop: { mode: 'off' } }) }
  )
  for (const f of readdirSync(join(s.projects, id, 'exports'))) if (f.endsWith('.mp4')) rmFile(join(s.projects, id, 'exports', f))
  const without = await exportBoth(s, id)
  const projOff = { ...projCrop, screenCrop: { mode: 'off' as const } }
  const h0 = measure(without.h, false, projOff, 'sem-recorte')
  const v0 = measure(without.v, true, projOff, 'sem-recorte')
  console.log(`[${name}] EXPORTAÇÃO SEM recorte: pixels que não são da página — 16:9 ${(h0 * 100).toFixed(2)}%, vertical ${(v0 * 100).toFixed(2)}%`)
  expect(h0, '16:9 sem recorte mostra a interface do navegador (a conferência enxerga)').toBeGreaterThan(0.06)
  expect(v0, 'vertical sem recorte mostra a interface do navegador').toBeGreaterThan(0.04)
  return { withCrop: Math.max(h1, v1), without: Math.min(h0, v0) }
}

function rmFile(p: string): void {
  execFileSync('cmd', ['/c', 'del', '/f', '/q', p.replace(/\//g, '\\')], { windowsHide: true, stdio: 'ignore' })
}

async function openAndPrepare(b: TestBrowser): Promise<{ s: Session; opened: OpenedBrowser; bar: Page }> {
  const opened = await openTestBrowser(b)
  browser = opened
  keepOnTop(opened.hwnd) // fica por cima de tudo (a janela é do teste): o clique só vale se ela estiver à vista
  const s = await launchTomada({ seed: false, realDevices: true })
  session = s
  await chooseAndRecord(s, { window: opened.hwnd })
  const bar = await waitForAux(s.app, 'bar', 40_000)
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording')
  return { s, opened, bar }
}

for (const b of BROWSERS) {
  test(`${b.name}: janela do navegador — a página é medida, o recorte automático vale e o vídeo não mostra a barra de abas`, async () => {
    test.skip(!existsSync(b.exe), `${b.name} não está instalado nesta máquina`)
    test.setTimeout(300_000)
    const { s, opened, bar } = await openAndPrepare(b)
    const frame0 = opened.frame()
    const page0 = opened.page()
    console.log(`[${b.name}] janela ${JSON.stringify(frame0)}; página ${JSON.stringify(page0)} (barra: ${page0.y - frame0.y} px acima, ${frame0.y + frame0.h - (page0.y + page0.h)} px abaixo)`)

    await sleep(2200)
    await clickButton(opened)
    await sleep(1500)

    // a janela é redimensionada no meio da gravação (mais estreita e mais baixa)
    setWindowRect(opened.hwnd, { x: frame0.x - 8, y: frame0.y, w: Math.round(frame0.w * 0.82) + 16, h: Math.round(frame0.h * 0.9) + 8 })
    await sleep(2400)
    await clickButton(opened)
    await sleep(1500)

    const d = await stopAndRead(s, bar)
    await verify(b, s, opened, d, ['resize'])
  })
}

test('chrome: DevTools acoplado, tela cheia (F11) e janela redimensionada: o retângulo acompanha', async () => {
  const b = BROWSERS[0]!
  test.skip(!existsSync(b.exe), 'chrome não está instalado nesta máquina')
  test.setTimeout(360_000)
  const { s, opened, bar } = await openAndPrepare(b)
  const frame0 = opened.frame()

  await sleep(2000)
  await clickButton(opened)
  await sleep(1200)

  // redimensiona
  setWindowRect(opened.hwnd, { x: frame0.x - 8, y: frame0.y, w: Math.round(frame0.w * 0.85) + 16, h: frame0.h + 8 })
  await sleep(2200)

  // DevTools acoplado (F12 com a janela de teste em primeiro plano)
  await pressKeyIn(opened.hwnd, VK_F12)
  await sleep(4500)
  const withTools = opened.page()
  console.log(`[chrome] com o DevTools: página ${JSON.stringify(withTools)}`)
  await pressKeyIn(opened.hwnd, VK_F12)
  await sleep(4500)

  // tela cheia (F11)
  await pressKeyIn(opened.hwnd, VK_F11)
  await sleep(4500)
  await pressKeyIn(opened.hwnd, VK_F11)
  await sleep(4500)

  const d = await stopAndRead(s, bar)
  await verify(b, s, opened, d, ['resize', 'devtools', 'fullscreen'], 1)
})

test('chrome: gravação de TELA com o navegador em primeiro plano — a página é registrada, o recorte NÃO liga sozinho e o editor oferece', async () => {
  const b = BROWSERS[0]!
  test.skip(!existsSync(b.exe), 'chrome não está instalado nesta máquina')
  test.setTimeout(300_000)
  const opened = await openTestBrowser(b)
  browser = opened
  keepOnTop(opened.hwnd)
  const s = await launchTomada({ seed: false, realDevices: true })
  session = s
  await chooseAndRecord(s, { screen: true })
  const bar = await waitForAux(s.app, 'bar', 40_000)
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording')
  const page0 = opened.page()
  console.log(`[tela] página do Chrome no início: ${JSON.stringify(page0)}`)

  await sleep(2500)
  await clickButton(opened)
  await sleep(2500)
  const d = await stopAndRead(s, bar)
  const { page } = s
  const capture = d.project.capture
  console.log(`[tela] captura: ${JSON.stringify(capture)}; quadro ${d.W}×${d.H}; gravado ${(d.recordedMs / 1000).toFixed(1)} s; páginas medidas: ${d.samples.length}`)

  // a captura de TELA registra a página do navegador à frente, mas não recorta sozinha (pode ser só mais uma janela entre outras)
  expect(capture.kind).toBe('screen')
  expect(capture.browser, 'o navegador à frente foi reconhecido').toMatchObject({ exe: b.exeName, engine: 'chromium', contentRect: true })
  expect(d.project.screenCrop, 'sem recorte automático em captura de tela').toBeUndefined()
  expect(d.samples.length).toBeGreaterThan(0)

  // a página medida (normalizada à TELA) bate com a área pintada no quadro, em cada trecho estável em que o navegador estava à frente
  const steps = stabilizeContentRects(d.samples, { w: d.W, h: d.H })
  const partial = steps.map((st, i) => ({ st, end: i + 1 < steps.length ? steps[i + 1]!.t : d.recordedMs })).filter((x) => x.st.rect.w < 0.999 || x.st.rect.h < 0.999)
  console.log(`[tela] trechos com a página medida: ${partial.map((x) => `${Math.round(x.st.t)}–${Math.round(x.end)} ms ${x.st.rect.x.toFixed(3)},${x.st.rect.y.toFixed(3)} ${x.st.rect.w.toFixed(3)}×${x.st.rect.h.toFixed(3)}`).join(' | ')}`)
  expect(partial.length, 'houve um trecho com o navegador à frente').toBeGreaterThan(0)
  const errors: number[] = []
  for (const x of partial) {
    if (x.end - x.st.t < 1200) continue
    for (const t of [x.st.t + 700, x.end - 300]) {
      if (t >= x.end || t <= x.st.t + 400) continue
      const painted = paintedBox(d, t)
      const err = edgeError(px(d, x.st.rect), painted)
      errors.push(err)
      expect(err, `tela: página medida × pintada em ${(t / 1000).toFixed(2)} s`).toBeLessThanOrEqual(TOL_PX)
    }
  }
  expect(errors.length, 'conferiu a página medida em algum instante').toBeGreaterThan(0)
  console.log(`[tela] PRECISÃO: ${errors.length} conferências; desvio máximo ${Math.max(...errors).toFixed(1)} px`)

  // o editor oferece o recorte (a página foi medida), sem ligar sozinho; ligar o Automático recorta a exportação
  await page.getByTestId('tab-style').click()
  await expect(page.getByTestId('crop-mode-off')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('crop-mode-auto')).toBeEnabled()
  await expect(page.getByTestId('crop-offer')).toBeVisible()
  mkdirSync(SCREENS_DIR, { recursive: true })
  await page.screenshot({ path: join(SCREENS_DIR, 'real-navegador-tela-editor-oferta.png') })
  const id = readdirSync(s.projects)[0]!
  const withoutCrop = await exportProject(page, id, { resolution: '1080p', fps: 30, format: 'horizontal' })
  expect(withoutCrop.phase).toBe('done')
  savePng(withoutCrop.outputPath!, partial[0]!.st.t / 1000 + 1.2, join(SCREENS_DIR, 'real-navegador-tela-16x9-sem-recorte.png'))
  const probe = Math.round(partial[0]!.st.t + 1200)
  const F = HORIZONTAL_1080
  const measure = (video: string, proj: Project): number => {
    const derived = deriveProject(proj, sceneOf(d, proj), F)
    const dest = evaluateScene(proj, derived, probe, F).screen!.dest
    return nonPageFraction(frameRgb(video, probe / 1000, F.w, F.h), F.w, dest)
  }
  const before = measure(withoutCrop.outputPath!, d.project)
  await page.getByTestId('crop-mode-auto').click()
  await expect.poll(() => parseProject(readFileSync(join(d.dir, 'project.json'), 'utf8')).screenCrop?.mode, { message: 'o recorte automático foi salvo' }).toBe('auto')
  const cropped = parseProject(readFileSync(join(d.dir, 'project.json'), 'utf8'))
  for (const f of readdirSync(join(s.projects, id, 'exports'))) if (f.endsWith('.mp4')) rmFile(join(s.projects, id, 'exports', f))
  const withCrop = await exportProject(page, id, { resolution: '1080p', fps: 30, format: 'horizontal' })
  expect(withCrop.phase).toBe('done')
  const after = measure(withCrop.outputPath!, cropped)
  savePng(withCrop.outputPath!, probe / 1000, join(SCREENS_DIR, 'real-navegador-tela-16x9-com-recorte.png'))
  console.log(`[tela] pixels que não são da página no 16:9 (a ${(probe / 1000).toFixed(1)} s): sem recorte ${(before * 100).toFixed(2)}%, com recorte ${(after * 100).toFixed(2)}%`)
  expect(before, 'sem recorte a tela inteira aparece').toBeGreaterThan(0.2)
  expect(after, 'com o Automático ligado só a página aparece').toBeLessThan(0.02)
})

/** As conferências comuns depois de parar a gravação. */
async function verify(b: TestBrowser, s: Session, opened: OpenedBrowser, d: Done, expectedChanges: string[], buttonClicks = 2): Promise<void> {
  const name = b.name + (expectedChanges.includes('devtools') ? '-devtools' : '')
  const capture = d.project.capture
  console.log(`[${name}] captura: ${JSON.stringify(capture)}; quadro ${d.W}×${d.H}; gravado ${(d.recordedMs / 1000).toFixed(1)} s; páginas medidas: ${d.samples.length}`)
  void opened

  // o documento: recorte automático ligado e o navegador reconhecido
  expect(capture.kind).toBe('window')
  expect(capture.browser, 'o navegador foi reconhecido').toMatchObject({ exe: b.exeName, engine: 'chromium', contentRect: true })
  expect(d.project.screenCrop).toMatchObject({ mode: 'auto' })
  expect(d.samples.length).toBeGreaterThan(0)

  // a página medida × a área pintada no quadro (±4 px), em cada trecho estável
  const { checks, states } = checkContentRect(d, name)
  const worst = Math.max(...checks.map((c) => c.error))
  console.log(
    `[${name}] PRECISÃO: ${checks.length} trechos medidos achados no vídeo e ${states} estados estáveis do vídeo conferidos; desvio máximo ${worst.toFixed(1)} px, médio ${(checks.reduce((a, c) => a + c.error, 0) / checks.length).toFixed(2)} px`
  )
  const steps = stabilizeContentRects(d.samples, { w: d.W, h: d.H })
  console.log(`[${name}] trechos da página (ms → caixa normalizada): ${steps.map((st) => `${Math.round(st.t)}: ${st.rect.x.toFixed(3)},${st.rect.y.toFixed(3)} ${st.rect.w.toFixed(3)}×${st.rect.h.toFixed(3)}`).join(' | ')}`)
  expect(steps.length, 'a página mudou de lugar/tamanho e o rastreador acompanhou').toBeGreaterThanOrEqual(expectedChanges.length + 1)

  // os cliques (a coordenada está no espaço da tela gravada): todos caem DENTRO da página pintada e pelo menos dois sobre o botão ciano
  const clicks = readJsonl<{ t: number; x: number; y: number; out?: boolean }>(join(d.dir, 'events/clicks.jsonl'))
  const real = clicks.filter((c) => !c.out)
  expect(real.length).toBeGreaterThanOrEqual(2)
  let onButton = 0
  for (const c of real) {
    const tShot = c.t + 400
    const rgb = frameRgb(d.videoPath, Math.max(0, (tShot - d.offsetMs) / 1000), d.W, d.H)
    const cx = c.x * d.W
    const cy = c.y * d.H
    const pageBox = colorBox(rgb, d.W, d.H, MAGENTA)
    expect(pageBox, `a página pintada aparece no quadro do clique em ${(c.t / 1000).toFixed(2)} s`).not.toBeNull()
    expect(cx >= pageBox!.x - 6 && cx <= pageBox!.x + pageBox!.w + 6 && cy >= pageBox!.y - 6 && cy <= pageBox!.y + pageBox!.h + 6, `clique ${JSON.stringify([cx, cy])} fora da página ${JSON.stringify(pageBox)}`).toBe(true)
    const found = findColorBox(rgb, d.W, { x: 0, y: 0, w: d.W, h: d.H }, hex('#00ffff'), 60)
    if (found) {
      const bb = found.box
      if (cx >= bb.x - 6 && cx <= bb.x + bb.w + 6 && cy >= bb.y - 6 && cy <= bb.y + bb.h + 6) onButton++
    }
  }
  expect(onButton, 'os cliques no botão ciano foram registrados sobre o botão no quadro').toBeGreaterThanOrEqual(buttonClicks)

  // o recorte que o editor e a exportação usam: dentro da área pintada, em todos os instantes conferidos
  const tl = resolveScreenCrop(d.project.screenCrop, d.samples, { w: d.W, h: d.H })
  expect(tl, 'o recorte automático existe').not.toBeNull()
  for (const c of checks) {
    const eff = px(d, tl!.at(c.step.t + 700)) // depois da rampa de 200 ms do trecho
    expect(eff.x, `recorte efetivo dentro da página no trecho de ${c.step.t.toFixed(0)} ms`).toBeGreaterThanOrEqual(c.painted.x - TOL_PX)
    expect(eff.y).toBeGreaterThanOrEqual(c.painted.y - TOL_PX)
    expect(eff.x + eff.w).toBeLessThanOrEqual(c.painted.x + c.painted.w + TOL_PX)
    expect(eff.y + eff.h).toBeLessThanOrEqual(c.painted.y + c.painted.h + TOL_PX)
  }

  // a folha de contato do vídeo gravado e as capturas antes/depois
  mkdirSync(SCREENS_DIR, { recursive: true })
  execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'contact-sheet.mjs'), d.videoPath, join(SCREENS_DIR, `real-navegador-${name}-gravado.png`), '4', '3', '480'], { stdio: 'inherit' })

  await checkExports(s, d, name)
}

