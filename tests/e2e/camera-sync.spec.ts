import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createProject, serializeProject } from '../../src/shared/project'
import { makeCameraSyncRaw } from '../helpers/camera-sync-media'
import { audioPcm, imageToRgb, lumaSeries, onsets } from '../helpers/media'
import { EXAMPLE_FOLDER, launchTomada, shot, type Session } from './helpers'
import { openEditor, previewShot, readSaved, seekPausedTo, waitSaved } from './editor-helpers'
import { exportProject } from './export-helpers'

let session: Session | undefined
test.afterEach(async () => {
  if (!session) return
  const problems = session.problems
  await session.close()
  session = undefined
  expect(problems).toEqual([])
})
const ffmpeg = (args: string[]): void => { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }) }

function seedCamera(session: Session, folder: string, offset = 80, unequal = false): void {
  const dir = join(session.projects, folder)
  mkdirSync(join(dir, 'media'), { recursive: true })
  // A saída oferecida pelo app é 60 qps: coloca o caso negativo na grade compatível (erro de quantização ≤5 ms).
  const raw = makeCameraSyncRaw(dir, offset, unequal, offset === -80 ? 1010 : 1000)
  // O sintético conserva o eixo comum a 250 qps; os quatro casos são auditados pelo normalizador real na integração.
  ffmpeg(['-i', raw, '-an', '-vf', 'setpts=PTS-STARTPTS,fps=250:start_time=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(dir, 'media/camera.mp4')])
  ffmpeg(['-i', raw, '-vn', '-af', `asetpts=PTS-STARTPTS+${unequal ? '0.08' : '0'}/TB,aresample=async=1:first_pts=0`, '-ac', '1', '-c:a', 'pcm_s16le', join(dir, 'media/voice.wav')])
  const project = createProject({ id: 'camera-sync-synthetic', title: 'Sincronia sintética', sources: {
    camera: { path: 'media/camera.mp4', w: 160, h: 90, fps: 250, durationMs: 3000 },
    voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs: unequal ? 3080 : 3000 }
  } })
  project.style.defaultLayout = 'camera'
  project.style.padding = 0
  project.style.radius = 0
  project.style.shadow.opacity = 0
  project.zoomPreset = 'off'
  writeFileSync(join(dir, 'project.json'), serializeProject(project))
}

test('sincronia manual busca a câmera na prévia pausada e na exportação, preserva a voz e permite desfazer', async () => {
  test.setTimeout(240_000)
  session = await launchTomada()
  seedCamera(session, EXAMPLE_FOLDER)
  const { page } = session
  await openEditor(session)
  await seekPausedTo(page, 1000)
  for (let frame = 0; frame < 8; frame++) await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true')
  await page.getByTestId('tab-camera').click()
  const before = await page.getByTestId('video-camera').evaluate((el) => (el as HTMLVideoElement).currentTime)
  const black = imageToRgb(await previewShot(page), 1, 1)[0]!
  expect(black).toBeLessThan(70)
  await page.getByTestId('camera-sync').fill('80')
  await expect.poll(async () => page.getByTestId('video-camera').evaluate((el, previous) => (el as HTMLVideoElement).currentTime - previous, before)).toBeCloseTo(0.08, 3)
  await expect.poll(async () => imageToRgb(await previewShot(page), 1, 1)[0]!).toBeGreaterThan(200)
  await waitSaved(session)
  expect(readSaved(session).sync.cameraAvManualOffsetMs).toBe(80)
  expect(readSaved(session).sync.cameraOffsetMs).toBe(0)
  await shot(page, 's1-camera-sincronia-manual')
  const first = await exportProject(page, EXAMPLE_FOLDER, { resolution: '1080p', fps: 60 })
  expect(first.phase, first.message).toBe('done')
  const flashes = lumaSeries(first.outputPath!, { x: 930, y: 510, w: 60, h: 60 })
  const flashMs = flashes.findIndex((v) => v > 128) * 1000 / 60
  const voiceMs = onsets(audioPcm(first.outputPath!), 48_000, { relative: 0.2 })[0]!
  expect(Math.abs(flashMs - voiceMs)).toBeLessThanOrEqual(5)
  expect(Math.abs(voiceMs - 1000)).toBeLessThanOrEqual(5)
  await page.getByTestId('camera-sync-auto').click()
  await expect(page.getByTestId('camera-sync')).toHaveValue('0')
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('camera-sync')).toHaveValue('80')
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('camera-sync')).toHaveValue('0')
  await waitSaved(session)
  const second = await exportProject(page, EXAMPLE_FOLDER, { resolution: '1080p', fps: 60 })
  expect(second.phase, second.message).toBe('done')
  const rawFlash = lumaSeries(second.outputPath!, { x: 930, y: 510, w: 60, h: 60 }).findIndex((v) => v > 128) * 1000 / 60
  const unchangedVoice = onsets(audioPcm(second.outputPath!), 48_000, { relative: 0.2 })[0]!
  expect(Math.abs(rawFlash - 1080)).toBeLessThanOrEqual(5)
  expect(unchangedVoice).toBe(voiceMs)
  console.log(`[sincronia e2e] câmera original=${rawFlash.toFixed(3)} ms; corrigida=${flashMs.toFixed(3)} ms; voz invariável=${voiceMs} ms`)
})

test('exportação real conserva offsets 0, +80, -80 e start_time desigual com erro ≤5 ms', async () => {
  test.setTimeout(240_000)
  session = await launchTomada({ seed: false })
  for (const [index, scenario] of [{ offset: 0, unequal: false }, { offset: 80, unequal: false }, { offset: -80, unequal: false }, { offset: 0, unequal: true }].entries()) {
    const folder = `s1-${index}`
    seedCamera(session, folder, scenario.offset, scenario.unequal)
    const done = await exportProject(session.page, folder, { resolution: '1080p', fps: 60 })
    expect(done.phase, done.message).toBe('done')
    const imageMs = lumaSeries(done.outputPath!, { x: 930, y: 510, w: 60, h: 60 }).findIndex((v) => v > 128) * 1000 / 60
    const soundMs = onsets(audioPcm(done.outputPath!), 48_000, { relative: 0.2 })[0]!
    const expected = scenario.offset - (scenario.unequal ? 80 : 0)
    expect(Math.abs(imageMs - soundMs - expected)).toBeLessThanOrEqual(5)
    console.log(`[cadeia e2e] esperado=${expected} ms, imagem=${imageMs.toFixed(3)} ms, áudio=${soundMs} ms`)
  }
})

test('calibração grava cinco segundos, avisa detector ausente e permite tentar novamente', async () => {
  test.setTimeout(60_000)
  session = await launchTomada()
  const { page } = session
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('calibrate-sync')).toBeEnabled()
  const mic = page.getByTestId('calibration-mic')
  // O dispositivo padrão fake não resolve groupId físico; escolha um aparelho concreto,
  // como o usuário instruído pela UI, para exercitar a ausência do runtime depois da captura.
  const physicalMic = await mic.evaluate((element) => Array.from((element as HTMLSelectElement).options).find((option) => option.value && !['default', 'communications'].includes(option.value))?.value)
  expect(physicalMic, 'a lista observada precisa conter um microfone físico para este cenário').toBeTruthy()
  await mic.selectOption(physicalMic!)
  await page.getByTestId('calibrate-sync').click()
  await expect(page.getByTestId('calibrate-sync')).toContainText('Gravando')
  await expect(page.getByTestId('calibration-error')).toContainText('não está preparado', { timeout: 30_000 })
  await expect(page.getByTestId('calibrate-sync')).toBeEnabled()
  await expect(page.getByTestId('calibrate-sync')).toHaveText('Tentar novamente')
  await expect(page.getByTestId('calibration-success')).toHaveCount(0)
  const settings = await page.evaluate(() => window.tomada.settings.get())
  expect(settings.settings.cameraCalibrations).toBeUndefined()
  await shot(page, 's1-calibracao-indisponivel')
})
