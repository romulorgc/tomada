/** Uma hora REAL de mídia sintética + eventos 120 Hz + 9.000 palavras, sem dado do usuário. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createProject, serializeProject } from '../../src/shared/project'
import { E2E_HIDDEN, launchTomada, shot, type Session } from './helpers'
import { FIXTURES_DIR } from '../helpers/fs'
import type { ExportReport } from '../../src/shared/ipc'
import { warmedRenderingSamples } from '../helpers/export-memory'

const HOUR = 3_600_000
const FOLDER = 'Projeto sintético de uma hora'
let session: Session | undefined
test.afterEach(async () => {
  if (!session) return
  const base = session.base
  const problems = session.problems
  await session.close()
  session = undefined
  expect(existsSync(base), 'a sessão sintética foi removida do disco').toBe(false)
  expect(problems, `erros da interface: ${problems.join('\n')}`).toEqual([])
})

function seedHour(s: Session) {
  const dir = join(s.projects, FOLDER)
  mkdirSync(join(dir, 'media'), { recursive: true })
  mkdirSync(join(dir, 'events'))
  // Um quadro por segundo é suficiente para medir a navegação e o streaming;
  // a exportação continua desenhando e codificando 1080p a 30 qps.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=1', '-t', '3600', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35', '-g', '1', join(dir, 'media/screen.mp4')], { windowsHide: true, timeout: 120_000 })
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3600', '-af', 'volume=0.02', '-ac', '1', '-c:a', 'pcm_s16le', join(dir, 'media/voice.wav')], { windowsHide: true, timeout: 120_000 })
  const p = createProject({ id: 'm5a-hour', title: FOLDER, createdAt: '2026-10-05T12:00:00Z', sources: { screen: { path: 'media/screen.mp4', w: 640, h: 360, fps: 1, durationMs: HOUR }, voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs: HOUR } }, capture: { kind: 'screen', boundsPx: { x: 0, y: 0, w: 640, h: 360 }, scale: 1, cursorHidden: false } })
  p.style.defaultLayout = 'screen'
  p.captions.enabled = true
  p.zoomPreset = 'off'
  // Edições existentes em toda a hora, sem diminuir a duração usada para o benchmark.
  p.zooms = Array.from({ length: 120 }, (_, i) => ({ id: `z${i}`, start: i * 30_000 + 1000, end: i * 30_000 + 4000, scale: 1.3, focus: 'auto' as const, origin: 'manual' as const }))
  writeFileSync(join(dir, 'project.json'), serializeProject(p))
  const cursor: string[] = []
  for (let i = 0; i < 432_000; i++) cursor.push(JSON.stringify({ t: Math.round(i * 1000 / 120 * 10) / 10, x: 0.5 + Math.sin(i / 900) * 0.3, y: 0.5 + Math.cos(i / 1300) * 0.2 }))
  writeFileSync(join(dir, 'events/cursor.jsonl'), `${cursor.join('\n')}\n`)
  writeFileSync(join(dir, 'events/clicks.jsonl'), `${Array.from({ length: 120 }, (_, i) => JSON.stringify({ t: i * 30_000 + 1500, x: 0.5, y: 0.5, button: 'left' })).join('\n')}\n`)
  writeFileSync(join(dir, 'events/keys.jsonl'), '')
  const words = Array.from({ length: 9000 }, (_, i) => ({ i, text: i % 20 === 19 ? 'sintético.' : i % 20 === 0 ? 'Projeto' : `palavra${i}`, start: i * 400, end: i * 400 + 320, prob: 0.95, kind: 'word' }))
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify({ engine: 'teste', model: 'sintético', language: 'pt', durationMs: HOUR, words, segments: [], vad: [], createdAt: '' }))
}

test('na próxima abertura oferece recuperar o bruto, pede descarte explícito e permite repetir a etapa que falhou', async () => {
  test.setTimeout(120_000)
  session = await launchTomada({ seed: false, env: { TOMADA_TEST_FAIL_STEP: 'camera' } })
  const base = session.base
  for (const id of ['Recuperar teste', 'Descartar teste']) {
    const dir = join(session.projects, id)
    mkdirSync(join(dir, 'raw'), { recursive: true })
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(FIXTURES_DIR, 'camera.webm'), '-t', '1.2', '-c', 'copy', '-live', '1', join(dir, 'raw/camera.webm')], { windowsHide: true })
    const old = new Date(Date.now() - 20000)
    utimesSync(join(dir, 'raw/camera.webm'), old, old)
    writeFileSync(join(dir, 'raw/recording.json'), JSON.stringify({ version: 1, sessionId: id, folder: id, title: id, createdAt: '2026-10-05T12:00:00Z', mode: 'camera', fps: 30, screen: null, camera: { file: 'raw/camera.webm', mime: 'video/webm', hasVideo: true, hasAudio: true, size: { w: 640, h: 360 } }, clock: { t0: 100_000, cameraStartAt: 100_000, screenStartAt: null, offsetMs: 0, rttMs: 1 }, pauses: [], openPauseAt: 101_500, lastChunkAt: 101_500, endedAt: null, stopReason: null, recordedMs: null, notes: [], saved: null, processedAt: null }))
  }
  await session.close({ keep: true })
  // Mantém a referência: afterEach também limpa a base caso o segundo lançamento falhe.
  session = await launchTomada({ base, env: { TOMADA_TEST_FAIL_STEP: 'camera' } })
  await expect(session.page.getByTestId('recovery-prompt')).toBeVisible()
  await expect(session.page.getByTestId('recovery-item').first()).toContainText('cursor, cliques e teclas')
  await session.page.getByTestId('recovery-later').click()
  await expect(session.page.getByTestId('recovery-prompt')).toHaveCount(0)
  expect(existsSync(join(session.projects, 'Recuperar teste', 'raw/camera.webm'))).toBe(true)
  expect(existsSync(join(session.projects, 'Descartar teste', 'raw/camera.webm'))).toBe(true)
  await session.close({ keep: true })
  session = await launchTomada({ base, env: { TOMADA_TEST_FAIL_STEP: 'camera' } })
  const { page, projects } = session
  await expect(page.getByTestId('recovery-prompt')).toBeVisible()
  expect(await page.getByTestId('recovery-item').count()).toBe(2)
  expect(existsSync(join(projects, 'Recuperar teste', 'project.json'))).toBe(false)
  await shot(page, 'm5a-recuperacao-oferta')
  const discard = page.getByTestId('recovery-item').filter({ hasText: 'Descartar teste' })
  await discard.getByTestId('recovery-discard').click()
  expect(existsSync(join(projects, 'Descartar teste', 'raw/camera.webm'))).toBe(true)
  await discard.getByTestId('recovery-confirm-discard').click()
  // Durante busy o modal inteiro some: count=0 sozinho não comprova a
  // conclusão do IPC/remoção no disco. Espera a oferta voltar já filtrada.
  await expect(page.getByTestId('recovery-item')).toHaveCount(1)
  await expect(discard).toHaveCount(0)
  await expect.poll(() => existsSync(join(projects, 'Descartar teste')), { message: 'o descarte aceito terminou a remoção física' }).toBe(false)
  await page.getByTestId('recovery-recover').click()
  await expect(page.getByTestId('processing-retry')).toBeVisible({ timeout: 30_000 })
  expect(existsSync(join(projects, 'Recuperar teste', 'raw/camera.webm'))).toBe(true)
  await shot(page, 'm5a-recuperacao-falha')
  await page.getByTestId('processing-retry').click()
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 45_000 })
  expect(existsSync(join(projects, 'Recuperar teste', 'project.json'))).toBe(true)
  const manifest = JSON.parse(readFileSync(join(projects, 'Recuperar teste', 'raw/recording.json'), 'utf8'))
  expect(manifest.recordedMs).toBeGreaterThanOrEqual(1200)
  expect(manifest.recordedMs).toBeLessThan(1600)
  expect(manifest.openPauseAt).toBeNull()
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true')
  await shot(page, 'm5a-recuperacao-editor')
})

test('uma hora: editor abre em menos de 3 s, Texto/linha do tempo fluidos e exportação mantém memória limitada', async () => {
  test.skip(E2E_HIDDEN, 'Mede abertura, rolagem e 12.000 quadros exportados de um projeto de uma hora com GPU; por software (janelas ocultas) estoura os 6 min do teste. Rodar com TOMADA_E2E_HIDDEN=0.')
  const full = process.env.TOMADA_LONG_EXPORT_FULL === '1'
  const cpuCanvas = process.env.TOMADA_LONG_DIAG_CPU_CANVAS === '1'
  const softwareEncoder = process.env.TOMADA_LONG_DIAG_SOFTWARE === '1'
  const measurementPath = join('test-results', cpuCanvas ? 'm5a-robustez-medicao-cpu.json' : softwareEncoder ? 'm5a-robustez-medicao-software.json' : full ? 'm5a-robustez-medicao-completa.json' : 'm5a-robustez-medicao.json')
  test.setTimeout(full ? 1_500_000 : 360_000)
  session = await launchTomada({ seed: false })
  const s = session
  if (cpuCanvas) await s.app.context().addInitScript(() => {
    const original = OffscreenCanvas.prototype.getContext
    Object.defineProperty(OffscreenCanvas.prototype, 'getContext', { value: function (this: OffscreenCanvas, id: string, options: Record<string, unknown> = {}) {
      return Reflect.apply(original, this, [id, id === '2d' ? { ...options, willReadFrequently: true } : options])
    } })
  })
  if (softwareEncoder) await s.app.context().addInitScript(() => {
    const original = VideoEncoder.prototype.configure
    Object.defineProperty(VideoEncoder.prototype, 'configure', { value: function (this: VideoEncoder, config: VideoEncoderConfig) {
      return Reflect.apply(original, this, [{ ...config, hardwareAcceleration: 'prefer-software' }])
    } })
  })
  seedHour(s)
  await s.page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  const started = Date.now()
  await s.page.getByTestId('card-open').click()
  await expect(s.page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 })
  await s.page.getByTestId('tab-text').click()
  await expect(s.page.getByTestId('transcript-view')).toHaveAttribute('data-words', '9000')
  // Prontidão inclui a cena com eventos e toda a transcrição, já utilizável na aba Texto.
  const openMs = Date.now() - started
  const scrollStarted = Date.now()
  await s.page.getByTestId('transcript-view').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect(s.page.locator('.tx-w[data-i="8999"]')).toHaveCount(1)
  const textScrollMs = Date.now() - scrollStarted
  expect(await s.page.locator('.tx-w').count()).toBeLessThan(1800)
  const zoomSlider = s.page.getByTestId('tl-zoom-slider')
  const sliderBounds = await zoomSlider.boundingBox()
  if (!sliderBounds) throw new Error('O slider da linha do tempo não ficou visível.')
  await zoomSlider.click({ position: { x: sliderBounds.width - 1, y: sliderBounds.height / 2 } })
  await expect(zoomSlider).toHaveValue((await zoomSlider.getAttribute('max'))!)
  const timeline = await s.page.getByTestId('timeline-scroll').evaluate(async (el) => {
    const begin = performance.now()
    if (el.scrollWidth < el.clientWidth * 20) throw new Error('O zoom não aumentou a linha do tempo: o teste não mediu a navegação ampliada.')
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
    if (el.scrollLeft < el.clientWidth) throw new Error('A linha do tempo não rolou: o teste não mediu a navegação.')
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    return { timeMs: performance.now() - begin, contentWidth: el.scrollWidth, viewportWidth: el.clientWidth, scrollLeft: el.scrollLeft }
  })
  const timelineMs = timeline.timeMs
  expect(await s.page.locator('.tl-tick').count()).toBeLessThan(100)
  await shot(s.page, full ? 'm5a-uma-hora-editor-completa' : 'm5a-uma-hora-editor')
  const { exportId } = await s.page.evaluate(async (projectId) => window.tomada.exporter.start({ projectId, resolution: '1080p', fps: 30 }), FOLDER)
  const samples: { phase: string; frame: number; timeMs: number; rendererMaxKb: number; rendererTotalKb: number; allKb: number; processes: { pid: number; type: string; workingSetSize: number }[] }[] = []
  const exportBegin = Date.now()
  let phase = ''
  let outputReport: ExportReport | undefined
  let lastFrameReport = 0
  const writeMeasurement = (): void => {
    mkdirSync(join('test-results'), { recursive: true })
    const warmed = warmedRenderingSamples(samples)
    const first = warmed[0], last = warmed.at(-1)
    const memoryGrowthKbPer1000Frames = first && last && last.frame > first.frame ? (last.rendererTotalKb - first.rendererTotalKb) * 1000 / (last.frame - first.frame) : null
    const gpuKb = (sample: typeof samples[number]): number => sample.processes.filter((process) => process.type === 'GPU').reduce((sum, process) => sum + process.workingSetSize, 0)
    const gpuGrowthKbPer1000Frames = first && last && last.frame > first.frame ? (gpuKb(last) - gpuKb(first)) * 1000 / (last.frame - first.frame) : null
    writeFileSync(measurementPath, JSON.stringify({ sessionBase: s.base, durationMs: HOUR, words: 9000, cursorSamples: 432000, openMs, textScrollMs, timelineMs, timeline, full, cpuCanvas, softwareEncoder, phase, outputReport, memoryGrowthKbPer1000Frames, gpuGrowthKbPer1000Frames, samples }, null, 2))
  }
  writeMeasurement()
  try {
    for (;;) {
      const progress = await s.page.evaluate(() => window.tomada.exporter.status())
      if (!progress || progress.exportId !== exportId) throw new Error('A exportação medida perdeu o estado.')
      phase = progress.phase
      outputReport = progress.report
      const metrics = await s.app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, workingSetSize: m.memory.workingSetSize })))
      const renderers = metrics.filter((m) => m.type === 'Tab')
      samples.push({ phase, frame: progress.frame, timeMs: Date.now() - exportBegin, rendererMaxKb: Math.max(0, ...renderers.map((m) => m.workingSetSize)), rendererTotalKb: renderers.reduce((sum, m) => sum + m.workingSetSize, 0), allKb: metrics.reduce((sum, m) => sum + m.workingSetSize, 0), processes: metrics })
      if (progress.frame - lastFrameReport >= 3000) {
        lastFrameReport = progress.frame
        console.log(JSON.stringify({ phase, frame: progress.frame, elapsedMs: Date.now() - exportBegin, rendererMaxMb: Math.round(samples.at(-1)!.rendererMaxKb / 1024) }))
        writeMeasurement()
      }
      if (phase === 'error') throw new Error(progress.message)
      if (phase === 'done' || !full && progress.frame >= 12_000) break
      await s.page.waitForTimeout(1000)
    }
  } finally {
    try {
      if (!full) await s.page.evaluate((id) => window.tomada.exporter.cancel(id), exportId)
    } finally {
      writeMeasurement() // mesmo se o fechamento da janela impedir o cancelamento
    }
  }
  const warmed = warmedRenderingSamples(samples)
  if (full) {
    expect(phase).toBe('done')
    expect(outputReport).toMatchObject({ expectedMs: HOUR, frames: 108_000, width: 1920, height: 1080, fps: 30 })
    expect(Math.abs(outputReport!.durationMs - HOUR)).toBeLessThan(100)
    expect(outputReport!.bytes).toBeGreaterThan(0)
    // Seeks independentes evitam decodificar a hora inteira só para a prancha.
    const contactTimes = [0, 900, 1800, 3599]
    const contactPath = join('test-results', 'screens', 'm5a-uma-hora-exportacao.png')
    mkdirSync(join('test-results', 'screens'), { recursive: true })
    const inputs = contactTimes.flatMap((time) => ['-ss', String(time), '-i', outputReport!.outputPath])
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', '[0:v]scale=480:270[a];[1:v]scale=480:270[b];[2:v]scale=480:270[c];[3:v]scale=480:270[d];[a][b][c][d]xstack=inputs=4:layout=0_0|480_0|0_270|480_270', '-frames:v', '1', contactPath], { windowsHide: true, timeout: 30_000 })
    expect(existsSync(contactPath)).toBe(true)
  }
  expect(samples.at(-1)!.frame).toBeGreaterThanOrEqual(full ? 108_000 : 12_000)
  // A população acompanhada precisa chegar ao fim da renderização; a saída
  // do worker durante mux/done não entra na faixa, mas entra nos picos.
  expect(warmed.at(-1)!.frame).toBeGreaterThanOrEqual(full ? 105_000 : 12_000)
  expect(Math.max(...samples.map((sample) => sample.rendererMaxKb))).toBeLessThan(1_500_000)
  expect(Math.max(...warmed.map((sample) => sample.rendererTotalKb)) - Math.min(...warmed.map((sample) => sample.rendererTotalKb))).toBeLessThan(300_000)
  const gpuKb = (sample: typeof samples[number]): number => sample.processes.filter((process) => process.type === 'GPU').reduce((sum, process) => sum + process.workingSetSize, 0)
  expect(Math.max(...samples.map(gpuKb))).toBeLessThan(1_500_000)
  expect(Math.max(...warmed.map(gpuKb)) - Math.min(...warmed.map(gpuKb))).toBeLessThan(300_000)
  expect(openMs).toBeLessThan(3000)
  expect(textScrollMs).toBeLessThan(1000)
  expect(timelineMs).toBeLessThan(100)
  const report = JSON.parse(readFileSync(measurementPath, 'utf8'))
  console.log(JSON.stringify({ openMs: report.openMs, textScrollMs, timelineMs, exportFrames: samples.at(-1)!.frame, rendererPeakMb: Math.round(Math.max(...samples.map((sample) => sample.rendererMaxKb)) / 1024), gpuPeakMb: Math.round(Math.max(...samples.map(gpuKb)) / 1024), allProcessesPeakMb: Math.round(Math.max(...samples.map((sample) => sample.allKb)) / 1024), rendererGrowthMb: Math.round((Math.max(...warmed.map((sample) => sample.rendererTotalKb)) - Math.min(...warmed.map((sample) => sample.rendererTotalKb))) / 1024), gpuGrowthMb: Math.round((Math.max(...warmed.map(gpuKb)) - Math.min(...warmed.map(gpuKb))) / 1024), memoryGrowthMbPer1000Frames: report.memoryGrowthKbPer1000Frames / 1024, gpuGrowthMbPer1000Frames: report.gpuGrowthKbPer1000Frames / 1024 }))
})
