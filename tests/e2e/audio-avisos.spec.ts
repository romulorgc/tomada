import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { analyzeAudioQuality } from '../../src/shared/audio-quality'
import { parseProject, serializeProject } from '../../src/shared/project'
import { openEditor, readSaved, waitSaved } from './editor-helpers'
import { EXAMPLE_FOLDER, launchTomada, setContentSize, shot, type Session } from './helpers'

let session: Session | undefined
test.afterEach(async () => {
  if (!session) return
  const problems = session.problems
  await session.close()
  session = undefined
  expect(problems, 'Erros da interface').toEqual([])
})

test('avisos do PCM são visíveis no editor e na revisão depois de fechar e reabrir', async () => {
  session = await launchTomada({ env: { TOMADA_TEST_HIDDEN: '1' } })
  await setContentSize(session, 1440, 1000)
  const file = join(session.projects, EXAMPLE_FOLDER, 'project.json')
  const project = parseProject(readFileSync(file, 'utf8'))
  const pcm = new Float32Array(48_000 * 5)
  for (let i = 0; i < 48_000; i++) pcm[i] = 0.01 * Math.SQRT2 * Math.sin(2 * Math.PI * 200 * i / 48_000)
  pcm.fill(0.95, 48_000 * 4, 48_000 * 4 + 6000)
  project.audioQuality = analyzeAudioQuality(pcm, 48_000, { activeRanges: [{ start: 0, end: 1000 }] })
  project.pcmSyncWarning = true
  expect(project.audioQuality.warnings).toEqual(['clipping', 'low-voice'])
  writeFileSync(file, serializeProject(project))
  await openEditor(session)
  const notice = session.page.getByTestId('audio-quality-notice')
  await expect(notice).toBeVisible()
  await expect(notice).toHaveAttribute('role', 'alert')
  await expect(notice).toContainText('125 ms acumulados')
  await expect(notice).toContainText('-40,0 dBFS RMS')
  await expect(notice).toContainText('Não foi possível confirmar a sincronia da voz')
  await shot(session.page, 'audio-avisos-editor')
  await session.page.getByTestId('bg-violeta').click()
  await waitSaved(session)
  expect(readSaved(session).audioQuality).toEqual(project.audioQuality)
  expect(readSaved(session).pcmSyncWarning).toBe(true)

  const base = session.base
  const previousProblems = session.problems
  await session.close({ keep: true })
  session = await launchTomada({ base, env: { TOMADA_TEST_HIDDEN: '1' } })
  session.problems.push(...previousProblems)
  await setContentSize(session, 1440, 1000)
  await session.page.getByTestId('card-review').click()
  await expect(session.page.getByTestId('review-view')).toBeVisible()
  await expect(session.page.getByTestId('audio-quality-notice')).toContainText('-40,0 dBFS RMS')
  await expect(session.page.getByTestId('audio-quality-notice')).toContainText('125 ms acumulados')
  await expect(session.page.getByTestId('audio-quality-notice')).toContainText('Não foi possível confirmar a sincronia da voz')
  await shot(session.page, 'audio-avisos-revisao')
  await session.page.getByTestId('review-editor').click()
  await expect(session.page.getByTestId('editor')).toBeVisible()
  await expect(session.page.getByTestId('audio-quality-notice')).toBeVisible()
})
