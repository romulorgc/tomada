import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { parseProject } from '../../src/shared/project'
import { auxPage, launchTomada, shot, waitForAux, type Session } from './helpers'

let s: Session | undefined

test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

type Probe = { durationS: number; w: number; h: number; fps: number; codec: string; hasAudio: boolean }

function probe(file: string): Probe {
  const out = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file], { encoding: 'utf8' })
  ) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number; avg_frame_rate?: string }[]; format: { duration?: string } }
  const v = out.streams.find((x) => x.codec_type === 'video')
  const [n, d] = (v?.avg_frame_rate ?? '0/1').split('/').map(Number)
  return {
    durationS: Number(out.format.duration ?? 0),
    w: v?.width ?? 0,
    h: v?.height ?? 0,
    fps: n && d ? n / d : 0,
    codec: v?.codec_name ?? '',
    hasAudio: out.streams.some((x) => x.codec_type === 'audio')
  }
}

function volumeDetect(file: string): { mean: number; max: number } {
  // ffmpeg escreve o relatório no stderr: execFileSync não o devolve; usa spawnSync.
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
  const mean = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr)?.[1]
  const max = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr)?.[1]
  const num = (v: string | undefined): number => (v === undefined || v === '-inf' ? -Infinity : Number(v))
  return { mean: num(mean), max: num(max) }
}

const lines = (file: string): string[] =>
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)

test('grava ~6 s com dispositivos falsos, pausa, para pela barra, processa e abre o projeto', async () => {
  test.setTimeout(150_000)
  s = await launchTomada({ seed: false, env: { TOMADA_TEST_AUTOSOURCE: 'screen', TOMADA_TEST_STEP_DELAY_MS: '600' } })
  const { page, app } = s

  // Antes de gravar não há atalho global.
  expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+R'))).toBe(false)

  await page.getByTestId('nav-record').click()
  await expect(page.getByTestId('source-card').first()).toBeVisible()
  await expect(page.getByTestId('camera-preview')).toHaveAttribute('data-live', 'true', { timeout: 20_000 })
  // O microfone falso (voz.wav) mexe o medidor.
  await expect
    .poll(async () => Number(await page.getByTestId('mic-meter').getAttribute('data-level')), { timeout: 20_000, intervals: [200] })
    .toBeGreaterThan(0.05)
  await shot(page, '12-gravar-dispositivos-falsos')

  const wallStart = Date.now()
  await page.getByTestId('record-start').click()

  // Contagem 3-2-1 numa sobreposição à parte.
  const countdown = await waitForAux(app, 'countdown')
  await expect(countdown.getByTestId('countdown-number')).toBeVisible()
  await shot(countdown, '13-contagem')

  // Gravando: barra flutuante aberta e atalhos globais ligados.
  const bar = await waitForAux(app, 'bar', 30_000)
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording')
  expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+R'))).toBe(true)
  expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+P'))).toBe(true)
  // No e2e oculto não precisa minimizar; continua pintando os MediaRecorder sem aparecer.
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))?.isMinimized() ?? null)).toBe(process.env.TOMADA_E2E_HIDDEN !== '1')

  await page.waitForTimeout(2500)
  const t1 = Number(await bar.getByTestId('bar-time').getAttribute('data-ms'))
  expect(t1).toBeGreaterThan(1500)
  await shot(bar, '14-barra-gravando')
  // O medidor da barra recebe o nível do microfone (a janela principal está minimizada).
  await expect
    .poll(async () => Number(await bar.getByTestId('bar-meter').getAttribute('data-level')), { timeout: 10_000, intervals: [200] })
    .toBeGreaterThan(0.02)

  // Pausa: o cronômetro para.
  await bar.getByTestId('bar-pause').click()
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'paused')
  const pausedAt = Number(await bar.getByTestId('bar-time').getAttribute('data-ms'))
  await page.waitForTimeout(1500)
  const pausedLater = Number(await bar.getByTestId('bar-time').getAttribute('data-ms'))
  expect(Math.abs(pausedLater - pausedAt)).toBeLessThan(100)
  await shot(bar, '15-barra-pausada')
  await bar.getByTestId('bar-pause').click()
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording')

  await page.waitForTimeout(3500)
  const beforeStop = Number(await bar.getByTestId('bar-time').getAttribute('data-ms'))
  await bar.getByTestId('bar-stop').click()

  // Processamento (com atraso de teste por passo para dar tempo da captura de tela).
  await expect(page.getByTestId('processing-view')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('step-screen')).toBeVisible()
  await shot(page, '16-processamento')
  // Depois de parar, o rastreio e os atalhos saem.
  expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+R'))).toBe(false)
  expect(auxPage(app, 'bar')).toBeUndefined()

  await expect(page.getByTestId('project-view')).toBeVisible({ timeout: 90_000 })
  const wall = (Date.now() - wallStart) / 1000

  // --- Arquivos
  const folders = readdirSync(s.projects)
  expect(folders).toHaveLength(1)
  const dir = join(s.projects, folders[0]!)
  for (const rel of [
    'raw/screen.webm',
    'raw/camera.webm',
    'raw/recording.json',
    'media/screen.mp4',
    'media/camera.mp4',
    'media/voice.wav',
    'media/thumb.jpg',
    'events/cursor.jsonl',
    'events/clicks.jsonl',
    'events/keys.jsonl',
    'project.json'
  ]) {
    expect(existsSync(join(dir, rel)), `falta ${rel}`).toBe(true)
  }

  const manifest = JSON.parse(readFileSync(join(dir, 'raw/recording.json'), 'utf8')) as { recordedMs: number; pauses: { start: number; end: number }[]; notes: string[] }
  const recorded = manifest.recordedMs / 1000
  console.log(`[gravacao] relógio de parede ${wall.toFixed(1)} s; barra ${(beforeStop / 1000).toFixed(2)} s; recordedMs ${recorded.toFixed(2)} s; pausas ${JSON.stringify(manifest.pauses.map((p) => +(p.end - p.start).toFixed(0)))}`)
  expect(recorded).toBeGreaterThan(5.5)
  expect(recorded).toBeLessThan(8.5)
  expect(manifest.pauses).toHaveLength(1)
  expect(manifest.pauses[0]!.end - manifest.pauses[0]!.start).toBeGreaterThan(1200)

  // --- Durações ±0,5 s
  const screen = probe(join(dir, 'media/screen.mp4'))
  const camera = probe(join(dir, 'media/camera.mp4'))
  const voice = probe(join(dir, 'media/voice.wav'))
  console.log(`[gravacao] tela ${JSON.stringify(screen)} câmera ${JSON.stringify(camera)} voz ${voice.durationS.toFixed(2)} s`)
  expect(Math.abs(screen.durationS - recorded)).toBeLessThan(0.5)
  expect(Math.abs(camera.durationS - recorded)).toBeLessThan(0.5)
  expect(Math.abs(voice.durationS - recorded)).toBeLessThan(0.5)
  expect(screen.codec).toBe('h264')
  expect(screen.fps).toBeCloseTo(30, 0)

  // --- voice.wav não está mudo
  const vol = volumeDetect(join(dir, 'media/voice.wav'))
  console.log(`[gravacao] voice.wav mean ${vol.mean} dB, max ${vol.max} dB`)
  expect(vol.max).toBeGreaterThan(-30)

  // --- project.json válido
  const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
  expect(project.sources.screen?.path).toBe('media/screen.mp4')
  expect(project.sources.camera?.path).toBe('media/camera.mp4')
  expect(project.sources.voice?.path).toBe('media/voice.wav')
  expect(project.capture.kind).toBe('screen')
  console.log(`[gravacao] captura: ${JSON.stringify(project.capture)}`)
  // Com as flags de dispositivo falso a "tela" é sintética: não tem cursor e a trilha informa
  // `cursor: 'never'` (o pedido vale). Então o projeto sai marcado como cursor oculto e o editor
  // passa a usar o sintético. Na captura de VERDADE (`npm run test:real`) o Electron 40 ignora o
  // pedido, a trilha informa "always" e `cursorHidden` é false (provado por quadro lá).
  expect(project.capture.cursorHidden).toBe(true)
  expect(project.style.cursor.mode).toBe('synthetic')
  expect(project.sync.screenOffsetMs).toBeGreaterThanOrEqual(0)
  expect(project.sync.cameraOffsetMs).toBeGreaterThanOrEqual(0)
  expect(project.capture.frameSize).toBeDefined()

  // --- cursor.jsonl: ~120 amostras por segundo gravado (±20%)
  const cursor = lines(join(dir, 'events/cursor.jsonl')).map((l) => JSON.parse(l) as { t: number; x: number; y: number })
  const perSecond = cursor.length / recorded
  console.log(`[gravacao] cursor: ${cursor.length} amostras, ${perSecond.toFixed(1)} por segundo; último t = ${cursor[cursor.length - 1]?.t}`)
  expect(perSecond).toBeGreaterThan(96)
  expect(perSecond).toBeLessThan(144)
  expect(cursor[cursor.length - 1]!.t).toBeLessThan(manifest.recordedMs + 100)
  for (const c of cursor) {
    expect(c.x).toBeGreaterThanOrEqual(0)
    expect(c.x).toBeLessThanOrEqual(1)
  }

  await shot(page, '17-projeto-gravado')
})
