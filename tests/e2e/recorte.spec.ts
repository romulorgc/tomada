/**
 * RECORTE DA TELA (C1), de ponta a ponta no Electron de verdade: a aba Estilo oferece Automático (desabilitado quando a página não
 * foi medida), Manual e Desligado; o retângulo se arrasta sobre a tela inteira (com proporção livre ou travada); cada gesto é UM passo
 * de desfazer; e a exportação 16:9 e a vertical mostram EXATAMENTE o pedaço da tela que o retângulo escolheu (comparado, pixel a
 * pixel, com o recorte do vídeo de origem). Capturas antes/depois em `test-results/screens/`.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { eventsFromText } from '../../src/shared/events'
import { HORIZONTAL_1080, VERTICAL_1080, deriveProject, evaluateScene, prepareEvents } from '../../src/shared/scene'
import { projectForFormat } from '../../src/shared/vertical'
import type { Project, Rect } from '../../src/shared/types'
import { frameRgb, rgbDiff } from '../helpers/media'
import { openEditor, readSaved, seekTo, waitSaved } from './editor-helpers'
import { editProject, exportProject } from './export-helpers'
import { FIXTURES_DIR } from '../helpers/fs'
import { EXAMPLE_FOLDER, SCREENS_DIR, launchTomada, shot, type Session } from './helpers'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

const N = 75 // o quadro de 2,5 s (30 qps)

/** O pedaço `r` (normalizado) do quadro `n` do vídeo de origem, reduzido para `w × h`, pelo mesmo filtro de cor do `frameRgb`. */
function expectedCrop(video: string, n: number, r: Rect, w: number, h: number): Uint8Array {
  const vf = `select=eq(n\\,${n}),crop=iw*${r.w}:ih*${r.h}:iw*${r.x}:ih*${r.y},scale=${w}:${h}:flags=area:in_color_matrix=bt709:out_color_matrix=bt709`
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', video, '-vf', vf, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 256 * 1024 * 1024, windowsHide: true })
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/** A região `x, y, w, h` (px) de um quadro RGB de largura `W`, menos uma margem (`m`) para os cantos e a borda. */
function region(rgb: Uint8Array, W: number, box: { x: number; y: number; w: number; h: number }, m: number): Uint8Array {
  const w = box.w - 2 * m
  const h = box.h - 2 * m
  const out = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    const from = ((box.y + m + y) * W + box.x + m) * 3
    out.set(rgb.subarray(from, from + w * 3), y * w * 3)
  }
  return out
}

/** Arrasta com o mouse de verdade, do centro de um elemento até um deslocamento. */
async function dragBy(page: Page, testId: string, dx: number, dy: number): Promise<void> {
  const box = (await page.getByTestId(testId).boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 })
  await page.mouse.move(x + dx, y + dy, { steps: 4 })
  await page.mouse.up()
}

const ratioOf = (r: Rect, w: number, h: number): number => (r.w * w) / (r.h * h)

test('recorte manual: arrastar o retângulo sobre a tela inteira, travar a proporção, desfazer, e a exportação 16:9 e a vertical mostram só o pedaço escolhido', async () => {
  test.setTimeout(300_000)
  s = await launchTomada()
  // sem câmera na frente, sem zoom e sem ripple: o quadro de saída é só o recorte da tela, comparável com o vídeo de origem
  editProject(s, (p) => {
    p.zoomPreset = 'off'
    p.zooms = []
    p.style.camera.hidden = true
    p.style.cursor.ripple = false
    p.vertical = { layout: 'screen-focus', layouts: [], zooms: [], zoomPreset: 'off' }
  })
  await openEditor(s)
  const { page } = s
  mkdirSync(SCREENS_DIR, { recursive: true })

  // a aba Estilo: o recorte no alto; "Automático" desabilitado (a página do navegador não foi medida nesta gravação)
  await page.getByTestId('tab-style').click()
  await expect(page.getByTestId('crop-section')).toBeVisible()
  await expect(page.getByTestId('crop-mode-off')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('crop-mode-auto')).toBeDisabled()
  await expect(page.getByTestId('crop-offer')).toHaveCount(0)
  await expect(page.getByTestId('crop-suggest')).toBeVisible() // sem a página medida, oferece procurar a barra do navegador
  const before = await page.getByTestId('preview-canvas').screenshot()
  writeFileSync(join(SCREENS_DIR, 'recorte-01-sem-recorte.png'), before)

  // Manual: abre o editor do retângulo sobre a tela INTEIRA
  await page.getByTestId('crop-mode-manual').click()
  await expect(page.getByTestId('crop-editor')).toBeVisible()
  await expect(page.getByTestId('crop-mode-manual')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('crop-box')).toBeVisible()
  await waitSaved(s)
  const first = readSaved(s).screenCrop!
  expect(first.mode).toBe('manual')
  expect(first.manual).toBeDefined()
  await page.screenshot({ path: join(SCREENS_DIR, 'recorte-02-editor.png') })

  // arrasta o canto de cima à esquerda para dentro e o de baixo à direita para dentro: o retângulo ENCOLHE (cada gesto = um passo)
  await dragBy(page, 'crop-handle-nw', 110, 70)
  await waitSaved(s)
  const afterNw = readSaved(s).screenCrop!.manual!
  expect(afterNw.x).toBeGreaterThan(first.manual!.x + 0.03)
  expect(afterNw.y).toBeGreaterThan(first.manual!.y + 0.03)
  expect(afterNw.x + afterNw.w).toBeCloseTo(first.manual!.x + first.manual!.w, 3) // o canto oposto não se mexe

  await dragBy(page, 'crop-handle-se', -90, -50)
  await waitSaved(s)
  const afterSe = readSaved(s).screenCrop!.manual!
  expect(afterSe.w).toBeLessThan(afterNw.w - 0.03)
  expect(afterSe.x).toBeCloseTo(afterNw.x, 3)

  // trava a proporção em 16:9 (em pixels da tela gravada): o retângulo vira o maior 16:9 que cabe nele
  await page.getByTestId('crop-lock-16x9').click()
  await waitSaved(s)
  const locked = readSaved(s).screenCrop!.manual!
  expect(ratioOf(locked, 1920, 1080)).toBeCloseTo(16 / 9, 2)

  // arrastar uma ponta com a proporção travada mantém a proporção
  await dragBy(page, 'crop-handle-se', -40, -10)
  await waitSaved(s)
  const resized = readSaved(s).screenCrop!.manual!
  expect(ratioOf(resized, 1920, 1080)).toBeCloseTo(16 / 9, 2)
  expect(resized.w).toBeLessThan(locked.w)

  // arrastar o corpo move o retângulo sem mudar o tamanho
  await dragBy(page, 'crop-box', 60, 30)
  await waitSaved(s)
  const moved = readSaved(s).screenCrop!.manual!
  expect(moved.w).toBeCloseTo(resized.w, 4)
  expect(moved.h).toBeCloseTo(resized.h, 4)
  expect(moved.x).toBeGreaterThan(resized.x)
  await page.screenshot({ path: join(SCREENS_DIR, 'recorte-03-editor-arrastado.png') })

  // Ctrl+Z desfaz UM gesto (o último arraste), não tudo
  await page.getByTestId('crop-done').click()
  await expect(page.getByTestId('crop-editor')).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await waitSaved(s)
  const undone = readSaved(s).screenCrop!.manual!
  expect(undone.x).toBeCloseTo(resized.x, 4)
  expect(undone.w).toBeCloseTo(resized.w, 4)
  await page.keyboard.press('Control+Shift+z')
  await waitSaved(s)
  expect(readSaved(s).screenCrop!.manual!.x).toBeCloseTo(moved.x, 4)

  // a prévia agora mostra só o recorte
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true')
  const after = await page.getByTestId('preview-canvas').screenshot()
  writeFileSync(join(SCREENS_DIR, 'recorte-04-com-recorte.png'), after)
  expect(Buffer.compare(before, after)).not.toBe(0)

  // ---------------------------------------------------------------------------------------------------------------------------
  // Exportação 16:9 e vertical: o que sai é o recorte do vídeo de origem (comparado pixel a pixel)
  const doc: Project = readSaved(s)
  const crop = doc.screenCrop!.manual!
  const eventsText = (rel: string): string | undefined => {
    try {
      return readFileSync(join(s!.projects, EXAMPLE_FOLDER, rel), 'utf8')
    } catch {
      return undefined
    }
  }
  const data = prepareEvents(eventsFromText({ cursor: eventsText('events/cursor.jsonl'), clicks: eventsText('events/clicks.jsonl'), keys: eventsText('events/keys.jsonl') }), 23_000)
  const sourceVideo = join(FIXTURES_DIR, 'projeto-exemplo', 'media', 'screen.mp4')
  const tMs = (N / 30) * 1000

  // 16:9
  const h = await exportProject(page, EXAMPLE_FOLDER, { resolution: '1080p', fps: 30, format: 'horizontal' })
  expect(h.message ?? '').toBe('')
  expect(h.phase).toBe('done')
  {
    const derived = deriveProject(doc, data, HORIZONTAL_1080)
    const scene = evaluateScene(doc, derived, tMs, HORIZONTAL_1080)
    const dest = scene.screen!.dest
    // o cartão tem a proporção do RECORTE, não a da tela gravada
    expect(dest.w / dest.h).toBeCloseTo(ratioOf(crop, 1920, 1080), 1)
    expect(scene.screen!.src.x * 1920).toBeCloseTo(crop.x * 1920, 0) // o tamanho do recorte é arredondado a pixels pares: até 1 px de folga
    expect(Math.abs(scene.screen!.src.w - crop.w) * 1920).toBeLessThan(1.5)
    const out = frameRgb(h.outputPath!, N, 1920, 1080)
    const got = region(out, 1920, dest, 8)
    const want = region(expectedCrop(sourceVideo, N, crop, dest.w, dest.h), dest.w, { x: 0, y: 0, w: dest.w, h: dest.h }, 8)
    const wrong = region(expectedCrop(sourceVideo, N, { x: 0, y: 0, w: 1, h: 1 }, dest.w, dest.h), dest.w, { x: 0, y: 0, w: dest.w, h: dest.h }, 8)
    const good = rgbDiff(got, want)
    const bad = rgbDiff(got, wrong)
    console.log(`[16:9] diferença para o recorte esperado ${(good.mean * 100).toFixed(2)}% (pixels muito diferentes ${(good.strongRatio * 100).toFixed(2)}%); para a tela inteira ${(bad.mean * 100).toFixed(2)}%`)
    expect(good.mean, 'o 16:9 mostra o pedaço escolhido').toBeLessThan(0.05)
    expect(bad.mean, 'e NÃO a tela inteira (a conferência enxerga a diferença)').toBeGreaterThan(good.mean * 2.5)
    writeFileSync(join(SCREENS_DIR, 'recorte-05-exportado-16x9.png'), execFileSync('ffmpeg', ['-v', 'error', '-i', h.outputPath!, '-vf', `select=eq(n\\,${N})`, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', '-'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }))
  }

  // vertical (o V-A segue o cursor DENTRO do recorte)
  const v = await exportProject(page, EXAMPLE_FOLDER, { resolution: '1080p', fps: 30, format: 'vertical' })
  expect(v.message ?? '').toBe('')
  expect(v.phase).toBe('done')
  {
    const view = projectForFormat(doc, 'vertical')
    const derived = deriveProject(view, data, VERTICAL_1080)
    const scene = evaluateScene(view, derived, tMs, VERTICAL_1080)
    const src = scene.screen!.src
    // o recorte vertical fica dentro do retângulo escolhido
    expect(src.x).toBeGreaterThanOrEqual(crop.x - 1e-6)
    expect(src.y).toBeGreaterThanOrEqual(crop.y - 1e-6)
    expect(src.x + src.w).toBeLessThanOrEqual(crop.x + crop.w + 1e-6)
    expect(src.y + src.h).toBeLessThanOrEqual(crop.y + crop.h + 1e-6)
    const out = frameRgb(v.outputPath!, N, 1080, 1920)
    const got = region(out, 1080, { x: 0, y: 0, w: 1080, h: 1920 }, 8)
    const want = region(expectedCrop(sourceVideo, N, src, 1080, 1920), 1080, { x: 0, y: 0, w: 1080, h: 1920 }, 8)
    // a tela inteira na altura toda (sem recorte): a faixa 9:16 do meio da tela
    const full = deriveProject({ ...view, screenCrop: { mode: 'off' } }, data, VERTICAL_1080)
    const wrongSrc = evaluateScene({ ...view, screenCrop: { mode: 'off' } }, full, tMs, VERTICAL_1080).screen!.src
    const wrong = region(expectedCrop(sourceVideo, N, wrongSrc, 1080, 1920), 1080, { x: 0, y: 0, w: 1080, h: 1920 }, 8)
    const good = rgbDiff(got, want)
    const bad = rgbDiff(got, wrong)
    console.log(`[9:16] diferença para o recorte esperado ${(good.mean * 100).toFixed(2)}%; para a faixa sem recorte ${(bad.mean * 100).toFixed(2)}%`)
    expect(good.mean, 'o vertical mostra só o que está dentro do retângulo').toBeLessThan(0.06)
    expect(bad.mean).toBeGreaterThan(good.mean * 2)
    writeFileSync(join(SCREENS_DIR, 'recorte-06-exportado-9x16.png'), execFileSync('ffmpeg', ['-v', 'error', '-i', v.outputPath!, '-vf', `select=eq(n\\,${N})`, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', '-'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }))
  }

  // Desligado: volta a tela inteira (um passo desfazível)
  await page.getByTestId('crop-mode-off').click()
  await waitSaved(s)
  expect(readSaved(s).screenCrop?.mode).toBe('off')
})

test('moldura de navegador: uma barra limpa com o endereço no topo do recorte, só no 16:9 e só com recorte', async () => {
  test.setTimeout(240_000)
  s = await launchTomada()
  editProject(s, (p) => {
    p.zoomPreset = 'off'
    p.zooms = []
    p.style.camera.hidden = true
    p.style.cursor.ripple = false
    p.screenCrop = { mode: 'manual', manual: { x: 0.05, y: 0.1, w: 0.9, h: 0.8 } }
  })
  await openEditor(s)
  const { page } = s
  await page.getByTestId('tab-style').click()
  await expect(page.getByTestId('crop-mode-manual')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('crop-frame')).toBeVisible()
  await expect(page.getByTestId('crop-frame-toggle')).toHaveAttribute('aria-checked', 'false')
  mkdirSync(SCREENS_DIR, { recursive: true })
  const plain = await page.getByTestId('preview-canvas').screenshot()
  writeFileSync(join(SCREENS_DIR, 'recorte-07-sem-moldura.png'), plain)

  await page.getByTestId('crop-frame-toggle').click()
  await expect(page.getByTestId('crop-domain')).toBeVisible()
  await page.getByTestId('crop-domain').fill('meusistema.com.br')
  await waitSaved(s)
  const saved = readSaved(s).screenCrop!
  expect(saved.browserFrame).toEqual({ enabled: true, domain: 'meusistema.com.br' })
  expect(saved.mode).toBe('manual')
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true')
  const framed = await page.getByTestId('preview-canvas').screenshot()
  writeFileSync(join(SCREENS_DIR, 'recorte-08-com-moldura.png'), framed)
  expect(Buffer.compare(plain, framed)).not.toBe(0)

  // no 9:16 a moldura não existe (e o painel avisa)
  await page.getByTestId('ratio-9-16').click()
  await expect(page.getByTestId('crop-frame')).toHaveCount(0)
  await page.getByTestId('ratio-16-9').click()
  await expect(page.getByTestId('crop-frame')).toBeVisible()

  // Desligado: sem recorte não há moldura
  await page.getByTestId('crop-mode-off').click()
  await expect(page.getByTestId('crop-frame')).toHaveCount(0)
})

// ---------------------------------------------------------------------------------------------------------------------------
// Revisão da C1, item 5: clicar na prévia fixa o foco do zoom no espaço do RECORTE (e o marcador cai onde se clicou)
test('foco do zoom pela prévia com o recorte ligado: o foco é a fração do RECORTE, a barra da moldura não conta e o marcador cai onde se clicou', async () => {
  test.setTimeout(180_000)
  s = await launchTomada()
  editProject(s, (p) => {
    p.zoomPreset = 'moderate'
    p.zooms = [{ id: 'z1', start: 2240, end: 4140, scale: 1.7, focus: 'auto', origin: 'auto' }]
    p.style.camera.hidden = true
    p.screenCrop = { mode: 'manual', manual: { x: 0.1, y: 0.2, w: 0.6, h: 0.6 } }
  })
  await openEditor(s)
  const { page } = s
  await seekTo(page, 500) // fora do zoom: o cartão mostra o recorte inteiro
  await page.getByTestId('seg-zoom-z1').click()
  await expect(page.getByTestId('zoom-selected-card')).toBeVisible()

  const eventsText = (rel: string): string | undefined => {
    try {
      return readFileSync(join(s!.projects, EXAMPLE_FOLDER, rel), 'utf8')
    } catch {
      return undefined
    }
  }
  const data = prepareEvents(eventsFromText({ cursor: eventsText('events/cursor.jsonl'), clicks: eventsText('events/clicks.jsonl'), keys: eventsText('events/keys.jsonl') }), 23_000)
  /** O ponto da TELA (px do navegador) na fração (fx, fy) da página do cartão, conforme a cena do documento de agora. */
  const pointAt = async (fx: number, fy: number): Promise<{ x: number; y: number }> => {
    const frame = (await page.getByTestId('preview-frame').boundingBox())!
    const doc = readSaved(s!)
    const screen = evaluateScene(doc, deriveProject(doc, data, HORIZONTAL_1080), 500, HORIZONTAL_1080).screen!
    const barH = screen.bar?.h ?? 0
    const cx = screen.dest.x + fx * screen.dest.w
    const cy = screen.dest.y + barH + fy * (screen.dest.h - barH)
    return { x: frame.x + (cx / HORIZONTAL_1080.w) * frame.width, y: frame.y + (cy / HORIZONTAL_1080.h) * frame.height }
  }
  const focusOf = (): { x: number; y: number } | 'auto' => readSaved(s!).zooms[0]!.focus

  // 1) sem moldura: a fração (0,5; 0,75) do cartão é o foco (0,5; 0,75) no recorte (na tela gravada seria 0,4 e 0,65)
  const click1 = await pointAt(0.5, 0.75)
  await page.mouse.click(click1.x, click1.y)
  await waitSaved(s)
  const f1 = focusOf()
  if (f1 === 'auto') throw new Error('o foco continuou automático')
  expect(f1.x).toBeCloseTo(0.5, 1)
  expect(f1.y).toBeCloseTo(0.75, 1)
  expect(Math.abs(f1.x - 0.4) + Math.abs(f1.y - 0.65), 'o foco foi salvo no espaço da tela gravada').toBeGreaterThan(0.1)
  // o marcador cai onde a pessoa clicou
  const marker1 = (await page.getByTestId('focus-marker').boundingBox())!
  expect(Math.abs(marker1.x + marker1.width / 2 - click1.x)).toBeLessThan(4)
  expect(Math.abs(marker1.y + marker1.height / 2 - click1.y)).toBeLessThan(4)
  await shot(page, 'recorte-09-foco-com-recorte')

  // 2) com a moldura: clicar na barra não muda o foco; clicar na página desconta a barra
  await page.getByTestId('tab-style').click()
  await page.getByTestId('crop-frame-toggle').click()
  await waitSaved(s)
  await seekTo(page, 500)
  // o zoom continua selecionado (a seleção sobrevive à troca de aba): só volta à aba Zoom; se a seleção se perdeu, seleciona de novo
  await page.getByTestId('tab-zoom').click()
  if (!(await page.getByTestId('zoom-selected-card').isVisible())) await page.getByTestId('seg-zoom-z1').click()
  await expect(page.getByTestId('zoom-selected-card')).toBeVisible()
  const before = focusOf()
  const doc = readSaved(s)
  const sc = evaluateScene(doc, deriveProject(doc, data, HORIZONTAL_1080), 500, HORIZONTAL_1080).screen!
  expect(sc.bar!.h).toBeGreaterThan(10)
  const frame = (await page.getByTestId('preview-frame').boundingBox())!
  const onBar = { x: frame.x + ((sc.dest.x + sc.dest.w / 2) / HORIZONTAL_1080.w) * frame.width, y: frame.y + ((sc.dest.y + sc.bar!.h / 2) / HORIZONTAL_1080.h) * frame.height }
  await page.mouse.click(onBar.x, onBar.y)
  await page.waitForTimeout(400)
  expect(focusOf(), 'clicar na barra da moldura não fixa foco').toEqual(before)
  const click2 = await pointAt(0.25, 0.5)
  await page.mouse.click(click2.x, click2.y)
  await waitSaved(s)
  const f2 = focusOf()
  if (f2 === 'auto') throw new Error('o foco continuou automático')
  expect(f2.x).toBeCloseTo(0.25, 1)
  expect(f2.y).toBeCloseTo(0.5, 1)
  const marker2 = (await page.getByTestId('focus-marker').boundingBox())!
  expect(Math.abs(marker2.x + marker2.width / 2 - click2.x)).toBeLessThan(4)
  expect(Math.abs(marker2.y + marker2.height / 2 - click2.y)).toBeLessThan(4)
})

// ---------------------------------------------------------------------------------------------------------------------------
// Revisão da C1, item 3: um recorte manual que não vale nunca vira "tela inteira" em silêncio
test('recorte manual inválido no documento: o editor AVISA (e o arraste só deixa o tamanho mínimo que o documento aceita)', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  editProject(s, (p) => {
    p.zoomPreset = 'off'
    p.zooms = []
    p.style.camera.hidden = true
    p.screenCrop = { mode: 'manual', manual: { x: 0.3, y: 0.3, w: 0.01, h: 0.01 } } // um documento antigo ou editado à mão
  })
  await openEditor(s)
  const { page } = s
  await page.getByTestId('tab-style').click()
  await expect(page.getByTestId('crop-mode-manual')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('crop-manual-invalid'), 'o aviso de que o recorte salvo não vale').toBeVisible()
  await shot(page, 'recorte-10-manual-invalido')

  // trocar para um retângulo bom tira o aviso; o arraste nunca passa do mínimo
  await page.getByTestId('crop-mode-off').click()
  await page.getByTestId('crop-mode-manual').click()
  await expect(page.getByTestId('crop-editor')).toBeVisible()
  await waitSaved(s)
  const start = readSaved(s).screenCrop!.manual!
  // arrasta o canto de baixo à direita para o canto de cima à esquerda, muito além
  const box = (await page.getByTestId('crop-handle-se').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 2000, box.y - 2000, { steps: 8 })
  await page.mouse.up()
  await waitSaved(s)
  const shrunk = readSaved(s).screenCrop!.manual!
  expect(shrunk.w).toBeLessThan(start.w)
  expect(shrunk.w * 1920, 'nunca menor que o mínimo do documento (8% da tela)').toBeGreaterThanOrEqual(0.08 * 1920 - 1)
  expect(shrunk.h * 1080).toBeGreaterThanOrEqual(0.08 * 1080 - 1)
  await expect(page.getByTestId('crop-manual-invalid')).toHaveCount(0)
})
