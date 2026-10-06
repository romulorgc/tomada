import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createProject, parseProject } from '../../src/shared/project'
import { PIPELINE_STEPS, newPipeline } from '../../src/shared/autopilot'
import type { Transcript } from '../../src/shared/types'
import { launchTomada, ROOT, shot, type Session } from './helpers'

let session: Session | undefined
test.afterEach(async () => {
  if (session) { const problems = session.problems; await session.close(); session = undefined; expect(problems).toEqual([]) }
})

test('a Revisão destaca cortes de nota baixa e desfaz uma grafia de produto sem trocar o uso comum', async () => {
  const root = join(ROOT, 'test-results', 'acabamento-piloto-ui')
  mkdirSync(root, { recursive: true })
  const base = mkdtempSync(join(root, 'sessao-'))
  const projects = join(base, 'projetos'), userData = join(base, 'userdata'), dir = join(projects, 'dicionario')
  mkdirSync(dir, { recursive: true }); mkdirSync(userData)
  const doc = createProject({ id: 'dicionario', title: 'Demonstração sintética', sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: 108_000 } } })
  doc.autopilot = newPipeline('dicionario')
  const words: Transcript['words'] = Array.from({ length: 36 }, (_, i) => ({ i, text: i === 1 || i === 13 ? 'sintoma' : i % 12 === 11 ? 'resultado.' : 'Cadastro', start: i * 3000 + 150, end: (i + 1) * 3000 - 350, prob: .9, kind: 'word' }))
  const transcript: Transcript = { words, segments: [], vad: [], durationMs: 108_000, engine: 'teste', model: 'sintético', language: 'pt', createdAt: '2026-10-06' }
  writeFileSync(join(dir, 'project.json'), JSON.stringify(doc)); writeFileSync(join(dir, 'transcript.json'), JSON.stringify(transcript))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ dictionary: ['Sintomax'], autopilot: { mode: 'prepare', steps: Object.fromEntries(PIPELINE_STEPS.map((id) => [id, ['dictionary', 'clips', 'publish', 'notify'].includes(id)])) } }))
  const responsePath = join(base, 'respostas.json')
  writeFileSync(responsePath, JSON.stringify([
    { task: 'dictionary', match: 'Sintomax', response: { corrections: [{ i: 1, before: 'sintoma', term: 'Sintomax', context: 'product', confidence: .99 }, { i: 13, before: 'sintoma', term: 'Sintomax', context: 'common', confidence: .99 }] } },
    { task: 'clips', match: '', response: { clips: [65, 58, 49].map((score, i) => ({ title: `Resultado ${i}`, hook: 'Resolva sua tarefa agora', ranges: [[i * 12, i * 12 + 11]], score, notes: { hook: score, flow: score, value: score }, reason: 'Trecho sintético completo' })) } },
    { task: 'publish', match: 'Grafias do dicionário', response: { titles: ['Sintomax: cadastro pronto'], description: 'Demonstração sintética do Sintomax.', tags: ['sintomax'], chapters: [], clips: [] } }
  ]))
  session = await launchTomada({ base, autopilot: true, env: { TOMADA_LLM_RESPONSES: responsePath } })
  const { page } = session
  await expect(page.getByTestId('review-view')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('review-item-clip-1').getByRole('alert')).toHaveText('Nota baixa: revise antes de postar')
  await expect(page.getByTestId('review-item-clip-2').getByRole('alert')).toHaveText('Nota baixa: revise antes de postar')
  await expect(page.getByTestId('review-youtube-text')).toHaveValue(/Sintomax: cadastro pronto/)
  await expect(page.getByTestId('review-dictionary-corrections')).toContainText('sintoma → Sintomax')
  await shot(page, 'acabamento-piloto-nota-baixa-dicionario')
  await page.getByTestId('review-dictionary-undo-1').click()
  await expect(page.getByTestId('review-dictionary-corrections')).toContainText('Troca desfeita')
  const saved = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
  expect(saved.wordFixes).toEqual({})
  expect(saved.review?.dictionaryCorrections?.[0]?.undone).toBe(true)
  expect(saved.clips.map((c) => c.score)).toEqual([65, 58])
  writeFileSync(join(ROOT, 'test-results', 'acabamento-piloto-medicao.json'), JSON.stringify({ pipelineMs: saved.autopilot?.elapsedMs, clips: saved.clips.length, lowScore: saved.clips.filter((c) => saved.review?.items[c.id]?.lowScore).length, corrections: saved.review?.dictionaryCorrections?.length, undone: saved.review?.dictionaryCorrections?.[0]?.undone, steps: saved.autopilot?.steps }, null, 2))
  await page.getByTestId('review-youtube-quick').getByText('Ajustes rápidos', { exact: true }).click()
  await expect(page.getByTestId('review-youtube-transcript')).toContainText('Cadastro sintoma')
  await shot(page, 'acabamento-piloto-dicionario-desfeito')
})
