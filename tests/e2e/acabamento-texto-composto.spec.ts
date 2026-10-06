import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { applyDictionaryCorrections } from '../../src/shared/dictionary-corrections'
import { parseProject } from '../../src/shared/project'
import type { Transcript } from '../../src/shared/types'
import { copyTree, FIXTURES_DIR } from '../helpers/fs'
import { openEditor, readSaved, seekTo, waitSaved } from './editor-helpers'
import { EXAMPLE_FOLDER, launchTomada, ROOT, shot, type Session } from './helpers'

let session: Session | undefined
test.afterEach(async () => { if (session) { const problems = session.problems; await session.close(); session = undefined; expect(problems).toEqual([]) } })

test('a aba Texto mostra o produto composto uma vez e conserva os índices e o intervalo original ao selecionar e cortar', async () => {
  const root = join(ROOT, 'test-results', 'acabamento-texto-composto')
  mkdirSync(root, { recursive: true })
  const base = mkdtempSync(join(root, 'sessao-')), dir = join(base, 'projetos', EXAMPLE_FOLDER), userData = join(base, 'userdata')
  copyTree(join(FIXTURES_DIR, 'projeto-exemplo'), dir)
  mkdirSync(userData)
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ autopilot: { mode: 'nothing' }, transcription: { auto: false, autoClean: false } }))
  const words: Transcript['words'] = ['Conheça', 'Jus', 'pronto.', 'Agora', 'cadastre', 'seu', 'cliente.'].map((text, i) => ({ i, text, start: i * 700 + 300, end: i * 700 + 900, prob: .99, kind: 'word' }))
  const transcript: Transcript = { words, segments: [], vad: [], durationMs: 20_000, engine: 'teste', model: 'sintético', language: 'pt', createdAt: '2026-10-06' }
  const doc = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
  doc.cuts = []; doc.mutes = []; doc.autoCleaned = true; doc.zoomPreset = 'off'; doc.zooms = []
  const corrected = applyDictionaryCorrections(doc, words, [{ i: 1, last: 2, before: 'Agen daí.', term: 'Agendaí', context: 'product', confidence: .99 }], ['Agendaí'])
  writeFileSync(join(dir, 'project.json'), JSON.stringify(corrected)); writeFileSync(join(dir, 'transcript.json'), JSON.stringify(transcript))
  session = await launchTomada({ base })
  const { page } = session
  await openEditor(session); await page.getByTestId('tab-text').click()
  const view = page.getByTestId('transcript-view'), product = page.locator('.tx-w[data-i="1"]'), next = page.locator('.tx-w[data-i="3"]')
  await expect(view).toHaveAttribute('data-words', '7')
  await expect(product).toHaveText('Agendaí.')
  await expect(page.locator('.tx-w[data-i="2"]')).toHaveCount(0)
  await expect(next).toHaveText('Agora')
  await next.click()
  await expect.poll(async () => Math.abs(Number(await page.getByTestId('preview-canvas').getAttribute('data-source-ms')) - 2400)).toBeLessThan(150)
  await seekTo(page, 1800)
  await expect(page.locator('.tx-w[data-now]')).toHaveAttribute('data-i', '1')
  await product.dblclick()
  await expect(page.getByTestId('text-selection-count')).toHaveText('2 palavras selecionadas')
  await page.keyboard.press('Delete')
  await expect(product).toHaveAttribute('data-struck', '')
  await waitSaved(session)
  const cut = readSaved(session).cuts.find((c) => c.reason === 'manual' && c.enabled)!
  expect(cut.start).toBeLessThanOrEqual(1000)
  expect(cut.end).toBeGreaterThanOrEqual(2300)
  expect(cut.end).toBeLessThan(2400)
  expect(JSON.parse(readFileSync(join(dir, 'transcript.json'), 'utf8')).words).toEqual(words)
  await shot(page, 'acabamento-texto-composto')
})
