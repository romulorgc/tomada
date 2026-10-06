/**
 * Qualidade da câmera (etapa "câmera real"): Ajustes tem "Qualidade da câmera" (Máxima por padrão, Alta = 1080p),
 * a escolha vale nas gravações, e a gravação deixa no projeto o que a câmera entregou (medido no arquivo bruto).
 * Dispositivos falsos do Chromium: a câmera falsa é 640×360 a 30 qps, então a sondagem de abertura aceita o primeiro degrau.
 * A câmera REAL (EMEET, 4K/1080p a 15-30 qps) é medida por `npm run medir:camera`.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { parseProject } from '../../src/shared/project'
import { EXAMPLE_FOLDER, launchTomada, shot, waitForAux, type Session } from './helpers'

let s: Session | undefined

test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

test('Ajustes: Qualidade da câmera vale Máxima por padrão, troca para Alta (1080p) e a escolha sobrevive ao reabrir o app', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  const { page } = s
  await page.getByTestId('nav-settings').click()
  const section = page.getByTestId('settings-camera-quality')
  await section.scrollIntoViewIfNeeded()
  await expect(section).toBeVisible()
  await expect(page.getByTestId('settings-camera-quality-max')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('settings-camera-quality-high')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('settings-camera-quality-choice')).toContainText('4K')
  await shot(page, 'camera-qualidade-ajustes-maxima')

  await page.getByTestId('settings-camera-quality-high').click()
  await expect(page.getByTestId('settings-camera-quality-high')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('settings-camera-quality-choice')).toContainText('sempre em 1080p')
  expect(await page.evaluate(() => window.tomada.record.getPrefs().then((p) => p.cameraQuality))).toBe('high')
  await shot(page, 'camera-qualidade-ajustes-alta')

  const base = s.base
  await s.close({ keep: true })
  s = await launchTomada({ base })
  await s.page.getByTestId('nav-settings').click()
  await expect(s.page.getByTestId('settings-camera-quality-high')).toHaveAttribute('aria-pressed', 'true')
  await s.page.getByTestId('settings-camera-quality-max').click()
  await expect(s.page.getByTestId('settings-camera-quality-max')).toHaveAttribute('aria-pressed', 'true')
  const page2 = s.page
  await expect.poll(() => page2.evaluate(() => window.tomada.record.getPrefs().then((p) => p.cameraQuality))).toBe('max')
})

async function recordCameraOnly(session: Session, seconds: number): Promise<string> {
  const { page, app } = session
  await page.getByTestId('nav-record').click()
  await page.getByTestId('mode-camera').click()
  await expect(page.getByTestId('camera-preview')).toHaveAttribute('data-live', 'true', { timeout: 20_000 })
  await expect(page.getByTestId('record-start')).toBeEnabled({ timeout: 20_000 })
  await page.getByTestId('record-start').click()
  const bar: Page = await waitForAux(app, 'bar', 60_000)
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording', { timeout: 30_000 })
  await page.waitForTimeout(seconds * 1000)
  await bar.getByTestId('bar-stop').click()
  await expect(page.getByTestId('project-view')).toBeVisible({ timeout: 120_000 })
  return join(session.projects, readdirSync(session.projects)[0]!)
}

test('a gravação abre a câmera pelo degrau escolhido, guarda a decisão no manifesto e a medida no projeto, sem aviso quando a câmera entrega 30 qps', async () => {
  test.setTimeout(240_000)
  s = await launchTomada({ seed: false, env: { TOMADA_TEST_AUTOSOURCE: 'screen' } })
  const dir = await recordCameraOnly(s, 3)
  expect(existsSync(join(dir, 'media/camera.mp4'))).toBe(true)
  const manifest = JSON.parse(readFileSync(join(dir, 'raw/recording.json'), 'utf8')) as { camera: { capture: { quality: string; profile: string; attempts: { profile: string; accepted: boolean; fps: number }[]; probeFps: number }; measured: { fps: number } } }
  // Padrão Máxima: tenta o 4K primeiro. A câmera falsa entrega 30 qps, então normalmente fica nele; se a máquina estiver
  // tão carregada que a sondagem mediu menos, o registro tem de mostrar a queda para o 1080p (nunca um meio-termo).
  expect(manifest.camera.capture.quality).toBe('max')
  expect(manifest.camera.capture.attempts[0]).toMatchObject({ profile: 'uhd' })
  if (manifest.camera.capture.profile === 'uhd') {
    expect(manifest.camera.capture.attempts[0]!.accepted).toBe(true)
    expect(manifest.camera.capture.probeFps).toBeGreaterThan(27)
  } else {
    expect(manifest.camera.capture.attempts.map((a) => a.profile)).toEqual(['uhd', 'fhd'])
    expect(manifest.camera.capture.attempts[0]!.accepted).toBe(false)
  }
  const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
  expect(project.cameraCapture).toBeDefined()
  expect(project.cameraCapture!.fps).toBeGreaterThan(24)
  expect(project.cameraCapture!.warning).toBeUndefined()
})

test('com "Alta (1080p)" a gravação nem tenta o 4K', async () => {
  test.setTimeout(240_000)
  s = await launchTomada({ seed: false, env: { TOMADA_TEST_AUTOSOURCE: 'screen' } })
  await s.page.evaluate(() => window.tomada.record.setPrefs({ cameraQuality: 'high' }))
  const dir = await recordCameraOnly(s, 3)
  const manifest = JSON.parse(readFileSync(join(dir, 'raw/recording.json'), 'utf8')) as { camera: { capture: { quality: string; profile: string; attempts: { profile: string }[] } } }
  expect(manifest.camera.capture).toMatchObject({ quality: 'high', profile: 'fhd' })
  expect(manifest.camera.capture.attempts.map((a) => a.profile)).toEqual(['fhd'])
})

test('a Revisão mostra o aviso de poucos quadros por segundo da câmera, com o motivo e o que fazer', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  const file = join(s.projects, EXAMPLE_FOLDER, 'project.json')
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const warning = 'A câmera gravou a 15,0 qps em 1920×1080 (o esperado é 30). Com pouca luz, a câmera reduz sozinha os quadros por segundo. O que fazer: acenda uma luz de frente para o rosto.'
  doc.cameraCapture = { quality: 'max', profile: 'fhd', width: 1920, height: 1080, fps: 15.04, probeFps: 15, warning }
  writeFileSync(file, JSON.stringify(doc))
  const { page } = s
  await page.reload()
  await page.getByTestId('card-review').first().click()
  await expect(page.getByTestId('review-view')).toBeVisible()
  const banner = page.getByTestId('camera-capture-warning')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('15,0 qps')
  await expect(banner).toContainText('acenda uma luz')
  await shot(page, 'camera-qualidade-revisao-aviso')
})
