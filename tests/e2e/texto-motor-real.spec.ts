/**
 * O app de verdade com o MOTOR de verdade: a aba Texto transcreve o projeto de exemplo com o faster-whisper na placa
 * de vídeo (a pasta das ferramentas é a do usuário, resolvida pelo app: caminho 8.3 quando o caminho tem acento),
 * a transcrição confere com o gabarito da voz sintética, a limpeza automática se aplica sobre ela e editar apagando
 * palavras corta o vídeo. Exige o motor preparado (`npm run preparar:transcricao`).
 */
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { parseTranscript } from '../../src/shared/transcript'
import { checkAgainstGabarito } from '../helpers/gabarito'
import { openEditor, readSaved, waitSaved } from './editor-helpers'
import { EXAMPLE_FOLDER, launchTomada, shot, type Session } from './helpers'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

test('transcreve o exemplo com o faster-whisper de verdade, limpa sozinho e apagar palavras corta o vídeo', async () => {
  test.setTimeout(180_000)
  // TOMADA_TOOLS_DIR vazio: vale a pasta de ferramentas do usuário (a que a preparação pela interface criou)
  s = await launchTomada({ env: { TOMADA_TRANSCRIBER: 'faster-whisper', TOMADA_TOOLS_DIR: '', TOMADA_LLM: 'off' } })
  const { page } = s
  // O gabarito foi medido com o prompt-base: os nomes do usuário mudam a grafia
  // de hesitações no Whisper. Este áudio sintético não usa esse vocabulário.
  await page.evaluate(() => window.tomada.dictionary.set([]))
  const file = join(s.projects, EXAMPLE_FOLDER, 'transcript.json')
  rmSync(file)
  await openEditor(s)
  await page.getByTestId('tab-text').click()
  await expect(page.getByTestId('text-transcribe'), 'o motor precisa estar preparado: npm run preparar:transcricao').toBeVisible({ timeout: 20_000 })
  await page.getByTestId('text-transcribe').click()
  await expect(page.getByTestId('text-job')).toBeVisible()
  await expect(page.getByTestId('transcript-view')).toBeVisible({ timeout: 120_000 })
  await shot(page, '44-texto-motor-real')

  // o arquivo no projeto confere com o gabarito da voz
  const t = parseTranscript(readFileSync(file, 'utf8'))
  expect(t.engine).toBe('faster-whisper')
  const report = checkAgainstGabarito(t)
  expect(report.wer, `WER ${(report.wer * 100).toFixed(1)}%`).toBeLessThan(0.15)
  expect(report.worstErrMs).toBeLessThanOrEqual(150)
  await expect(page.getByTestId('transcript-view')).toHaveAttribute('data-words', String(t.words.length))

  // a limpeza automática (transcrição nova) já se aplicou sobre ela
  await expect(page.getByTestId('toast').first()).toContainText('Limpeza automática aplicada', { timeout: 30_000 })
  await waitSaved(s)
  const cuts = readSaved(s).cuts
  expect(cuts.filter((c) => c.reason === 'silence').length).toBeGreaterThanOrEqual(3)
  expect(cuts.filter((c) => c.reason === 'filler').length).toBeGreaterThanOrEqual(1)

  // apagar palavras no texto corta o vídeo (e uma palavra do começo, que a limpeza não tocou)
  const total = Number(await page.getByTestId('current-time').getAttribute('data-total-ms'))
  const target = t.words.find((w) => w.text.toLowerCase().startsWith('mostrar'))!
  await page.locator(`.tx-w[data-i="${target.i}"]`).dblclick()
  await page.keyboard.press('Delete')
  await expect(page.locator(`.tx-w[data-i="${target.i}"]`)).toHaveAttribute('data-struck', '')
  await expect.poll(async () => Number(await page.getByTestId('current-time').getAttribute('data-total-ms'))).toBeLessThan(total - 200)
})
