/**
 * O editor (prévia, painel lateral, barra superior, atalhos): zooms automáticos ao abrir, mudanças que persistem
 * no project.json e sobrevivem a reabrir o app, "Desligado" que não regenera, a reprodução que pula os trechos
 * cortados, o relógio único e os atalhos do teclado, fundo/câmera/foco no que se VÊ, salvamento com erro visível,
 * áudio tratado da prévia e as capturas de cada aba. A linha do tempo está em `editor-linha-do-tempo.spec.ts`
 * e o Exportar em `editor-exportar.spec.ts`.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { FIXTURES_DIR } from '../helpers/fs'
import { imageToRgb } from '../helpers/media'
import { editProject } from './export-helpers'
import { EXAMPLE_FOLDER, launchTomada, SCREENS_DIR, setContentSize, shot, type Session } from './helpers'
import { dragOnTrack, openEditor, outputMs, outputTotalMs, playheadMs, previewShot, readSaved, seekByRuler, seekTo, waitSaved } from './editor-helpers'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

/** Fecha o app e abre de novo com os MESMOS dados (a pergunta é o que sobrou no disco). */
async function reopen(session: Session): Promise<Session> {
  const { base, problems } = session
  await session.close({ keep: true })
  const next = await launchTomada({ base })
  next.problems.push(...problems)
  return next
}

/** Cor (r,g,b) do canto superior esquerdo da prévia, que é só fundo: o que muda com o fundo escolhido. */
async function backdrop(page: import('@playwright/test').Page): Promise<[number, number, number]> {
  // a faixa de cima, no meio: só fundo (a margem do quadro da tela é de 6%)
  const rgb = imageToRgb(await previewShot(page), 64, 36)
  const i = 32 * 3
  return [rgb[i]!, rgb[i + 1]!, rgb[i + 2]!]
}

const near = (a: readonly number[], b: readonly number[], tol = 30): boolean => a.every((v, i) => Math.abs(v - b[i]!) <= tol)

test('abrir um projeto sem zooms gera os do preset moderado e grava; reabrir não gera de novo', async () => {
  s = await launchTomada()
  expect(readSaved(s).zooms).toEqual([])
  await openEditor(s)
  await s.page.getByTestId('tab-zoom').click()
  await expect(s.page.getByTestId('zoom-count')).toHaveText('3 zooms')
  await expect(s.page.getByTestId('zoom-moderate')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => readSaved(s!).zooms.length, { timeout: 10_000 }).toBe(3)
  const first = readSaved(s)
  expect(first.zoomPreset).toBe('moderate')
  expect(first.zooms.every((z) => z.end > z.start && z.scale > 1 && z.scale <= 8)).toBe(true)
  // o preset gera zooms AUTOMÁTICOS: nenhum é marcado como manual
  expect(first.zooms.every((z) => z.origin === 'auto')).toBe(true)
  // e eles aparecem como segmentos na trilha Zoom
  await expect(s.page.locator('[data-testid^="seg-zoom-"]')).toHaveCount(3)
  await shot(s.page, '25-editor-zoom-moderado')

  s = await reopen(s)
  await openEditor(s)
  await s.page.getByTestId('tab-zoom').click()
  await expect(s.page.getByTestId('zoom-count')).toHaveText('3 zooms')
  // os mesmos zooms (não foram refeitos com outros ids)
  expect(readSaved(s).zooms.map((z) => z.id)).toEqual(first.zooms.map((z) => z.id))
})

test('fundo, layout, posição da câmera e preset de zoom persistem no project.json e sobrevivem a reabrir', async () => {
  s = await launchTomada()
  const { page } = s
  await openEditor(s)

  await page.getByTestId('bg-violeta').click()
  await page.getByTestId('tab-layout').click()
  await page.getByTestId('layout-side-by-side').click()
  await page.getByTestId('tab-camera').click()
  await page.getByTestId('corner-top-left').click()
  await page.getByTestId('tab-zoom').click()
  await page.getByTestId('zoom-intense').click()

  await expect.poll(() => readSaved(s!).zoomPreset, { timeout: 10_000 }).toBe('intense')
  const saved = readSaved(s)
  expect(saved.style.defaultLayout).toBe('side-by-side')
  expect(saved.style.camera.corner).toBe('top-left')
  expect(saved.style.background.type).toBe('gradient')
  expect(saved.zooms.length).toBeGreaterThan(0)
  await expect(page.getByTestId('zoom-intense')).toHaveAttribute('aria-pressed', 'true')
  await shot(page, '26-editor-estilo-mudado')

  s = await reopen(s)
  await openEditor(s)
  await expect(s.page.getByTestId('bg-violeta')).toHaveAttribute('aria-pressed', 'true')
  await s.page.getByTestId('tab-layout').click()
  await expect(s.page.getByTestId('layout-side-by-side')).toHaveAttribute('aria-pressed', 'true')
  await s.page.getByTestId('tab-camera').click()
  await expect(s.page.getByTestId('corner-top-left')).toHaveAttribute('aria-pressed', 'true')
  await s.page.getByTestId('tab-zoom').click()
  await expect(s.page.getByTestId('zoom-intense')).toHaveAttribute('aria-pressed', 'true')
  expect(readSaved(s).zooms.map((z) => z.id)).toEqual(saved.zooms.map((z) => z.id))
})

test('"Desligado" tira os zooms e eles NÃO voltam ao reabrir', async () => {
  s = await launchTomada()
  await openEditor(s)
  await s.page.getByTestId('tab-zoom').click()
  await expect.poll(() => readSaved(s!).zooms.length, { timeout: 10_000 }).toBe(3)

  await s.page.getByTestId('zoom-off').click()
  await expect(s.page.getByTestId('zoom-count')).toHaveText('Nenhum zoom')
  await expect.poll(() => readSaved(s!).zoomPreset, { timeout: 10_000 }).toBe('off')
  expect(readSaved(s).zooms).toEqual([])

  s = await reopen(s)
  await openEditor(s)
  await s.page.getByTestId('tab-zoom').click()
  await expect(s.page.getByTestId('zoom-off')).toHaveAttribute('aria-pressed', 'true')
  await expect(s.page.getByTestId('zoom-count')).toHaveText('Nenhum zoom')
  expect(readSaved(s).zooms).toEqual([])
})

test('"Gerar de novo" avisa que substitui os automáticos e MANTÉM os manuais', async () => {
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.zoomPreset = 'moderate'
    p.zooms = [
      { id: 'z1', start: 2240, end: 4140, scale: 1.7, focus: 'auto', origin: 'auto' },
      { id: 'zm', start: 18_000, end: 19_500, scale: 2.4, focus: 'auto', origin: 'manual' }
    ]
  })
  await openEditor(s)
  await page.getByTestId('tab-zoom').click()
  await expect(page.getByTestId('zoom-count')).toHaveText('2 zooms')
  await page.getByTestId('zoom-regenerate').click()
  await expect(page.getByTestId('zoom-regenerate-confirm')).toContainText('substitui o zoom automático')
  await expect(page.getByTestId('zoom-regenerate-confirm')).toContainText('mantém o zoom manual')
  await shot(page, '31-zoom-gerar-de-novo-aviso')
  await page.getByTestId('zoom-regenerate-yes').click()
  await expect.poll(() => readSaved(s!).zooms.length, { timeout: 10_000 }).toBeGreaterThan(1)
  const zooms = readSaved(s).zooms
  const kept = zooms.find((z) => z.id === 'zm')
  expect(kept, 'o zoom manual sumiu ao regenerar').toBeTruthy()
  expect(kept!.scale).toBe(2.4)
  expect(zooms.filter((z) => z.origin === 'auto').length).toBeGreaterThan(0)
  // desfazer devolve exatamente o estado anterior
  await page.keyboard.press('Control+z')
  await expect.poll(() => readSaved(s!).zooms.map((z) => z.id).join(',')).toBe('z1,zm')
})

test('a reprodução pula os trechos cortados: nenhum quadro da prévia vem de dentro do corte', async () => {
  test.setTimeout(120_000)
  s = await launchTomada({ seed: true })
  // corte de 1000 a 3000 ms (origem); a saída tem 2 s a menos
  editProject(s, (p) => {
    p.zoomPreset = 'off'
    p.cuts = [{ id: 'c1', start: 1000, end: 3000, reason: 'manual', enabled: true }]
  })
  const { page } = s
  await openEditor(s)
  expect(await outputTotalMs(page)).toBe(21_000) // 23 s − 2 s

  // começa 400 ms antes do corte (saída 600 ms = origem 600 ms) e toca
  await seekByRuler(page, 600)
  await expect.poll(() => playheadMs(page)).toBeGreaterThan(450)
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 })
  const start = await playheadMs(page)
  expect(start).toBeLessThan(750)
  await page.getByTestId('play-toggle').click()

  const seen: number[] = []
  await expect
    .poll(
      async () => {
        const v = Number(await page.getByTestId('preview-canvas').getAttribute('data-source-ms'))
        seen.push(v)
        return v
      },
      { timeout: 30_000, intervals: [40] }
    )
    .toBeGreaterThan(3600)
  await page.getByTestId('play-toggle').click() // pausa

  // vimos instantes antes do corte, e depois dele; nunca no meio (folga de 120 ms nas bordas)
  expect(seen.some((v) => v < 1000)).toBe(true)
  expect(seen.some((v) => v >= 3000)).toBe(true)
  const inside = seen.filter((v) => v > 1120 && v < 2880)
  expect(inside, `a prévia mostrou instantes de dentro do corte: ${inside.join(', ')}`).toEqual([])
  // o relógio da prévia é o de SAÍDA: pulou 2 s
  const seconds = Number(await page.getByTestId('current-time').getAttribute('data-seconds'))
  expect(seconds).toBeGreaterThan(1.5)
  expect(seconds).toBeLessThan(2.9)
})

test('relógio único: tela e câmera seguem o mesmo tempo e, depois de tocar, não se afastam mais que um quadro e meio', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.zoomPreset = 'off'
  })
  await openEditor(s)
  await page.getByTestId('play-toggle').click()
  await expect.poll(async () => Number(await page.getByTestId('preview-canvas').getAttribute('data-source-ms')), { timeout: 20_000 }).toBeGreaterThan(4000)
  // a diferença entre o relógio e cada vídeo (a câmera tem 300 ms a menos de duração, mas começa junto)
  const drift = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid=preview-canvas]') as HTMLCanvasElement
    const clock = Number(canvas.dataset.sourceMs) / 1000
    const screen = document.querySelector('[data-testid=video-screen]') as HTMLVideoElement
    const camera = document.querySelector('[data-testid=video-camera]') as HTMLVideoElement
    return { screen: Math.abs(screen.currentTime - clock) * 1000, camera: Math.abs(camera.currentTime - clock) * 1000 }
  })
  console.log(`deriva em relação ao relógio: tela ${drift.screen.toFixed(0)} ms, câmera ${drift.camera.toFixed(0)} ms`)
  expect(drift.screen).toBeLessThan(150)
  expect(drift.camera).toBeLessThan(150)
  await page.getByTestId('play-toggle').click()
})

test('atalhos: Espaço, J/K/L, ←/→, Shift+←/→, Home/End e Esc', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.zoomPreset = 'off'
  })
  await openEditor(s)
  const playing = (): Promise<string | null> => page.getByTestId('play-toggle').getAttribute('data-playing')
  const total = await outputTotalMs(page)
  expect(total).toBe(23_000)

  // Shift+→ pula 1 s e Shift+← volta 1 s (tempo de SAÍDA; aqui igual ao da origem: não há cortes)
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(() => outputMs(page)).toBe(1000)
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(() => outputMs(page)).toBe(2000)
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(() => outputMs(page)).toBe(1000)

  // ← e → andam UM quadro (30 qps ⇒ 33,3 ms)
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => outputMs(page)).toBe(1033)
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => outputMs(page)).toBe(1067)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => outputMs(page)).toBe(1033)

  // Home / End
  await page.keyboard.press('End')
  await expect.poll(() => outputMs(page)).toBeGreaterThan(total - 80)
  await page.keyboard.press('Home')
  await expect.poll(() => outputMs(page)).toBe(0)

  // Espaço toca e pausa
  await page.keyboard.press('Space')
  await expect.poll(playing).toBe('true')
  await expect.poll(() => outputMs(page), { timeout: 15_000 }).toBeGreaterThan(600)
  await page.keyboard.press('Space')
  await expect.poll(playing).toBe('false')
  const stopped = await outputMs(page)
  await page.waitForTimeout(500)
  expect(Math.abs((await outputMs(page)) - stopped)).toBeLessThan(40)

  // L toca; L de novo dobra a velocidade; K para; J toca para trás
  await page.keyboard.press('Home')
  await page.keyboard.press('KeyL')
  await expect.poll(playing).toBe('true')
  await page.keyboard.press('KeyL')
  await expect(page.getByTestId('tp-rate')).toContainText('2')
  await expect.poll(() => outputMs(page), { timeout: 15_000 }).toBeGreaterThan(400)
  await page.keyboard.press('KeyK')
  await expect.poll(playing).toBe('false')
  const afterK = await outputMs(page)
  expect(afterK).toBeGreaterThan(0)
  await page.keyboard.press('KeyJ')
  await expect.poll(playing).toBe('true')
  await expect.poll(() => outputMs(page), { timeout: 10_000 }).toBeLessThan(afterK - 100)
  await page.keyboard.press('KeyK')
  await expect.poll(playing).toBe('false')

  // com o foco num campo de texto os atalhos não agem (digitar o nome não toca o vídeo)
  await page.getByTestId('project-title').click()
  await expect(page.getByTestId('title-input')).toBeFocused()
  const before = await outputMs(page)
  await page.keyboard.type(' j l ')
  await page.keyboard.press('ArrowLeft')
  expect(await playing()).toBe('false')
  expect(await outputMs(page)).toBe(before)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('title-input')).toHaveCount(0)
})

test('trocar o fundo muda o pixel da prévia; cor sólida, cores livres com ângulo e imagem do disco', async () => {
  test.setTimeout(90_000)
  const dir = mkdtempSync(join(tmpdir(), 'tomada-bg-'))
  const image = join(dir, 'fundo.jpg')
  copyFileSync(join(FIXTURES_DIR, 'projeto-exemplo', 'media', 'thumb.jpg'), image)
  s = await launchTomada({ env: { TOMADA_TEST_PICK_IMAGE: image } })
  const { page } = s
  editProject(s, (p) => {
    p.zoomPreset = 'off'
  })
  await openEditor(s)

  const night = await backdrop(page)
  await page.getByTestId('bg-branco').click()
  await expect.poll(async () => near(await backdrop(page), [255, 255, 255]), { message: 'o fundo branco aparece na prévia' }).toBe(true)
  await page.getByTestId('bg-preto').click()
  await expect.poll(async () => near(await backdrop(page), [0, 0, 0])).toBe(true)
  expect(near(night, [0, 0, 0]), 'o fundo padrão não é preto').toBe(false)

  // cor sólida
  await page.getByTestId('bg-type-solid').click()
  await expect(page.getByTestId('bg-color')).toBeVisible()
  await page.getByTestId('bg-color').fill('#ff0000')
  await expect.poll(async () => near(await backdrop(page), [255, 0, 0])).toBe(true)
  await waitSaved(s)
  expect(readSaved(s).style.background).toEqual({ type: 'solid', color: '#ff0000' })

  // cores livres com ângulo
  await page.getByTestId('bg-type-gradient').click()
  await page.getByTestId('bg-from').fill('#00ff00')
  await page.getByTestId('bg-to').fill('#0000ff')
  await page.getByTestId('bg-angle').fill('90')
  await waitSaved(s)
  const free = readSaved(s).style.background
  expect(free).toMatchObject({ type: 'gradient', from: '#00ff00', to: '#0000ff', angle: 90 })
  await expect.poll(async () => (await backdrop(page))[1]).toBeGreaterThan(60)
  // um clique no preset desmarca as cores livres e marca o preset
  await page.getByTestId('bg-menta').click()
  await expect(page.getByTestId('bg-menta')).toHaveAttribute('aria-pressed', 'true')

  // imagem do disco: copiada para dentro do projeto
  await page.getByTestId('bg-type-image').click()
  await expect(page.getByTestId('bg-image')).toBeVisible()
  await waitSaved(s)
  const bg = readSaved(s).style.background
  expect(bg.type).toBe('image')
  if (bg.type !== 'image') throw new Error('fundo não virou imagem')
  expect(bg.path.startsWith('media/')).toBe(true)
  expect(existsSync(join(s.projects, EXAMPLE_FOLDER, bg.path))).toBe(true)
  expect(statSync(join(s.projects, EXAMPLE_FOLDER, bg.path)).size).toBeGreaterThan(1000)
  await shot(page, '32-editor-fundo-imagem')

  // margem, raio e sombra mexem no documento (e um arraste do controle é UM passo de desfazer)
  await page.getByTestId('style-margin').fill('0.15')
  await page.getByTestId('style-radius').fill('40')
  await waitSaved(s)
  const style = readSaved(s).style
  expect(style.padding).toBeCloseTo(0.15, 3)
  expect(style.radius).toBe(40)
  rmSync(dir, { recursive: true, force: true })
})

test('título editável, salvamento visível (salvo → salvando → salvo), e erro ao salvar nunca fica calado', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.zoomPreset = 'off'
  })
  await openEditor(s)
  await waitSaved(s)

  // renomear pelo título
  await page.getByTestId('project-title').click()
  const input = page.getByTestId('title-input')
  await expect(input).toBeFocused()
  await input.fill('Aula de Psicanálise nº 3')
  await input.press('Enter')
  await expect(page.getByTestId('project-title')).toHaveText('Aula de Psicanálise nº 3')
  await waitSaved(s)
  expect(readSaved(s).title).toBe('Aula de Psicanálise nº 3')
  // Esc cancela
  await page.getByTestId('project-title').click()
  await page.getByTestId('title-input').fill('Nome que não vale')
  await page.getByTestId('title-input').press('Escape')
  await expect(page.getByTestId('project-title')).toHaveText('Aula de Psicanálise nº 3')
  // título vazio é rejeitado (volta ao anterior)
  await page.getByTestId('project-title').click()
  await page.getByTestId('title-input').fill('   ')
  await page.getByTestId('title-input').press('Enter')
  await expect(page.getByTestId('project-title')).toHaveText('Aula de Psicanálise nº 3')
  // o título renomeado vale na biblioteca
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('project-title')).toHaveText('Projeto de exemplo')
  await page.keyboard.press('Control+Shift+z')
  await expect(page.getByTestId('project-title')).toHaveText('Aula de Psicanálise nº 3')

  // indicador: uma edição passa por "salvando" e volta a "salvo", com o arquivo no disco
  await page.getByTestId('tab-camera').click()
  await page.getByTestId('camera-mirror').click()
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', /saving|saved/)
  await waitSaved(s)
  expect(readSaved(s).style.camera.mirror).toBe(true)

  // erro: o project.json vira uma PASTA (a gravação atômica não consegue renomear por cima)
  const file = join(s.projects, EXAMPLE_FOLDER, 'project.json')
  const original = readFileSync(file, 'utf8')
  rmSync(file)
  mkdirSync(file)
  await page.getByTestId('camera-mirror').click()
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'error', { timeout: 15_000 })
  await expect(page.getByTestId('save-retry')).toBeVisible()
  await expect(page.getByTestId('toast-error').first()).toContainText('salvar')
  await shot(page, '33-editor-erro-ao-salvar')
  // some o erro depois de arrumar o disco e tentar de novo
  rmSync(file, { recursive: true, force: true })
  await page.getByTestId('save-retry').click()
  await waitSaved(s)
  const recovered = readSaved(s)
  expect(recovered.style.camera.mirror).toBe(false)
  expect(original.length).toBeGreaterThan(100)
  s.problems.length = 0 // a falha do disco é registrada de propósito
})

test('câmera: forma, tamanho, borda, espelhar e esconder; posição pela grade e ARRASTANDO na prévia', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.zoomPreset = 'off'
  })
  await openEditor(s)
  await page.getByTestId('tab-camera').click()

  await page.getByTestId('camera-shape-square').click()
  await page.getByTestId('camera-size').fill('0.4')
  await page.getByTestId('camera-border').fill('8')
  await page.getByTestId('camera-mirror').click()
  await page.getByTestId('camera-shrink').click()
  await waitSaved(s)
  let cam = readSaved(s).style.camera
  expect(cam.shape).toBe('square')
  expect(cam.size).toBeCloseTo(0.4, 3)
  expect(cam.borderWidth).toBe(8)
  expect(cam.mirror).toBe(true)
  expect(cam.shrinkOnZoom).toBe(false) // o padrão é encolher: o clique desligou

  // posição: arrastar a bolha na prévia até o canto superior esquerdo
  await page.getByTestId('camera-shape-circle').click()
  await page.getByTestId('camera-size').fill('0.26')
  await expect(page.getByTestId('corner-bottom-right')).toHaveAttribute('aria-pressed', 'true')
  const frame = (await page.getByTestId('preview-frame').boundingBox())!
  // a bolha mora no canto inferior direito da área da tela: fica a ~85% da largura e ~85% da altura
  const from = { x: frame.x + frame.width * 0.86, y: frame.y + frame.height * 0.84 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(frame.x + frame.width * 0.5, frame.y + frame.height * 0.5, { steps: 6 })
  await page.mouse.move(frame.x + frame.width * 0.12, frame.y + frame.height * 0.14, { steps: 6 })
  await page.mouse.up()
  await expect(page.getByTestId('corner-top-left')).toHaveAttribute('aria-pressed', 'true')
  await waitSaved(s)
  cam = readSaved(s).style.camera
  expect(cam.corner).toBe('top-left')
  // o arraste inteiro é UM passo: um Ctrl+Z volta ao canto de antes
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('corner-bottom-right')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Control+Shift+z')
  await expect(page.getByTestId('corner-top-left')).toHaveAttribute('aria-pressed', 'true')

  // esconder: a câmera some da prévia (o pixel onde ela estava passa a ser o da tela)
  await page.getByTestId('corner-bottom-right').click()
  await expect(page.getByTestId('corner-bottom-right')).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(250)
  const shotWith = imageToRgb(await previewShot(page), 64, 36)
  await page.getByTestId('camera-show').click()
  await expect(page.getByTestId('camera-show')).toHaveAttribute('aria-checked', 'false')
  await waitSaved(s)
  expect(readSaved(s).style.camera.hidden).toBe(true)
  await page.waitForTimeout(250)
  const shotWithout = imageToRgb(await previewShot(page), 64, 36)
  let different = 0
  for (let i = 0; i < shotWith.length; i += 3) if (Math.abs(shotWith[i]! - shotWithout[i]!) > 24 || Math.abs(shotWith[i + 1]! - shotWithout[i + 1]!) > 24) different++
  expect(different, 'a câmera escondida precisa mudar a imagem').toBeGreaterThan(10)
  await page.getByTestId('tab-camera').click() // continua na aba
  await expect(page.getByTestId('camera-size')).toBeDisabled()
})

test('foco manual: com um zoom selecionado, clicar na prévia fixa o foco daquele zoom naquele ponto', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.zoomPreset = 'moderate'
    p.zooms = [{ id: 'z1', start: 2240, end: 4140, scale: 1.7, focus: 'auto', origin: 'auto' }]
  })
  await openEditor(s)
  await seekTo(page, 3000)

  // sem zoom selecionado, clicar na prévia não muda nada
  const frame = (await page.getByTestId('preview-frame').boundingBox())!
  await page.mouse.click(frame.x + frame.width * 0.3, frame.y + frame.height * 0.3)
  await waitSaved(s)
  expect(readSaved(s).zooms[0]!.focus).toBe('auto')

  // seleciona o zoom na trilha (abre a aba Zoom) e clica na prévia
  await page.getByTestId('seg-zoom-z1').click()
  await expect(page.getByTestId('zoom-selected-card')).toBeVisible()
  await expect(page.getByTestId('focus-hint')).toBeVisible()
  await page.mouse.click(frame.x + frame.width * 0.3, frame.y + frame.height * 0.3)
  await waitSaved(s)
  const z = readSaved(s).zooms[0]!
  expect(z.focus).not.toBe('auto')
  if (z.focus === 'auto') throw new Error('foco continuou automático')
  // 30% da largura/altura da prévia, dentro do quadro da tela (que tem margem): a coordenada normalizada cai entre 0 e 0,5
  expect(z.focus.x).toBeGreaterThan(0)
  expect(z.focus.x).toBeLessThan(0.5)
  expect(z.focus.y).toBeGreaterThan(0)
  expect(z.focus.y).toBeLessThan(0.5)
  expect(z.origin).toBe('manual')
  await expect(page.getByTestId('zoom-focus-fixed')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('focus-marker')).toBeVisible()
  await shot(page, '34-editor-foco-manual')

  // voltar ao automático
  await page.getByTestId('zoom-focus-auto').click()
  await waitSaved(s)
  expect(readSaved(s).zooms[0]!.focus).toBe('auto')
})

test('áudio da prévia: começa com a voz crua e passa à voz TRATADA (gerada uma vez, em segundo plano); forma de onda e miniaturas ficam no disco', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  const { page } = s
  await openEditor(s)
  const media = join(s.projects, EXAMPLE_FOLDER, 'media')
  await expect(page.getByTestId('audio-status')).toHaveAttribute('data-treated', 'true', { timeout: 60_000 })
  const preview = join(media, 'voice-preview.m4a')
  expect(existsSync(preview)).toBe(true)
  const mtime = statSync(preview).mtimeMs
  expect(statSync(preview).size).toBeGreaterThan(5000)
  await expect.poll(() => existsSync(join(media, 'peaks.json')), { timeout: 30_000 }).toBe(true)
  const peaks = JSON.parse(readFileSync(join(media, 'peaks.json'), 'utf8')) as { columnsPerSecond?: number; peaks?: unknown[] }
  expect(JSON.stringify(peaks).length).toBeGreaterThan(200)
  // a forma de onda desenhada tem pixels (a trilha mostra a voz)
  await expect(page.getByTestId('waveform')).toBeVisible()
  const drawn = await page.getByTestId('waveform').evaluate((el) => {
    const c = el as HTMLCanvasElement
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++
    return n
  })
  expect(drawn).toBeGreaterThan(500)
  // miniaturas da tela na trilha de vídeo
  await expect.poll(() => page.locator('[data-testid=track-video] .tl-thumbs img').count(), { timeout: 30_000 }).toBeGreaterThan(2)

  // abrir de novo não regera o que já existe (cache por mtime da fonte)
  s = await reopen(s)
  await openEditor(s)
  await expect(s.page.getByTestId('audio-status')).toHaveAttribute('data-treated', 'true', { timeout: 30_000 })
  expect(statSync(preview).mtimeMs).toBe(mtime)
})

test('o editor cabe de 1280×720 a 2560×1440 sem rolagem lateral e com tudo à vista', async () => {
  s = await launchTomada()
  const { page } = s
  await openEditor(s)
  for (const [w, h] of [
    [1280, 720],
    [1440, 900],
    [2560, 1440]
  ] as const) {
    await setContentSize(s, w, h)
    await page.waitForTimeout(300)
    const o = await page.evaluate(() => {
      const main = document.querySelector('main')!
      return { doc: document.documentElement.scrollWidth - window.innerWidth, docY: document.documentElement.scrollHeight - window.innerHeight, main: main.scrollWidth - main.clientWidth }
    })
    expect(o, `editor ${w}x${h}`).toEqual({ doc: 0, docY: 0, main: 0 })
    for (const id of ['editor-top', 'preview-canvas', 'play-toggle', 'current-time', 'side-panel', 'tab-style', 'tab-ai', 'timeline', 'timeline-ruler', 'track-video', 'track-zoom', 'track-layout', 'export-open', 'undo', 'save-status']) {
      const b = await page.getByTestId(id).boundingBox()
      expect(b, `${id} em ${w}x${h}`).not.toBeNull()
      expect(b!.x + b!.width, `${id} cortado à direita em ${w}x${h}`).toBeLessThanOrEqual(w + 0.5)
      expect(b!.y + b!.height, `${id} cortado embaixo em ${w}x${h}`).toBeLessThanOrEqual(h + 0.5)
      expect(b!.x, `${id} para fora à esquerda em ${w}x${h}`).toBeGreaterThanOrEqual(0)
      expect(b!.y, `${id} para fora em cima em ${w}x${h}`).toBeGreaterThanOrEqual(0)
    }
    // a prévia mantém 16:9 e tem tamanho de ferramenta (não vira selo)
    const c = (await page.getByTestId('preview-frame').boundingBox())!
    expect(c.width / c.height).toBeGreaterThan(1.7)
    expect(c.width / c.height).toBeLessThan(1.8)
    expect(c.width, `prévia pequena em ${w}x${h}`).toBeGreaterThan(w * 0.36)
    await shot(page, `27-editor-${w}x${h}`)
  }
})

test('capturas: cada aba do painel e a linha do tempo', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.cuts = [{ id: 'c1', start: 6000, end: 7800, reason: 'manual', enabled: true }]
    p.layouts = [{ id: 'l1', start: 15_000, end: 19_000, layout: 'side-by-side' }]
  })
  await openEditor(s)
  await expect(page.getByTestId('audio-status')).toHaveAttribute('data-treated', 'true', { timeout: 60_000 })
  await expect.poll(() => page.locator('[data-testid=track-video] .tl-thumbs img').count(), { timeout: 30_000 }).toBeGreaterThan(2)
  await seekTo(page, 11_000)
  for (const tab of ['style', 'camera', 'zoom', 'layout', 'text', 'captions', 'clips', 'publish', 'ai'] as const) {
    await page.getByTestId(`tab-${tab}`).click()
    await expect(page.getByTestId(`${tab}-panel`)).toBeVisible()
    await page.waitForTimeout(150)
    await shot(page, `28-editor-aba-${tab}`)
  }
  // as nove abas são de verdade (Texto: texto.spec.ts; Cortes, Publicar e IA: cortes.spec.ts): nenhuma é "em breve"
  for (const tab of ['text', 'clips', 'publish', 'ai'] as const) {
    await page.getByTestId(`tab-${tab}`).click()
    await expect(page.getByTestId(`${tab}-panel`)).not.toContainText(/em breve/i)
  }

  // linha do tempo, com zoom e seleção
  await page.getByTestId('tab-zoom').click()
  await page.locator('[data-testid^="seg-zoom-"]').first().click()
  await page.getByTestId('timeline').screenshot({ path: join(SCREENS_DIR, '29-editor-linha-do-tempo.png') })
  await shot(page, '30-editor-completo')
})

test('estados vazios desenhados: projeto sem câmera, sem voz e sem cursor/cliques', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    delete p.sources.camera
    delete p.sources.voice
    p.style.defaultLayout = 'screen'
    p.zoomPreset = undefined
  })
  rmSync(join(s.projects, EXAMPLE_FOLDER, 'events'), { recursive: true, force: true })
  await openEditor(s)

  // câmera: painel com estado vazio (nada de controle que não faz nada)
  await page.getByTestId('tab-camera').click()
  await expect(page.getByTestId('camera-empty')).toBeVisible()
  await expect(page.getByTestId('camera-size')).toHaveCount(0)
  await shot(page, '46-editor-sem-camera')

  // layout: os que precisam da câmera ficam desligados e dizem por quê
  await page.getByTestId('tab-layout').click()
  await expect(page.getByTestId('layout-screen')).toBeEnabled()
  await expect(page.getByTestId('layout-bubble')).toBeDisabled()
  await expect(page.getByTestId('layout-camera')).toBeDisabled()
  await expect(page.getByTestId('layout-side-by-side')).toBeDisabled()

  // zoom: sem cursor e cliques só resta "Desligado", com o aviso; nenhum zoom foi gerado
  await page.getByTestId('tab-zoom').click()
  await expect(page.getByText('Esta gravação não tem cursor e cliques')).toBeVisible()
  await expect(page.getByTestId('zoom-subtle')).toBeDisabled()
  await expect(page.getByTestId('zoom-moderate')).toBeDisabled()
  await expect(page.getByTestId('zoom-intense')).toBeDisabled()
  await expect(page.getByTestId('zoom-regenerate')).toBeDisabled()
  await expect(page.getByTestId('zoom-count')).toHaveText('Nenhum zoom')
  expect(readSaved(s).zooms).toEqual([])
  // mas dá para criar um zoom à mão (com foco no centro, sem trilha de cursor)
  await dragOnTrack(page, 'track-zoom', 4000, 7000)
  await expect(page.locator('[data-testid^="seg-zoom-"]')).toHaveCount(1)

  // linha do tempo: a trilha de vídeo diz que não há áudio, e as miniaturas vêm da tela
  await expect(page.getByTestId('track-video')).toContainText('Sem áudio nesta gravação')
  await expect.poll(() => page.locator('[data-testid=track-video] .tl-thumbs img').count(), { timeout: 30_000 }).toBeGreaterThan(2)
  await expect(page.getByTestId('waveform')).toHaveCount(0)
  // o estado do áudio não finge que "prepara a voz tratada" onde não há voz
  await expect(page.getByTestId('audio-status')).toHaveAttribute('data-treated', 'none')
  await expect(page.getByTestId('audio-status')).toContainText('Sem áudio nesta gravação')
  await shot(page, '47-editor-sem-voz-e-sem-cursor')
})

test('arquivo da tela que sumiu: erro DESENHADO na prévia, com o motivo, e o resto do editor segue de pé', async () => {
  test.setTimeout(90_000)
  s = await launchTomada()
  const { page } = s
  editProject(s, (p) => {
    p.zoomPreset = 'off'
  })
  rmSync(join(s.projects, EXAMPLE_FOLDER, 'media', 'screen.mp4'))
  await page.getByTestId('card-open').click()
  await expect(page.getByTestId('editor')).toBeVisible()
  await expect(page.getByTestId('preview-error')).toBeVisible()
  await expect(page.getByTestId('preview-error')).toContainText('A prévia não consegue mostrar este vídeo')
  await expect(page.getByTestId('preview-error')).toContainText('O arquivo não foi encontrado')
  await expect(page.getByRole('button', { name: /pasta/i }).first()).toBeVisible()
  await shot(page, '48-editor-arquivo-sumiu')
  // a edição continua possível e voltar à biblioteca também
  await page.getByTestId('tab-camera').click()
  await expect(page.getByTestId('camera-panel')).toBeVisible()
  await page.getByTestId('back-to-library').click()
  await expect(page.getByTestId('project-card')).toHaveCount(1)
  s.problems.length = 0 // o 404 do vídeo que sumiu aparece como erro de mídia no console, de propósito
})
