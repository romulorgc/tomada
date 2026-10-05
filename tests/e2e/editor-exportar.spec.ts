/**
 * EXPORTAR pelo diálogo do editor: predefinições, nome, pasta, progresso real com cancelar, resultado (tocar,
 * mostrar na pasta, copiar caminho) e a prova de que o editor continua respondendo durante a exportação (rAF).
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { probeJson } from '../helpers/media'
import { editProject, exportsDirOf, listExports } from './export-helpers'
import { EXAMPLE_FOLDER, launchTomada, shot, type Session } from './helpers'
import { openEditor, outputTotalMs, readSaved, waitSaved } from './editor-helpers'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

const FRAME_MS = 1000 / 30

function exampleEdits(p: Parameters<Parameters<typeof editProject>[1]>[0]): void {
  p.zoomPreset = 'moderate'
  p.zooms = [{ id: 'z1', start: 7300, end: 9200, scale: 1.7, focus: 'auto', origin: 'auto' }]
  p.cuts = [{ id: 'c1', start: 2000, end: 4500, reason: 'manual', enabled: true }]
}

test('exportar pelo diálogo: predefinições, nome, pasta, arquivo conferido com ffprobe e as três ações do resultado', async () => {
  test.setTimeout(240_000)
  const out = mkdtempSync(join(tmpdir(), 'tomada-saida-'))
  s = await launchTomada({ env: { TOMADA_TEST_PICK_DIR: out } })
  const { page } = s
  editProject(s, exampleEdits)
  await openEditor(s)
  const total = await outputTotalMs(page)
  expect(total).toBe(20_500) // 23 s − 2,5 s cortados

  await page.getByTestId('export-open').click()
  const dialog = page.getByTestId('export-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('data-phase', 'form')
  // padrão: 1080p, 30 qps, nome do título, pasta exports/ do projeto
  await expect(page.getByTestId('export-preset-1080p')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('export-fps-30')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('export-name')).toHaveValue('Projeto de exemplo - YouTube 1080p')
  await expect(page.getByTestId('export-dir')).toContainText('exports')
  await expect(page.getByTestId('export-start')).toHaveText('Exportar 1080p')
  await expect(page.getByTestId('export-summary')).toContainText('20') // duração de saída
  await page.waitForTimeout(400) // a animação do diálogo termina antes da foto
  await shot(page, '42-exportar-formulario')
  // nada do formulário passa da borda do diálogo (um caminho de pasta longo não pode alargar a coluna)
  const fit = await dialog.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const out: string[] = []
    for (const child of el.querySelectorAll<HTMLElement>('[data-testid^=export-preset-], [data-testid=export-name], [data-testid=export-choose-dir], [data-testid=export-start]')) {
      const b = child.getBoundingClientRect()
      if (b.right > box.right + 0.5 || b.left < box.left - 0.5) out.push(`${child.dataset.testid}: ${b.left.toFixed(0)}..${b.right.toFixed(0)} fora de ${box.left.toFixed(0)}..${box.right.toFixed(0)}`)
    }
    return { out, scrollX: el.scrollWidth - el.clientWidth }
  })
  expect(fit.out, 'partes do formulário fora do diálogo').toEqual([])
  expect(fit.scrollX).toBe(0)

  // predefinições: 1440p e 4K, 60 qps; o nome padrão acompanha, e voltar ao 1080p30 também
  await page.getByTestId('export-preset-1440p').click()
  await expect(page.getByTestId('export-start')).toHaveText('Exportar 1440p')
  await expect(page.getByTestId('export-name')).toHaveValue('Projeto de exemplo - YouTube 1440p')
  await page.getByTestId('export-preset-2160p').click()
  await page.getByTestId('export-fps-60').click()
  await expect(page.getByTestId('export-start')).toHaveText('Exportar 4K')
  await expect(page.getByTestId('export-name')).toHaveValue('Projeto de exemplo - YouTube 4K60')
  await page.getByTestId('export-preset-1080p').click()
  await page.getByTestId('export-fps-30').click()
  await expect(page.getByTestId('export-name')).toHaveValue('Projeto de exemplo - YouTube 1080p')

  // nome e pasta escolhidos
  await page.getByTestId('export-name').fill('Minha aula final')
  await page.getByTestId('export-choose-dir').click()
  await expect(page.getByTestId('export-dir')).toHaveText(out)
  await expect(page.getByTestId('export-reset-dir')).toBeVisible()
  await page.getByTestId('export-reset-dir').click()
  await expect(page.getByTestId('export-dir')).toContainText('exports')
  await page.getByTestId('export-choose-dir').click()
  await expect(page.getByTestId('export-dir')).toHaveText(out)
  // sem nome não exporta
  await page.getByTestId('export-name').fill('   ')
  await expect(page.getByTestId('export-start')).toBeDisabled()
  await page.getByTestId('export-name').fill('Minha aula final')
  await expect(page.getByTestId('export-start')).toBeEnabled()

  await page.getByTestId('export-start').click()
  await expect(page.getByTestId('export-progress')).toBeVisible()
  // progresso REAL: quadros, velocidade e tempo restante
  await expect(page.getByTestId('export-detail')).toContainText(/\d+ de \d+ quadros/, { timeout: 60_000 })
  await expect(page.getByTestId('export-detail')).toContainText(/quadros por segundo/)
  await page.waitForTimeout(400) // a animação do diálogo termina antes da foto
  await shot(page, '22-exportando')
  const fractions: number[] = []
  const t0 = Date.now()
  while (Date.now() - t0 < 150_000 && !(await page.getByTestId('export-done').isVisible())) {
    const v = await page.getByRole('progressbar').getAttribute('aria-valuenow', { timeout: 1000 }).catch(() => null)
    if (v !== null) fractions.push(Number(v))
    await page.waitForTimeout(100)
  }
  await expect(page.getByTestId('export-done')).toBeVisible()
  expect(fractions.length).toBeGreaterThan(2)
  expect(Math.max(...fractions)).toBeGreaterThan(fractions[0]!) // a barra andou
  await page.waitForTimeout(400) // a animação do diálogo termina antes da foto
  await shot(page, '24-exportacao-pronta')
  // as três ações do resultado ficam numa linha só, dentro do diálogo
  const tops: number[] = []
  const dialogBox = (await dialog.boundingBox())!
  for (const id of ['export-play', 'export-reveal', 'export-copy']) {
    const b = (await page.getByTestId(id).boundingBox())!
    tops.push(Math.round(b.y))
    expect(b.x + b.width, `${id} passa da borda do diálogo`).toBeLessThanOrEqual(dialogBox.x + dialogBox.width)
  }
  expect(new Set(tops).size, `as ações do resultado quebraram de linha: ${tops.join(', ')}`).toBe(1)

  // o arquivo existe, na pasta escolhida, com o nome escolhido, e o ffprobe confere
  const file = join(out, 'Minha aula final.mp4')
  expect(existsSync(file)).toBe(true)
  expect(readdirSync(out)).toEqual(['Minha aula final.mp4']) // nenhum temporário sobrou
  expect(listExports(s)).toEqual([]) // e nada foi para a pasta padrão
  await expect(page.getByTestId('export-done-path')).toContainText('Minha aula final.mp4')
  await expect(page.getByTestId('export-report')).toContainText('1920×1080')
  const probe = probeJson(file)
  const video = probe.streams.find((x) => x.codec_type === 'video')!
  const audio = probe.streams.find((x) => x.codec_type === 'audio')!
  expect(video.width).toBe(1920)
  expect(video.height).toBe(1080)
  expect(video.r_frame_rate).toBe('30/1')
  expect(audio).toBeTruthy()
  expect(Math.abs(Number(probe.format.duration) * 1000 - total)).toBeLessThanOrEqual(FRAME_MS * 1.5)

  // tocar, mostrar na pasta e copiar o caminho
  await page.getByTestId('export-play').click()
  await page.getByTestId('export-reveal').click()
  await page.getByTestId('export-copy').click()
  await expect.poll(() => s!.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(file)
  const calls = await s.app.evaluate(() => (globalThis as { __tomadaTestCalls?: { op: string; path: string }[] }).__tomadaTestCalls ?? [])
  expect(calls).toEqual(expect.arrayContaining([{ op: 'open', path: file }, { op: 'reveal', path: file }]))
  await expect(page.getByTestId('toast').first()).toBeVisible()

  // exportar de novo com o MESMO nome não apaga o anterior
  await page.getByTestId('export-again').click()
  await expect(page.getByTestId('export-start')).toBeVisible()
  await page.getByTestId('export-name').fill('Minha aula final')
  await page.getByTestId('export-start').click()
  await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 150_000 })
  expect(readdirSync(out).sort()).toHaveLength(2)
  expect(existsSync(file)).toBe(true)
  await page.getByTestId('export-done-close').click()
  await expect(page.getByTestId('export-dialog')).toHaveCount(0)
  rmSync(out, { recursive: true, force: true })
})

test('cancelar a exportação apaga o parcial e volta ao formulário; Esc fecha o diálogo sem interromper', async () => {
  test.setTimeout(180_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, exampleEdits)
  await openEditor(s)

  await page.getByTestId('export-open').click()
  await page.getByTestId('export-preset-2160p').click()
  await page.getByTestId('export-fps-60').click() // 4K a 60 qps demora o bastante para dar tempo de cancelar
  await page.getByTestId('export-start').click()
  await expect(page.getByTestId('export-progress')).toBeVisible()
  await expect(page.getByTestId('export-phase')).toHaveText('Gerando o vídeo', { timeout: 30_000 })
  await expect(page.getByTestId('export-detail')).toContainText(/\d+ de \d+ quadros/, { timeout: 60_000 })

  // Esc fecha o diálogo, a exportação segue e o botão da barra vira um indicador de progresso
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('export-dialog')).toHaveCount(0)
  await expect(page.getByTestId('export-pill')).toBeVisible()
  await expect(page.getByTestId('export-open')).toHaveCount(0)
  await page.getByTestId('export-pill').click()
  await expect(page.getByTestId('export-progress')).toBeVisible()

  await page.getByTestId('export-cancel').click()
  await expect(page.getByTestId('export-cancelled')).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(400) // a animação do diálogo termina antes da foto
  await shot(page, '23-exportacao-cancelada')
  expect(listExports(s)).toEqual([]) // nenhum parcial, nenhum temporário, nenhum arquivo final
  await page.getByTestId('export-restart').click()
  await expect(page.getByTestId('export-start')).toBeVisible()
  await page.getByTestId('export-close').click()
  await expect(page.getByTestId('export-open')).toBeVisible()
})

test('falha visível: sem a mídia da tela a exportação mostra o motivo e oferece tentar de novo', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  const { page } = s
  // troca o vídeo da tela por lixo: a prévia já abre com erro desenhado e o render não consegue abrir
  writeFileSync(join(s.projects, EXAMPLE_FOLDER, 'media', 'screen.mp4'), 'isto não é um vídeo')
  await page.getByTestId('card-open').click()
  await expect(page.getByTestId('editor')).toBeVisible()
  await page.getByTestId('export-open').click()
  await page.getByTestId('export-start').click()
  await expect(page.getByTestId('export-error')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('export-error')).toContainText('Não consegui')
  await expect(page.getByTestId('export-retry')).toBeVisible()
  await page.waitForTimeout(400) // a animação do diálogo termina antes da foto
  await shot(page, '43-exportar-erro')
  expect(listExports(s)).toEqual([])
  // voltar ao formulário mostra de novo as opções
  await page.getByTestId('export-back').click()
  await expect(page.getByTestId('export-start')).toBeVisible()
  s.problems.length = 0 // o vídeo quebrado também aparece como erro de mídia no console, de propósito
})

test('o editor continua respondendo durante a exportação: rAF da tela, cliques, edição salva e reprodução', async () => {
  test.setTimeout(300_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, exampleEdits)
  await openEditor(s)
  await expect(page.getByTestId('audio-status')).toHaveAttribute('data-treated', 'true', { timeout: 60_000 })

  // conta os quadros de tela (requestAnimationFrame) e guarda o instante de cada um
  await page.evaluate(() => {
    const w = window as unknown as { __raf: { times: number[]; stop: boolean } }
    w.__raf = { times: [], stop: false }
    const loop = (t: number): void => {
      w.__raf.times.push(t)
      if (!w.__raf.stop) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })

  await page.getByTestId('export-open').click()
  await page.getByTestId('export-preset-2160p').click() // o caso mais pesado: 4K a 60 qps
  await page.getByTestId('export-fps-60').click()
  await page.getByTestId('export-start').click()
  await expect(page.getByTestId('export-detail')).toContainText(/\d+ de \d+ quadros/, { timeout: 60_000 })
  const renderStart = await page.evaluate(() => performance.now())

  // fecha o diálogo e MEXE no editor enquanto exporta
  await page.getByTestId('export-keep-editing').click()
  await expect(page.getByTestId('export-pill')).toBeVisible()
  await page.getByTestId('tab-camera').click()
  await expect(page.getByTestId('camera-panel')).toBeVisible()
  await page.getByTestId('tab-style').click()
  await page.getByTestId('bg-branco').click()
  await waitSaved(s)
  expect(readSaved(s).style.background).toMatchObject({ type: 'solid', color: '#ffffff' })
  await page.getByTestId('play-toggle').click()
  await expect.poll(async () => Number(await page.getByTestId('current-time').getAttribute('data-ms')), { timeout: 30_000 }).toBeGreaterThan(500)
  await page.getByTestId('play-toggle').click()
  await shot(page, '44-editando-durante-exportacao')

  // espera a exportação acabar (o diálogo está fechado: o resultado vem pelo aviso e pelo botão)
  await expect(page.getByTestId('export-open')).toBeVisible({ timeout: 240_000 })
  const renderEnd = await page.evaluate(() => performance.now())

  const stats = await page.evaluate(
    ({ from, to }) => {
      const w = window as unknown as { __raf: { times: number[]; stop: boolean } }
      w.__raf.stop = true
      const times = w.__raf.times.filter((t) => t >= from && t <= to)
      const seconds = (to - from) / 1000
      let worst = Infinity
      for (let a = from; a + 1000 <= to; a += 250) worst = Math.min(worst, times.filter((t) => t >= a && t < a + 1000).length)
      let maxGap = 0
      for (let i = 1; i < times.length; i++) maxGap = Math.max(maxGap, times[i]! - times[i - 1]!)
      return { frames: times.length, seconds, qps: times.length / seconds, worstSecond: worst === Infinity ? null : worst, maxGap }
    },
    { from: renderStart, to: renderEnd }
  )
  console.log(
    `UI DURANTE A EXPORTAÇÃO (4K60 de ${(await outputTotalMs(page)) / 1000} s, editor aberto e em uso): ` +
      `${stats.frames} quadros de tela em ${stats.seconds.toFixed(1)} s = ${stats.qps.toFixed(1)} qps; pior janela de 1 s = ${stats.worstSecond} qps; maior intervalo ${stats.maxGap.toFixed(0)} ms`
  )
  expect(stats.seconds).toBeGreaterThan(1.5)
  expect(stats.qps, 'a tela do editor caiu abaixo de 50 qps durante a exportação').toBeGreaterThanOrEqual(50)
  expect(stats.maxGap, 'a interface travou durante a exportação').toBeLessThan(400)

  // o resultado não passa batido: aviso na tela, e o arquivo está lá
  await expect(page.getByTestId('toast').first()).toContainText('Vídeo exportado')
  expect(listExports(s)).toHaveLength(1)
  const name = listExports(s)[0]!
  expect(name).toMatch(/4K60\.mp4$/)
  // o 4K a 60 qps SAI de verdade (o encoder por hardware desta máquina recusa essa configuração: o exportador cai no outro)
  const probe = probeJson(join(exportsDirOf(s), name))
  const video = probe.streams.find((x) => x.codec_type === 'video')!
  expect(video.width).toBe(3840)
  expect(video.height).toBe(2160)
  expect(video.r_frame_rate).toBe('60/1')
  expect(Math.abs(Number(probe.format.duration) * 1000 - 20_500)).toBeLessThan(40)
})

test('pasta de destino que não dá para usar: o erro diz o motivo, oferece voltar e não deixa nada pela metade', async () => {
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'tomada-pasta-ruim-'))
  const blocker = join(dir, 'arquivo.txt')
  writeFileSync(blocker, 'isto é um arquivo, não uma pasta')
  s = await launchTomada({ env: { TOMADA_TEST_PICK_DIR: join(blocker, 'sub') } })
  const { page } = s
  await openEditor(s)
  await page.getByTestId('export-open').click()
  await page.getByTestId('export-choose-dir').click()
  await expect(page.getByTestId('export-dir')).toContainText('arquivo.txt')
  await page.getByTestId('export-start').click()
  await expect(page.getByTestId('export-error')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('export-error')).toContainText('Não consegui usar a pasta de destino')
  await page.waitForTimeout(400) // a animação do diálogo termina antes da foto
  await shot(page, '45-exportar-pasta-invalida')
  expect(listExports(s)).toEqual([])
  expect(readdirSync(dir)).toEqual(['arquivo.txt'])
  // voltar ao formulário e escolher a pasta padrão de novo
  await page.getByTestId('export-back').click()
  await expect(page.getByTestId('export-start')).toBeVisible()
  await expect(page.getByTestId('export-dir')).toContainText('arquivo.txt') // a escolha continua à vista, para a pessoa trocar
  await page.getByTestId('export-reset-dir').click()
  await expect(page.getByTestId('export-dir')).toContainText('exports')
  rmSync(dir, { recursive: true, force: true })
})
