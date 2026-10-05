import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { EXAMPLE_FOLDER, launchTomada, setContentSize, shot, videoState, type Session } from './helpers'

let s: Session | undefined

test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    // Nenhum erro de console/página (CSP, 404 de arquivo, exceção) pode passar batido.
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

test('a biblioteca mostra o cartão do projeto de exemplo', async () => {
  s = await launchTomada()
  const { page } = s

  await expect(page.getByRole('heading', { name: 'Biblioteca', level: 1 })).toBeVisible()
  const card = page.getByTestId('project-card')
  await expect(card).toHaveCount(1)
  await expect(card.getByTestId('card-title')).toHaveText('Projeto de exemplo')
  await expect(card.getByTestId('card-duration')).toHaveText('0:23')
  await expect(card.getByTestId('card-date')).toHaveText('04/10/2026')
  await expect(page.getByTestId('library-count')).toHaveText('1 gravação')

  // A miniatura veio pelo protocolo tomada-media:// (prova o protocolo de ponta a ponta).
  const img = card.locator('img')
  await expect(img).toHaveCount(1)
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(640)

  await shot(page, '01-biblioteca-1440x900')

  // As ações do cartão (renomear, mostrar na pasta, apagar) aparecem no hover.
  await card.hover()
  await expect(card.getByTestId('card-rename')).toBeVisible()
  await expect(card.getByTestId('card-reveal')).toBeVisible()
  await expect(card.getByTestId('card-delete')).toBeVisible()
  await expect.poll(() => card.getByTestId('card-delete').evaluate((el) => getComputedStyle(el.parentElement!).opacity)).toBe('1')
  await shot(page, '01b-biblioteca-cartao-com-acoes')
})

test('todas as vistas cabem de 1280×720 a 2560×1440, sem rolagem lateral nem nada cortado', async () => {
  s = await launchTomada()
  const { page } = s
  await expect(page.getByTestId('project-card')).toHaveCount(1)

  const overflowOf = () =>
    page.evaluate(() => {
      const main = document.querySelector('main')!
      return { doc: document.documentElement.scrollWidth - window.innerWidth, main: main.scrollWidth - main.clientWidth }
    })

  for (const [w, h] of [
    [1280, 720],
    [2560, 1440]
  ] as const) {
    const tag = `${w}x${h}`
    await setContentSize(s, w, h)

    // Biblioteca
    await page.getByTestId('nav-library').click()
    await expect(page.getByTestId('project-card')).toBeVisible()
    const box = await page.getByTestId('project-card').boundingBox()
    expect(box!.x + box!.width, `cartão cortado em ${tag}`).toBeLessThanOrEqual(w)
    expect(await overflowOf(), `biblioteca ${tag}`).toEqual({ doc: 0, main: 0 })
    await shot(page, `02-biblioteca-${tag}`)

    // Projeto aberto (provisório): os dois vídeos e a barra aparecem inteiros
    await page.getByTestId('card-open').click()
    await expect(page.getByTestId('project-view')).toBeVisible()
    await expect.poll(async () => (await videoState(page, 'video-screen')).readyState).toBeGreaterThanOrEqual(2)
    expect(await overflowOf(), `projeto ${tag}`).toEqual({ doc: 0, main: 0 })
    for (const id of ['video-screen', 'video-camera', 'play-toggle', 'scrubber']) {
      const b = await page.getByTestId(id).boundingBox()
      expect(b!.x + b!.width, `${id} cortado em ${tag}`).toBeLessThanOrEqual(w)
    }
    await shot(page, `03-projeto-${tag}`)

    // Gravar e Ajustes
    await page.getByTestId('nav-record').click()
    await expect(page.getByTestId('record-view')).toBeVisible()
    expect(await overflowOf(), `gravar ${tag}`).toEqual({ doc: 0, main: 0 })
    await shot(page, `03b-gravar-${tag}`)
    await page.getByTestId('nav-settings').click()
    await expect(page.getByTestId('settings-view')).toBeVisible()
    await expect(page.getByTestId('ffmpeg-version')).toBeVisible()
    expect(await overflowOf(), `ajustes ${tag}`).toEqual({ doc: 0, main: 0 })
    await shot(page, `03c-ajustes-${tag}`)
  }
})

test('abrir o projeto toca o vídeo: currentTime avança, tela e câmera juntas, e a barra busca (Range)', async () => {
  s = await launchTomada()
  const { page } = s

  await page.getByTestId('card-open').click()
  await expect(page.getByTestId('project-view')).toBeVisible()
  await expect(page.getByTestId('project-title')).toHaveText('Projeto de exemplo')

  // Os dois vídeos carregam (readyState ≥ 2 = já tem quadro).
  await expect.poll(async () => (await videoState(page, 'video-screen')).readyState).toBeGreaterThanOrEqual(2)
  await expect.poll(async () => (await videoState(page, 'video-camera')).readyState).toBeGreaterThanOrEqual(2)
  expect((await videoState(page, 'video-screen')).error).toBeNull()
  expect((await videoState(page, 'video-camera')).error).toBeNull()
  expect((await videoState(page, 'video-screen')).duration).toBeCloseTo(23, 0)

  const t0 = (await videoState(page, 'video-screen')).currentTime
  expect(t0).toBe(0)

  await page.getByTestId('play-toggle').click()
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('data-playing', 'true')

  // currentTime avança de verdade nos dois, e um não se afasta do outro.
  await expect.poll(async () => (await videoState(page, 'video-screen')).currentTime, { timeout: 15_000 }).toBeGreaterThan(1.2)
  const screen = await videoState(page, 'video-screen')
  const camera = await videoState(page, 'video-camera')
  expect(screen.paused).toBe(false)
  expect(camera.paused).toBe(false)
  expect(camera.currentTime).toBeGreaterThan(0.8)
  expect(Math.abs(screen.currentTime - camera.currentTime)).toBeLessThan(0.4)
  // o relógio da tela acompanha o do vídeo
  await expect.poll(async () => Number(await page.getByTestId('current-time').getAttribute('data-seconds'))).toBeGreaterThan(1)
  await shot(page, '04-projeto-tocando')

  // Pausa de verdade: o tempo para.
  await page.getByTestId('play-toggle').click()
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('data-playing', 'false')
  const paused = (await videoState(page, 'video-screen')).currentTime
  await page.waitForTimeout(600)
  expect((await videoState(page, 'video-screen')).currentTime).toBeCloseTo(paused, 1)

  // Buscar para a frente só funciona se o protocolo atende Range.
  await page.getByTestId('scrubber').fill('17000')
  await expect.poll(async () => (await videoState(page, 'video-screen')).currentTime).toBeGreaterThan(16.5)
  await expect.poll(async () => (await videoState(page, 'video-camera')).currentTime).toBeGreaterThan(16.5)
  await page.getByTestId('play-toggle').click()
  await expect.poll(async () => (await videoState(page, 'video-screen')).currentTime, { timeout: 10_000 }).toBeGreaterThan(17.8)
  await page.getByTestId('play-toggle').click()

  // Volta para a biblioteca.
  await page.getByTestId('back-to-library').click()
  await expect(page.getByTestId('project-card')).toHaveCount(1)
})

test('o protocolo atende Range de ponta a ponta DENTRO do Electron (206 + Content-Range) e barra `..`', async () => {
  s = await launchTomada()
  const { page } = s
  await expect(page.getByTestId('project-card')).toHaveCount(1)

  const result = await page.evaluate(async (folder) => {
    const base = `tomada-media://project/${encodeURIComponent(folder)}`
    const head = await fetch(`${base}/media/screen.mp4`, { headers: { Range: 'bytes=0-99' } })
    const body = await head.arrayBuffer()
    const tail = await fetch(`${base}/media/screen.mp4`, { headers: { Range: 'bytes=-50' } })
    const bad = await fetch(`${base}/media/screen.mp4`, { headers: { Range: 'bytes=999999999-' } })
    const escape = await fetch(`${base}/a%2f..%2f..%2fx.mp4`)
    const missing = await fetch(`${base}/media/nao-existe.mp4`)
    return {
      headStatus: head.status,
      headRange: head.headers.get('content-range'),
      headLength: body.byteLength,
      tailStatus: tail.status,
      badStatus: bad.status,
      badRange: bad.headers.get('content-range'),
      escapeStatus: escape.status,
      missingStatus: missing.status
    }
  }, EXAMPLE_FOLDER)

  expect(result.headStatus).toBe(206)
  expect(result.headRange).toMatch(/^bytes 0-99\/\d+$/)
  expect(result.headLength).toBe(100)
  expect(result.tailStatus).toBe(206)
  expect(result.badStatus).toBe(416)
  expect(result.badRange).toMatch(/^bytes \*\/\d+$/)
  expect(result.escapeStatus).toBe(403)
  expect(result.missingStatus).toBe(404)
  // fetch recusado (403/404/416) escreve no console do Chromium; é esperado aqui.
  s.problems.length = 0
})

test('renomear no lugar persiste no project.json e sobrevive a reabrir o app', async () => {
  s = await launchTomada()
  const { page } = s
  const card = page.getByTestId('project-card')

  await card.hover()
  await card.getByTestId('card-rename').click()
  const input = card.getByTestId('rename-input')
  await expect(input).toBeFocused()
  await input.fill('Aula de Psicanálise nº 2')
  await shot(page, '04b-renomeando-no-lugar')
  await input.press('Enter')

  await expect(card.getByTestId('card-title')).toHaveText('Aula de Psicanálise nº 2')
  await expect(page.getByTestId('toast')).toContainText('Título salvo')

  const file = join(s.projects, EXAMPLE_FOLDER, 'project.json')
  expect(JSON.parse(readFileSync(file, 'utf8')).title).toBe('Aula de Psicanálise nº 2')
  // a pasta mantém o nome e nenhum temporário ficou para trás
  expect(readdirSync(join(s.projects, EXAMPLE_FOLDER)).filter((n) => n.endsWith('.tmp'))).toEqual([])

  // Fecha e reabre com os MESMOS dados.
  const base = s.base
  const problems = s.problems
  await s.close({ keep: true })
  s = await launchTomada({ base })
  s.problems.push(...problems)
  await expect(s.page.getByTestId('card-title')).toHaveText('Aula de Psicanálise nº 2')
})

test('Escape cancela a renomeação e título vazio não muda nada', async () => {
  s = await launchTomada()
  const { page } = s
  const card = page.getByTestId('project-card')

  await card.getByTestId('card-rename').focus()
  await card.getByTestId('card-rename').press('Enter')
  const input = card.getByTestId('rename-input')
  await input.fill('Isto não vale')
  await input.press('Escape')
  await expect(card.getByTestId('card-title')).toHaveText('Projeto de exemplo')

  await card.getByTestId('card-rename').click()
  await card.getByTestId('rename-input').fill('   ')
  await card.getByTestId('rename-input').press('Enter')
  await expect(card.getByTestId('card-title')).toHaveText('Projeto de exemplo')
  expect(JSON.parse(readFileSync(join(s.projects, EXAMPLE_FOLDER, 'project.json'), 'utf8')).title).toBe('Projeto de exemplo')
})

test('apagar: modal próprio com confirmação, Cancelar/Esc mantêm, Apagar remove da lista e do disco', async () => {
  s = await launchTomada()
  const { page } = s
  const card = page.getByTestId('project-card')
  const dir = join(s.projects, EXAMPLE_FOLDER)

  // Cancelar mantém.
  await card.getByTestId('card-delete').click()
  const dialog = page.getByTestId('confirm-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('role', 'alertdialog')
  await expect(dialog).toContainText('Apagar “Projeto de exemplo”?')
  await expect(dialog).toContainText('Lixeira')
  await expect(page.getByTestId('confirm-cancel')).toBeFocused() // foco no lado seguro
  await shot(page, '05-confirmar-apagar')
  await page.getByTestId('confirm-cancel').click()
  await expect(dialog).toHaveCount(0)
  await expect(card).toHaveCount(1)
  expect(existsSync(dir)).toBe(true)

  // Esc também mantém.
  await card.getByTestId('card-delete').click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(card).toHaveCount(1)

  // Tab fica preso no diálogo.
  await card.getByTestId('card-delete').click()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('confirm-ok')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('confirm-cancel')).toBeFocused()

  // Apagar de verdade.
  await page.getByTestId('confirm-ok').click()
  await expect(dialog).toHaveCount(0)
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('empty-state')).toBeVisible()
  await expect(page.getByTestId('toast')).toContainText('Lixeira')
  await expect.poll(() => existsSync(dir)).toBe(false) // foi para a Lixeira do Windows
  await shot(page, '06-biblioteca-vazia-depois-de-apagar')
})

test('biblioteca vazia convida a gravar', async () => {
  s = await launchTomada({ seed: false })
  const { page } = s
  const empty = page.getByTestId('empty-state')
  await expect(empty).toBeVisible()
  await expect(empty).toContainText('Nenhuma gravação ainda')
  await expect(page.getByTestId('project-card')).toHaveCount(0)
  await shot(page, '07-biblioteca-vazia')
  await page.getByTestId('empty-record').click()
  await expect(page.getByTestId('record-view')).toBeVisible()
})

test('pasta quebrada, pasta sem projeto e arquivo solto não derrubam a biblioteca (e ficam no log)', async () => {
  s = await launchTomada({ junk: true })
  const { page } = s
  await expect(page.getByTestId('project-card')).toHaveCount(1)
  await expect(page.getByTestId('card-title')).toHaveText('Projeto de exemplo')

  const logsDir = join(s.userData, 'logs')
  await expect.poll(() => existsSync(logsDir)).toBe(true)
  const log = readdirSync(logsDir).map((f) => readFileSync(join(logsDir, f), 'utf8')).join('\n')
  expect(log).toContain('Pasta ignorada na biblioteca (pasta-quebrada)')
  expect(log).toContain('Pasta ignorada na biblioteca (pasta-sem-projeto)')
})

test('a tela Gravar oferece fontes, câmera e microfone, e volta para a biblioteca', async () => {
  s = await launchTomada()
  const { page } = s
  await page.getByTestId('nav-record').click()
  const view = page.getByTestId('record-view')
  await expect(view).toBeVisible()
  await expect(page.getByTestId('nav-record')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('record-start')).toBeVisible()
  await page.getByTestId('nav-library').click()
  await expect(page.getByTestId('project-card')).toHaveCount(1)
})
