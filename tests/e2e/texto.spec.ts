/**
 * A aba Texto (M3) de ponta a ponta, no app de verdade e com o motor de transcrição e a IA de TESTE
 * (`TOMADA_TRANSCRIBER=mock`, `TOMADA_LLM=mock`): as palavras do projeto de exemplo, clicar busca, selecionar + Delete
 * corta (e a reprodução pula), restaurar, fichas de pausa, Ctrl+F, corrigir uma palavra, a palavra atual acesa, o painel
 * Limpeza (prévia, aplicar como UM passo desfazível, revisar por motivo, silenciar, recomeços da IA com confirmação),
 * a preparação de primeira vez (com falha, "Tentar de novo" e conclusão) e a transcrição de projeto antigo.
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { openEditor, outputTotalMs, readSaved, seekTo, waitSaved } from './editor-helpers'
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

const word = (page: Page, i: number) => page.locator(`.tx-w[data-i="${i}"]`)

async function openText(session: Session): Promise<void> {
  await openEditor(session)
  await session.page.getByTestId('tab-text').click()
  await expect(session.page.getByTestId('transcript-view')).toBeVisible()
}

/** Seleciona as palavras `a..b` arrastando o mouse sobre elas, como a pessoa faz. */
async function dragWords(page: Page, a: number, b: number): Promise<void> {
  await word(page, a).scrollIntoViewIfNeeded()
  const from = await word(page, a).boundingBox()
  const to = await word(page, b).boundingBox()
  if (!from || !to) throw new Error('Palavras fora da tela.')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  const mid = await word(page, Math.round((a + b) / 2)).boundingBox()
  if (mid) await page.mouse.move(mid.x + mid.width / 2, mid.y + mid.height / 2, { steps: 4 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 4 })
  await page.mouse.up()
}

const savedCuts = (session: Session) => readSaved(session).cuts

test('a aba Texto mostra as palavras do projeto, as pausas clicáveis e destaca a hesitação', async () => {
  s = await launchTomada()
  const { page } = s
  await openText(s)
  await expect(page.getByTestId('transcript-view')).toHaveAttribute('data-words', '36')
  await expect(page.getByTestId('text-stats')).toContainText('36 palavras')
  await expect(page.getByTestId('transcript-paragraph')).toHaveCount(3)
  await expect(word(page, 0)).toHaveText('Olá,')
  await expect(word(page, 35)).toHaveText('próxima.')
  // "hã" é hesitação pura: destacada; "tipo" e "né" são muletas que só o contexto sugere
  await expect(word(page, 19)).toHaveAttribute('data-filler', '')
  await expect(page.getByTestId('pause-chip')).toHaveCount(3)
  await expect(page.getByTestId('pause-chip').first()).toContainText('1,5 s')
  await shot(page, '40-aba-texto')
})

test('clicar numa palavra leva a prévia até ela, e a palavra atual fica acesa', async () => {
  s = await launchTomada()
  const { page } = s
  await openText(s)
  await word(page, 11).click()
  const canvas = page.getByTestId('preview-canvas')
  await expect.poll(async () => Math.abs(Number(await canvas.getAttribute('data-source-ms')) - 7451), { timeout: 10_000 }).toBeLessThan(150)
  await expect(page.locator('.tx-w[data-now]')).toHaveAttribute('data-i', '11')
  await word(page, 26).scrollIntoViewIfNeeded()
  await word(page, 26).click()
  await expect(page.locator('.tx-w[data-now]')).toHaveAttribute('data-i', '26')
  // o clique só busca: não seleciona nem corta nada
  await expect(page.getByTestId('text-selection-bar')).toHaveCount(0)
  expect(savedCuts(s)).toEqual([])
})

test('selecionar palavras e apertar Delete corta o vídeo; a reprodução pula o corte; Ctrl+Z e Restaurar devolvem', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  const { page } = s
  await openText(s)
  const before = await outputTotalMs(page)

  await dragWords(page, 12, 14)
  await expect(page.getByTestId('text-selection-count')).toHaveText('3 palavras selecionadas')
  await page.keyboard.press('Delete')
  for (const i of [12, 13, 14]) await expect(word(page, i)).toHaveAttribute('data-struck', '')
  for (const i of [11, 15]) await expect(word(page, i)).not.toHaveAttribute('data-struck', '')
  await expect(page.getByTestId('text-stats')).toContainText('3 de 36 palavras cortadas')
  await expect.poll(() => outputTotalMs(page)).toBeLessThan(before - 1000)
  await waitSaved(s)
  const cuts = savedCuts(s)
  expect(cuts).toHaveLength(1)
  expect(cuts[0]).toMatchObject({ reason: 'manual', enabled: true })

  // a reprodução não passa por dentro do corte
  await word(page, 11).click()
  await seekTo(page, 7451)
  const cut = cuts[0]!
  await page.keyboard.press('Space')
  const seen = await page.evaluate(
    ({ stopAt }) =>
      new Promise<number[]>((resolve) => {
        const el = document.querySelector('[data-testid=preview-canvas]')!
        const out: number[] = []
        const timer = setInterval(() => {
          const v = Number(el.getAttribute('data-source-ms'))
          out.push(v)
          if (v >= stopAt) {
            clearInterval(timer)
            resolve(out)
          }
        }, 25)
        setTimeout(() => {
          clearInterval(timer)
          resolve(out)
        }, 6000)
      }),
    { stopAt: cut.end + 400 }
  )
  await page.keyboard.press('Space')
  expect(Math.max(...seen)).toBeGreaterThanOrEqual(cut.end)
  expect(seen.filter((v) => v > cut.start + 120 && v < cut.end - 120)).toEqual([])

  // Ctrl+Z desfaz o corte inteiro
  await page.keyboard.press('Control+z')
  await expect(page.locator('.tx-w[data-struck]')).toHaveCount(0)
  await waitSaved(s)
  expect(savedCuts(s)).toEqual([])

  // refaz, e agora Restaurar (pela barra da seleção)
  await page.keyboard.press('Control+Shift+z')
  await expect(page.locator('.tx-w[data-struck]')).toHaveCount(3)
  await word(page, 13).dblclick() // duplo clique seleciona a palavra
  await page.getByTestId('text-restore').click()
  await expect(word(page, 13)).not.toHaveAttribute('data-struck', '')
  await expect(word(page, 12)).toHaveAttribute('data-struck', '')
  await expect(word(page, 14)).toHaveAttribute('data-struck', '')
})

test('a ficha de pausa corta a pausa e, clicada de novo, restaura', async () => {
  s = await launchTomada()
  const { page } = s
  await openText(s)
  const chip = page.getByTestId('pause-chip').first()
  const total = await outputTotalMs(page)
  await chip.click()
  await expect(chip).toHaveAttribute('data-struck', '')
  await expect.poll(() => outputTotalMs(page)).toBeLessThan(total - 1000)
  await waitSaved(s)
  expect(savedCuts(s)).toHaveLength(1)
  await chip.click()
  await expect(chip).not.toHaveAttribute('data-struck', '')
  await waitSaved(s)
  expect(savedCuts(s)).toEqual([])
  expect(await outputTotalMs(page)).toBe(total)
})

test('Ctrl+F busca palavra e frase (sem ligar para acento e pontuação); Enter anda pelos resultados; Esc fecha', async () => {
  s = await launchTomada()
  const { page } = s
  await openEditor(s)
  await page.getByTestId('tab-camera').click()
  await page.keyboard.press('Control+f')
  // leva à aba Texto e põe o foco no campo
  await expect(page.getByTestId('text-search-input')).toBeFocused()
  await page.getByTestId('text-search-input').fill('HOJE')
  await expect(page.getByTestId('text-search-count')).toHaveText('1 de 2')
  await expect(page.locator('.tx-w[data-match]')).toHaveCount(2)
  await expect(page.locator('.tx-w[data-match="now"]')).toHaveAttribute('data-i', '2')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('text-search-count')).toHaveText('2 de 2')
  await expect(page.locator('.tx-w[data-match="now"]')).toHaveAttribute('data-i', '32')
  // a prévia foi para o resultado
  await expect.poll(async () => Number(await page.getByTestId('preview-canvas').getAttribute('data-source-ms'))).toBeGreaterThan(18_000)
  await page.getByTestId('text-search-input').fill('o resultado aparece')
  await expect(page.getByTestId('text-search-count')).toHaveText('1 de 1')
  await page.getByTestId('text-search-input').fill('nao existe esta frase')
  await expect(page.getByTestId('text-search-count')).toHaveText('Nada encontrado')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('text-search')).toHaveCount(0)
  await expect(page.locator('.tx-w[data-match]')).toHaveCount(0)
})

test('corrigir o texto de uma palavra vale para a legenda, persiste e o Ctrl+Z desfaz', async () => {
  s = await launchTomada()
  const { page } = s
  await openText(s)
  await word(page, 1).dblclick()
  await expect(page.getByTestId('text-selection-count')).toHaveText('1 palavra selecionada')
  await page.getByTestId('text-fix-open').click()
  await page.getByTestId('text-fix-input').fill('pessoas')
  await page.keyboard.press('Enter')
  await expect(word(page, 1)).toHaveText('pessoas')
  await expect(word(page, 1)).toHaveAttribute('data-fixed', '')
  await waitSaved(s)
  expect(readSaved(s).wordFixes).toEqual({ '1': 'pessoas' })
  // o áudio e os tempos não mudam: nenhum corte
  expect(savedCuts(s)).toEqual([])
  await page.keyboard.press('Control+z')
  await expect(word(page, 1)).toHaveText('pessoal.')
  await waitSaved(s)
  expect(readSaved(s).wordFixes).toBeUndefined()
})

test('Limpeza: prévia do ganho, aplicar vira UM passo desfazível, revisar por motivo e restaurar um corte', async () => {
  s = await launchTomada()
  const { page } = s
  await openText(s)
  await page.getByTestId('text-pane-clean').click()
  await expect(page.getByTestId('clean-section')).toBeVisible()
  // padrão: silêncio Rápido + hesitações cortando
  await expect(page.getByTestId('clean-silence-tutorial')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('clean-preview-text')).toHaveText(/^Sai \d+,\d s · de 0:2\d para 0:1\d$/)
  await expect(page.getByTestId('clean-counts')).toContainText('silêncios: 5')
  await expect(page.getByTestId('clean-counts')).toContainText('hesitações: 1')
  const total = await outputTotalMs(page)

  await page.getByTestId('clean-apply').click()
  await waitSaved(s)
  const cuts = savedCuts(s)
  // as 3 pausas do meio e as duas pontas (antes da 1ª palavra e depois da última: o corte vai até a ponta do vídeo)
  expect(cuts.filter((c) => c.reason === 'silence')).toHaveLength(5)
  expect(cuts.filter((c) => c.reason === 'filler')).toHaveLength(1)
  expect(await outputTotalMs(page)).toBeLessThan(total - 3000)
  await expect(page.getByTestId('toast').first()).toContainText('Limpeza aplicada')
  // depois de aplicar não há mais o que fazer com as mesmas escolhas
  await expect(page.getByTestId('clean-apply')).toBeDisabled()

  // revisão por motivo
  await expect(page.getByTestId('review-silence')).toBeVisible()
  await expect(page.getByTestId('review-silence').getByTestId('review-row')).toHaveCount(5)
  await expect(page.getByTestId('review-filler').getByTestId('review-row')).toHaveCount(1)
  await expect(page.getByTestId('review-filler').getByTestId('review-row').first()).toContainText('hã')
  const row = page.getByTestId('review-silence').getByTestId('review-row').first()
  await row.getByTestId('review-toggle').click()
  await expect(row).toHaveAttribute('data-enabled', 'false')
  await waitSaved(s)
  expect(savedCuts(s).filter((c) => c.reason === 'silence' && !c.enabled)).toHaveLength(1)
  await row.getByTestId('review-toggle').click()
  await expect(row).toHaveAttribute('data-enabled', 'true')

  // e no texto: as palavras do "hã" aparecem riscadas
  await page.getByTestId('text-pane-text').click()
  await expect(word(page, 19)).toHaveAttribute('data-struck', '')

  // UM passo só desfaz tudo (depois das duas trocas do "Restaurar", que também são passos)
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await waitSaved(s)
  expect(savedCuts(s)).toEqual([])
})

test('Limpeza silenciando: a voz cala nas muletas e hesitações, a imagem e o tempo seguem', async () => {
  s = await launchTomada()
  const { page } = s
  await openText(s)
  await page.getByTestId('text-pane-clean').click()
  await page.getByTestId('clean-silence-off').click()
  await page.getByTestId('clean-crutches').click()
  await page.getByTestId('clean-mode-mute').click()
  const total = await outputTotalMs(page)
  await expect(page.getByTestId('clean-preview-text')).toContainText('Voz silenciada')
  await page.getByTestId('clean-apply').click()
  await waitSaved(s)
  const saved = readSaved(s)
  expect(saved.cuts).toEqual([])
  expect((saved.mutes ?? []).length).toBeGreaterThanOrEqual(2)
  expect((saved.mutes ?? []).every((m) => m.enabled && m.reason === 'filler')).toBe(true)
  // o tempo não muda
  expect(await outputTotalMs(page)).toBe(total)
  await expect(page.getByTestId('review-mutes')).toBeVisible()
})

test('Limpeza: recomeços da IA entram na conta e no corte', async () => {
  const file = join(tmpdir(), `tomada-e2e-recomecos-${process.pid}.json`)
  writeFileSync(file, JSON.stringify([{ match: '', response: { retakes: [{ from: 12, to: 14, reason: 'repetiu a frase' }, { from: 999, to: 1000, reason: 'fora da faixa' }] } }]))
  s = await launchTomada({ env: { TOMADA_LLM_RESPONSES: file } })
  const { page } = s
  await openText(s)
  await page.getByTestId('text-pane-clean').click()
  await page.getByTestId('clean-silence-off').click()
  await page.getByTestId('clean-hesitations').click()
  await page.getByTestId('clean-find-retakes').click()
  await expect(page.getByText('1 recomeço encontrado')).toBeVisible()
  await expect(page.getByText('1 sugestão sem sentido foi descartada.')).toBeVisible()
  await expect(page.getByTestId('clean-retakes')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('clean-counts')).toContainText('recomeços: 1')
  await page.getByTestId('clean-apply').click()
  await waitSaved(s)
  const retakes = savedCuts(s).filter((c) => c.reason === 'retake')
  expect(retakes).toHaveLength(1)
  await page.getByTestId('text-pane-text').click()
  for (const i of [12, 13, 14]) await expect(word(page, i)).toHaveAttribute('data-struck', '')
})

test('Limpeza: recomeços que cortam mais de 30% do vídeo pedem confirmação antes de aplicar', async () => {
  const file = join(tmpdir(), `tomada-e2e-muitos-${process.pid}.json`)
  writeFileSync(file, JSON.stringify([{ match: '', response: { retakes: [{ from: 0, to: 30, reason: 'tudo errado' }] } }]))
  s = await launchTomada({ env: { TOMADA_LLM_RESPONSES: file } })
  const { page } = s
  await openText(s)
  await page.getByTestId('text-pane-clean').click()
  await page.getByTestId('clean-silence-off').click()
  await page.getByTestId('clean-hesitations').click()
  await page.getByTestId('clean-find-retakes').click()
  await expect(page.getByTestId('clean-retakes')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('clean-apply').click()
  await expect(page.getByTestId('clean-confirm')).toBeVisible()
  await expect(page.getByTestId('clean-confirm')).toContainText('% do vídeo')
  await waitSaved(s)
  expect(savedCuts(s)).toEqual([]) // nada foi aplicado ainda
  await page.getByTestId('clean-confirm-ok').click()
  await waitSaved(s)
  expect(savedCuts(s).filter((c) => c.reason === 'retake')).toHaveLength(1)
})

test('IA indisponível: o recomeço mostra o motivo, sem fingir que funcionou', async () => {
  s = await launchTomada({ env: { TOMADA_LLM: 'off' } })
  const { page } = s
  await openText(s)
  await page.getByTestId('text-pane-clean').click()
  await page.getByTestId('clean-find-retakes').click()
  await expect(page.getByTestId('clean-retakes-error')).toBeVisible()
  await expect(page.getByTestId('clean-retakes-error')).toContainText('Não consegui procurar os recomeços')
  expect(savedCuts(s)).toEqual([])
})

test('sem transcrição e sem preparo: a aba guia a preparação, mostra o erro, tenta de novo e transcreve', async () => {
  test.setTimeout(90_000)
  s = await launchTomada({ env: { TOMADA_TRANSCRIBER: 'mock-unprepared', TOMADA_TEST_PREPARE_FAIL: 'model', TOMADA_TEST_PREPARE_STEP_MS: '800', TOMADA_TEST_TRANSCRIBE_DELAY_MS: '1200' } })
  const { page } = s
  rmSync(join(s.projects, EXAMPLE_FOLDER, 'transcript.json'))
  await openEditor(s)
  await page.getByTestId('tab-text').click()
  await expect(page.getByTestId('text-panel')).toContainText('Falta preparar a transcrição')
  await expect(page.getByTestId('prepare-start')).toBeVisible()
  await shot(page, '41-texto-preparar')

  await page.getByTestId('prepare-start').click()
  await expect(page.getByTestId('prepare-progress')).toBeVisible()
  await expect(page.getByTestId('prepare-step-python')).toHaveAttribute('data-status', /running|done/)
  // falha simulada no passo do modelo: erro visível, com o passo, e "Tentar de novo"
  await expect(page.getByTestId('prepare-error')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('prepare-error')).toContainText('Falha simulada')
  await expect(page.getByTestId('prepare-step-model')).toHaveAttribute('data-status', 'error')
  await shot(page, '42-texto-preparar-erro')

  await page.getByTestId('prepare-retry').click()
  await expect(page.getByTestId('prepare-progress')).toBeVisible()
  // pronta: aparece o convite para transcrever
  await expect(page.getByTestId('text-transcribe')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('text-transcribe').click()
  await expect(page.getByTestId('text-job')).toBeVisible()
  await expect(page.getByTestId('transcript-view')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('transcript-view')).toHaveAttribute('data-words', '15')
})

test('Ajustes: o dicionário persiste e a chave da IA nunca volta para a tela nem fica em texto claro', async () => {
  s = await launchTomada()
  const { page } = s
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('settings-transcription')).toBeVisible()
  await expect(page.getByTestId('prepare-ready')).toBeVisible()
  await page.getByTestId('dictionary-input').fill('Kubernetes\nTomada\nkubernetes')
  await expect(page.getByTestId('dictionary-count')).toContainText('2 de 200')
  await page.getByTestId('dictionary-save').click()
  await expect(page.getByTestId('toast').first()).toContainText('Dicionário salvo')

  const key = 'sk-teste-0123456789-abcdefghij-NAO-E-REAL'
  await page.getByTestId('ai-key-input').fill(key)
  await page.getByTestId('ai-key-save').click()
  await expect(page.getByTestId('ai-key-state')).toContainText('Há uma chave guardada')
  await expect(page.getByTestId('ai-key-input')).toHaveValue('')
  expect(await page.content()).not.toContain(key)
  // em disco: cifrada, nunca em texto claro
  const texts = readdirSync(s.userData)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readFileSync(join(s!.userData, f), 'utf8'))
  expect(texts.some((t) => t.includes('"apiKeyEnc"'))).toBe(true)
  expect(texts.every((t) => !t.includes(key))).toBe(true)

  // reabre: o dicionário voltou e a chave segue guardada
  const { base, problems } = s
  await s.close({ keep: true })
  s = await launchTomada({ base })
  s.problems.push(...problems)
  await s.page.getByTestId('nav-settings').click()
  await expect(s.page.getByTestId('dictionary-input')).toHaveValue('Kubernetes\nTomada')
  await expect(s.page.getByTestId('ai-key-state')).toContainText('Há uma chave guardada')
  await s.page.getByTestId('ai-key-clear').click()
  await expect(s.page.getByTestId('ai-key-state')).toContainText('Nenhuma chave guardada')
})
