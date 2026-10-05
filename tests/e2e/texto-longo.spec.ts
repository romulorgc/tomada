/**
 * Uma hora de fala (9.000 palavras) na aba Texto: a lista é VIRTUALIZADA (só existem no DOM os parágrafos perto da
 * janela), rolar até o fim e voltar é rápido, a seleção e a busca atravessam o texto inteiro e a palavra atual
 * continua acesa. O projeto de exemplo ganha uma transcrição sintética longa (só o texto; a mídia é a de 23 s).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { openEditor } from './editor-helpers'
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

const VOCAB = ['então', 'a', 'gente', 'vai', 'abrir', 'o', 'painel', 'de', 'controle', 'e', 'mostrar', 'como', 'cada', 'passo', 'funciona', 'na', 'prática', 'sem', 'complicar', 'nada', 'né', 'tipo', 'casa', 'rapidamente', 'depois', 'exportar']
const COUNT = 9000

function longTranscript(): string {
  const words = []
  let t = 500
  for (let i = 0; i < COUNT; i++) {
    const text = VOCAB[(i * 7 + (i >> 3)) % VOCAB.length]!
    const bare = i % 25 === 24 ? `${text}.` : text
    words.push({ i, text: i % 25 === 0 ? bare.charAt(0).toUpperCase() + bare.slice(1) : bare, start: t, end: t + 330, prob: 0.95, kind: 'word' })
    t += 400 + (i % 25 === 24 ? 1300 : 0)
  }
  const last = words[words.length - 1]!
  return `${JSON.stringify({ engine: 'teste', model: 'longo', language: 'pt', durationMs: last.end + 500, words, segments: [], vad: [], createdAt: '' })}\n`
}

test('9.000 palavras: só uma janela de parágrafos no DOM, rolar até o fim é rápido, seleção e busca atravessam tudo', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  writeFileSync(join(s.projects, EXAMPLE_FOLDER, 'transcript.json'), longTranscript())
  const { page } = s
  await openEditor(s)
  await page.getByTestId('tab-text').click()
  const view = page.getByTestId('transcript-view')
  await expect(view).toHaveAttribute('data-words', String(COUNT))
  await expect(page.getByTestId('text-stats')).toContainText('9.000 palavras')

  // virtualizada: nem de longe as 9.000 palavras no DOM
  const rendered = await page.locator('.tx-w').count()
  expect(rendered).toBeGreaterThan(20)
  expect(rendered).toBeLessThan(1800)
  await shot(page, '43-texto-9000-palavras')

  // rola até o fim e confere que a última palavra aparece, e quanto tempo levou
  const t0 = Date.now()
  await expect
    .poll(
      async () => {
        await view.evaluate((el) => {
          el.scrollTop = el.scrollHeight
        })
        return page.locator('.tx-w[data-i="8999"]').count()
      },
      { timeout: 20_000, intervals: [50] }
    )
    .toBe(1)
  expect(Date.now() - t0).toBeLessThan(5000)
  expect(await page.locator('.tx-w').count()).toBeLessThan(1800)

  // volta ao começo e anda pelo meio: sempre só uma janela
  await view.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(page.locator('.tx-w[data-i="0"]')).toHaveCount(1)
  await view.evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2
  })
  await expect.poll(() => page.locator('.tx-w').count()).toBeGreaterThan(20)
  expect(await page.locator('.tx-w').count()).toBeLessThan(1800)

  // seleção entre pontos distantes: clique numa palavra, rola longe, Shift+clique em outra
  await view.evaluate((el) => {
    el.scrollTop = 0
  })
  const first = page.locator('.tx-w[data-i="3"]')
  await first.click()
  await view.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(page.locator('.tx-w[data-i="8999"]')).toHaveCount(1)
  await page.locator('.tx-w[data-i="8995"]').click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('text-selection-count')).toHaveText(`${8995 - 3 + 1} palavras selecionadas`)

  // busca em todo o texto: "casa" aparece em ~1/26 das palavras; ir ao último resultado leva a lista até lá
  await page.getByTestId('text-selection-clear').click()
  await page.keyboard.press('Control+f')
  await page.getByTestId('text-search-input').fill('casa')
  const countText = await page.getByTestId('text-search-count').textContent()
  const total = Number(/de (\d+)/.exec(countText ?? '')?.[1])
  expect(total).toBeGreaterThan(200)
  await page.getByTestId('text-search-input').press('Shift+Enter') // volta ao último resultado
  await expect(page.getByTestId('text-search-count')).toHaveText(`${total} de ${total}`)
  await expect(page.locator('.tx-w[data-match="now"]')).toHaveCount(1)
})

test('a palavra atual acompanha a reprodução e a lista a segue sem o usuário rolar', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  writeFileSync(join(s.projects, EXAMPLE_FOLDER, 'transcript.json'), longTranscript())
  const { page } = s
  await openEditor(s)
  await page.getByTestId('tab-text').click()
  await expect(page.getByTestId('transcript-view')).toHaveAttribute('data-words', String(COUNT))
  await page.locator('.tx-w[data-i="2"]').click()
  await expect(page.locator('.tx-w[data-now]')).toHaveAttribute('data-i', '2')
  await page.keyboard.press('Space')
  await expect.poll(async () => Number(await page.locator('.tx-w[data-now]').getAttribute('data-i'))).toBeGreaterThan(8)
  await page.keyboard.press('Space')
})
