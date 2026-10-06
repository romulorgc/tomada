/**
 * O recorte do fundo no editor (M4c), no Electron de verdade com o motor de teste da câmera (`TOMADA_CAMERA=mock`), nos casos que a
 * revisão independente achou:
 *  - escolher o Apresentador num CORTE (e só nele: o formato aberto não usa o layout) pede o recorte do fundo sozinho, e o corte exporta;
 *  - uma máscara corrompida não atrapalha a prévia de um layout que não a usa (bolha, lado a lado, tela cheia) e, no Apresentador, o erro
 *    manda para "Recortar de novo", que de fato REFAZ a máscara (não devolve o resultado guardado).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { MATTE_FILE, MATTE_META_FILE } from '../../src/shared/matte'
import type { Clip } from '../../src/shared/types'
import { probeJson } from '../helpers/media'
import { DEMO, TOPIC, cleanupLong, launchLong, longDir, readLong } from './cortes-helpers'
import { editProject } from './export-helpers'
import { openEditor, readSaved, waitSaved } from './editor-helpers'
import { EXAMPLE_FOLDER, launchTomada, type Session } from './helpers'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    cleanupLong()
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

const MOCK = { TOMADA_CAMERA: 'mock' }

const CLIP: Clip = {
  id: 'clip-1',
  title: 'Agende em três cliques, sem planilha',
  hook: 'Agende em três cliques',
  // os trechos de um corte são tempo de origem em ms (a primeira e a última frase do assunto "agenda" da demonstração)
  ranges: [{ start: DEMO.sentences[TOPIC.agenda[0]]!.startMs, end: DEMO.sentences[TOPIC.agenda[1]]!.endMs }],
  score: 90,
  notes: { hook: 88, flow: 90, value: 92 },
  reason: 'Mostra o agendamento do pedido ao horário marcado.',
  format: 'vertical',
  layoutV: 'auto',
  source: 'manual'
}

test('escolher o Apresentador num CORTE pede o recorte do fundo sozinho (o formato aberto não usa o layout) e o corte exporta com ele', async () => {
  test.setTimeout(300_000)
  s = await launchLong({
    camera: true,
    env: { ...MOCK, TOMADA_TEST_CAMERA_DELAY_MS: '300' },
    edit: (p) => {
      p.style.defaultLayout = 'side-by-side'
      p.clips = [CLIP]
    }
  })
  const dir = longDir(s)
  await openEditor(s)
  const { page } = s
  // o rosto é procurado ao abrir; o recorte do fundo ainda não existe e ninguém o pediu
  await expect.poll(() => existsSync(join(dir, 'media', 'camera-face.json')), { timeout: 30_000 }).toBe(true)
  expect(existsSync(join(dir, MATTE_FILE))).toBe(false)

  await page.getByTestId('tab-clips').click()
  const card = page.getByTestId('clip-card')
  await expect(card).toHaveCount(1)
  await card.getByTestId('clip-edit-toggle').click()
  await card.getByTestId('clip-layout-presenter').click()
  await expect(card.getByTestId('clip-layout-presenter')).toHaveAttribute('aria-pressed', 'true')
  await waitSaved(s)
  expect(readLong(s).clips[0]).toMatchObject({ layoutV: 'presenter' })
  // sem abrir a prévia do corte e sem tocar no layout do formato aberto: o app pede o recorte sozinho
  await expect.poll(() => existsSync(join(dir, MATTE_FILE)) && existsSync(join(dir, MATTE_META_FILE)), { timeout: 60_000 }).toBe(true)

  // e o corte EXPORTA (antes, a exportação do corte falhava por falta da máscara)
  await card.getByTestId('clip-select').check()
  await page.getByTestId('clips-export-selected').click()
  await expect(page.getByTestId('clip-queue-item').nth(0)).toHaveAttribute('data-state', 'done', { timeout: 240_000 })
  const out = join(dir, 'exports', 'cortes')
  const mp4 = readdirSync(out).find((n) => n.endsWith('.mp4'))
  expect(mp4, 'o corte não foi exportado').toBeDefined()
  expect(probeJson(join(out, mp4!)).streams.find((x) => x.codec_type === 'video')).toMatchObject({ width: 1080, height: 1920 })
})

test('máscara corrompida: a prévia de um layout que não a usa segue sem erro; no Apresentador o erro manda "Recortar de novo", que REFAZ a máscara', async () => {
  test.setTimeout(180_000)
  s = await launchTomada({ env: { ...MOCK, TOMADA_TEST_CAMERA_DELAY_MS: '300' } })
  editProject(s, (p) => {
    p.style.defaultLayout = 'side-by-side'
    p.zoomPreset = 'off'
    p.zooms = []
  })
  // uma máscara VÁLIDA no papel (o camera-matte.json confere com a câmera) cujo vídeo está estragado
  const dir = join(s.projects, EXAMPLE_FOLDER)
  const garbage = Buffer.alloc(4096, 7)
  writeFileSync(join(dir, MATTE_FILE), garbage)
  const cam = readSaved(s).sources.camera!
  const meta = { version: 1, engine: 'rvm-resnet50', source: cam.path, sourceMtimeMs: Math.trunc(statSync(join(dir, cam.path)).mtimeMs), frames: 100, fps: 30, frame: { w: 640, h: 360 }, createdAt: '2026-10-05T12:00:00.000Z' }
  writeFileSync(join(dir, MATTE_META_FILE), JSON.stringify(meta))

  await openEditor(s)
  const { page } = s
  // layout lado a lado (não usa a máscara): a prévia fica pronta e SEM erro, mesmo com o vídeo da máscara estragado
  await page.waitForTimeout(2500)
  await expect(page.getByTestId('preview-error')).toHaveCount(0)
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true')

  // no Apresentador a máscara é necessária: o erro aparece e diz o que fazer
  await page.getByTestId('tab-layout').click()
  await page.getByTestId('layout-presenter').click()
  await expect(page.getByTestId('preview-error')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('preview-error')).toContainText('Recortar de novo')

  // "Recortar de novo" REFAZ: a máscara estragada é substituída por um vídeo de verdade (o cache não é devolvido) e o erro some
  await page.getByTestId('tab-camera').click()
  await expect(page.getByTestId('matte-redo')).toBeVisible()
  await page.getByTestId('matte-redo').click()
  await expect.poll(() => statSync(join(dir, MATTE_FILE)).size, { timeout: 60_000 }).toBeGreaterThan(garbage.length)
  expect(readFileSync(join(dir, MATTE_FILE)).subarray(4, 8).toString('latin1'), 'a máscara refeita não é um MP4').toBe('ftyp')
  await expect(page.getByTestId('preview-error')).toHaveCount(0, { timeout: 20_000 })
})
