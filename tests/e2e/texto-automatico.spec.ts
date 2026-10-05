/**
 * O que acontece SOZINHO na M3: a transcrição começa depois de cada gravação (com o chip na biblioteca enquanto roda),
 * obedece ao botão dos Ajustes, e a limpeza automática se aplica UMA vez a um projeto recém-transcrito, desfazível e sem
 * voltar sozinha na próxima abertura. Motor e IA de teste (ver `helpers.ts`).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { parseProject } from '../../src/shared/project'
import { parseTranscript } from '../../src/shared/transcript'
import { openEditor, readSaved, waitSaved } from './editor-helpers'
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

const AUTO = { TOMADA_TEST_AUTOSOURCE: 'screen' }

/** Grava ~3 s com os dispositivos falsos, para pela barra e espera o projeto abrir. */
async function recordShort(session: Session): Promise<void> {
  const { page, app } = session
  await page.getByTestId('nav-record').click()
  await expect(page.getByTestId('camera-preview')).toHaveAttribute('data-live', 'true', { timeout: 20_000 })
  await expect(page.getByTestId('record-start')).toBeEnabled({ timeout: 20_000 })
  await page.getByTestId('record-start').click()
  const bar = await waitForAux(app, 'bar', 40_000)
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording', { timeout: 30_000 })
  await page.waitForTimeout(2500)
  await bar.getByTestId('bar-stop').click()
  await expect(page.getByTestId('project-view')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 30_000 })
}

const projectDir = (session: Session): string => join(session.projects, readdirSync(session.projects)[0]!)

test('depois de gravar a transcrição começa sozinha: chip na biblioteca, transcript.json no projeto e texto na aba', async () => {
  test.setTimeout(180_000)
  s = await launchTomada({ seed: false, env: { ...AUTO, TOMADA_TEST_TRANSCRIBE_DELAY_MS: '7000' } })
  const { page } = s
  await recordShort(s)
  const dir = projectDir(s)

  // enquanto roda: a aba mostra o andamento e a biblioteca, o chip
  await page.getByTestId('tab-text').click()
  await expect(page.getByTestId('text-job')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('back-to-library').click()
  await expect(page.getByTestId('card-transcribing')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('card-transcribing')).toContainText(/Na fila|Transcrevendo/)

  // termina: o chip some e o arquivo está no projeto, no formato do app
  await expect(page.getByTestId('card-transcribing')).toHaveCount(0, { timeout: 60_000 })
  expect(existsSync(join(dir, 'transcript.json'))).toBe(true)
  const t = parseTranscript(readFileSync(join(dir, 'transcript.json'), 'utf8'))
  expect(t.engine).toBe('teste')
  expect(t.words).toHaveLength(15)
  expect(t.createdAt).not.toBe('')

  // abrir o projeto: o texto está lá
  await page.getByTestId('card-open').click()
  await page.getByTestId('tab-text').click()
  await expect(page.getByTestId('transcript-view')).toHaveAttribute('data-words', '15')
})

test('com o botão desligado nos Ajustes a gravação não é transcrita; a aba oferece "Transcrever" e funciona', async () => {
  test.setTimeout(180_000)
  s = await launchTomada({ seed: false, env: AUTO })
  const { page } = s
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('pref-auto-transcribe')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('pref-auto-transcribe').click()
  await expect(page.getByTestId('pref-auto-transcribe')).toHaveAttribute('aria-checked', 'false')
  await recordShort(s)
  const dir = projectDir(s)

  await page.getByTestId('tab-text').click()
  await expect(page.getByTestId('text-transcribe')).toBeVisible()
  await page.waitForTimeout(1500)
  expect(existsSync(join(dir, 'transcript.json'))).toBe(false)

  await page.getByTestId('text-transcribe').click()
  await expect(page.getByTestId('transcript-view')).toHaveAttribute('data-words', '15', { timeout: 30_000 })
  expect(existsSync(join(dir, 'transcript.json'))).toBe(true)
})

/** O projeto de exemplo com uma transcrição "recém-feita" (createdAt de agora): é o que dispara a limpeza automática. */
function freshTranscript(session: Session): void {
  const file = join(session.projects, EXAMPLE_FOLDER, 'transcript.json')
  const t = JSON.parse(readFileSync(file, 'utf8')) as { createdAt: string }
  t.createdAt = new Date().toISOString()
  writeFileSync(file, `${JSON.stringify(t)}\n`)
}

async function waitCuts(session: Session, n: number): Promise<void> {
  await waitSaved(session)
  await expect.poll(() => readSaved(session).cuts.length, { timeout: 15_000 }).toBe(n)
}

test('limpeza automática: aplica UMA vez ao projeto recém-transcrito, avisa, desfaz com Ctrl+Z e não volta ao reabrir', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  freshTranscript(s)
  expect(readSaved(s).autoCleaned).toBeUndefined()
  await openEditor(s)
  const { page } = s
  await expect(page.getByTestId('toast').first()).toContainText('Limpeza automática aplicada')
  await waitCuts(s, 6) // as 3 pausas, as duas pontas e o "hã"
  expect(readSaved(s).autoCleaned).toBe(true)
  expect(readSaved(s).cuts.filter((c) => c.reason === 'silence')).toHaveLength(5)
  expect(readSaved(s).cuts.filter((c) => c.reason === 'filler')).toHaveLength(1)

  // UM passo desfaz tudo; a marca de "já aplicada" fica
  await page.keyboard.press('Control+z')
  await waitCuts(s, 0)
  expect(readSaved(s).autoCleaned).toBe(true)

  // reabrir o app: a limpeza NÃO volta sozinha
  const { base, problems } = s
  await s.close({ keep: true })
  s = await launchTomada({ base })
  s.problems.push(...problems)
  await openEditor(s)
  await s.page.getByTestId('tab-text').click()
  await expect(s.page.getByTestId('transcript-view')).toBeVisible()
  await s.page.waitForTimeout(1500)
  expect(readSaved(s).cuts).toEqual([])
})

test('limpeza automática desligada nos Ajustes: nada é aplicado, e a marca não é gasta', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  freshTranscript(s)
  const { page } = s
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('pref-auto-clean')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('pref-auto-clean').click()
  await expect(page.getByTestId('pref-auto-clean')).toHaveAttribute('aria-checked', 'false')
  await page.getByTestId('nav-library').click()
  await openEditor(s)
  await page.getByTestId('tab-text').click()
  await expect(page.getByTestId('transcript-view')).toBeVisible()
  await page.waitForTimeout(1500)
  expect(readSaved(s).cuts).toEqual([])
  expect(readSaved(s).autoCleaned).toBeUndefined()
})

test('o projeto de exemplo (transcrição de teste, sem data) não leva limpeza automática', async () => {
  s = await launchTomada()
  await openEditor(s)
  await s.page.getByTestId('tab-text').click()
  await expect(s.page.getByTestId('transcript-view')).toBeVisible()
  await s.page.waitForTimeout(1500)
  expect(readSaved(s).cuts).toEqual([])
  expect(parseProject(readFileSync(join(s.projects, EXAMPLE_FOLDER, 'project.json'), 'utf8')).autoCleaned).toBeUndefined()
})
