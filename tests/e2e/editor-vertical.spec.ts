/**
 * O EDITOR EM 9:16 (M4a), no Electron de verdade: alternar o formato, a edição PRÓPRIA do vertical (zooms e layouts) que persiste em
 * `project.vertical` sem mexer no 16:9, desfazer, a aba Legendas (estilos, ajustes, SRT e VTT), o guia das zonas das plataformas, a
 * prévia que é igual à exportação e o diálogo de exportar com o formato vertical.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { frameRgb, imageToRgb, probeJson, rgbDiff } from '../helpers/media'
import { editProject, exportsDirOf } from './export-helpers'
import { EXAMPLE_FOLDER, launchTomada, shot, type Session } from './helpers'
import { openEditor, previewShot, readSaved, seekPausedTo, waitSaved } from './editor-helpers'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

const frame = (page: Page) => page.getByTestId('preview-frame')
const canvasSize = (page: Page): Promise<{ w: number; h: number }> =>
  page.getByTestId('preview-canvas').evaluate((c) => ({ w: (c as HTMLCanvasElement).width, h: (c as HTMLCanvasElement).height }))

/** Leva a reprodução PARADA a `toMs` (Home e Shift+→, 1 s cada; sem cortes saída = origem): não depende de onde ela estava antes. */
async function stepTo(page: Page, _fromMs: number, toMs: number): Promise<void> {
  await seekPausedTo(page, toMs)
}

/** Pixels do amarelo de destaque (#FFD93D ±30) na prévia reduzida. */
function yellowPixels(png: Buffer, w = 270, h = 480): number {
  const rgb = imageToRgb(png, w, h)
  let n = 0
  for (let i = 0; i < rgb.length; i += 3) if (Math.abs(rgb[i]! - 255) <= 30 && Math.abs(rgb[i + 1]! - 217) <= 30 && Math.abs(rgb[i + 2]! - 61) <= 45) n++
  return n
}

async function openVertical(session: Session): Promise<void> {
  await openEditor(session)
  await session.page.getByTestId('ratio-9-16').click()
  await expect(frame(session.page)).toHaveAttribute('data-format', 'vertical')
  await expect(session.page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 })
}

test('alternar 9:16: o canvas fica em pé, o vertical ganha edição PRÓPRIA (zooms 1,35×) e o 16:9 não muda; layout, desfazer e volta', async () => {
  test.setTimeout(180_000)
  s = await launchTomada()
  const { page } = s
  await openEditor(s)
  await expect(frame(page)).toHaveAttribute('data-format', 'horizontal')
  await expect(page.getByTestId('ratio-16-9')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('safe-guide')).toHaveCount(0) // as zonas são só do vertical
  await expect.poll(() => readSaved(s!).zooms.length, { timeout: 10_000 }).toBe(1) // o 16:9 gerou os dele ao abrir
  const horizontalBefore = readSaved(s)
  const wide = await canvasSize(page)
  expect(wide.w).toBeGreaterThan(wide.h)
  await shot(page, '60-editor-16x9')

  await page.getByTestId('ratio-9-16').click()
  await expect(frame(page)).toHaveAttribute('data-format', 'vertical')
  await expect(page.getByTestId('ratio-9-16')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 })
  const tall = await canvasSize(page)
  expect(tall.h).toBeGreaterThan(tall.w)
  expect(tall.h / tall.w).toBeCloseTo(16 / 9, 1) // o canvas acompanha o tamanho da janela, arredondado
  await shot(page, '61-editor-9x16')

  // a primeira vez no 9:16 gera zooms de vertical (Moderado, 1,35×, até 3 por minuto) e grava, sem tocar nos do 16:9
  await expect.poll(() => readSaved(s!).vertical?.zoomPreset, { timeout: 10_000 }).toBe('moderate')
  const saved = readSaved(s)
  expect(saved.vertical!.zooms.length).toBeGreaterThan(0)
  expect(saved.vertical!.zooms.every((z) => z.scale === 1.35 && z.origin === 'auto')).toBe(true)
  expect(saved.zooms).toEqual(horizontalBefore.zooms)
  expect(saved.zoomPreset).toBe('moderate')
  expect(saved.style.defaultLayout).toBe(horizontalBefore.style.defaultLayout)

  // a aba Zoom do vertical mostra o preset do vertical e os zooms dele
  await page.getByTestId('tab-zoom').click()
  await expect(page.getByTestId('zoom-moderate')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('zoom-count')).toHaveText(`${saved.vertical!.zooms.length} ${saved.vertical!.zooms.length === 1 ? 'zoom' : 'zooms'}`)

  // layouts do vertical: V-A, V-B, V-C e só a câmera
  await page.getByTestId('tab-layout').click()
  for (const id of ['screen-focus', 'stack', 'screen-wide', 'camera']) await expect(page.getByTestId(`layout-${id}`)).toBeVisible()
  await expect(page.getByTestId('layout-bubble')).toHaveCount(0)
  await expect(page.getByTestId('layout-screen-focus')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('layout-stack').click()
  await expect(page.getByTestId('layout-stack')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => readSaved(s!).vertical?.layout, { timeout: 10_000 }).toBe('stack')
  expect(readSaved(s).style.defaultLayout).toBe(horizontalBefore.style.defaultLayout) // o 16:9 segue como estava
  await shot(page, '62-editor-9x16-camera-e-tela')

  // desfazer volta o layout do vertical (e só ele)
  await page.getByTestId('undo').click()
  await expect(page.getByTestId('layout-screen-focus')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => readSaved(s!).vertical?.layout, { timeout: 10_000 }).toBe('screen-focus')

  // voltar ao 16:9: os layouts e os zooms são os do 16:9
  await page.getByTestId('ratio-16-9').click()
  await expect(frame(page)).toHaveAttribute('data-format', 'horizontal')
  await expect(page.getByTestId('layout-bubble')).toBeVisible()
  await expect(page.getByTestId('layout-stack')).toHaveCount(0)
  await page.getByTestId('tab-zoom').click()
  await expect(page.getByTestId('zoom-count')).toHaveText('1 zoom')
  await expect(page.getByTestId('zoom-moderate')).toHaveAttribute('aria-pressed', 'true')
  await waitSaved(s)
})

test('legendas no 9:16: Natural (caixa mista) de partida, estilos e ajustes do vertical sem mexer na legenda do 16:9, e a legenda aparece na prévia', async () => {
  test.setTimeout(180_000)
  s = await launchTomada()
  const { page } = s
  await openVertical(s)
  const captions16 = readSaved(s).captions
  await page.getByTestId('tab-captions').click()
  await expect(page.getByTestId('captions-panel')).toBeVisible()
  await expect(page.getByTestId('captions-show')).toHaveAttribute('aria-checked', 'true') // o vertical já vem com legenda
  await expect(page.getByTestId('caption-style-natural')).toHaveAttribute('aria-pressed', 'true') // E1: 72% das legendas brasileiras são em caixa mista
  await expect(page.getByTestId('captions-words')).toHaveValue('2') // uma linha de 2 palavras
  for (const id of ['highlight', 'natural', 'clean', 'karaoke']) await expect(page.getByTestId(`caption-style-${id}`)).toBeVisible()
  await expect(page.getByTestId('captions-format-note')).toContainText(/vertical/i)
  await page.waitForTimeout(500) // as amostras dos cartões desenham quando as fontes carregam
  await shot(page, '63-aba-legendas-vertical')

  // a legenda na prévia: a palavra acesa põe o amarelo de destaque; desligada, ele some
  await stepTo(page, 0, 3000)
  const withCaption = yellowPixels(await previewShot(page))
  await page.getByTestId('captions-show').click()
  await expect(page.getByTestId('captions-show')).toHaveAttribute('aria-checked', 'false')
  await page.waitForTimeout(300)
  const without = yellowPixels(await previewShot(page))
  console.log(`prévia 9:16 em 3 s: pixels amarelos com legenda ${withCaption}, sem ${without}`)
  expect(withCaption - without).toBeGreaterThan(40)
  await page.getByTestId('captions-show').click()
  await expect(page.getByTestId('captions-show')).toHaveAttribute('aria-checked', 'true')

  // trocar de estilo e ajustar: vai para vertical.captions, nunca para a legenda do 16:9
  await page.getByTestId('caption-style-clean').click()
  await expect(page.getByTestId('caption-style-clean')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('captions-size').fill('1.3')
  await page.getByTestId('captions-words').fill('3')
  await expect.poll(() => readSaved(s!).vertical?.captions?.style, { timeout: 10_000 }).toBe('clean')
  await expect.poll(() => readSaved(s!).vertical?.captions?.size, { timeout: 10_000 }).toBe(1.3)
  await expect.poll(() => readSaved(s!).vertical?.captions?.wordsPerLine, { timeout: 10_000 }).toBe(3)
  const doc = readSaved(s)
  expect(doc.captions).toEqual(captions16) // a legenda do 16:9 não mudou
  await shot(page, '64-legenda-clean-vertical')

  // o 16:9 tem a legenda dele: desligada, Natural
  await page.getByTestId('ratio-16-9').click()
  await expect(page.getByTestId('captions-show')).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId(`caption-style-${captions16.style}`)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('captions-format-note')).toContainText(/16:9/)
  await page.getByTestId('captions-show').click()
  await expect.poll(() => readSaved(s!).captions.enabled, { timeout: 10_000 }).toBe(true)
  expect(readSaved(s).vertical?.captions?.style).toBe('clean') // e o vertical segue como estava
  await shot(page, '65-legenda-16x9')
})

test('o usuário ajusta o que o automático escolheu: câmera em cima, palavra em destaque, posição da legenda e palavras por linha (cada formato com o seu)', async () => {
  test.setTimeout(180_000)
  s = await launchTomada()
  const { page } = s
  await openVertical(s)
  const before16 = readSaved(s)

  // câmera em cima: opção do V-B, só do vertical
  await page.getByTestId('tab-layout').click()
  await expect(page.getByTestId('layout-camera-top')).toHaveAttribute('aria-checked', 'false')
  await page.getByTestId('layout-camera-top').click()
  await expect(page.getByTestId('layout-camera-top')).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => readSaved(s!).vertical?.cameraTop, { timeout: 10_000 }).toBe(true)
  expect(JSON.stringify(readSaved(s).style)).not.toContain('stackCameraTop') // a visão do vertical nunca vaza para o estilo do 16:9
  expect(readSaved(s).style).toEqual(before16.style)
  await page.getByTestId('layout-camera-top').click()
  await expect.poll(() => readSaved(s!).vertical?.cameraTop, { timeout: 10_000 }).toBeUndefined()

  // a palavra falada em destaque vem ligada e se desliga; a legenda do 16:9 não muda
  await page.getByTestId('tab-captions').click()
  await expect(page.getByTestId('captions-highlight-word')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('captions-highlight-word').click()
  await expect.poll(() => readSaved(s!).vertical?.captions?.highlightWord, { timeout: 10_000 }).toBe(false)
  expect(readSaved(s).captions).toEqual(before16.captions)

  // palavras por linha: no máximo 3 no vertical
  await expect(page.getByTestId('captions-words')).toHaveAttribute('max', '3')

  // posição: automática (acompanha o layout) até a pessoa mexer; "voltar ao automático" desfaz
  await expect(page.getByTestId('captions-position-note')).toContainText('automática')
  await page.getByTestId('captions-position').fill('0.5')
  await expect.poll(() => readSaved(s!).vertical?.captions?.positionY, { timeout: 10_000 }).toBe(0.5)
  await expect(page.getByTestId('captions-position-note')).toContainText('fixa')
  await page.getByTestId('captions-position-auto').click()
  await expect.poll(() => readSaved(s!).vertical?.captions?.positionY, { timeout: 10_000 }).toBeUndefined()
  await expect(page.getByTestId('captions-position-note')).toContainText('automática')

  // o 16:9 tem os padrões dele: até 6 palavras por linha, e o destaque dele continua ligado
  await page.getByTestId('ratio-16-9').click()
  await expect(page.getByTestId('captions-words')).toHaveAttribute('max', '6')
  await expect(page.getByTestId('captions-highlight-word')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('captions-position-note')).toHaveCount(0) // a posição automática por layout é do vertical
  await waitSaved(s)
})

test('SRT e VTT pela aba Legendas: arquivo em exports/ no tempo certo, nunca sobrescreve, e o caminho aparece', async () => {
  test.setTimeout(180_000)
  s = await launchTomada()
  const { page } = s
  await openEditor(s)
  await page.getByTestId('tab-captions').click()
  const dir = exportsDirOf(s)
  expect(existsSync(dir)).toBe(false)

  await page.getByTestId('captions-export-srt').click()
  await expect(page.getByTestId('captions-saved')).toContainText('Projeto de exemplo - legendas.srt')
  const srt = readFileSync(join(dir, 'Projeto de exemplo - legendas.srt'), 'utf8')
  expect(srt.startsWith('1\n00:00:00,400 --> 00:00:01,753\nOlá, pessoal.\n\n2\n')).toBe(true)
  expect(srt).toContain('Hoje eu vou mostrar como gravar a tela.')
  expect(srt).toContain(["é Então, vamos clicar", "aqui no botão de gravar."].join(String.fromCharCode(10))) // duas linhas de até 42 caracteres
  expect(srt).not.toContain('hã') // a hesitação não vira legenda

  await page.getByTestId('captions-export-vtt').click()
  await expect(page.getByTestId('captions-saved')).toContainText('Projeto de exemplo - legendas.vtt')
  expect(readFileSync(join(dir, 'Projeto de exemplo - legendas.vtt'), 'utf8').startsWith('WEBVTT\n\n00:00:00.400 --> 00:00:01.753\n')).toBe(true)

  // "Mostrar na pasta" no arquivo gravado: o processo principal aceita (está dentro da raiz dos projetos)
  await page.getByTestId('captions-saved').getByRole('button').click()
  const revealed = await s.app.evaluate(() => (globalThis as { __tomadaTestCalls?: { op: string; path: string }[] }).__tomadaTestCalls ?? [])
  expect(revealed).toEqual(expect.arrayContaining([{ op: 'reveal', path: join(dir, 'Projeto de exemplo - legendas.vtt') }]))

  // de novo: o nome tomado ganha " (2)" e o primeiro arquivo fica como estava
  await page.getByTestId('captions-export-srt').click()
  await expect(page.getByTestId('captions-saved')).toContainText('Projeto de exemplo - legendas (2).srt')
  expect(readdirSync(dir).sort()).toEqual(['Projeto de exemplo - legendas (2).srt', 'Projeto de exemplo - legendas.srt', 'Projeto de exemplo - legendas.vtt'])
  expect(readFileSync(join(dir, 'Projeto de exemplo - legendas.srt'), 'utf8')).toBe(srt)
})

test('SRT com um corte: a legenda seguinte vem para o tempo de SAÍDA e o que foi cortado não aparece', async () => {
  test.setTimeout(180_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.cuts = [{ id: 'c1', start: 2000, end: 5000, reason: 'manual', enabled: true }]
  })
  await openEditor(s)
  await page.getByTestId('tab-captions').click()
  await page.getByTestId('captions-export-srt').click()
  await expect(page.getByTestId('captions-saved')).toContainText('legendas.srt')
  const srt = readFileSync(join(exportsDirOf(s), 'Projeto de exemplo - legendas.srt'), 'utf8')
  expect(srt).not.toContain('mostrar')
  expect(srt).toContain('Olá, pessoal.')
  // "é" falada em 7117 ms de origem sai 3 s mais cedo: 4117 ms
  expect(srt).toContain('00:00:04,117 --> ')
  expect(srt).toContain(["é Então, vamos clicar", "aqui no botão de gravar."].join(String.fromCharCode(10)))
})

test('sem transcrição: os botões de SRT e VTT ficam desligados e a aba diz o que fazer', async () => {
  test.setTimeout(180_000)
  s = await launchTomada()
  const { page } = s
  rmSync(join(s.projects, EXAMPLE_FOLDER, 'transcript.json'))
  await openEditor(s)
  await page.getByTestId('tab-captions').click()
  await expect(page.getByTestId('captions-export-srt')).toBeDisabled()
  await expect(page.getByTestId('captions-export-vtt')).toBeDisabled()
  await expect(page.getByTestId('captions-panel')).toContainText(/transcri/i)
})

test('Zonas: mostra a caixa segura e as faixas do TikTok, Reels e Shorts só na prévia do vertical; some ao voltar ao 16:9', async () => {
  test.setTimeout(180_000)
  s = await launchTomada()
  const { page } = s
  await openVertical(s)
  await expect(page.getByTestId('safe-guide-overlay')).toHaveCount(0)
  await page.getByTestId('safe-guide').click()
  await expect(page.getByTestId('safe-guide')).toHaveAttribute('aria-pressed', 'true')
  const overlay = page.getByTestId('safe-guide-overlay')
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('[data-platform]')).toHaveCount(3)
  await expect(overlay.locator('.sg-box')).toBeVisible()
  // a caixa segura cobre 65-940 × 270-1440 do quadro
  const geo = await page.evaluate(() => {
    const f = document.querySelector('[data-testid=preview-frame]')!.getBoundingClientRect()
    const b = document.querySelector('[data-testid=safe-guide-overlay] .sg-box')!.getBoundingClientRect()
    return { x: (b.left - f.left) / f.width, y: (b.top - f.top) / f.height, w: b.width / f.width, h: b.height / f.height }
  })
  expect(geo.x).toBeCloseTo(65 / 1080, 2)
  expect(geo.y).toBeCloseTo(270 / 1920, 2)
  expect(geo.w).toBeCloseTo(875 / 1080, 2)
  expect(geo.h).toBeCloseTo(1170 / 1920, 2)
  await page.waitForTimeout(300)
  await shot(page, '66-zonas-das-plataformas')
  // o guia é da interface: não entra no documento
  expect(JSON.stringify(readSaved(s))).not.toMatch(/safeGuide|safe-guide/)
  await page.getByTestId('ratio-16-9').click()
  await expect(page.getByTestId('safe-guide-overlay')).toHaveCount(0)
  await expect(page.getByTestId('safe-guide')).toHaveCount(0)
})

test('PRÉVIA = EXPORTAÇÃO no 9:16: cada quadro da prévia se parece com o SEU quadro do arquivo vertical (com legenda) muito mais que com os dos outros instantes', async () => {
  test.setTimeout(300_000)
  s = await launchTomada()
  const { page } = s
  await openVertical(s)
  await expect.poll(() => readSaved(s!).vertical?.zoomPreset, { timeout: 10_000 }).toBe('moderate')
  const times = [3000, 5000, 8000, 11_000, 12_000, 15_000]
  const preview: Uint8Array[] = []
  let at = 0
  for (const t of times) {
    await stepTo(page, at, t)
    at = t
    preview.push(imageToRgb(await previewShot(page), 90, 160))
  }
  await waitSaved(s)

  const done = await page.evaluate(async (projectId) => {
    const { exportId } = await window.tomada.exporter.start({ projectId, resolution: '1080p', fps: 30, format: 'vertical' })
    for (;;) {
      await new Promise((r) => setTimeout(r, 150))
      const st = await window.tomada.exporter.status()
      if (st && st.exportId === exportId && (st.phase === 'done' || st.phase === 'error' || st.phase === 'cancelled')) return st
    }
  }, EXAMPLE_FOLDER)
  expect(done.message ?? '').toBe('')
  expect(done.phase).toBe('done')
  // O quadro do arquivo (bt709, 1080×1920) e o da prévia (captura do canvas pelo Chromium) diferem um pouco em cor e em
  // borda, sempre; o que prova "mesma imagem" é cada prévia parecer-se MUITO mais com o SEU quadro do arquivo do que com o dos outros instantes.
  const exported = times.map((t) => frameRgb(done.outputPath!, Math.round((t / 1000) * 30), 90, 160))
  const results: string[] = []
  times.forEach((t, k) => {
    const own = rgbDiff(preview[k]!, exported[k]!)
    const others = exported.map((e, j) => (j === k ? Infinity : rgbDiff(preview[k]!, e).mean))
    const nearest = Math.min(...others)
    results.push(`t=${t} ms: própria ${(own.mean * 100).toFixed(2)}% (muito diferentes ${(own.strongRatio * 100).toFixed(2)}%), a mais parecida dos outros instantes ${(nearest * 100).toFixed(2)}%`)
    expect(own.mean, `diferença média em t=${t}`).toBeLessThan(0.035)
    expect(own.strongRatio, `pixels muito diferentes em t=${t}`).toBeLessThan(0.06)
    expect(own.mean, `t=${t}: a prévia tem de parecer-se com o seu quadro bem mais que com o dos outros`).toBeLessThan(nearest * 0.8)
  })
  console.log('prévia × exportação vertical (90×160):' + String.fromCharCode(10) + results.join(String.fromCharCode(10)))
})

test('exportar pelo diálogo no 9:16: o formato aberto vem escolhido, o nome muda por formato e o arquivo sai 1080×1920', async () => {
  test.setTimeout(240_000)
  s = await launchTomada()
  const { page } = s
  await openVertical(s)
  await page.getByTestId('export-open').click()
  const dialog = page.getByTestId('export-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('export-format-vertical')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('export-preset-vertical')).toBeVisible()
  await expect(page.getByTestId('export-preset-1080p')).toHaveCount(0)
  await expect(page.getByTestId('export-name')).toHaveValue('Projeto de exemplo - Vertical')
  await expect(page.getByTestId('export-start')).toHaveText('Exportar Vertical 9:16')
  await expect(page.getByTestId('export-captions-warning')).toHaveCount(0) // há transcrição
  await page.waitForTimeout(400)
  await shot(page, '67-exportar-vertical')

  await page.getByTestId('export-format-horizontal').click()
  await expect(page.getByTestId('export-preset-1080p')).toBeVisible()
  await expect(page.getByTestId('export-name')).toHaveValue('Projeto de exemplo - YouTube 1080p')
  await page.getByTestId('export-format-vertical').click()
  await expect(page.getByTestId('export-name')).toHaveValue('Projeto de exemplo - Vertical')

  await page.getByTestId('export-start').click()
  await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 120_000 })
  const out = join(exportsDirOf(s), 'Projeto de exemplo - Vertical.mp4')
  const v = probeJson(out).streams.find((x) => x.codec_type === 'video')!
  expect(v).toMatchObject({ width: 1080, height: 1920 })
  await expect(page.getByTestId('export-report')).toBeVisible()
  await page.waitForTimeout(300)
  await shot(page, '68-exportar-vertical-pronto')
})

test('legenda ligada e nenhuma transcrição: o diálogo AVISA que o vídeo vertical sai sem legenda (o 16:9 não avisa)', async () => {
  test.setTimeout(180_000)
  s = await launchTomada()
  const { page } = s
  rmSync(join(s.projects, EXAMPLE_FOLDER, 'transcript.json'))
  await openVertical(s)
  await page.getByTestId('export-open').click()
  await expect(page.getByTestId('export-captions-warning')).toBeVisible()
  await expect(page.getByTestId('export-captions-warning')).toContainText(/sem legenda/)
  await page.getByTestId('export-format-horizontal').click()
  await expect(page.getByTestId('export-captions-warning')).toHaveCount(0) // no 16:9 a legenda está desligada
})
