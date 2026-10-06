/**
 * Cenários da gravação além do caminho feliz (`gravacao.spec.ts`): falha de processamento com
 * "Tentar de novo", só tela, só câmera, descartar e recomeçar pela barra, câmera que
 * desconecta no meio e preferências lembradas. Dispositivos falsos e `TOMADA_TEST_AUTOSOURCE`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
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

const AUTO = { TOMADA_TEST_AUTOSOURCE: 'screen' }

/** Abre a tela Gravar, espera tudo ficar pronto, grava e devolve a página da barra flutuante. */
async function startRecording(session: Session, opts: { camera: boolean; mode?: 'screen' | 'camera' | 'screen-camera' }): Promise<Page> {
  const { page, app } = session
  await page.getByTestId('nav-record').click()
  if (opts.mode) await page.getByTestId(`mode-${opts.mode}`).click()
  if (opts.camera) await expect(page.getByTestId('camera-preview')).toHaveAttribute('data-live', 'true', { timeout: 20_000 })
  await expect(page.getByTestId('record-start')).toBeEnabled({ timeout: 20_000 })
  await page.getByTestId('record-start').click()
  const bar = await waitForAux(app, 'bar', 40_000)
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording', { timeout: 30_000 })
  return bar
}

function projectFolders(session: Session): string[] {
  return readdirSync(session.projects)
}

function probeDuration(file: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' })
  return Number(out.trim())
}

test('passo que falha no processamento: o motivo aparece, o bruto fica e "Tentar de novo" conclui sem regravar', async () => {
  test.setTimeout(150_000)
  s = await launchTomada({ seed: false, env: { ...AUTO, TOMADA_TEST_FAIL_STEP: 'voice' } })
  const { page } = s
  const bar = await startRecording(s, { camera: true })
  await page.waitForTimeout(2500)
  await bar.getByTestId('bar-stop').click()

  const view = page.getByTestId('processing-view')
  await expect(view).toHaveAttribute('data-status', 'failed', { timeout: 90_000 })
  await expect(page.getByTestId('processing-error')).toBeVisible()
  await expect(page.getByTestId('processing-error-detail')).toContainText('Falha simulada')
  await expect(page.getByTestId('step-voice')).toHaveAttribute('data-status', 'error')
  await expect(page.getByTestId('step-screen')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('step-project')).toHaveAttribute('data-status', 'pending')
  await shot(page, '18-processamento-falhou')

  // O bruto e o manifesto continuam lá; nada com cara de projeto pronto.
  const folders = projectFolders(s)
  expect(folders).toHaveLength(1)
  const dir = join(s.projects, folders[0]!)
  expect(existsSync(join(dir, 'raw/screen.webm'))).toBe(true)
  expect(existsSync(join(dir, 'raw/camera.webm'))).toBe(true)
  expect(existsSync(join(dir, 'raw/recording.json'))).toBe(true)
  expect(existsSync(join(dir, 'project.json'))).toBe(false)

  await page.getByTestId('processing-retry').click()
  await expect(page.getByTestId('project-view')).toBeVisible({ timeout: 90_000 })
  expect(existsSync(join(dir, 'project.json'))).toBe(true)
  expect(existsSync(join(dir, 'media/voice.wav'))).toBe(true)
  const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
  expect(project.sources.voice?.path).toBe('media/voice.wav')
  expect(projectFolders(s)).toHaveLength(1) // não gravou outra
})

test('só a tela: sem passos de câmera e sem câmera no projeto', async () => {
  test.setTimeout(150_000)
  s = await launchTomada({ seed: false, env: { ...AUTO, TOMADA_TEST_STEP_DELAY_MS: '500' } })
  const { page } = s
  const bar = await startRecording(s, { camera: false, mode: 'screen' })
  await page.waitForTimeout(2500)
  await bar.getByTestId('bar-stop').click()

  await expect(page.getByTestId('processing-view')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('step-screen')).toBeVisible()
  await expect(page.getByTestId('step-camera')).toHaveCount(0)
  await expect(page.getByTestId('project-view')).toBeVisible({ timeout: 90_000 })

  const dir = join(s.projects, projectFolders(s)[0]!)
  expect(existsSync(join(dir, 'raw/camera.webm'))).toBe(false)
  expect(existsSync(join(dir, 'media/camera.mp4'))).toBe(false)
  const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
  expect(project.sources.screen?.path).toBe('media/screen.mp4')
  expect(project.sources.camera).toBeUndefined()
  expect(project.capture.kind).toBe('screen')
  expect(readFileSync(join(dir, 'events/cursor.jsonl'), 'utf8').length).toBeGreaterThan(0)
})

test('só a câmera: sem tela, sem rastreio do mouse, com câmera e voz', async () => {
  test.setTimeout(150_000)
  s = await launchTomada({ seed: false, env: AUTO })
  const { page, app } = s
  const bar = await startRecording(s, { camera: true, mode: 'camera' })
  // Só câmera não minimiza a janela principal (não há tela para esconder dela).
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))?.isMinimized() ?? null)).toBe(false)
  await page.waitForTimeout(2500)
  await bar.getByTestId('bar-stop').click()
  await expect(page.getByTestId('project-view')).toBeVisible({ timeout: 90_000 })

  const dir = join(s.projects, projectFolders(s)[0]!)
  expect(existsSync(join(dir, 'raw/screen.webm'))).toBe(false)
  expect(existsSync(join(dir, 'events'))).toBe(false)
  expect(existsSync(join(dir, 'media/camera.mp4'))).toBe(true)
  expect(existsSync(join(dir, 'media/voice.wav'))).toBe(true)
  const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
  expect(project.sources.screen).toBeUndefined()
  expect(project.sources.camera?.path).toBe('media/camera.mp4')
  expect(project.sources.voice?.path).toBe('media/voice.wav')
  expect(probeDuration(join(dir, 'media/camera.mp4'))).toBeGreaterThan(1.8)
})

test('descartar pela barra apaga a gravação e devolve a janela; recomeçar descarta e começa outra do zero', async () => {
  test.setTimeout(180_000)
  s = await launchTomada({ seed: false, env: AUTO })
  const { page, app } = s
  const mainMinimized = (): Promise<boolean | null> =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))?.isMinimized() ?? null)

  let bar = await startRecording(s, { camera: true })
  expect(await mainMinimized()).toBe(process.env.TOMADA_E2E_HIDDEN !== '1')
  expect(projectFolders(s)).toHaveLength(1)
  await page.waitForTimeout(1500)

  // Descartar pede confirmação; "não" mantém a gravação.
  await bar.getByTestId('bar-discard').click()
  await expect(bar.getByTestId('bar-confirm')).toBeVisible()
  await shot(bar, '19-barra-confirmar')
  await bar.getByTestId('bar-confirm-no').click()
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording')
  expect(projectFolders(s)).toHaveLength(1)

  await bar.getByTestId('bar-discard').click()
  await bar.getByTestId('bar-confirm-yes').click()
  await expect.poll(() => auxPage(app, 'bar'), { timeout: 20_000 }).toBeUndefined()
  await expect.poll(mainMinimized, { timeout: 20_000 }).toBe(false)
  // Em modo de teste a pasta vai direto, sem Lixeira real. Com as janelas ocultas a principal nunca fica minimizada, então o
  // poll acima já passou antes da remoção terminar: o próprio desaparecimento da pasta é o ponto de sincronia.
  await expect.poll(() => projectFolders(s!), { timeout: 20_000 }).toEqual([])
  expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+R'))).toBe(false)
  await expect(page.getByTestId('record-view')).toHaveAttribute('data-phase', 'idle')

  // Recomeçar: a primeira pasta some e uma nova nasce; só ela sobra.
  bar = await startRecording(s, { camera: true })
  const first = projectFolders(s)
  expect(first).toHaveLength(1)
  await page.waitForTimeout(1200)
  await bar.getByTestId('bar-restart').click()
  await bar.getByTestId('bar-confirm-yes').click()
  await expect.poll(() => auxPage(app, 'bar'), { timeout: 20_000 }).toBeUndefined()
  const bar2 = await waitForAux(app, 'bar', 40_000)
  await expect(bar2.getByTestId('bar')).toHaveAttribute('data-status', 'recording', { timeout: 30_000 })
  expect(projectFolders(s)).toHaveLength(1)
  const t = Number(await bar2.getByTestId('bar-time').getAttribute('data-ms'))
  expect(t).toBeLessThan(2500) // cronômetro do zero, não herdado

  await page.waitForTimeout(1500)
  await bar2.getByTestId('bar-stop').click()
  await expect(page.getByTestId('project-view')).toBeVisible({ timeout: 90_000 })
  expect(projectFolders(s)).toHaveLength(1)
  expect(existsSync(join(s.projects, projectFolders(s)[0]!, 'project.json'))).toBe(true)
})

test('câmera que desconecta no meio: aviso na tela, a gravação segue e termina, e o aviso fica registrado', async () => {
  test.setTimeout(150_000)
  s = await launchTomada({ seed: false, env: AUTO })
  const { page } = s
  // Guarda os fluxos de dispositivo que a interface abrir, para poder "desconectar" o da gravação.
  await page.evaluate(() => {
    const w = window as unknown as { __streams?: MediaStream[] }
    w.__streams = []
    const md = navigator.mediaDevices
    const original = md.getUserMedia.bind(md)
    md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const stream = await original(constraints)
      w.__streams!.push(stream)
      return stream
    }
  })
  const bar = await startRecording(s, { camera: true })
  await page.waitForTimeout(2000)
  await page.evaluate(() => {
    const w = window as unknown as { __streams: MediaStream[] }
    const stream = w.__streams[w.__streams.length - 1]!
    for (const track of stream.getVideoTracks()) {
      track.stop()
      track.dispatchEvent(new Event('ended')) // o que o Chromium faz quando o aparelho é desligado
    }
  })
  await expect(page.getByText('A câmera foi desconectada', { exact: false }).first()).toBeVisible({ timeout: 10_000 })
  await shot(page, '20-camera-desconectada')
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording') // continua gravando
  await page.waitForTimeout(2000)
  await bar.getByTestId('bar-stop').click()

  await expect(page.getByTestId('project-view')).toBeVisible({ timeout: 90_000 })
  const dir = join(s.projects, projectFolders(s)[0]!)
  const manifest = JSON.parse(readFileSync(join(dir, 'raw/recording.json'), 'utf8')) as { notes: string[]; recordedMs: number }
  expect(manifest.notes.some((n) => n.includes('câmera foi desconectada'))).toBe(true)
  expect(manifest.recordedMs).toBeGreaterThan(3500)
  const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
  expect(project.sources.screen?.path).toBe('media/screen.mp4')
  expect(project.sources.voice?.path).toBe('media/voice.wav')
  // A tela e a voz cobrem a gravação inteira, mesmo com a câmera mais curta.
  expect(Math.abs(probeDuration(join(dir, 'media/screen.mp4')) - manifest.recordedMs / 1000)).toBeLessThan(0.6)
})

test('as escolhas da tela Gravar (modo e quadros por segundo) voltam na próxima abertura', async () => {
  test.setTimeout(90_000)
  s = await launchTomada({ seed: false })
  await s.page.getByTestId('nav-record').click()
  await s.page.getByTestId('mode-screen').click()
  await s.page.getByTestId('fps-60').click()
  await expect(s.page.getByTestId('fps-60')).toHaveAttribute('aria-pressed', 'true')
  // O pedido de gravar as escolhas é assíncrono: espera chegar ao disco antes de fechar o app.
  const settingsFile = join(s.userData, 'settings.json')
  await expect
    .poll(() => {
      try {
        const record = (JSON.parse(readFileSync(settingsFile, 'utf8')) as { record?: { mode?: string; fps?: number } }).record
        return `${record?.mode}/${record?.fps}`
      } catch {
        return 'sem arquivo'
      }
    })
    .toBe('screen/60')
  const { base } = s
  const problems = s.problems
  await s.close({ keep: true })
  expect(problems).toEqual([])

  s = await launchTomada({ base, seed: false })
  await s.page.getByTestId('nav-record').click()
  await expect(s.page.getByTestId('mode-screen')).toHaveAttribute('aria-pressed', 'true')
  await expect(s.page.getByTestId('fps-60')).toHaveAttribute('aria-pressed', 'true')
  await expect(s.page.getByTestId('mode-screen-camera')).toHaveAttribute('aria-pressed', 'false')
})

test('moldura-guia na prévia da câmera: aparece com a dica, só na prévia, e desliga e volta pelo ajuste', async () => {
  test.setTimeout(90_000)
  s = await launchTomada({ seed: false, env: AUTO })
  const { page } = s
  await page.getByTestId('nav-record').click()
  await expect(page.getByTestId('camera-preview')).toHaveAttribute('data-live', 'true', { timeout: 20_000 })
  const guide = page.getByTestId('framing-guide')
  // a moldura é do estilo Apresentador recortado: no Quadro ao lado (padrão) ela não aparece
  await expect(guide).toHaveCount(0)
  await page.getByTestId('camera-style-presenter').click()
  await expect(guide).toBeVisible()
  await expect(guide).toContainText('tronco e as mãos')
  await expect(guide).toContainText('luz de frente')
  // a moldura é só da prévia: o vídeo gravado e a bolha não a têm
  await expect(page.getByTestId('camera-preview').locator('video')).toHaveCount(1)
  await shot(page, 'gravar-moldura-guia')

  await page.getByText('Ajustes do som e da bolha').click()
  await page.getByTestId('guide-toggle').click()
  await expect(guide).toHaveCount(0)
  await page.getByTestId('guide-toggle').click()
  await expect(guide).toBeVisible()

  // só tela: sem câmera não há prévia nem ajuste da moldura
  await page.getByTestId('mode-screen').click()
  await expect(page.getByTestId('guide-toggle')).toHaveCount(0)
  await expect(guide).toHaveCount(0)
})
