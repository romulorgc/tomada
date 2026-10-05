/**
 * CAPTURA REAL (`npm run test:real`). O Tomada grava uma janela de teste (e depois a tela
 * inteira) enquanto este teste move o mouse e CLICA DE VERDADE com SendInput.
 *
 * Segurança: o único clique permitido é dentro da janela de teste, e antes de cada um a
 * janela em primeiro plano é conferida (`safeClick`); se não for a de teste, o teste aborta
 * sem clicar. No fim, o cursor volta ao centro da tela principal.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { parseProject } from '../../src/shared/project'
import { auxPage, launchTomada, SCREENS_DIR, waitForAux, type Session } from '../e2e/helpers'
import { copyTree, ROOT } from '../helpers/fs'
import {
  averageColorPerFrame,
  countOffColor,
  dist,
  findColorBox,
  frameRgb,
  hex,
  saveCropPng,
  type Box,
  type Rgb
} from './frames'
import {
  activateByClick,
  clientRect,
  foregroundHwnd,
  frameRect,
  monitorCount,
  monitorRectOfWindow,
  moveSmooth,
  parkCursorAtPrimaryCenter,
  primaryMonitorRect,
  safeClick,
  type Pt,
  type Rect
} from './win-input'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Layout = {
  dpr: number
  viewport: { w: number; h: number }
  buttons: Record<'A' | 'B' | 'C' | 'D', { cx: number; cy: number; w: number; h: number }>
  palette: string[]
}
type Target = { app: ElectronApplication; page: Page; hwnd: number; layout: Layout }
type Performed = { kind: 'activate' | 'button'; id?: 'A' | 'B' | 'C' | 'D'; point: Pt; ordinal?: number }
type ClickLine = { t: number; x: number; y: number; button: string; upT?: number; out?: boolean }

const BUTTON_COLORS: Record<'A' | 'B' | 'C' | 'D', string> = { A: '#ff00ff', B: '#00ffff', C: '#ffff00', D: '#80ff00' }
const SEQUENCE: ('A' | 'B' | 'C' | 'D')[] = ['A', 'B', 'C', 'D', 'A', 'C']

let session: Session | undefined
let target: Target | undefined

async function startTarget(display: 'primary' | 'secondary'): Promise<Target> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env.TARGET_DISPLAY = display
  const app = await electron.launch({ args: [join(ROOT, 'tests', 'real', 'target-app', 'main.cjs')], cwd: ROOT, env })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const hwnd = await app.evaluate(({ BrowserWindow }) => {
    const b = BrowserWindow.getAllWindows()[0]!.getNativeWindowHandle()
    return Number(b.readBigUInt64LE(0))
  })
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __layout?: unknown }).__layout)).toBe('function')
  const layout = (await page.evaluate(() => (window as unknown as { __layout: () => Layout }).__layout())) as Layout
  await sleep(1200) // deixa a janela assentar na posição final (e no tamanho final, em monitor de DPI diferente)
  return { app, page, hwnd, layout }
}

test.afterEach(async () => {
  try {
    if (session) {
      const problems = session.problems
      await session.close()
      session = undefined
      expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
    }
  } finally {
    await target?.app.close().catch(() => undefined)
    target = undefined
    // Devolve o cursor ao centro da tela principal, aconteça o que acontecer.
    parkCursorAtPrimaryCenter(primaryMonitorRect())
  }
})

function buttonPoint(t: Target, id: 'A' | 'B' | 'C' | 'D'): Pt {
  const c = clientRect(t.hwnd)
  const b = t.layout.buttons[id]
  return { x: Math.round(c.x + b.cx * t.layout.dpr), y: Math.round(c.y + b.cy * t.layout.dpr) }
}

type Mode = 'window' | 'screen'

async function selectSourceAndRecord(s: Session, t: Target, mode: Mode, screenIndex: number): Promise<void> {
  const { page } = s
  await page.getByTestId('nav-record').click()
  await expect(page.getByTestId('source-card').first()).toBeVisible()
  await page.getByTestId('mode-screen').click()
  // Espera a escolha automática de microfone da primeira abertura e então desliga o microfone.
  await expect(page.getByTestId('mic-select')).not.toHaveValue('')
  await page.getByTestId('mic-select').selectOption('')
  await expect(page.getByTestId('mic-select')).toHaveValue('')
  if (mode === 'window') {
    await page.getByTestId('source-tab-windows').click()
    const card = page.locator(`[data-testid="source-card"][data-source-id="window:${t.hwnd}:0"]`)
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.click()
    await expect(card).toHaveAttribute('aria-pressed', 'true')
  } else {
    await page.getByTestId('source-tab-screens').click()
    const card = page.locator('[data-testid="source-card"][data-kind="screen"]').nth(screenIndex)
    await expect(card).toBeVisible()
    await card.click()
    await expect(card).toHaveAttribute('aria-pressed', 'true')
  }
  await page.getByTestId('record-start').click()
}

async function choreograph(t: Target, wait: () => Promise<void>): Promise<Performed[]> {
  const performed: Performed[] = []
  // O DPI da janela pode mudar depois de ela assentar no monitor (monitor com escala diferente): relê.
  t.layout = (await t.page.evaluate(() => (window as unknown as { __layout: () => Layout }).__layout())) as Layout
  const c = clientRect(t.hwnd)
  console.log(`[alvo] hwnd ${t.hwnd} dpr ${t.layout.dpr} cliente ${JSON.stringify(c)} moldura ${JSON.stringify(frameRect(t.hwnd))} monitor ${JSON.stringify(monitorRectOfWindow(t.hwnd))}`)
  const neutral: Pt = { x: Math.round(c.x + 30 * t.layout.dpr), y: Math.round(c.y + 30 * t.layout.dpr) }
  await wait()
  const clicked = await activateByClick(t.hwnd, neutral)
  if (clicked) performed.push({ kind: 'activate', point: neutral })
  await sleep(500)
  let ordinal = 0
  for (const id of SEQUENCE) {
    const p = buttonPoint(t, id)
    console.log(`[alvo] indo para o botão ${id} em (${p.x}, ${p.y})`)
    await moveSmooth(p, 700)
    await sleep(150)
    await safeClick(t.hwnd) // confere primeiro plano e janela sob o cursor; senão lança sem clicar
    ordinal++
    performed.push({ kind: 'button', id, point: p, ordinal })
    await sleep(900) // o cursor fica sobre o botão: dá tempo do quadro registrar a cor e o cursor
  }
  await sleep(400)
  return performed
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T)
}

type Deviation = { n: number; id: string; clickT: number; frameT: number; dev: number }

async function scenario(name: string, mode: Mode, display: 'primary' | 'secondary', screenIndex: number): Promise<void> {
  const t = await startTarget(display)
  target = t
  const mon = monitorRectOfWindow(t.hwnd)
  // Dispositivos REAIS: com as flags de dispositivo falso o Chromium também FALSIFICA a captura de tela
  // (entrega um quadro verde gerado). Aqui o microfone fica desligado e não há câmera (modo "só a tela").
  const s = await launchTomada({ seed: false, realDevices: true })
  session = s
  const { app: tomada, page } = s

  await selectSourceAndRecord(s, t, mode, screenIndex)
  const bar = await waitForAux(tomada, 'bar', 40_000)
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording')

  let barBounds: Rect | null = null
  const performed = await choreograph(t, async () => {
    barBounds = await tomada.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('#bar'))
      if (!w) return null
      const r = screen.dipToScreenRect(null, w.getBounds())
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })
  })

  // Confere que a janela de teste registrou os cliques que mandamos (e só eles).
  const pageClicks = (await t.page.evaluate(() => (window as unknown as { __clicks: { n: number; id: string; color: string; at: number }[] }).__clicks)) as { n: number; id: string; color: string; at: number }[]
  expect(pageClicks.map((c) => c.id)).toEqual(SEQUENCE)

  await bar.getByTestId('bar-stop').click()
  await expect(page.getByTestId('project-view')).toBeVisible({ timeout: 120_000 })

  // ---------------------------------------------------------------------------------
  const appLog = readdirSync(join(s.userData, 'logs'))
    .map((f) => readFileSync(join(s.userData, 'logs', f), 'utf8'))
    .join('\n')
  const interesting = appLog.split('\n').filter((l) => /Janela "|Tela "|Gravando|Início|Rastreador|Eventos salvos|preparada|difere|mudou/.test(l))
  console.log(`[${name}] log do app:\n${interesting.map((l) => `  ${l.slice(0, 400)}`).join('\n')}`)
  const folders = readdirSync(s.projects)
  expect(folders).toHaveLength(1)
  const dir = join(s.projects, folders[0]!)
  // KEEP_DIR=<pasta>: guarda uma cópia da gravação para olhar depois (depuração).
  if (process.env.KEEP_DIR) copyTree(dir, join(process.env.KEEP_DIR, name))
  const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(dir, 'raw/recording.json'), 'utf8')) as { clock: { t0: number }; recordedMs: number }
  const screenSrc = project.sources.screen!
  const capture = project.capture
  const frame = capture.frameSize!
  const dpr = t.layout.dpr
  const client = clientRect(t.hwnd)

  const clicks = readJsonl<ClickLine>(join(dir, 'events/clicks.jsonl'))
  const cursor = readJsonl<{ t: number; x: number; y: number; out?: boolean }>(join(dir, 'events/cursor.jsonl'))
  console.log(`[${name}] captura: ${JSON.stringify(capture)}; quadro ${screenSrc.w}×${screenSrc.h} @ ${screenSrc.fps}; cliques ${clicks.length}; cursor ${cursor.length}; dur ${(manifest.recordedMs / 1000).toFixed(2)} s; sync ${JSON.stringify(project.sync)}`)

  // Origem e tamanho da área que o quadro mostra (em px físicos), calculados POR FORA do app.
  // Janela de OUTRO programa: o quadro é a moldura inteira (com barra de título); tela: o monitor.
  const area: Rect = mode === 'screen' ? mon : frameRect(t.hwnd)
  expect(capture.kind).toBe(mode === 'window' ? 'window' : 'screen')
  expect(Math.abs(frame.w - area.w)).toBeLessThanOrEqual(2)
  expect(Math.abs(frame.h - area.h)).toBeLessThanOrEqual(2)
  if (mode === 'screen') {
    expect(capture.boundsPx).toEqual(mon) // o app e o Win32 concordam sobre o monitor
  }

  // (a) cliques em clicks.jsonl a ±0,02 dos centros esperados (na ordem em que foram feitos)
  expect(clicks.length).toBe(performed.length)
  const deviations: Deviation[] = []
  const clickReport: string[] = []
  performed.forEach((p, i) => {
    const got = clicks[i]!
    const ex = { x: (p.point.x - area.x) / area.w, y: (p.point.y - area.y) / area.h }
    clickReport.push(`${p.kind === 'button' ? p.id : 'neutro'}: esperado (${ex.x.toFixed(4)}, ${ex.y.toFixed(4)}) obtido (${got.x}, ${got.y})`)
    expect(Math.abs(got.x - ex.x), `x do clique ${i}`).toBeLessThanOrEqual(0.02)
    expect(Math.abs(got.y - ex.y), `y do clique ${i}`).toBeLessThanOrEqual(0.02)
    expect(got.button).toBe('left')
    expect(got.out).toBeFalsy()
    expect(got.upT).toBeGreaterThan(got.t)
  })
  console.log(`[${name}] cliques:\n  ${clickReport.join('\n  ')}`)

  // Tempo do clique do rastreador × tempo do mousedown visto pela própria janela de teste (mesmo relógio de parede).
  const trackerLatency = pageClicks.map((pc, i) => {
    const buttonClicks = clicks.filter((_, k) => performed[k]!.kind === 'button')
    return buttonClicks[i]!.t + manifest.clock.t0 - pc.at
  })
  console.log(`[${name}] rastreador − mousedown da janela (ms): ${trackerLatency.map((v) => v.toFixed(1)).join(', ')}`)

  // (b) sincronia: primeiro quadro com a cor nova vs. tempo do clique
  const patchCss = { x: 820, y: 60, w: 50, h: 50 } // fundo liso, longe dos botões e do contador
  const ox = client.x - area.x // onde a área de cliente começa DENTRO do quadro
  const oy = client.y - area.y
  const patch: Box = { x: Math.round(ox + patchCss.x * dpr), y: Math.round(oy + patchCss.y * dpr), w: Math.round(patchCss.w * dpr), h: Math.round(patchCss.h * dpr) }
  const colors = averageColorPerFrame(join(dir, 'media/screen.mp4'), patch)
  const palette = t.layout.palette.map(hex)
  let searchFrom = 0
  const buttonClickLines = clicks.filter((_, k) => performed[k]!.kind === 'button')
  buttonClickLines.forEach((c, k) => {
    const want: Rgb = palette[k % palette.length]!
    let idx = -1
    for (let i = searchFrom; i < colors.length; i++) {
      if (dist(colors[i]!, want) < 40) {
        idx = i
        break
      }
    }
    expect(idx, `não achei o quadro com a cor do clique ${k + 1} (${t.layout.palette[k % palette.length]})`).toBeGreaterThanOrEqual(0)
    searchFrom = idx
    const frameT = (idx / screenSrc.fps) * 1000 + project.sync.screenOffsetMs
    deviations.push({ n: k + 1, id: performed.filter((p) => p.kind === 'button')[k]!.id!, clickT: c.t, frameT, dev: frameT - c.t })
  })
  console.log(`[${name}] SINCRONIA clique → primeiro quadro com a cor nova (ms): ${deviations.map((d) => `${d.id}${d.n}: ${d.dev.toFixed(0)}`).join(' | ')}`)
  console.log(`[${name}] sync.screenOffsetMs=${project.sync.screenOffsetMs} cameraOffsetMs=${project.sync.cameraOffsetMs}`)

  // (c) a coordenada normalizada × tamanho do quadro cai sobre o botão no quadro (achado pela cor)
  const videoPath = join(dir, 'media/screen.mp4')
  const clientInFrame: Box = { x: Math.max(0, Math.round(ox)), y: Math.max(0, Math.round(oy)), w: Math.min(frame.w, Math.round(client.w)), h: Math.min(frame.h, Math.round(client.h)) }
  buttonClickLines.forEach((c, k) => {
    const p = performed.filter((q) => q.kind === 'button')[k]!
    const atS = (c.t - project.sync.screenOffsetMs + 450) / 1000
    const rgb = frameRgb(videoPath, atS, screenSrc.w, screenSrc.h)
    const found = findColorBox(rgb, screenSrc.w, clientInFrame, hex(BUTTON_COLORS[p.id!]), 28)
    expect(found, `botão ${p.id} não aparece no quadro em ${atS.toFixed(2)} s`).not.toBeNull()
    const px = c.x * frame.w
    const py = c.y * frame.h
    const b = found!.box
    const inside = px >= b.x - 3 && px <= b.x + b.w + 3 && py >= b.y - 3 && py <= b.y + b.h + 3
    expect(inside, `clique ${k + 1} (${px.toFixed(0)}, ${py.toFixed(0)}) fora do botão ${p.id} no quadro ${JSON.stringify(b)}`).toBe(true)
  })
  console.log(`[${name}] os ${buttonClickLines.length} cliques caem sobre o botão certo no quadro (achado pela cor)`)

  // Cursor do sistema: presente ou ausente no vídeo? (recorte ao redor do clique C, ampliado)
  const probeClick = buttonClickLines[2]!
  const probePerf = performed.filter((q) => q.kind === 'button')[2]!
  const probeAt = (probeClick.t - project.sync.screenOffsetMs + 450) / 1000
  const hot: Box = { x: Math.round(probeClick.x * frame.w) - 6, y: Math.round(probeClick.y * frame.h) - 6, w: 40, h: 40 }
  const probeRgb = frameRgb(videoPath, probeAt, screenSrc.w, screenSrc.h)
  const offColor = countOffColor(probeRgb, screenSrc.w, hot, hex(BUTTON_COLORS[probePerf.id!]), 60)
  console.log(`[${name}] CURSOR no vídeo: ${offColor} pixels fogem da cor do botão num recorte de 40×40 sobre o ponto do clique (cursorHidden=${capture.cursorHidden})`)
  mkdirSync(SCREENS_DIR, { recursive: true })
  saveCropPng(videoPath, probeAt, hot, 8, join(SCREENS_DIR, `real-${name}-cursor.png`))
  // Medido: o Chromium do Electron 40 ignora `cursor: 'never'` (tela e janela): o cursor real vai no vídeo.
  expect(capture.cursorHidden).toBe(false)
  expect(project.style.cursor.mode).toBe('real')
  expect(offColor, 'o cursor real tem de aparecer no quadro').toBeGreaterThan(12)

  // A barra flutuante NÃO aparece na captura de tela (setContentProtection).
  if (mode === 'screen' && barBounds) {
    const bb = barBounds as Rect
    const midS = (manifest.recordedMs / 2 - project.sync.screenOffsetMs) / 1000
    const rgbMid = frameRgb(videoPath, midS, screenSrc.w, screenSrc.h)
    const region: Box = { x: Math.max(0, bb.x - mon.x), y: Math.max(0, bb.y - mon.y), w: bb.w, h: bb.h }
    const recBtn = findColorBox(rgbMid, screenSrc.w, region, hex('#ff6a3c'), 24)
    console.log(`[${name}] barra flutuante em (${region.x}, ${region.y}, ${region.w}×${region.h}) no quadro: pixels do botão vermelho = ${recBtn?.count ?? 0}`)
    expect(recBtn?.count ?? 0, 'a barra flutuante apareceu na captura (setContentProtection falhou)').toBeLessThan(30)
    saveCropPng(videoPath, midS, region, 1, join(SCREENS_DIR, `real-${name}-regiao-da-barra.png`))
  }

  // Folha de contato e cópia do quadro
  // (o Playwright carrega .ts como CommonJS e não importa .mjs: roda o script como processo)
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'contact-sheet.mjs'), videoPath, join(SCREENS_DIR, `real-${name}-folha-de-contato.png`), '4', '3', '480'], { stdio: 'inherit' })
  copyFileSync(join(dir, 'media/thumb.jpg'), join(SCREENS_DIR, `real-${name}-miniatura.jpg`))

  // Resultado numérico para o relatório
  const devs = deviations.map((d) => d.dev)
  console.log(`[${name}] RESUMO sincronia: min ${Math.min(...devs).toFixed(0)} ms, máx ${Math.max(...devs).toFixed(0)} ms, média ${(devs.reduce((a, b) => a + b, 0) / devs.length).toFixed(0)} ms`)
  for (const d of deviations) {
    expect(d.dev, `desvio do clique ${d.n} (${d.id})`).toBeGreaterThanOrEqual(0)
    expect(d.dev, `desvio do clique ${d.n} (${d.id})`).toBeLessThanOrEqual(150)
  }

  // Log do rastreador
  const logFile = readdirSync(join(s.userData, 'logs')).map((f) => join(s.userData, 'logs', f))[0]!
  const log = readFileSync(logFile, 'utf8')
  const line = log.split('\n').find((l) => l.includes('Rastreador:'))
  console.log(`[${name}] ${line ? line.slice(line.indexOf('Rastreador:')) : 'sem linha do rastreador no log'}`)
}

test('captura real: JANELA de teste (cliques, sincronia, cursor ausente, botões no quadro)', async () => {
  await scenario('janela', 'window', 'primary', 0)
})

test('captura real: TELA principal (125%): coordenada normalizada × quadro cai sobre o botão', async () => {
  await scenario('tela-principal', 'screen', 'primary', 0)
})

test('captura real: TELA secundária (DPI misto, monitor acima da principal)', async () => {
  test.skip(monitorCount() < 2, 'esta máquina não tem segundo monitor')
  await scenario('tela-secundaria', 'screen', 'secondary', 1)
})

// ---------------------------------------------------------------------------------------
// Pausa e janela fechada, com cliques de verdade

type Step = { kind: 'activate' | 'button'; id?: 'A' | 'B' | 'C' | 'D'; point: Pt; paused: boolean }

/** Abre a janela de teste e o Tomada, escolhe a janela e grava; devolve tudo pronto para a coreografia. */
async function startWindowRecording(): Promise<{ t: Target; s: Session; bar: Page }> {
  const t = await startTarget('primary')
  target = t
  const s = await launchTomada({ seed: false, realDevices: true })
  session = s
  await selectSourceAndRecord(s, t, 'window', 0)
  const bar = await waitForAux(s.app, 'bar', 40_000)
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording')
  // O DPI da janela pode mudar depois de ela assentar: relê o layout.
  t.layout = (await t.page.evaluate(() => (window as unknown as { __layout: () => Layout }).__layout())) as Layout
  return { t, s, bar }
}

/** Clique de verdade num botão da janela de teste; reativa a janela (clique neutro) se o foco saiu dela. */
async function pressButton(t: Target, id: 'A' | 'B' | 'C' | 'D', steps: Step[], paused: boolean): Promise<void> {
  if (foregroundHwnd() !== t.hwnd) {
    const c = clientRect(t.hwnd)
    const neutral: Pt = { x: Math.round(c.x + 30 * t.layout.dpr), y: Math.round(c.y + 30 * t.layout.dpr) }
    if (await activateByClick(t.hwnd, neutral)) steps.push({ kind: 'activate', point: neutral, paused })
    await sleep(300)
  }
  const p = buttonPoint(t, id)
  await moveSmooth(p, 600)
  await sleep(150)
  await safeClick(t.hwnd)
  steps.push({ kind: 'button', id, point: p, paused })
  await sleep(900)
}

function durationOf(file: string): number {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' }).trim())
}

test('captura real: pausa no meio (o clique dado durante a pausa some; o vídeo e a linha do tempo seguem coerentes)', async () => {
  test.setTimeout(240_000)
  const { t, s, bar } = await startWindowRecording()
  const { page } = s
  const steps: Step[] = []
  await sleep(1500)
  const c0 = clientRect(t.hwnd)
  const neutral: Pt = { x: Math.round(c0.x + 30 * t.layout.dpr), y: Math.round(c0.y + 30 * t.layout.dpr) }
  if (await activateByClick(t.hwnd, neutral)) steps.push({ kind: 'activate', point: neutral, paused: false })
  await sleep(500)

  await pressButton(t, 'A', steps, false)
  await pressButton(t, 'B', steps, false)

  await bar.getByTestId('bar-pause').click()
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'paused')
  await sleep(600)
  await pressButton(t, 'C', steps, true) // clique DENTRO da pausa: não pode virar evento
  await sleep(600)
  await bar.getByTestId('bar-pause').click()
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording')
  await sleep(500)

  await pressButton(t, 'D', steps, false)
  await pressButton(t, 'A', steps, false)
  await sleep(400)

  const pageClicks = (await t.page.evaluate(() => (window as unknown as { __clicks: { n: number; id: string; color: string; at: number }[] }).__clicks)) as { n: number; id: string; color: string; at: number }[]
  expect(pageClicks.map((x) => x.id)).toEqual(['A', 'B', 'C', 'D', 'A'])

  await bar.getByTestId('bar-stop').click()
  await expect(page.getByTestId('project-view')).toBeVisible({ timeout: 120_000 })

  const dir = join(s.projects, readdirSync(s.projects)[0]!)
  if (process.env.KEEP_DIR) copyTree(dir, join(process.env.KEEP_DIR, 'pausa'))
  const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(dir, 'raw/recording.json'), 'utf8')) as { recordedMs: number; pauses: { start: number; end: number }[]; endedAt: number; clock: { t0: number } }
  const clicks = readJsonl<ClickLine>(join(dir, 'events/clicks.jsonl'))
  const cursor = readJsonl<{ t: number }>(join(dir, 'events/cursor.jsonl'))
  const kept = steps.filter((x) => !x.paused)
  expect(steps.filter((x) => x.paused && x.kind === 'button')).toHaveLength(1)

  // Uma pausa, do tamanho que provocamos (cerca de 3 s), e o tempo gravado desconta essa pausa.
  expect(manifest.pauses).toHaveLength(1)
  const pausedMs = manifest.pauses[0]!.end - manifest.pauses[0]!.start
  const wallMs = manifest.endedAt - manifest.clock.t0
  console.log(`[pausa] pausa ${pausedMs.toFixed(0)} ms; relógio total ${wallMs.toFixed(0)} ms; gravado ${manifest.recordedMs.toFixed(0)} ms; cliques ${clicks.length} de ${steps.length} feitos`)
  expect(pausedMs).toBeGreaterThan(2200)
  expect(pausedMs).toBeLessThan(5000)
  expect(Math.abs(wallMs - pausedMs - manifest.recordedMs)).toBeLessThan(5)

  // Os eventos da pausa não existem: um clique a menos, na ordem certa e nos pontos certos.
  const frameBox = frameRect(t.hwnd)
  expect(clicks.length).toBe(kept.length)
  kept.forEach((p, i) => {
    const ex = { x: (p.point.x - frameBox.x) / frameBox.w, y: (p.point.y - frameBox.y) / frameBox.h }
    expect(Math.abs(clicks[i]!.x - ex.x), `x do clique ${i}`).toBeLessThanOrEqual(0.02)
    expect(Math.abs(clicks[i]!.y - ex.y), `y do clique ${i}`).toBeLessThanOrEqual(0.02)
    expect(clicks[i]!.t).toBeLessThanOrEqual(manifest.recordedMs + 50)
  })
  for (let i = 1; i < clicks.length; i++) expect(clicks[i]!.t).toBeGreaterThan(clicks[i - 1]!.t)

  // O cursor segue contínuo na linha do tempo gravada: a pausa foi descontada, não virou buraco.
  let maxGap = 0
  for (let i = 1; i < cursor.length; i++) maxGap = Math.max(maxGap, cursor[i]!.t - cursor[i - 1]!.t)
  console.log(`[pausa] cursor: ${cursor.length} amostras; maior intervalo ${maxGap.toFixed(1)} ms; último t ${cursor[cursor.length - 1]!.t}`)
  expect(maxGap).toBeLessThan(150)
  expect(cursor[cursor.length - 1]!.t).toBeLessThan(manifest.recordedMs + 100)

  // O vídeo não tem a pausa: a duração bate com o tempo gravado, e as cores mudam no instante dos cliques que ficaram.
  const videoPath = join(dir, 'media/screen.mp4')
  const durationS = durationOf(videoPath)
  console.log(`[pausa] vídeo ${durationS.toFixed(2)} s × gravado ${(manifest.recordedMs / 1000).toFixed(2)} s`)
  expect(Math.abs(durationS - manifest.recordedMs / 1000)).toBeLessThan(0.5)

  const client = clientRect(t.hwnd)
  const screenSrc = project.sources.screen!
  const ox = client.x - frameBox.x
  const oy = client.y - frameBox.y
  const dpr = t.layout.dpr
  const patch: Box = { x: Math.round(ox + 820 * dpr), y: Math.round(oy + 60 * dpr), w: Math.round(50 * dpr), h: Math.round(50 * dpr) }
  const colors = averageColorPerFrame(videoPath, patch)
  const keptPageClicks = pageClicks.filter((_, i) => i !== 2) // sem o clique C (dado na pausa)
  const buttonKept = clicks.filter((_, i) => kept[i]!.kind === 'button')
  let searchFrom = 0
  const devs: number[] = []
  buttonKept.forEach((c, k) => {
    const want = hex(keptPageClicks[k]!.color)
    let idx = -1
    for (let i = searchFrom; i < colors.length; i++) {
      if (dist(colors[i]!, want) < 40) {
        idx = i
        break
      }
    }
    expect(idx, `não achei o quadro com a cor do clique ${k + 1} (${keptPageClicks[k]!.color})`).toBeGreaterThanOrEqual(0)
    searchFrom = idx
    devs.push((idx / screenSrc.fps) * 1000 + project.sync.screenOffsetMs - c.t)
  })
  console.log(`[pausa] SINCRONIA clique → quadro (ms), antes e depois da pausa: ${devs.map((d) => d.toFixed(0)).join(' | ')}`)
  for (const d of devs) {
    expect(d).toBeGreaterThanOrEqual(0)
    expect(d).toBeLessThanOrEqual(150)
  }
})

test('captura real: a janela gravada fecha no meio (a gravação para sozinha, salva até ali e avisa)', async () => {
  test.setTimeout(240_000)
  const { t, s } = await startWindowRecording()
  const { page, app } = s
  const steps: Step[] = []
  await sleep(1500)
  const c0 = clientRect(t.hwnd)
  const neutral: Pt = { x: Math.round(c0.x + 30 * t.layout.dpr), y: Math.round(c0.y + 30 * t.layout.dpr) }
  if (await activateByClick(t.hwnd, neutral)) steps.push({ kind: 'activate', point: neutral, paused: false })
  await sleep(500)
  await pressButton(t, 'A', steps, false)
  await pressButton(t, 'B', steps, false)

  const areaBefore = frameRect(t.hwnd)
  await t.app.close() // a janela gravada some
  await expect(page.getByText('A tela ou janela gravada fechou', { exact: false }).first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('project-view')).toBeVisible({ timeout: 120_000 })
  await expect.poll(() => auxPage(app, 'bar'), { timeout: 10_000 }).toBeUndefined()

  const dir = join(s.projects, readdirSync(s.projects)[0]!)
  if (process.env.KEEP_DIR) copyTree(dir, join(process.env.KEEP_DIR, 'janela-fechada'))
  const manifest = JSON.parse(readFileSync(join(dir, 'raw/recording.json'), 'utf8')) as { recordedMs: number; stopReason: string; notes: string[] }
  const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
  const clicks = readJsonl<ClickLine>(join(dir, 'events/clicks.jsonl'))
  console.log(`[janela-fechada] motivo ${manifest.stopReason}; gravado ${(manifest.recordedMs / 1000).toFixed(2)} s; cliques ${clicks.length}; avisos ${JSON.stringify(manifest.notes)}`)
  expect(manifest.stopReason).toBe('source-ended')
  expect(clicks.length).toBe(steps.length)
  expect(project.sources.screen?.path).toBe('media/screen.mp4')
  expect(project.capture.kind).toBe('window')
  // O que foi gravado até o fechamento está inteiro e o vídeo tem a duração do que foi gravado.
  const durationS = durationOf(join(dir, 'media/screen.mp4'))
  expect(manifest.recordedMs).toBeGreaterThan(5000)
  expect(Math.abs(durationS - manifest.recordedMs / 1000)).toBeLessThan(0.6)
  // O quadro continua com o tamanho da moldura que existia.
  expect(Math.abs(project.capture.frameSize!.w - areaBefore.w)).toBeLessThanOrEqual(2)
  expect(Math.abs(project.capture.frameSize!.h - areaBefore.h)).toBeLessThanOrEqual(2)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))?.isMinimized() ?? null)).toBe(false)
})
