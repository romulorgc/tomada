/**
 * Estilo da câmera na tela Gravar (M4c): "Quadro ao lado" ou "Apresentador recortado", escolhido ANTES de gravar.
 * Aparece só com tela + câmera, lembra a última escolha (o Ajustes mostra o mesmo padrão), mostra a moldura-guia só no
 * Apresentador e a escolha chega ao manifesto e ao projeto da gravação. Dispositivos falsos e `TOMADA_TEST_AUTOSOURCE`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { parseProject } from '../../src/shared/project'
import { launchTomada, shot, waitForAux, type Session } from './helpers'

let s: Session | undefined

test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

test('estilo da câmera: aparece com câmera, some sem câmera, persiste (Gravar e Ajustes) e chega ao manifesto e ao projeto', async () => {
  test.setTimeout(240_000)
  s = await launchTomada({ seed: false, env: { TOMADA_TEST_AUTOSOURCE: 'screen' } })
  let { page } = s
  await page.getByTestId('nav-record').click()
  await expect(page.getByTestId('camera-preview')).toHaveAttribute('data-live', 'true', { timeout: 20_000 })
  const side = page.getByTestId('camera-style-side-by-side')
  const presenter = page.getByTestId('camera-style-presenter')

  // padrão: Quadro ao lado, sem moldura-guia (ela é do Apresentador)
  await expect(side).toHaveAttribute('aria-pressed', 'true')
  await expect(presenter).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('framing-guide')).toHaveCount(0)

  await presenter.click()
  await expect(presenter).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('framing-guide')).toBeVisible()
  await shot(page, 'gravar-estilo-camera-apresentador')

  // sem câmera (nenhuma escolhida) ou só a tela: a escolha some
  await page.getByTestId('camera-select').selectOption('')
  await expect(side).toHaveCount(0)
  await expect(presenter).toHaveCount(0)
  await page.getByTestId('camera-select').selectOption({ index: 1 })
  await expect(presenter).toHaveAttribute('aria-pressed', 'true') // lembrou
  await page.getByTestId('mode-screen').click()
  await expect(presenter).toHaveCount(0)
  await page.getByTestId('mode-camera').click()
  await expect(presenter).toHaveCount(0)
  await page.getByTestId('mode-screen-camera').click()
  await expect(presenter).toHaveAttribute('aria-pressed', 'true')

  // o Ajustes mostra o mesmo padrão e muda a mesma preferência
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('settings-camera-style-presenter')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('settings-camera-style-side-by-side').click()
  await expect(page.getByTestId('settings-camera-style-side-by-side')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('nav-record').click()
  await expect(page.getByTestId('camera-style-side-by-side')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('camera-style-presenter').click()
  await expect.poll(async () => (await page.evaluate(() => window.tomada.record.getPrefs())).cameraStyle).toBe('presenter')

  // a última escolha volta depois de fechar e abrir o app
  const base = s.base
  await s.close({ keep: true })
  s = undefined
  s = await launchTomada({ base, seed: false, env: { TOMADA_TEST_AUTOSOURCE: 'screen' } })
  page = s.page
  await page.getByTestId('nav-record').click()
  await expect(page.getByTestId('camera-preview')).toHaveAttribute('data-live', 'true', { timeout: 20_000 })
  await expect(page.getByTestId('camera-style-presenter')).toHaveAttribute('aria-pressed', 'true')

  // grava um pouco: a escolha vai para o manifesto e para o projeto
  await expect(page.getByTestId('record-start')).toBeEnabled({ timeout: 20_000 })
  await page.getByTestId('record-start').click()
  const bar = await waitForAux(s.app, 'bar', 40_000)
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording', { timeout: 30_000 })
  await page.waitForTimeout(2500)
  await bar.getByTestId('bar-stop').click()
  await expect(page.getByTestId('project-view')).toBeVisible({ timeout: 120_000 })
  const dir = join(s.projects, readdirSync(s.projects)[0]!)
  expect(existsSync(join(dir, 'project.json'))).toBe(true)
  expect(JSON.parse(readFileSync(join(dir, 'raw/recording.json'), 'utf8')).cameraStyle).toBe('presenter')
  expect(parseProject(readFileSync(join(dir, 'project.json'), 'utf8')).cameraStyle).toBe('presenter')
})
