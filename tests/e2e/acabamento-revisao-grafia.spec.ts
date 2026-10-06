import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { applyDictionaryCorrections, undoDictionaryCorrection } from '../../src/shared/dictionary-corrections'
import { captionSourceOf, captionWords } from '../../src/shared/captions'
import { parseProject } from '../../src/shared/project'
import { reviewDocument } from '../../src/shared/review'
import { newPipeline } from '../../src/shared/autopilot'
import type { Project, Transcript } from '../../src/shared/types'
import { copyTree, FIXTURES_DIR } from '../helpers/fs'
import { readSaved, waitSaved } from './editor-helpers'
import { EXAMPLE_FOLDER, launchTomada, ROOT, shot, type Session } from './helpers'

let session: Session | undefined
test.afterEach(async () => { if (session) { const problems = session.problems; await session.close(); session = undefined; expect(problems).toEqual([]) } })

async function openReview(commonUndone: boolean) {
  const root = join(ROOT, 'test-results', 'acabamento-revisao-grafia')
  mkdirSync(root, { recursive: true })
  const base = mkdtempSync(join(root, 'sessao-')), dir = join(base, 'projetos', EXAMPLE_FOLDER), userData = join(base, 'userdata')
  copyTree(join(FIXTURES_DIR, 'projeto-exemplo'), dir); mkdirSync(userData)
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ autopilot: { mode: 'nothing' }, transcription: { auto: false, autoClean: false } }))
  const words: Transcript['words'] = ['Conheça', 'Jus', 'pronto.', 'Agora', 'cadastre', 'seu', 'cliente.'].map((text, i) => ({ i, text, start: i * 700 + 300, end: i * 700 + 900, prob: .99, kind: 'word' }))
  let doc = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
  doc.cuts = []; doc.mutes = []; doc.layouts = []; doc.zoomPreset = 'off'; doc.zooms = []; doc.captions.enabled = true; doc.autoCleaned = true
  doc = applyDictionaryCorrections(doc, words, [{ i: 1, last: 2, before: 'Agen daí.', term: 'Agendaí', context: 'product', confidence: .99 }], ['Agendaí'])
  if (commonUndone) doc = undoDictionaryCorrection(doc, 1)
  doc.autopilot = newPipeline(doc.id); doc.autopilot.status = 'done'; doc.autopilot.steps.forEach((s) => { s.status = 'done' })
  doc.review!.items.youtube = { origin: 'manual', decision: 'pending', edits: { cuts: [], zooms: [], layouts: [], captions: doc.captions, style: doc.style, wordFixes: { '1': 'Agendaí Pro.' }, dictionaryCorrections: doc.review!.dictionaryCorrections!.map((c) => ({ ...c, manualSpan: true })) } }
  const transcript: Transcript = { words, segments: [], vad: [], durationMs: 23_000, engine: 'teste', model: 'sintético', language: 'pt', createdAt: '2026-10-06' }
  writeFileSync(join(dir, 'project.json'), JSON.stringify(doc)); writeFileSync(join(dir, 'transcript.json'), JSON.stringify(transcript))
  const responses = join(base, 'respostas.json')
  writeFileSync(responses, JSON.stringify([{ task: 'edit', match: '', response: { ops: [{ op: 'layout', from: 1, to: 2, layout: 'screen' }], reply: 'Mudei só o layout.' } }]))
  session = await launchTomada({ base, env: { TOMADA_LLM_RESPONSES: responses } })
  // O renderer real monta o patch; esta fronteira de persistência não inicia o render de vídeo neste teste de textos.
  await session.app.evaluate(({ ipcMain }, file) => {
    const fs = process.getBuiltinModule('fs')
    ipcMain.removeHandler('review:update')
    ipcMain.handle('review:update', (_event, _id: string, itemId: string, patch: object) => {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'))
      current.review.items[itemId] = { ...current.review.items[itemId], ...patch, origin: 'manual' }
      fs.writeFileSync(file, JSON.stringify(current))
      return { ok: true, value: current }
    })
  }, join(dir, 'project.json'))
  await session.page.getByTestId('card-review').click()
  await expect(session.page.getByTestId('review-view')).toBeVisible()
  return { session, words, dir }
}

const manualCaption = (doc: Project, words: Transcript['words']) => captionWords(words, captionSourceOf(reviewDocument(doc, 'youtube'), 23_000)).filter((w) => w.i === 1 || w.i === 2)

test('a transcrição rápida usa o agrupamento manual efetivo do item depois do desfazer comum', async () => {
  const { session: s } = await openReview(true)
  await s.page.getByTestId('review-youtube-quick').getByText('Ajustes rápidos', { exact: true }).click()
  const quick = s.page.getByTestId('review-youtube-transcript')
  await expect(quick.getByRole('button')).toHaveCount(6)
  await expect(quick.getByRole('button').nth(1)).toHaveText('Agendaí Pro.')
  await expect(quick.getByRole('button').nth(2)).toHaveText('Agora')
})

test('aplicar um plano só de layout conserva o agrupamento manual, a legenda única e a transcrição rápida', async () => {
  const { session: s, words, dir } = await openReview(true)
  const page = s.page
  await page.getByTestId('review-youtube-instruction').fill('Mude só o layout desse nome')
  await page.getByTestId('review-youtube-ask').click(); await page.getByTestId('review-youtube-apply').click()
  const saved = readSaved(s)
  expect(saved.review?.items.youtube?.edits?.dictionaryCorrections?.[0]?.manualSpan).toBe(true)
  expect(saved.review?.items.youtube?.edits?.layouts.some((l) => l.layout === 'screen')).toBe(true)
  expect(manualCaption(saved, words)).toEqual([{ i: 1, text: 'Agendaí Pro.', start: 1000, end: 2300 }])
  await page.getByTestId('review-youtube-quick').getByText('Ajustes rápidos', { exact: true }).click()
  await expect(page.getByTestId('review-youtube-transcript').getByRole('button')).toHaveCount(6)
  expect(JSON.parse(readFileSync(join(dir, 'transcript.json'), 'utf8')).words).toEqual(words)
  await shot(page, 'acabamento-revisao-plano-grafia')
})

test('restaurar o original por item persiste uma sobreposição explícita sem desfazer o nome dos demais itens', async () => {
  const { session: s, words, dir } = await openReview(false)
  const page = s.page
  const openItem = async () => {
    await page.getByTestId('review-item-youtube').getByRole('button', { name: 'Abrir no editor', exact: true }).click()
    await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true')
    await page.getByTestId('tab-text').click()
  }
  await openItem()
  await page.locator('.tx-w[data-i="1"]').dblclick()
  await page.getByTestId('text-fix-open').click(); await page.getByTestId('text-fix-revert').click()
  await waitSaved(s)
  const saved = readSaved(s)
  expect(saved.review?.items.youtube?.edits?.wordFixes?.['1']).toBe('Jus')
  expect(saved.wordFixes?.['1']).toBe('Agendaí.')
  expect(manualCaption(saved, words).map((w) => w.text)).toEqual(['Jus', 'pronto.'])
  expect(captionWords(words, captionSourceOf(saved, 23_000)).filter((w) => w.i === 1 || w.i === 2).map((w) => w.text)).toEqual(['Agendaí.'])
  await page.getByTestId('back-to-library').click(); await expect(page.getByTestId('review-view')).toBeVisible()
  await openItem()
  await expect(page.locator('.tx-w[data-i="1"]')).toHaveText('Jus')
  await expect(page.locator('.tx-w[data-i="2"]')).toHaveText('pronto.')
  expect(JSON.parse(readFileSync(join(dir, 'transcript.json'), 'utf8')).words).toEqual(words)
  await shot(page, 'acabamento-revisao-original-por-item')
})
