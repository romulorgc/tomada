/**
 * O editor (prévia + seletores): zooms automáticos ao abrir, mudanças que persistem no project.json e
 * sobrevivem a reabrir o app, "Desligado" que não regenera, e a reprodução que pula os trechos cortados.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Project } from '../../src/shared/types'
import { editProject } from './export-helpers'
import { EXAMPLE_FOLDER, launchTomada, setContentSize, shot, type Session } from './helpers'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

const readSaved = (session: Session): Project => JSON.parse(readFileSync(join(session.projects, EXAMPLE_FOLDER, 'project.json'), 'utf8')) as Project

async function openProject(session: Session): Promise<void> {
  await expect(session.page.getByTestId('project-card')).toHaveCount(1)
  await session.page.getByTestId('card-open').click()
  await expect(session.page.getByTestId('editor')).toBeVisible()
  await expect(session.page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 })
}

/** Fecha o app e abre de novo com os MESMOS dados (a pergunta é o que sobrou no disco). */
async function reopen(session: Session): Promise<Session> {
  const { base, problems } = session
  await session.close({ keep: true })
  const next = await launchTomada({ base })
  next.problems.push(...problems)
  return next
}

test('abrir um projeto sem zooms gera os do preset moderado e grava; reabrir não gera de novo', async () => {
  s = await launchTomada()
  expect(readSaved(s).zooms).toEqual([])
  await openProject(s)
  await expect(s.page.getByTestId('zoom-count')).toHaveText('3 zooms')
  await expect(s.page.getByTestId('zoom-moderate')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => readSaved(s!).zooms.length, { timeout: 10_000 }).toBe(3)
  const first = readSaved(s)
  expect(first.zoomPreset).toBe('moderate')
  expect(first.zooms.every((z) => z.end > z.start && z.scale > 1 && z.scale <= 8)).toBe(true)
  await shot(s.page, '25-editor-zoom-moderado')

  s = await reopen(s)
  await openProject(s)
  await expect(s.page.getByTestId('zoom-count')).toHaveText('3 zooms')
  // os mesmos zooms (não foram refeitos com outros ids)
  expect(readSaved(s).zooms.map((z) => z.id)).toEqual(first.zooms.map((z) => z.id))
})

test('fundo, layout, posição da câmera e preset de zoom persistem no project.json e sobrevivem a reabrir', async () => {
  s = await launchTomada()
  const { page } = s
  await openProject(s)

  await page.getByTestId('bg-violeta').click()
  await page.getByTestId('layout-side-by-side').click()
  await page.getByTestId('corner-top-left').click()
  await page.getByTestId('zoom-intense').click()

  await expect.poll(() => readSaved(s!).zoomPreset, { timeout: 10_000 }).toBe('intense')
  const saved = readSaved(s)
  expect(saved.style.defaultLayout).toBe('side-by-side')
  expect(saved.style.camera.corner).toBe('top-left')
  expect(saved.style.background.type).toBe('gradient')
  expect(saved.zooms.length).toBeGreaterThan(0)
  await expect(page.getByTestId('bg-violeta')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('layout-side-by-side')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('corner-top-left')).toHaveAttribute('aria-pressed', 'true')
  await shot(page, '26-editor-estilo-mudado')

  s = await reopen(s)
  await openProject(s)
  await expect(s.page.getByTestId('bg-violeta')).toHaveAttribute('aria-pressed', 'true')
  await expect(s.page.getByTestId('layout-side-by-side')).toHaveAttribute('aria-pressed', 'true')
  await expect(s.page.getByTestId('corner-top-left')).toHaveAttribute('aria-pressed', 'true')
  await expect(s.page.getByTestId('zoom-intense')).toHaveAttribute('aria-pressed', 'true')
  expect(readSaved(s).zooms.map((z) => z.id)).toEqual(saved.zooms.map((z) => z.id))
})

test('"Desligado" tira os zooms e eles NÃO voltam ao reabrir', async () => {
  s = await launchTomada()
  await openProject(s)
  await expect.poll(() => readSaved(s!).zooms.length, { timeout: 10_000 }).toBe(3)

  await s.page.getByTestId('zoom-off').click()
  await expect(s.page.getByTestId('zoom-count')).toHaveText('Nenhum zoom')
  await expect.poll(() => readSaved(s!).zoomPreset, { timeout: 10_000 }).toBe('off')
  expect(readSaved(s).zooms).toEqual([])

  s = await reopen(s)
  await openProject(s)
  await expect(s.page.getByTestId('zoom-off')).toHaveAttribute('aria-pressed', 'true')
  await expect(s.page.getByTestId('zoom-count')).toHaveText('Nenhum zoom')
  expect(readSaved(s).zooms).toEqual([])
})

test('a reprodução pula os trechos cortados: nenhum quadro da prévia vem de dentro do corte', async () => {
  test.setTimeout(120_000)
  s = await launchTomada({ seed: true })
  // corte de 1000 a 3000 ms (origem); a saída tem 2 s a menos
  editProject(s, (p) => {
    p.zoomPreset = 'off'
    p.cuts = [{ id: 'c1', start: 1000, end: 3000, reason: 'manual', enabled: true }]
  })
  const { page } = s
  await openProject(s)
  await expect(page.getByTestId('scrubber')).toHaveAttribute('max', '21000') // 23 s − 2 s

  // começa 400 ms antes do corte (saída 600 ms = origem 600 ms) e toca
  await page.getByTestId('scrubber').fill('600')
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 })
  await page.getByTestId('play-toggle').click()

  const seen: number[] = []
  await expect
    .poll(
      async () => {
        const v = Number(await page.getByTestId('preview-canvas').getAttribute('data-source-ms'))
        seen.push(v)
        return v
      },
      { timeout: 30_000, intervals: [40] }
    )
    .toBeGreaterThan(3600)
  await page.getByTestId('play-toggle').click() // pausa

  // vimos instantes antes do corte, e depois dele; nunca no meio (folga de 120 ms nas bordas)
  expect(seen.some((v) => v < 1000)).toBe(true)
  expect(seen.some((v) => v >= 3000)).toBe(true)
  const inside = seen.filter((v) => v > 1120 && v < 2880)
  expect(inside, `a prévia mostrou instantes de dentro do corte: ${inside.join(', ')}`).toEqual([])
  // o relógio da prévia é o de SAÍDA: pulou 2 s
  const seconds = Number(await page.getByTestId('current-time').getAttribute('data-seconds'))
  expect(seconds).toBeGreaterThan(1.5)
  expect(seconds).toBeLessThan(2.9)
})

test('o editor cabe de 1280×720 a 2560×1440 sem rolagem lateral e com tudo à vista', async () => {
  s = await launchTomada()
  const { page } = s
  await openProject(s)
  for (const [w, h] of [
    [1280, 720],
    [2560, 1440]
  ] as const) {
    await setContentSize(s, w, h)
    await page.waitForTimeout(250)
    const o = await page.evaluate(() => {
      const main = document.querySelector('main')!
      return { doc: document.documentElement.scrollWidth - window.innerWidth, main: main.scrollWidth - main.clientWidth }
    })
    expect(o, `editor ${w}x${h}`).toEqual({ doc: 0, main: 0 })
    for (const id of ['preview-canvas', 'play-toggle', 'scrubber', 'export-panel', 'style-panel']) {
      const b = await page.getByTestId(id).boundingBox()
      expect(b, id).not.toBeNull()
      expect(b!.x + b!.width, `${id} cortado em ${w}x${h}`).toBeLessThanOrEqual(w)
      expect(b!.x, `${id} para fora à esquerda em ${w}x${h}`).toBeGreaterThanOrEqual(0)
    }
    await shot(page, `27-editor-${w}x${h}`)
  }
})
