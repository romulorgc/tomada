/**
 * A LINHA DO TEMPO do editor, mexida como a pessoa mexe (mouse e teclado de verdade): cortes por intervalo,
 * restaurar, desfazer/refazer; trilhas de Zoom e de Layout (criar arrastando, mover, redimensionar, dividir, apagar);
 * ímã; "esconder cortes"; zoom e rolagem da linha do tempo; cabeça de reprodução; altura redimensionável.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { editProject } from './export-helpers'
import { launchTomada, shot, type Session } from './helpers'
import { dragOnTrack, openEditor, outputTotalMs, playheadMs, readSaved, seekByRuler, seekTo, timelineGeometry, waitSaved, xOfDisplay } from './editor-helpers'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

const segs = (page: Page, kind: 'zoom' | 'layout'): Locator => page.locator(`[data-testid^="seg-${kind}-"]`)
const cutsEls = (page: Page): Locator => page.locator('[data-testid^="cut-"]')

async function range(loc: Locator): Promise<{ start: number; end: number }> {
  return { start: Number(await loc.getAttribute('data-start')), end: Number(await loc.getAttribute('data-end')) }
}

/** Arrasta o mouse de `from` por `dx` pixels (em passos, como a mão). */
async function dragBy(page: Page, from: { x: number; y: number }, dx: number): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + dx / 2, from.y, { steps: 5 })
  await page.mouse.move(from.x + dx, from.y, { steps: 5 })
  await page.mouse.up()
}

async function centerOf(loc: Locator): Promise<{ x: number; y: number; w: number; left: number; right: number }> {
  const b = (await loc.boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, left: b.x, right: b.x + b.width }
}

const msPerPx = async (page: Page): Promise<number> => 1 / (await timelineGeometry(page)).pxPerMs

test('arrastar um intervalo na trilha de vídeo + Delete corta (manual); Ctrl+Z desfaz, Ctrl+Shift+Z e Ctrl+Y refazem; clicar no corte restaura', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.zoomPreset = 'off'
  })
  await openEditor(s)
  await waitSaved(s)
  expect(await outputTotalMs(page)).toBe(23_000)
  await expect(page.getByTestId('tl-cut')).toBeDisabled()

  await dragOnTrack(page, 'track-video', 5000, 8000)
  const sel = page.getByTestId('tl-range')
  await expect(sel).toBeVisible()
  const r = await range(sel)
  expect(Math.abs(r.start - 5000)).toBeLessThan(120)
  expect(Math.abs(r.end - 8000)).toBeLessThan(120)
  await expect(page.getByTestId('tl-cut')).toBeEnabled()
  await shot(page, '35-linha-do-tempo-intervalo')

  await page.keyboard.press('Delete')
  await expect(cutsEls(page)).toHaveCount(1)
  await expect(sel).toHaveCount(0) // o intervalo some ao cortar
  await waitSaved(s)
  const saved = readSaved(s).cuts
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ reason: 'manual', enabled: true })
  expect(Math.abs(saved[0]!.start - r.start)).toBeLessThan(2)
  expect(Math.abs(saved[0]!.end - r.end)).toBeLessThan(2)
  expect(await outputTotalMs(page)).toBe(Math.round(23_000 - (saved[0]!.end - saved[0]!.start)))
  await shot(page, '36-linha-do-tempo-corte')

  // desfazer / refazer
  await page.keyboard.press('Control+z')
  await expect(cutsEls(page)).toHaveCount(0)
  await waitSaved(s)
  expect(readSaved(s).cuts).toEqual([])
  expect(await outputTotalMs(page)).toBe(23_000)
  await page.keyboard.press('Control+Shift+z')
  await expect(cutsEls(page)).toHaveCount(1)
  await page.keyboard.press('Control+z')
  await expect(cutsEls(page)).toHaveCount(0)
  await page.keyboard.press('Control+y')
  await expect(cutsEls(page)).toHaveCount(1)
  await waitSaved(s)
  expect(readSaved(s).cuts).toHaveLength(1)
  // os botões da barra fazem o mesmo
  await page.getByTestId('undo').click()
  await expect(cutsEls(page)).toHaveCount(0)
  await expect(page.getByTestId('undo')).toBeDisabled()
  await page.getByTestId('redo').click()
  await expect(cutsEls(page)).toHaveCount(1)

  // clicar no corte restaura (corte manual some do documento)
  await cutsEls(page).first().click()
  await expect(cutsEls(page)).toHaveCount(0)
  await waitSaved(s)
  expect(readSaved(s).cuts).toEqual([])
  expect(await outputTotalMs(page)).toBe(23_000)
  // e dá para desfazer o restaurar
  await page.keyboard.press('Control+z')
  await expect(cutsEls(page)).toHaveCount(1)

  // cortar pelo botão da barra: marca outro intervalo e usa a tesoura
  await dragOnTrack(page, 'track-video', 12_000, 14_000)
  await page.getByTestId('tl-cut').click()
  await expect(cutsEls(page)).toHaveCount(2)
  await waitSaved(s)
  expect(readSaved(s).cuts).toHaveLength(2)

  // cortar por cima de um corte manual funde os dois (não empilha). O gesto começa FORA do corte e entra nele.
  await dragOnTrack(page, 'track-video', 15_500, 13_000)
  await page.keyboard.press('Backspace')
  await waitSaved(s)
  await expect.poll(() => readSaved(s!).cuts.length).toBe(2)
  const merged = readSaved(s).cuts
  expect(Math.abs(merged[1]!.start - 12_000)).toBeLessThan(2)
  expect(merged[1]!.end - merged[1]!.start).toBeGreaterThan(3300)
  await expect(cutsEls(page)).toHaveCount(2)

  // Esc limpa o intervalo marcado
  await dragOnTrack(page, 'track-video', 18_000, 20_000)
  await expect(sel).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sel).toHaveCount(0)
})

test('corte automático restaurado só é DESLIGADO e pode ser religado com um clique', async () => {
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.zoomPreset = 'off'
    p.cuts = [{ id: 'sil1', start: 9000, end: 9700, reason: 'silence', enabled: true }]
  })
  await openEditor(s)
  expect(await outputTotalMs(page)).toBe(22_300)
  await page.getByTestId('cut-sil1').click()
  await waitSaved(s)
  expect(readSaved(s).cuts[0]).toMatchObject({ id: 'sil1', enabled: false, reason: 'silence' })
  expect(await outputTotalMs(page)).toBe(23_000)
  await expect(page.getByTestId('cut-sil1')).toHaveAttribute('data-off', 'true')
  await page.getByTestId('cut-sil1').click() // religa
  await waitSaved(s)
  expect(readSaved(s).cuts[0]!.enabled).toBe(true)
  expect(await outputTotalMs(page)).toBe(22_300)
})

test('trilha Zoom: criar arrastando, escala no painel, redimensionar, mover, não sobrepor, apagar, tecla Z; cada arraste é UM passo de desfazer', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.zoomPreset = 'off'
  })
  await openEditor(s)
  await waitSaved(s)
  await expect(page.getByTestId('track-zoom')).toContainText('zoom') // estado vazio desenhado

  await dragOnTrack(page, 'track-zoom', 4000, 7000)
  await expect(segs(page, 'zoom')).toHaveCount(1)
  await waitSaved(s)
  let z = readSaved(s).zooms
  expect(z).toHaveLength(1)
  expect(z[0]).toMatchObject({ origin: 'manual', scale: 1.7, focus: 'auto' })
  expect(Math.abs(z[0]!.start - 4000)).toBeLessThan(120)
  expect(Math.abs(z[0]!.end - 7000)).toBeLessThan(120)
  // criou e selecionou: a aba Zoom abre sozinha com o zoom
  await expect(page.getByTestId('zoom-selected-card')).toBeVisible()
  await expect(page.getByTestId('tab-zoom')).toHaveAttribute('aria-selected', 'true')

  // escala pelo painel
  await page.getByTestId('zoom-scale').fill('2.5')
  await waitSaved(s)
  expect(readSaved(s).zooms[0]!.scale).toBe(2.5)

  // redimensionar pela borda direita (+120 px)
  const seg = segs(page, 'zoom').first()
  const before = await range(seg)
  const k = await msPerPx(page)
  let c = await centerOf(seg)
  await dragBy(page, { x: c.right - 2, y: c.y }, 120)
  let after = await range(seg)
  expect(after.start).toBe(before.start)
  expect(Math.abs(after.end - (before.end + 120 * k))).toBeLessThan(60)
  // o arraste inteiro é UM passo: um Ctrl+Z volta ao tamanho de antes (não 10 passinhos)
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await range(seg)).end).toBe(before.end)

  // redimensionar pela borda esquerda (+60 px: encolhe o começo)
  c = await centerOf(seg)
  await dragBy(page, { x: c.left + 2, y: c.y }, 60)
  after = await range(seg)
  expect(after.end).toBe(before.end)
  expect(after.start).toBeGreaterThan(before.start + 60 * k - 60)
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await range(seg)).start).toBe(before.start)

  // mover o corpo (+100 px): mesma duração
  c = await centerOf(seg)
  await dragBy(page, { x: c.x, y: c.y }, 100)
  after = await range(seg)
  expect(Math.abs(after.end - after.start - (before.end - before.start))).toBeLessThanOrEqual(2)
  expect(Math.abs(after.start - (before.start + 100 * k))).toBeLessThan(60)
  await waitSaved(s)
  expect(readSaved(s).zooms[0]!.origin).toBe('manual')
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await range(seg)).start).toBe(before.start)

  // um segundo zoom adiante; arrastar a borda esquerda dele PARA DENTRO do primeiro não sobrepõe
  await dragOnTrack(page, 'track-zoom', 12_000, 15_000)
  await expect(segs(page, 'zoom')).toHaveCount(2)
  const second = segs(page, 'zoom').nth(1)
  const firstNow = await range(seg)
  c = await centerOf(second)
  await dragBy(page, { x: c.left + 2, y: c.y }, -(c.left - (await centerOf(seg)).x))
  await waitSaved(s)
  z = readSaved(s).zooms
  expect(z).toHaveLength(2)
  expect(z[1]!.start).toBeGreaterThanOrEqual(z[0]!.end)
  expect(z[0]!.end).toBe(firstNow.end)

  // criar em cima de um zoom existente não faz nada (e não quebra)
  await dragOnTrack(page, 'track-zoom', firstNow.start + 400, firstNow.end - 400)
  await expect(segs(page, 'zoom')).toHaveCount(2)

  // apagar com Delete (selecionado) e desfazer
  await segs(page, 'zoom').nth(1).click()
  await page.keyboard.press('Delete')
  await expect(segs(page, 'zoom')).toHaveCount(1)
  await page.keyboard.press('Control+z')
  await expect(segs(page, 'zoom')).toHaveCount(2)
  // apagar pelo botão do painel
  await segs(page, 'zoom').nth(1).click()
  await page.getByTestId('zoom-remove').click()
  await expect(segs(page, 'zoom')).toHaveCount(1)

  // tecla Z: zoom de 2 s a partir da cabeça de reprodução
  const at = await seekTo(page, 18_000)
  await page.keyboard.press('KeyZ')
  await expect(segs(page, 'zoom')).toHaveCount(2)
  await waitSaved(s)
  z = readSaved(s).zooms
  expect(Math.abs(z[1]!.start - at)).toBeLessThan(2)
  expect(Math.abs(z[1]!.end - z[1]!.start - 2000)).toBeLessThan(2)
  await shot(page, '37-linha-do-tempo-zooms')
})

test('ímã: o segmento gruda na cabeça de reprodução e nas bordas dos outros, com a guia à vista', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.zoomPreset = 'off'
  })
  await openEditor(s)

  // 1) o fim de um zoom criado a poucos pixels da cabeça de reprodução cai EXATAMENTE nela
  const headRaw = await seekTo(page, 10_000)
  const head = Math.round(headRaw)
  const g = await timelineGeometry(page)
  const lane = (await page.getByTestId('track-zoom').boundingBox())!
  const y = lane.y + lane.height / 2
  await page.mouse.move(xOfDisplay(g, 6000), y)
  await page.mouse.down()
  await page.mouse.move(xOfDisplay(g, 8000), y, { steps: 5 })
  await page.mouse.move(xOfDisplay(g, head) - 5, y, { steps: 5 }) // 5 px antes (dentro dos 8 px do ímã)
  await expect(page.getByTestId('snap-guide')).toBeVisible()
  await page.mouse.up()
  await expect(page.getByTestId('snap-guide')).toHaveCount(0)
  await waitSaved(s)
  let z = readSaved(s).zooms
  expect(z).toHaveLength(1)
  expect(Math.abs(z[0]!.end - headRaw)).toBeLessThan(1.5)

  // 2) o começo de outro, criado perto da borda direita do primeiro, gruda nela
  const first = z[0]!
  await page.mouse.move(xOfDisplay(g, first.end) + 5 + 0.01, y)
  await page.mouse.down()
  await page.mouse.move(xOfDisplay(g, first.end + 1500), y, { steps: 5 })
  await page.mouse.move(xOfDisplay(g, first.end + 3000), y, { steps: 5 })
  await page.mouse.up()
  await waitSaved(s)
  z = readSaved(s).zooms
  expect(z).toHaveLength(2)
  expect(z[1]!.start).toBeGreaterThanOrEqual(first.end)
  expect(Math.abs(z[1]!.start - first.end)).toBeLessThan(1.5)

  // 3) longe de qualquer borda (mais de 8 px) NÃO gruda
  await seekByRuler(page, 21_000)
  const far = z[1]!.end + 2000
  await page.mouse.move(xOfDisplay(g, far), y)
  await page.mouse.down()
  await page.mouse.move(xOfDisplay(g, far + 900), y, { steps: 4 })
  await page.mouse.up()
  await waitSaved(s)
  z = readSaved(s).zooms
  expect(z).toHaveLength(3)
  expect(Math.abs(z[2]!.start - far)).toBeLessThan(60)
  expect(Math.abs(z[2]!.start - z[1]!.end)).toBeGreaterThan(500)
})

test('trilha Layout: criar arrastando, trocar o layout do trecho, S divide na cabeça de reprodução, apagar; layout do vídeo na aba', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.zoomPreset = 'off'
  })
  await openEditor(s)
  await expect(page.getByTestId('track-layout')).toContainText('Tela e câmera') // o estado vazio diz qual layout vale

  await dragOnTrack(page, 'track-layout', 3000, 9000)
  await expect(segs(page, 'layout')).toHaveCount(1)
  await waitSaved(s)
  let l = readSaved(s).layouts
  expect(l).toHaveLength(1)
  expect(l[0]!.layout).not.toBe('bubble') // o padrão é a bolha: o trecho novo é de outro layout
  await expect(page.getByTestId('tab-layout')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('layout-selected-card')).toBeVisible()

  await page.getByTestId('layout-seg-camera').click()
  await waitSaved(s)
  expect(readSaved(s).layouts[0]!.layout).toBe('camera')
  await expect(page.getByTestId('layout-seg-camera')).toHaveAttribute('aria-pressed', 'true')

  // S divide na cabeça de reprodução
  const head = await seekTo(page, 6000)
  await page.keyboard.press('KeyS')
  await expect(segs(page, 'layout')).toHaveCount(2)
  await waitSaved(s)
  l = readSaved(s).layouts
  expect(l).toHaveLength(2)
  expect(Math.abs(l[0]!.end - head)).toBeLessThan(2)
  expect(l[0]!.end).toBe(l[1]!.start)
  expect(l[0]!.layout).toBe(l[1]!.layout)
  // o segundo pedaço (selecionado) vira lado a lado
  await page.getByTestId('layout-seg-side-by-side').click()
  await waitSaved(s)
  expect(readSaved(s).layouts.map((x) => x.layout)).toEqual(['camera', 'side-by-side'])
  await shot(page, '38-linha-do-tempo-layouts')

  // S fora de qualquer trecho divide o layout PADRÃO em dois trechos (para trocar o de um dos lados)
  const head2 = await seekTo(page, 15_000)
  await page.keyboard.press('KeyS')
  await expect(segs(page, 'layout')).toHaveCount(4)
  await waitSaved(s)
  l = readSaved(s).layouts
  expect(l.map((x) => x.layout)).toEqual(['camera', 'side-by-side', 'bubble', 'bubble'])
  expect(l[2]!.start).toBe(l[1]!.end)
  expect(Math.abs(l[2]!.end - head2)).toBeLessThan(2)
  expect(l[3]!.end).toBe(23_000)

  // apagar o selecionado (o último pedaço, recém-criado) e desfazer
  await page.getByTestId('layout-remove').click()
  await expect(segs(page, 'layout')).toHaveCount(3)
  await page.keyboard.press('Control+z')
  await expect(segs(page, 'layout')).toHaveCount(4)

  // layout do VÍDEO na aba: muda o padrão do documento
  await page.getByTestId('layout-screen').click()
  await waitSaved(s)
  expect(readSaved(s).style.defaultLayout).toBe('screen')
})

test('esconder cortes colapsa a linha do tempo para o tempo de SAÍDA; a emenda restaura; a cabeça de reprodução continua certa', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.zoomPreset = 'off'
    p.cuts = [{ id: 'c1', start: 5000, end: 10_000, reason: 'manual', enabled: true }]
  })
  await openEditor(s)
  const open = await timelineGeometry(page)
  const cutBox = (await page.getByTestId('cut-c1').boundingBox())!
  expect(cutBox.width).toBeGreaterThan(open.pxPerMs * 4500) // o corte aparece com a largura de 5 s
  expect(await page.getByTestId('cut-c1').getAttribute('class')).toContain('tl-cut')
  await shot(page, '39-linha-do-tempo-cortes-visiveis')

  await page.getByTestId('tl-hide-cuts').click()
  await expect(page.getByTestId('timeline-scroll')).toHaveAttribute('data-hide-cuts', 'true')
  const hidden = await timelineGeometry(page)
  // 23 s → 18 s no mesmo espaço: cada ms ocupa 23/18 mais pixels
  expect(hidden.pxPerMs / open.pxPerMs).toBeGreaterThan(23 / 18 - 0.03)
  expect(hidden.pxPerMs / open.pxPerMs).toBeLessThan(23 / 18 + 0.03)
  expect(await page.getByTestId('cut-c1').getAttribute('class')).toContain('tl-seam')
  await shot(page, '40-linha-do-tempo-cortes-escondidos')

  // clicar na régua no instante de SAÍDA 6 s leva à ORIGEM 11 s (pulou os 5 s cortados)
  await seekByRuler(page, 6000)
  expect(Math.abs((await playheadMs(page)) - 11_000)).toBeLessThan(80)
  // e antes do corte são o mesmo tempo
  await seekByRuler(page, 2000)
  expect(Math.abs((await playheadMs(page)) - 2000)).toBeLessThan(80)

  // a emenda restaura o corte
  await page.getByTestId('cut-c1').click()
  await waitSaved(s)
  expect(readSaved(s).cuts).toEqual([])
  await page.getByTestId('tl-hide-cuts').click()
  await expect(page.getByTestId('timeline-scroll')).toHaveAttribute('data-hide-cuts', 'false')
})

test('zoom da linha do tempo: Ctrl+roda ancorado no ponteiro, botões, controle e "ajustar"; a roda sozinha rola na horizontal', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  const { page } = s
  await openEditor(s)
  const scroll = page.getByTestId('timeline-scroll')
  const fit = await timelineGeometry(page)
  expect(fit.scrollLeft).toBe(0)
  const sw = await scroll.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
  expect(sw.scroll).toBeLessThanOrEqual(sw.client + 1) // ajustada à largura: sem rolagem

  // a régua tem marcas legíveis
  expect(await page.locator('[data-testid=timeline-ruler] .tl-tick em').count()).toBeGreaterThan(3)

  // botão de aproximar
  await page.getByTestId('tl-zoom-in').click()
  await expect.poll(async () => (await timelineGeometry(page)).pxPerMs).toBeGreaterThan(fit.pxPerMs * 1.4)
  await page.getByTestId('tl-fit').click()
  await expect.poll(async () => (await timelineGeometry(page)).pxPerMs).toBeCloseTo(fit.pxPerMs, 6)

  // Ctrl+roda: o instante sob o ponteiro continua sob o ponteiro
  const box = (await scroll.boundingBox())!
  const px = box.x + box.width * 0.62
  const py = box.y + box.height / 2
  const msAt = async (): Promise<number> => {
    const g = await timelineGeometry(page)
    return (px - g.contentX) / g.pxPerMs
  }
  const anchor = await msAt()
  await page.mouse.move(px, py)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -500)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await timelineGeometry(page)).pxPerMs).toBeGreaterThan(fit.pxPerMs * 1.5)
  const zoomed = await timelineGeometry(page)
  expect(zoomed.scrollLeft).toBeGreaterThan(0)
  expect(Math.abs((await msAt()) - anchor)).toBeLessThan(3 / zoomed.pxPerMs + 20)
  await shot(page, '41-linha-do-tempo-aproximada')

  // roda sozinha rola na horizontal
  const left0 = (await timelineGeometry(page)).scrollLeft
  await page.mouse.wheel(0, 240)
  await expect.poll(async () => (await timelineGeometry(page)).scrollLeft).toBeGreaterThan(left0 + 100)
  await page.mouse.wheel(0, -100000)
  await expect.poll(async () => (await timelineGeometry(page)).scrollLeft).toBe(0)

  // o controle deslizante leva da escala "cabe tudo" até o máximo e de volta
  await page.getByTestId('tl-zoom-slider').fill('1000')
  const max = await timelineGeometry(page)
  expect(max.pxPerMs).toBeGreaterThan(zoomed.pxPerMs)
  await page.getByTestId('tl-zoom-slider').fill('0')
  await expect.poll(async () => (await timelineGeometry(page)).pxPerMs).toBeCloseTo(fit.pxPerMs, 5)
  // afastar além do "cabe tudo" não passa do ajuste
  await page.getByTestId('tl-zoom-out').click()
  expect((await timelineGeometry(page)).pxPerMs).toBeCloseTo(fit.pxPerMs, 5)
})

test('cabeça de reprodução: arrastar na régua leva o vídeo junto; clicar na trilha também; ao tocar a linha do tempo a acompanha', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.zoomPreset = 'off'
  })
  await openEditor(s)
  const g = await timelineGeometry(page)

  // arrastar pela régua
  await page.mouse.move(xOfDisplay(g, 2000), g.rulerY)
  await page.mouse.down()
  await page.mouse.move(xOfDisplay(g, 5000), g.rulerY, { steps: 6 })
  await page.mouse.move(xOfDisplay(g, 9000), g.rulerY, { steps: 6 })
  await page.mouse.up()
  expect(Math.abs((await playheadMs(page)) - 9000)).toBeLessThan(80)
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 })
  expect(Math.abs(Number(await page.getByTestId('preview-canvas').getAttribute('data-source-ms')) - 9000)).toBeLessThan(80)

  // um clique (sem arrastar) na trilha de vídeo também leva a cabeça até lá
  const lane = (await page.getByTestId('track-video').boundingBox())!
  await page.mouse.click(xOfDisplay(g, 14_000), lane.y + lane.height / 2)
  expect(Math.abs((await playheadMs(page)) - 14_000)).toBeLessThan(80)
  // e um clique no vazio da trilha de zoom também (sem criar nada)
  const zl = (await page.getByTestId('track-zoom').boundingBox())!
  await page.mouse.click(xOfDisplay(g, 3000), zl.y + zl.height / 2)
  expect(Math.abs((await playheadMs(page)) - 3000)).toBeLessThan(80)
  await expect(segs(page, 'zoom')).toHaveCount(0)

  // aproxima bastante e toca: a linha do tempo rola para manter a cabeça à vista
  await page.getByTestId('tl-zoom-slider').fill('800')
  await page.keyboard.press('Home')
  await page.keyboard.press('Space')
  await expect.poll(async () => (await timelineGeometry(page)).scrollLeft, { timeout: 30_000 }).toBeGreaterThan(50)
  const head = await page.getByTestId('playhead').boundingBox()
  const viewport = (await page.getByTestId('timeline-scroll').boundingBox())!
  expect(head!.x).toBeGreaterThanOrEqual(viewport.x - 2)
  expect(head!.x).toBeLessThanOrEqual(viewport.x + viewport.width + 2)
  await page.keyboard.press('Space')
})

test('a altura da linha do tempo se ajusta arrastando a alça (ou com ↑/↓) e a prévia cede espaço sem sumir', async () => {
  test.setTimeout(60_000)
  s = await launchTomada()
  const { page } = s
  await openEditor(s)
  const heightOf = async (): Promise<number> => (await page.getByTestId('timeline').boundingBox())!.height
  const h0 = await heightOf()
  const preview0 = (await page.getByTestId('preview-frame').boundingBox())!.height
  const handle = (await page.getByTestId('timeline-split').boundingBox())!
  const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x, from.y - 40, { steps: 4 })
  await page.mouse.move(from.x, from.y - 90, { steps: 4 })
  await page.mouse.up()
  // O React aplica a altura no quadro seguinte: sob carga (outras baterias rodando na máquina) ler logo depois do mouse.up pegava a altura antiga.
  await expect.poll(heightOf).toBeGreaterThan(h0 + 60)
  const h1 = await heightOf()
  expect((await page.getByTestId('preview-frame').boundingBox())!.height).toBeLessThan(preview0)

  // teclado
  await page.getByTestId('timeline-split').focus()
  await page.keyboard.press('ArrowDown')
  await expect.poll(heightOf).toBeLessThan(h1 - 15)
  // limites: nunca esconde a prévia (62% no máximo) nem a linha do tempo (176 px no mínimo)
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowUp')
  const max = await heightOf()
  const win = await page.evaluate(() => window.innerHeight)
  expect(max).toBeLessThan(win * 0.7)
  expect((await page.getByTestId('preview-frame').boundingBox())!.height).toBeGreaterThan(100)
  for (let i = 0; i < 80; i++) await page.keyboard.press('ArrowDown')
  expect(await heightOf()).toBeGreaterThan(150)
})
