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
import { CROP_GUARD_MS, isFullRect, resolveScreenCrop, stabilizeContentRects, type CropStep, type CropTimeline } from '../../src/shared/crop'
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
    if (e.name.startsWith('.tmp')) continue // pastas temporárias do app, que somem enquanto se copia
    const a = join(from, e.name)
    const b = join(to, e.name)
    try {
      if (e.isDirectory()) copyTreeSafe(a, b)
      else copyFileSync(a, b)
    } catch {
      // o arquivo sumiu no meio da cópia (o app limpando): é só depuração
    }
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
  const allSteps = stabilizeContentRects(d.samples, { w: d.W, h: d.H })
  const fullWindows = fullFrameWindows(d)
  const steps = allSteps.filter((st, i) => i === 0 || !isFullStep(d, st)) // a tela cheia fica de fora (ver isFullStep)
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
  // um ESTADO do vídeo é uma caixa que se mantém por pelo menos MIN_STATE_FRAMES quadros seguidos: a animação do F11 passa por
  // tamanhos que duram menos que isso e que ninguém mede
  let runStart = 0
  for (let i = 1; i <= boxes.length; i++) {
    const a = boxes[runStart]
    const b = boxes[i]
    if (a && b && edgeError(a, b) <= 1.5) continue
    if (a && i - runStart >= MIN_STATE_FRAMES) states.push({ t: times[runStart]!, box: { x: a.x, y: a.y, w: a.w, h: a.h } })
    runStart = i
  }
  expect(states.length, `${label}: o vídeo tem estados estáveis da página pintada`).toBeGreaterThan(0)

  const expectedOf = (st: CropStep): Rect => px(d, st.rect)
  for (const st of states) {
    // a animação de uma troca (F11) deixa quadros com tamanhos que ninguém mediu por até ~2 s: dentro dela o estado não conta
    if (steps.slice(1).some((x) => st.t >= x.t - 600 && st.t <= x.t + 2000) || fullWindows.some((w) => st.t >= w.from && st.t <= w.to)) continue
    const best = Math.min(...steps.map((x) => edgeError(expectedOf(x), st.box)))
    expect(best, `${label}: o vídeo mostra a página ${JSON.stringify(st.box)} aos ${(st.t / 1000).toFixed(1)} s e o rastreador não mediu nada assim (medidos: ${steps.map((x) => JSON.stringify(expectedOf(x))).join(' ')})`).toBeLessThanOrEqual(TOL_PX)
  }

  const checks: Check[] = []
  steps.forEach((step) => {
    const idx = allSteps.indexOf(step)
    const end = idx + 1 < allSteps.length ? allSteps[idx + 1]!.t : d.recordedMs
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

// ---------------------------------------------------------------------------------------------------------------------------
// A tela cheia (F11): a página é a janela toda, então NÃO há interface do navegador para o recorte expor. O quadro que o capturador do
// Chrome entrega nesse estado às vezes vem com bordas pretas dele mesmo (medido numa gravação: o quadro de 1358×866 com a janela de
// 1920×1080 encolhida no canto), e isso não é defeito do recorte nem da medida: os trechos de tela cheia ficam fora das conferências de
// geometria e de pixels (o que vem depois deles, a página normal, continua conferido).
const isFullStep = (d: Done, st: CropStep): boolean => isFullRect(st.rect, { w: d.W, h: d.H }, 6)

/** Os trechos (ms, tempo dos eventos) em que a página medida é a janela toda. */
function fullFrameWindows(d: Done): { from: number; to: number }[] {
  const steps = stabilizeContentRects(d.samples, { w: d.W, h: d.H })
  return steps.flatMap((st, i) => (i > 0 && isFullStep(d, st) ? [{ from: st.t - 150, to: (i + 1 < steps.length ? steps[i + 1]!.t : d.recordedMs) + 150 }] : []))
}

// Revisão da C1 (item 7): o recorte conferido em TODOS os instantes (início, transições, retomadas), não só no meio dos trechos longos

const AUDIT_STEP_MS = 250
/** Quadros seguidos com a mesma página para ela contar como um ESTADO do vídeo (e não como a animação de uma troca). */
const MIN_STATE_FRAMES = 4
/** O recorte já se protege contra o desencontro entre o vídeo e os eventos até esta folga (CROP_GUARD_MS). Acima dela o instante é de transição e o teste avisa. */
const SYNC_TOL_MS = CROP_GUARD_MS

type Lag = { step: number; eventMs: number; videoMs: number | null; lagMs: number | null }

/** A caixa pintada do vídeo de origem a cada 100 ms (em metade da resolução): serve para achar QUANDO o vídeo mostra cada trecho medido. */
function stateTrack(d: Done): { t: number; box: Rect | null }[] {
  const W = Math.round(d.W / 2)
  const H = Math.round(d.H / 2)
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', d.videoPath, '-vf', `fps=10,scale=${W}:${H}:flags=area`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30, windowsHide: true })
  const n = Math.floor(raw.length / (W * H * 3))
  const out: { t: number; box: Rect | null }[] = []
  for (let k = 0; k < n; k++) {
    const b = colorBox(raw.subarray(k * W * H * 3, (k + 1) * W * H * 3), W, H, MAGENTA)
    out.push({ t: k * 100, box: b ? { x: b.x * 2, y: b.y * 2, w: b.w * 2, h: b.h * 2 } : null })
  }
  return out
}

/** Para cada troca medida, quanto o vídeo demorou (ou adiantou) para mostrá-la. */
function transitionLags(d: Done, track: { t: number; box: Rect | null }[]): Lag[] {
  const steps = stabilizeContentRects(d.samples, { w: d.W, h: d.H })
  return steps.slice(1).map((st, i) => {
    const want = px(d, st.rect)
    let video: number | null = null
    for (let k = Math.max(0, Math.floor((st.t - 1500) / 100)); k < track.length - 2; k++) {
      if ([0, 1, 2].every((j) => track[k + j]!.box && edgeError(track[k + j]!.box!, want) <= 6)) {
        video = track[k]!.t
        break
      }
    }
    return { step: i + 1, eventMs: st.t, videoMs: video, lagMs: video === null ? null : video - st.t }
  })
}

/** Os trechos de tempo em que o vídeo e os eventos discordam mais que a folga do recorte: neles a conferência estrita não vale. */
function exemptWindows(lags: Lag[]): { from: number; to: number }[] {
  return lags
    .filter((l) => l.lagMs === null || Math.abs(l.lagMs) > SYNC_TOL_MS)
    .map((l) => {
      const v = l.videoMs ?? l.eventMs + 1500
      return { from: Math.min(l.eventMs, v) - 150, to: Math.max(l.eventMs, v) + 300 }
    })
}
const isExempt = (windows: { from: number; to: number }[], t: number): boolean => windows.some((w) => t >= w.from && t <= w.to)

/**
 * O recorte automático CABE na página que o vídeo mostra, em todos os instantes de 0,25 em 0,25 s (do primeiro quadro ao fim),
 * com a tolerância de ±4 px. É o que impede a barra de abas de aparecer na abertura, nas transições e depois de uma retomada.
 */
function auditGeometry(d: Done, tl: CropTimeline, windows: { from: number; to: number }[], lags: Lag[], label: string): { checked: number; skipped: number; stable: Set<number>; moving: number[] } {
  const times: number[] = []
  for (let t = 0; t < d.recordedMs - 150; t += AUDIT_STEP_MS) times.push(t)
  const boxes = times.map((t) => {
    try {
      const b = paintedBox(d, t)
      return { x: b.x, y: b.y, w: b.w, h: b.h }
    } catch {
      return null // sem a cor da página (janela em movimento)
    }
  })
  const same = (a: Rect | null | undefined, b: Rect | null | undefined): boolean => Boolean(a && b && edgeError(a, b) <= 2)
  // Um quadro com a página PARADA faz parte de uma sequência de quadros com a mesma caixa. Quadro em movimento (a animação do F11 passa por tamanhos que
  // ninguém mediu) não tem geometria para conferir, mas só pode existir PERTO de uma troca.
  const stable = new Set<number>()
  const moving: number[] = []
  const runs: boolean[] = new Array(times.length).fill(false)
  let start = 0
  for (let i = 1; i <= times.length; i++) {
    if (boxes[start] && same(boxes[start], boxes[i])) continue
    if (boxes[start] && i - start >= MIN_STATE_FRAMES) for (let k = start; k < i; k++) runs[k] = true
    start = i
  }
  times.forEach((t, i) => {
    if (runs[i]) stable.add(t)
    else moving.push(t)
  })
  const nearSwitch = (t: number): boolean => lags.some((l) => Math.abs(t - l.eventMs) <= 1200 || (l.videoMs !== null && Math.abs(t - l.videoMs) <= 1200))
  for (const t of moving) expect(nearSwitch(t) || isExempt(windows, t), `${label}: o quadro de ${(t / 1000).toFixed(2)} s tem a página em movimento e nenhuma troca por perto`).toBe(true)

  let checked = 0
  let skipped = 0
  times.forEach((t, i) => {
    if (!stable.has(t) || isExempt(windows, t)) {
      skipped++
      return
    }
    const box = boxes[i]!
    const c = px(d, tl.at(t))
    const ok = c.x >= box.x - TOL_PX && c.y >= box.y - TOL_PX && c.x + c.w <= box.x + box.w + TOL_PX && c.y + c.h <= box.y + box.h + TOL_PX
    expect(ok, `${label}: aos ${(t / 1000).toFixed(2)} s o recorte ${JSON.stringify(c)} sai da página pintada ${JSON.stringify(box)}`).toBe(true)
    checked++
  })
  return { checked, skipped, stable, moving }
}

/**
 * O vídeo EXPORTADO (16:9 ou vertical) não mostra a interface do navegador em nenhum instante: a fração de pixels do cartão que não
 * são da página (borda suavizada, cursor, ripple) fica junto da mediana do próprio vídeo; a barra de abas e a de endereço pesariam
 * mais de 10 pontos.
 */
function auditPixels(video: string, vertical: boolean, proj: Project, data: ReturnType<typeof prepareEvents>, windows: { from: number; to: number }[], stable: Set<number>, label: string, mode: 'clean' | 'measure' = 'clean'): { baseline: number; worst: number; worstAt: number; checked: number } {
  const F = vertical ? VERTICAL_1080 : HORIZONTAL_1080
  const W = vertical ? 540 : 960
  const H = vertical ? 960 : 540
  const k = W / F.w
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', video, '-vf', `fps=${1000 / AUDIT_STEP_MS},scale=${W}:${H}:flags=area`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30, windowsHide: true })
  const n = Math.floor(raw.length / (W * H * 3))
  const derived = deriveProject(proj, data, F)
  const fractions: { t: number; frac: number }[] = []
  for (let i = 0; i < n; i++) {
    const t = i * AUDIT_STEP_MS
    if (isExempt(windows, t) || !stable.has(t)) continue // só quadros em que a página do vídeo de origem está parada
    const dest = evaluateScene(proj, derived, t, F).screen!.dest
    const region = { x: dest.x * k, y: dest.y * k, w: dest.w * k, h: dest.h * k }
    fractions.push({ t, frac: nonPageFraction(raw.subarray(i * W * H * 3, (i + 1) * W * H * 3), W, region) })
  }
  const sorted = fractions.map((f) => f.frac).sort((a, b) => a - b)
  const baseline = sorted[Math.floor(sorted.length / 2)] ?? 0
  const worst = fractions.reduce((a, f) => (f.frac > a.frac ? f : a), { t: 0, frac: 0 })
  expect(fractions.length, `${label}: quadros conferidos`).toBeGreaterThan(5)
  if (mode === 'measure') return { baseline, worst: worst.frac, worstAt: worst.t, checked: fractions.length }
  expect(baseline, `${label}: o vídeo exportado com recorte quase não tem pixel fora da página (mediana)`).toBeLessThan(0.04)
  expect(worst.frac - baseline, `${label}: aos ${(worst.t / 1000).toFixed(2)} s o vídeo exportado mostra ${(worst.frac * 100).toFixed(1)}% de pixels fora da página (mediana ${(baseline * 100).toFixed(1)}%)`).toBeLessThan(0.025)
  return { baseline, worst: worst.frac, worstAt: worst.t, checked: fractions.length }
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
async function checkExports(s: Session, d: Done, name: string, windows: { from: number; to: number }[], stable: Set<number>): Promise<{ withCrop: number; without: number }> {
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
  console.log(`[${name}] EXPORTAÇÃO COM recorte (meio dos trechos): pixels que não são da página — 16:9 ${(h1 * 100).toFixed(2)}%, vertical ${(v1 * 100).toFixed(2)}%`)
  // todos os instantes, do primeiro quadro ao fim, nos dois formatos
  const ah = auditPixels(withCrop.h, false, projCrop, data, windows, stable, `${name} 16:9`)
  const av = auditPixels(withCrop.v, true, projCrop, data, windows, stable, `${name} vertical`)
  console.log(`[${name}] AUDITORIA dos quadros exportados: 16:9 ${ah.checked} quadros (mediana ${(ah.baseline * 100).toFixed(2)}%, pior ${(ah.worst * 100).toFixed(2)}% aos ${(ah.worstAt / 1000).toFixed(2)} s); vertical ${av.checked} quadros (mediana ${(av.baseline * 100).toFixed(2)}%, pior ${(av.worst * 100).toFixed(2)}% aos ${(av.worstAt / 1000).toFixed(2)} s)`)

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
  measure(without.h, false, projOff, 'sem-recorte') // só para a captura de tela do "antes"
  measure(without.v, true, projOff, 'sem-recorte')
  // a conferência não é cega: SEM o recorte, o pior quadro mostra a barra de abas e a de endereço (os mesmos quadros e a mesma conta)
  const h0 = auditPixels(without.h, false, projOff, data, windows, stable, `${name} 16:9 sem recorte`, 'measure')
  const v0 = auditPixels(without.v, true, projOff, data, windows, stable, `${name} vertical sem recorte`, 'measure')
  console.log(`[${name}] EXPORTAÇÃO SEM recorte: pior quadro com pixels fora da página — 16:9 ${(h0.worst * 100).toFixed(2)}%, vertical ${(v0.worst * 100).toFixed(2)}%`)
  expect(h0.worst, '16:9 sem recorte mostra a interface do navegador (a conferência enxerga)').toBeGreaterThan(0.06)
  expect(v0.worst, 'vertical sem recorte mostra a interface do navegador').toBeGreaterThan(0.04)
  return { withCrop: Math.max(h1, v1), without: Math.min(h0.worst, v0.worst) }
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

/** F12 e espera a página mudar de largura (abrir: encolhe; fechar: cresce); se a tecla se perdeu, aperta de novo (até 3 vezes). */
async function toggleDevTools(opened: OpenedBrowser, wantOpen: boolean): Promise<void> {
  const before = opened.page().w
  for (let attempt = 1; attempt <= 3; attempt++) {
    await pressKeyIn(opened.hwnd, VK_F12)
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      const w = opened.page().w
      if (wantOpen ? w < before * 0.7 : w > before * 1.3) return
      await sleep(200)
    }
    console.log(`[devtools] tentativa ${attempt}: a página não mudou de largura (${before} px); apertando F12 de novo`)
  }
  throw new Error(`O F12 não ${wantOpen ? 'abriu' : 'fechou'} o DevTools do navegador de teste.`)
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

  // DevTools acoplado (F12 com a janela de teste em primeiro plano; a tecla só vale quando a página de fato mudou de largura)
  await toggleDevTools(opened, true)
  await sleep(4500)
  const withTools = opened.page()
  console.log(`[chrome] com o DevTools: página ${JSON.stringify(withTools)}`)
  await toggleDevTools(opened, false)
  await sleep(4500)

  // tela cheia (F11)
  await pressKeyIn(opened.hwnd, VK_F11)
  await sleep(4500)
  await pressKeyIn(opened.hwnd, VK_F11)
  await sleep(4500)

  const d = await stopAndRead(s, bar)
  await verify(b, s, opened, d, ['resize', 'devtools', 'fullscreen'], 1)
})

test('chrome: F11, pausar, sair do F11 DURANTE a pausa e retomar: a página de depois da retomada vale (sem barra de abas no vídeo)', async () => {
  const b = BROWSERS[0]!
  test.skip(!existsSync(b.exe), 'chrome não está instalado nesta máquina')
  test.setTimeout(360_000)
  const { s, opened, bar } = await openAndPrepare(b)

  await sleep(2500)
  await clickButton(opened)
  await sleep(1500)

  // tela cheia (F11) e pausa
  await pressKeyIn(opened.hwnd, VK_F11)
  await sleep(4500)
  await bar.getByTestId('bar-pause').click()
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'paused')
  await sleep(700)

  // sai da tela cheia DURANTE a pausa: o rastreador vê a janela voltar ao normal, mas nenhuma amostra cabe no vídeo
  const fullPage = opened.page()
  await activateByClick(opened.hwnd, { x: Math.round(fullPage.x + 40), y: Math.round(fullPage.y + fullPage.h - 40) })
  await pressKeyIn(opened.hwnd, VK_F11)
  await sleep(3000)
  console.log(`[pausa] página depois de sair do F11, ainda pausado: ${JSON.stringify(opened.page())}`)

  // retoma: a página de AGORA (normal) tem de valer, mesmo que o rastreador não meça de novo
  await bar.getByTestId('bar-pause').click()
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording')
  await sleep(5500)

  const d = await stopAndRead(s, bar)
  const manifest = JSON.parse(readFileSync(join(d.dir, 'raw/recording.json'), 'utf8')) as { pauses: { start: number; end: number }[] }
  expect(manifest.pauses, 'a gravação teve uma pausa').toHaveLength(1)
  const steps = stabilizeContentRects(d.samples, { w: d.W, h: d.H })
  const last = steps[steps.length - 1]!
  console.log(`[pausa] trechos da página (ms → caixa): ${steps.map((st) => `${Math.round(st.t)}: ${st.rect.x.toFixed(3)},${st.rect.y.toFixed(3)} ${st.rect.w.toFixed(3)}×${st.rect.h.toFixed(3)}`).join(' | ')}; gravado ${(d.recordedMs / 1000).toFixed(1)} s`)
  // o último trecho é a página NORMAL (com a barra de abas fora dela), que começou na retomada, não a tela cheia
  expect(last.rect.y, 'depois da retomada a página volta a ter as abas em cima (não é a tela cheia)').toBeGreaterThan(0.08)
  expect(last.t, 'o trecho da retomada começa na retomada, não no fim').toBeLessThan(d.recordedMs - 4000)
  await verify(b, s, opened, d, ['fullscreen', 'resume'], 1)
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
  const tl = resolveScreenCrop(d.project.screenCrop, d.samples, { w: d.W, h: d.H }, d.project.sources.screen!.durationMs)
  expect(tl, 'o recorte automático existe').not.toBeNull()
  for (const c of checks) {
    const eff = px(d, tl!.at(c.step.t + 700)) // depois da rampa de 200 ms do trecho
    expect(eff.x, `recorte efetivo dentro da página no trecho de ${c.step.t.toFixed(0)} ms`).toBeGreaterThanOrEqual(c.painted.x - TOL_PX)
    expect(eff.y).toBeGreaterThanOrEqual(c.painted.y - TOL_PX)
    expect(eff.x + eff.w).toBeLessThanOrEqual(c.painted.x + c.painted.w + TOL_PX)
    expect(eff.y + eff.h).toBeLessThanOrEqual(c.painted.y + c.painted.h + TOL_PX)
  }

  // o recorte cabe na página que o vídeo mostra em TODOS os instantes (início, transições, retomadas)
  const track = stateTrack(d)
  const lags = transitionLags(d, track)
  const windows = [...exemptWindows(lags), ...fullFrameWindows(d)]
  console.log(`[${name}] defasagem do vídeo em cada troca (ms): ${lags.map((l) => `${l.step}: ${l.lagMs === null ? 'não achada' : l.lagMs}`).join(' | ') || 'nenhuma troca'}; instantes dispensados: ${windows.length}`)
  const audit = auditGeometry(d, tl!, windows, lags, name)
  console.log(`[${name}] GEOMETRIA: o recorte cabe na página pintada em ${audit.checked} instantes (de 0,25 em 0,25 s, do primeiro quadro ao fim); ${audit.skipped} dispensados (em movimento perto de uma troca: ${audit.moving.length}; defasagem acima de ${SYNC_TOL_MS} ms)`)
  expect(audit.checked, 'conferiu a maior parte da gravação').toBeGreaterThan(Math.floor(d.recordedMs / AUDIT_STEP_MS) * 0.5)

  // a folha de contato do vídeo gravado e as capturas antes/depois
  mkdirSync(SCREENS_DIR, { recursive: true })
  execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'contact-sheet.mjs'), d.videoPath, join(SCREENS_DIR, `real-navegador-${name}-gravado.png`), '4', '3', '480'], { stdio: 'inherit' })

  await checkExports(s, d, name, windows, audit.stable)
}

