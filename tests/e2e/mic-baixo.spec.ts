import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { FIXTURES_DIR } from '../helpers/fs'
import { launchTomada, type Session } from './helpers'

/**
 * CASO REAL do usuário (06/10/2026): fone USB com o volume de entrada do Windows em 0% (faixa 0 a +23,8 dB) e fala em -38 dBFS de pico.
 * O Windows é um aparelho EM MEMÓRIA (`TOMADA_TEST_MIC_VOLUME`): nada aqui toca o volume real. A fala vem do dispositivo falso do
 * Chromium, com a voz Maria reduzida a -38 dBFS de pico; a tela e o app ficam escondidos.
 */
const ffmpeg = (args: string[]): string => {
  const run = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], { encoding: 'utf8', windowsHide: true })
  if (run.status !== 0) throw new Error(`ffmpeg: ${run.stderr}`)
  return run.stderr
}

function fakeArgs(dir: string, peakDbfs: number): string[] {
  const voice = join(FIXTURES_DIR, 'voz.wav')
  const max = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(ffmpeg(['-i', voice, '-af', 'volumedetect', '-f', 'null', '-']))![1])
  const wav = join(dir, `voz-${Math.abs(peakDbfs)}.wav`)
  ffmpeg(['-i', voice, '-af', `volume=${peakDbfs - max}dB`, '-c:a', 'pcm_s16le', wav])
  const y4m = join(dir, 'fake-camera.y4m')
  if (!existsSync(y4m)) copyFileSync(join(FIXTURES_DIR, 'fake-camera.y4m'), y4m)
  return ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, `--use-file-for-fake-video-capture=${y4m}`]
}

let session: Session | undefined
let temp: string | undefined
test.beforeEach(() => { temp = mkdtempSync(join(tmpdir(), 'tomada-mic-baixo-')); mkdirSync(temp, { recursive: true }) })
test.afterEach(async () => {
  const problems = session?.problems ?? []
  await session?.close()
  session = undefined
  if (temp) rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  expect(problems, 'Erros da interface').toEqual([])
})

test('volume de entrada no mínimo e fala em -38 dBFS: aviso alto com o nome do microfone e "Ajustar sozinho" sobe o volume do aparelho', async () => {
  test.setTimeout(120_000)
  session = await launchTomada({ realDevices: true, args: fakeArgs(temp!, -38), env: {
    TOMADA_TEST_HIDDEN: '1',
    TOMADA_TEST_MIC_VOLUME: JSON.stringify({ name: 'Microfone (USB PnP Sound Device)', db: 0, minDb: 0, maxDb: 23.8125, stepDb: 0.1875 })
  } })
  await session.page.getByTestId('nav-record').click()
  const check = session.page.getByTestId('mic-level-check')
  await expect(session.page.getByTestId('mic-name')).toHaveText('Microfone (USB PnP Sound Device)')
  await expect(session.page.getByTestId('mic-windows-volume')).toContainText('0%')
  // O volume no mínimo já avisa; depois de 2 s de fala a razão da fala baixa entra também.
  const warning = session.page.getByTestId('mic-level-warning')
  await expect(warning).toBeVisible()
  await expect(warning).toHaveAttribute('role', 'alert')
  await expect(session.page.getByTestId('mic-level-title')).toHaveText('Seu microfone está baixo demais: a voz vai sair com chiado.')
  await expect(warning).toContainText('no mínimo')
  await expect(warning).toContainText('dBFS de pico', { timeout: 20_000 })
  await expect(check).toHaveAttribute('data-status', 'too-low')

  await session.page.getByTestId('mic-adjust').click()
  await expect(session.page.getByTestId('mic-adjust-status')).toBeVisible()
  // O aparelho em memória sobe ao máximo; o dispositivo falso não muda a fala, então o ajuste termina dizendo o limite.
  const result = session.page.getByTestId('mic-adjust-result')
  await expect(result).toBeVisible({ timeout: 60_000 })
  await expect(result).toHaveAttribute('data-outcome', 'at-max')
  await expect(result).toContainText('chegou ao máximo')
  await expect(session.page.getByTestId('mic-windows-volume')).toContainText('100%')
})

test('microfone com a voz em nível normal (-12 dBFS de pico) e volume de entrada a 85%: só mostra o nome, sem aviso', async () => {
  test.setTimeout(90_000)
  session = await launchTomada({ realDevices: true, args: fakeArgs(temp!, -12), env: {
    TOMADA_TEST_HIDDEN: '1',
    TOMADA_TEST_MIC_VOLUME: JSON.stringify({ name: 'Microfone (EMEET SmartCam C60E 4K)', db: 8, minDb: 0, maxDb: 10, stepDb: 1 })
  } })
  await session.page.getByTestId('nav-record').click()
  await expect(session.page.getByTestId('mic-name')).toHaveText('Microfone (EMEET SmartCam C60E 4K)')
  await expect(session.page.getByTestId('mic-windows-volume')).toContainText('80%')
  // Tempo para a fala ser medida (2 s) e o estado virar "ok".
  await expect(session.page.getByTestId('mic-level-check')).toHaveAttribute('data-status', 'ok', { timeout: 30_000 })
  await expect(session.page.getByTestId('mic-level-warning')).toHaveCount(0)
})
