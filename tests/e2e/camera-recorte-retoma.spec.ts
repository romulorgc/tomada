/**
 * O recorte do fundo em pedaços, RETOMÁVEL (R1), no Electron de verdade com o motor de teste da câmera (`TOMADA_CAMERA=mock`):
 *  - o aviso discreto "Recortando você do fundo: N%" aparece na barra do editor enquanto o recorte roda em segundo plano;
 *  - FECHAR o app no meio deixa o aviso no log (e o andamento no projeto); ao REABRIR, ele continua do último pedaço pronto, sozinho, e o
 *    aviso diz que está "continuando de onde parou";
 *  - se falhar, o aviso é claro, o motivo vai para o log e "Tentar de novo" continua dos pedaços que já estavam prontos.
 * Pedaços de 2 s (`TOMADA_TEST_MATTE_CHUNK_S`) e recorte lento (`TOMADA_TEST_MATTE_DELAY_MS`) fazem o projeto de exemplo (22,7 s) ter 12 pedaços.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { MATTE_FILE } from '../../src/shared/matte'
import { parseProject } from '../../src/shared/project'
import { MATTE_PARTS_DIR, MATTE_PROGRESS_FILE, parseMatteProgress } from '../../src/shared/matte-parts'
import { openEditor } from './editor-helpers'
import { EXAMPLE_FOLDER, launchTomada, waitForAux, type Session } from './helpers'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

const MOCK = { TOMADA_CAMERA: 'mock', TOMADA_TEST_MATTE_CHUNK_S: '2', TOMADA_TEST_MATTE_DELAY_MS: '9000' }
const dirOf = (session: Pick<Session, 'projects'>): string => join(session.projects, EXAMPLE_FOLDER)
const progressOf = (session: Pick<Session, 'projects'>) => {
  const file = join(dirOf(session), MATTE_PROGRESS_FILE)
  return existsSync(file) ? parseMatteProgress(readFileSync(file, 'utf8')) : null
}
const logOf = (session: Pick<Session, 'userData'>): string => {
  const dir = join(session.userData, 'logs')
  return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n') : ''
}

async function startMatte(session: Session): Promise<void> {
  await openEditor(session)
  await session.page.getByTestId('tab-camera').click()
  await session.page.getByTestId('matte-start').click()
}

test('fechar o app no meio: o log avisa; ao reabrir o recorte continua do último pedaço pronto, sozinho, com o aviso "continuando"', async () => {
  test.setTimeout(240_000)
  s = await launchTomada({ env: MOCK })
  await startMatte(s)
  const chip = s.page.getByTestId('matte-chip')
  await expect(chip).toBeVisible()
  await expect(s.page.getByTestId('matte-chip-text')).toContainText('Recortando você do fundo:')
  await expect(s.page.getByTestId('matte-chip-text')).toContainText('%')
  await expect.poll(() => progressOf(s!)?.chunks.length ?? 0, { timeout: 30_000 }).toBeGreaterThanOrEqual(3)

  // FECHA o app no meio (como o usuário fechando a janela): nada de cancelamento silencioso
  const folder = { projects: s.projects, userData: s.userData }
  const base = s.base
  await s.close({ keep: true })
  s = undefined
  const stopped = progressOf(folder)!
  expect(stopped.status).toBe('interrupted')
  const done = stopped.chunks.length
  expect(done).toBeGreaterThanOrEqual(3)
  expect(done).toBeLessThan(12)
  expect(existsSync(join(dirOf(folder), MATTE_FILE))).toBe(false)
  expect(logOf(folder)).toContain(`interrompido pelo fechamento do app em`)
  expect(logOf(folder)).toContain(`continua do pedaço ${done + 1}`)

  // REABRE o app: continua sozinho, sem ninguém pedir
  s = await launchTomada({ base, env: MOCK })
  await expect.poll(() => logOf(s!).includes(`vou continuar do pedaço ${done + 1}`), { timeout: 30_000 }).toBe(true)
  // o aviso de que vai continuar aparece onde a pessoa estiver (aqui, a biblioteca), sem ela abrir o projeto
  await expect(s.page.getByTestId('toast')).toContainText('ficou pela metade quando o app fechou', { timeout: 20_000 })
  await openEditor(s)
  await expect(s.page.getByTestId('matte-chip-text')).toContainText('Continuando o recorte do fundo de onde parou', { timeout: 20_000 })
  await expect.poll(() => existsSync(join(dirOf(s!), MATTE_FILE)), { timeout: 60_000 }).toBe(true)
  await expect(s.page.getByTestId('matte-chip')).toHaveCount(0)
  expect(progressOf(s)).toBeNull()
  expect(existsSync(join(dirOf(s), MATTE_PARTS_DIR))).toBe(false)
  expect(logOf(s)).toContain(`retomando do pedaço ${done + 1}`)
  // a aba Câmera também sabe: o recorte está pronto
  await expect(s.page.getByTestId('matte-status')).toHaveAttribute('data-state', 'ready')
})

test('falhou no meio: aviso claro com "Tentar de novo", motivo no log, e ele CONTINUA dos pedaços prontos', async () => {
  test.setTimeout(180_000)
  s = await launchTomada({ env: { ...MOCK, TOMADA_TEST_MATTE_DELAY_MS: '2400', TOMADA_TEST_MATTE_FAIL: '1' } })
  await startMatte(s)
  const chip = s.page.getByTestId('matte-chip')
  await expect(chip).toHaveAttribute('data-state', 'failed', { timeout: 30_000 })
  await expect(s.page.getByTestId('matte-chip-text')).toContainText('Não consegui recortar você do fundo.')
  await expect(s.page.getByTestId('matte-chip-retry')).toBeVisible()
  expect(logOf(s)).toContain('Falha simulada no recorte do fundo')
  const kept = progressOf(s)!
  expect(kept.status).toBe('failed')
  expect(kept.chunks.length).toBeGreaterThanOrEqual(1)

  await s.page.getByTestId('matte-chip-retry').click()
  await expect.poll(() => existsSync(join(dirOf(s!), MATTE_FILE)), { timeout: 60_000 }).toBe(true)
  await expect(s.page.getByTestId('matte-chip')).toHaveCount(0)
  expect(logOf(s)).toContain(`retomando do pedaço ${kept.chunks.length + 1}`)
  expect(progressOf(s)).toBeNull()
})

test('toda gravação com câmera gera o recorte sozinha, em segundo plano, mesmo com o estilo "Quadro ao lado" (o padrão)', async () => {
  test.setTimeout(240_000)
  s = await launchTomada({ seed: false, env: { TOMADA_TEST_AUTOSOURCE: 'screen', TOMADA_CAMERA: 'mock', TOMADA_TEST_MATTE_CHUNK_S: '1', TOMADA_TEST_MATTE_DELAY_MS: '1500' } })
  const { page } = s
  await page.getByTestId('nav-record').click()
  await expect(page.getByTestId('camera-preview')).toHaveAttribute('data-live', 'true', { timeout: 20_000 })
  await expect(page.getByTestId('camera-style-side-by-side')).toHaveAttribute('aria-pressed', 'true') // ninguém escolheu o Apresentador
  await expect(page.getByTestId('record-start')).toBeEnabled({ timeout: 20_000 })
  await page.getByTestId('record-start').click()
  const bar = await waitForAux(s.app, 'bar', 40_000)
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording', { timeout: 30_000 })
  await page.waitForTimeout(2500)
  await bar.getByTestId('bar-stop').click()
  await expect(page.getByTestId('project-view')).toBeVisible({ timeout: 120_000 })
  const dir = join(s.projects, readdirSync(s.projects)[0]!)
  expect(parseProject(readFileSync(join(dir, 'project.json'), 'utf8')).cameraStyle).not.toBe('presenter')

  // o recorte começa logo depois de gravar, sem ninguém pedir, e termina em pedaços
  await expect.poll(() => existsSync(join(dir, MATTE_FILE)), { timeout: 90_000 }).toBe(true)
  const log = logOf(s)
  expect(log).toContain('começando, em pedaços de 1 s')
  expect(log).toMatch(/pedaço 1 pronto/)
  expect(existsSync(join(dir, MATTE_PROGRESS_FILE))).toBe(false)
  expect(existsSync(join(dir, MATTE_PARTS_DIR))).toBe(false)
})
