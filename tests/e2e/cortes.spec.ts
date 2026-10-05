/**
 * CORTES VERTICAIS, PUBLICAR e EDITAR PEDINDO (M4b) de ponta a ponta, no Electron de verdade, com a IA de TESTE
 * (`TOMADA_LLM=mock` + respostas gravadas por tarefa) e a transcrição sintética da demonstração "Agendaí" no projeto de 3 minutos.
 *
 *  - sugerir cortes → lista → exportar 2 em lote → arquivos 1080×1920 com áudio e a legenda no quadro (pixel do amarelo de
 *    destaque, dentro da caixa segura) + folha de contato de um corte;
 *  - editar pedindo: UMA mudança, Ctrl+Z desfaz; confirmação acima de 20%; operação inválida recusada com o motivo;
 *  - publicar: capítulos válidos para o YouTube; textos por corte;
 *  - sem IA: a heurística de cortes e os capítulos por pausas funcionam e a interface explica como ligar a IA;
 *  - a interface nunca nomeia o fornecedor da IA.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { clipDocument } from '../../src/shared/clips'
import { keptRanges, outputDuration, sourceToOutput } from '../../src/shared/timeline'
import { audioPcm, frameRgb, probeJson } from '../helpers/media'
import {
  CLIPS_RESPONSES,
  DEMO,
  LONG_MS,
  PUBLISH_RESPONSE,
  TOPIC,
  VENDOR,
  cleanupLong,
  editResponse,
  launchLong,
  longDir,
  range,
  readLong
} from './cortes-helpers'
import { openEditor, waitSaved } from './editor-helpers'
import { ROOT, SCREENS_DIR, shot, type Session } from './helpers'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    cleanupLong()
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

const FRAME_MS = 1000 / 30
const W = 1080
const H = 1920
const SAFE = { x0: 65, x1: 940, y0: 270, y1: 1440 }
/** O amarelo de destaque do Destaque (#FFD93D). */
const YELLOW = { r: 255, g: 217, b: 61 }

const isYellow = (px: Uint8Array, i: number): boolean => Math.abs(px[i]! - YELLOW.r) <= 30 && Math.abs(px[i + 1]! - YELLOW.g) <= 30 && Math.abs(px[i + 2]! - YELLOW.b) <= 45

/** Quantos pixels amarelos há no quadro e a caixa que eles ocupam (linhas e colunas com pelo menos 6: o ruído solto não conta). */
function yellowBox(px: Uint8Array): { count: number; x0: number; x1: number; y0: number; y1: number } {
  const rows = new Array<number>(H).fill(0)
  const cols = new Array<number>(W).fill(0)
  let count = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isYellow(px, (y * W + x) * 3)) {
        rows[y]!++
        cols[x]!++
        count++
      }
    }
  }
  const first = (arr: number[]): number => arr.findIndex((v) => v >= 6)
  const last = (arr: number[]): number => arr.length - 1 - [...arr].reverse().findIndex((v) => v >= 6)
  return { count, x0: first(cols), x1: last(cols), y0: first(rows), y1: last(rows) }
}

/** O texto visível da página inteira: nenhum fornecedor de IA pode aparecer. */
async function expectNoVendor(page: Page, where: string): Promise<void> {
  const text = await page.evaluate(() => document.body.innerText)
  expect(text, `a interface nomeou o fornecedor da IA (${where})`).not.toMatch(VENDOR)
}

/** "Sugerir cortes" e, em seguida, "Sugerir mais cortes": os três cortes do roteiro (o terceiro vem do segundo pedido). */
async function suggestThree(page: Page): Promise<void> {
  await page.getByTestId('clips-suggest').click()
  await expect(page.getByTestId('clip-card')).toHaveCount(2)
  await page.getByTestId('clips-suggest').click()
  await expect(page.getByTestId('clip-card')).toHaveCount(3)
}

/** O painel lateral nunca ganha rolagem horizontal (nada passa da borda, nem com título e texto compridos). */
async function expectNoPanelOverflow(page: Page, where: string): Promise<void> {
  const o = await page.evaluate(() => {
    const body = document.querySelector('.ed-panel-body')!
    return { scroll: body.scrollWidth, client: body.clientWidth }
  })
  expect(o.scroll, `rolagem horizontal no painel (${where})`).toBeLessThanOrEqual(o.client)
}

async function openClips(session: Session): Promise<Page> {
  const { page } = session
  await openEditor(session)
  await page.getByTestId('tab-clips').click()
  await expect(page.getByTestId('clips-suggest')).toBeVisible()
  return page
}

/** "34,6 s" ou "1 min 04 s" → segundos. */
function secondsOf(text: string | null): number {
  const t = text ?? ''
  const min = /(\d+)\s*min\s*(\d+)\s*s/.exec(t)
  if (min) return Number(min[1]) * 60 + Number(min[2])
  return Number(t.replace(/[^\d,]/g, '').replace(',', '.'))
}

// ---------------------------------------------------------------------------------------------------------------------

test('sugerir cortes → lista → exportar 2 em lote: arquivos 1080×1920 com áudio e a legenda no quadro, e a folha de contato', async () => {
  test.setTimeout(900_000)
  s = await launchLong({ responses: CLIPS_RESPONSES })
  const page = await openClips(s)

  // (1) sugerir: dois cortes (um vídeo de 3 min comporta 2 por pedido), com título, gancho, nota e duração (30 a 60 s)
  await page.getByTestId('clips-suggest').click()
  const cards = page.getByTestId('clip-card')
  await expect(cards).toHaveCount(2)
  await expect(page.getByTestId('clips-last')).toHaveAttribute('data-source', 'ai')
  await expect(page.getByTestId('clips-last')).toContainText('2 cortes sugeridos pela IA')
  // "Sugerir mais cortes": o que já existe não se repete (a conferência diz por quê) e o terceiro assunto entra
  await expect(page.getByTestId('clips-suggest')).toContainText('Sugerir mais cortes')
  await page.getByTestId('clips-suggest').click()
  await expect(cards).toHaveCount(3)
  await expect(page.getByTestId('clips-last')).toContainText('1 corte sugerido pela IA')
  await page.getByTestId('clips-dropped').locator('summary').click()
  await expect(page.getByTestId('clips-dropped')).toContainText('repete o corte')
  await expect(page.getByTestId('clip-title').nth(0)).toContainText('Agende em três cliques, sem planilha')
  await expect(page.getByTestId('clip-hook').nth(1)).toContainText('Os lembretes saem sozinhos')
  for (let k = 0; k < 3; k++) {
    const secs = secondsOf(await page.getByTestId('clip-duration').nth(k).textContent())
    expect(secs, `duração do corte ${k + 1}`).toBeGreaterThanOrEqual(30)
    expect(secs, `duração do corte ${k + 1}`).toBeLessThanOrEqual(60)
  }
  await expect(cards.nth(0)).toContainText('Nota 90')
  await expect(cards.nth(0)).toContainText('Gancho 88 · Fluxo 90 · Valor 92')
  await expectNoVendor(page, 'aba Cortes com a lista')
  await shot(page, 'cortes-01-lista')

  // (2) marca 2 e exporta em lote pela fila
  await expect(page.getByTestId('clips-export-selected')).toBeDisabled()
  await cards.nth(0).getByTestId('clip-select').check()
  await cards.nth(1).getByTestId('clip-select').check()
  await expect(page.getByTestId('clips-selected-count')).toHaveText('2 cortes selecionados')
  await page.getByTestId('clips-export-selected').click()
  await expect(page.getByTestId('clip-queue-item')).toHaveCount(2)
  await expect(page.getByTestId('clips-queue-cancel')).toBeVisible()
  await shot(page, 'cortes-02-fila')
  await expect(page.getByTestId('clip-queue-item').nth(0)).toHaveAttribute('data-state', 'done', { timeout: 420_000 })
  await expect(page.getByTestId('clip-queue-item').nth(1)).toHaveAttribute('data-state', 'done', { timeout: 420_000 })
  await expect(page.getByTestId('clip-queue-summary')).toContainText('2 de 2 cortes exportados')
  await expect(page.getByTestId('clips-queue-cancel')).toHaveCount(0)
  await expectNoPanelOverflow(page, 'aba Cortes com a fila pronta')
  await shot(page, 'cortes-03-fila-pronta')

  // (3) os arquivos: nome "NN - título", MP4 + texto de legenda e hashtags
  const out = join(longDir(s), 'exports', 'cortes')
  const names = readdirSync(out).sort()
  console.log(`exports/cortes: ${names.join(' | ')}`)
  const mp4s = names.filter((n) => n.endsWith('.mp4'))
  const txts = names.filter((n) => n.endsWith('.txt'))
  expect(mp4s).toHaveLength(2)
  expect(txts).toHaveLength(2)
  expect(mp4s[0]).toMatch(/^01 - .*Agende em três cliques.*\.mp4$/)
  expect(mp4s[1]).toMatch(/^02 - .*Lembrete automático.*\.mp4$/)
  expect(readFileSync(join(out, txts[0]!), 'utf8')).toContain('Agende em três cliques')

  const doc = readLong(s)
  expect(doc.clips).toHaveLength(3)
  const sheets: string[] = []
  for (const [k, name] of mp4s.entries()) {
    const file = join(out, name)
    const clip = doc.clips[k]!
    // a limpeza do projeto (os 30 cortes de silêncio) vale dentro do corte; o que está fora dos trechos sai
    const scene = clipDocument(doc, clip)
    const expectedMs = outputDuration(LONG_MS, scene.cuts)
    expect(expectedMs).toBeGreaterThan(25_000)
    expect(expectedMs).toBeLessThan(65_000)
    const probe = probeJson(file)
    const video = probe.streams.find((x) => x.codec_type === 'video')!
    const audio = probe.streams.find((x) => x.codec_type === 'audio')!
    expect(video, `vídeo do corte ${k + 1}`).toMatchObject({ codec_name: 'h264', width: 1080, height: 1920, pix_fmt: 'yuv420p', r_frame_rate: '30/1' })
    expect(audio, `áudio do corte ${k + 1}`).toMatchObject({ codec_name: 'aac', sample_rate: '48000' })
    expect(Math.abs(Number(video.duration) * 1000 - expectedMs), `duração do corte ${k + 1}`).toBeLessThanOrEqual(FRAME_MS * 1.5)
    expect(Math.abs(Number(audio.duration) - Number(video.duration)) * 1000).toBeLessThan(60)

    // o áudio tem fala de verdade (não é silêncio): a voz do projeto, com os cortes de silêncio e o que ficou fora do corte tirados
    const pcm = audioPcm(file)
    let peak = 0
    for (let i = 0; i < pcm.length; i += 4) peak = Math.max(peak, Math.abs(pcm[i]!))
    expect(peak, `o áudio do corte ${k + 1} está mudo`).toBeGreaterThan(2000)

    // a legenda no quadro: uma palavra inteira, longa e fora dos cortes de silêncio, falada depois do gancho (os 2 primeiros s)
    const kept = keptRanges(LONG_MS, scene.cuts)
    const word = DEMO.words.find((w) => {
      if (w.kind !== 'word' || w.end - w.start < 380) return false
      if (!kept.some((r) => w.start >= r.start + 60 && w.end <= r.end - 60)) return false
      return sourceToOutput(w.start, kept) > 4000 && clip.ranges.some((r) => w.start >= r.start && w.end <= r.end)
    })
    expect(word, `uma palavra longa dentro do corte ${k + 1} para conferir a legenda`).toBeDefined()
    const atMs = sourceToOutput((word!.start + word!.end) / 2, kept)
    const px = frameRgb(file, Math.round((atMs / 1000) * 30), W, H)
    const box = yellowBox(px)
    console.log(`corte ${k + 1}: palavra "${word!.text}" em ${(atMs / 1000).toFixed(2)} s: ${box.count} pixels amarelos, caixa x ${box.x0}–${box.x1}, y ${box.y0}–${box.y1}`)
    expect(box.count, `a palavra acesa tem de pôr o amarelo de destaque no quadro (corte ${k + 1})`).toBeGreaterThan(1500)
    expect(box.x0).toBeGreaterThanOrEqual(SAFE.x0 - 6)
    expect(box.x1).toBeLessThanOrEqual(SAFE.x1 + 6)
    expect(box.y0).toBeGreaterThanOrEqual(SAFE.y0 - 6)
    expect(box.y1).toBeLessThanOrEqual(SAFE.y1 + 6)

    // folha de contato do corte (6 × 2, 270 px de largura): a olho, o enquadramento, a legenda e o gancho
    const sheet = join(SCREENS_DIR, k === 0 ? 'corte-vertical-folha-de-contato.png' : `corte-vertical-${k + 1}-folha-de-contato.png`)
    execFileSync('node', [join(ROOT, 'scripts', 'contact-sheet.mjs'), file, sheet, '6', '2', '270'], { windowsHide: true })
    expect(statSync(sheet).size).toBeGreaterThan(20_000)
    sheets.push(sheet)
  }
  console.log(`folhas de contato dos cortes exportados:\n  ${sheets.join('\n  ')}`)
  expect(existsSync(sheets[0]!)).toBe(true)
  await expectNoVendor(page, 'aba Cortes com a fila pronta')
})

test('folha de contato de um corte com tela e câmera: a edição vertical automática (zoom e layout pela atividade) vale dentro do corte', async () => {
  test.setTimeout(300_000)
  s = await launchLong({ responses: CLIPS_RESPONSES, camera: true, solidScreen: false, fixedVertical: false })
  const page = await openClips(s)
  await page.getByTestId('clips-suggest').click()
  await expect(page.getByTestId('clip-card')).toHaveCount(2)
  await page.getByTestId('clip-card').nth(0).getByTestId('clip-select').check()
  await page.getByTestId('clips-export-selected').click()
  await expect(page.getByTestId('clip-queue-item').nth(0)).toHaveAttribute('data-state', 'done', { timeout: 300_000 })
  const out = join(longDir(s), 'exports', 'cortes')
  const mp4 = readdirSync(out).find((n) => n.endsWith('.mp4'))!
  const file = join(out, mp4)
  const probe = probeJson(file)
  expect(probe.streams.find((x) => x.codec_type === 'video')).toMatchObject({ width: 1080, height: 1920 })
  expect(probe.streams.find((x) => x.codec_type === 'audio')).toBeDefined()
  const sheet = join(SCREENS_DIR, 'corte-vertical-tela-e-camera-folha-de-contato.png')
  execFileSync('node', [join(ROOT, 'scripts', 'contact-sheet.mjs'), file, sheet, '6', '2', '270'], { windowsHide: true })
  expect(statSync(sheet).size).toBeGreaterThan(20_000)
  console.log(`folha de contato (tela e câmera, edição automática): ${sheet}`)
  // a exportação não escreveu na edição vertical do projeto aberto: o vertical só nasce quando a pessoa o abre
  await expectNoVendor(page, 'aba Cortes (tela e câmera)')
})

test('prévia do corte, edição (gancho, começo e fim por frase), apagar e desfazer', async () => {
  test.setTimeout(240_000)
  s = await launchLong({ responses: CLIPS_RESPONSES })
  const page = await openClips(s)
  await suggestThree(page)
  const cards = page.getByTestId('clip-card')

  // a prévia mostra o CORTE (sempre 9:16) e o relógio é o do corte
  const clipSecs = secondsOf(await page.getByTestId('clip-duration').nth(0).textContent())
  await cards.nth(0).getByTestId('clip-preview').click()
  await expect(page.getByTestId('preview-clip-banner')).toContainText('Prévia do corte «Agende em três cliques, sem planilha»')
  await expect(page.getByTestId('preview-frame')).toHaveAttribute('data-format', 'vertical')
  await expect.poll(async () => Number(await page.getByTestId('current-time').getAttribute('data-total-ms')) / 1000).toBeGreaterThan(clipSecs - 1)
  const totalMs = Number(await page.getByTestId('current-time').getAttribute('data-total-ms'))
  expect(Math.abs(totalMs / 1000 - clipSecs)).toBeLessThan(1)
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true')
  await shot(page, 'cortes-04-previa-do-corte')
  await page.getByTestId('preview-clip-exit').click()
  await expect(page.getByTestId('preview-clip-banner')).toHaveCount(0)
  await expect.poll(async () => Number(await page.getByTestId('current-time').getAttribute('data-total-ms'))).toBeGreaterThan(totalMs * 3)

  // editar: gancho (contagem de palavras e aviso acima de 8), layout e começo/fim uma frase para o lado
  await cards.nth(0).getByTestId('clip-edit-toggle').click()
  const hook = cards.nth(0).getByTestId('clip-hook-input')
  await hook.fill('Agende um cliente em três cliques e sem planilha nenhuma')
  await expect(cards.nth(0).getByTestId('clip-hook-count')).toContainText('10 de 8 palavras')
  await expect(cards.nth(0)).toContainText('passa de 8 palavras')
  await hook.fill('Agende em três cliques')
  await expect(cards.nth(0).getByTestId('clip-hook-count')).toContainText('4 de 8 palavras')
  await cards.nth(0).getByTestId('clip-layout-screen-wide').click()
  await expect(cards.nth(0).getByTestId('clip-layout-screen-wide')).toHaveAttribute('aria-pressed', 'true')
  const before = secondsOf(await page.getByTestId('clip-duration').nth(0).textContent())
  await cards.nth(0).getByTestId('clip-start-later').click()
  await expect.poll(async () => secondsOf(await page.getByTestId('clip-duration').nth(0).textContent())).toBeLessThan(before)
  await cards.nth(0).getByTestId('clip-end-later').click()
  await expect(cards.nth(0)).toContainText('Ajustado')
  await waitSaved(s)
  const saved = readLong(s).clips[0]!
  expect(saved).toMatchObject({ hook: 'Agende em três cliques', layoutV: 'screen-wide', source: 'manual' })

  // apagar e desfazer (o corte volta como estava)
  await cards.nth(2).getByTestId('clip-delete').click()
  await expect(cards).toHaveCount(2)
  await page.getByTestId('tab-clips').click() // tira o foco de qualquer campo
  await page.keyboard.press('Control+z')
  await expect(cards).toHaveCount(3)
  await expect(page.getByTestId('clip-title').nth(2)).toContainText('Feche o mês em um minuto')
  await expectNoPanelOverflow(page, 'aba Cortes editando')
  await expectNoVendor(page, 'aba Cortes editando')
})

test('editar pedindo: uma mudança só, Ctrl+Z desfaz; acima de 20% pede confirmação; o que não vale é recusado com o motivo', async () => {
  test.setTimeout(240_000)
  const small = [{ op: 'cut', from: range(4, 5)[0], to: range(4, 5)[1], reason: 'repetição' }]
  const huge = [{ op: 'cut', from: range(...TOPIC.cliente)[0], to: range(...TOPIC.agenda)[1], reason: 'só o final' }]
  const bad = [
    { op: 'cut', from: 99_999, to: 100_000 },
    { op: 'layout', from: range(10, 10)[0], to: range(10, 10)[1], layout: 'inexistente' }
  ]
  s = await launchLong({
    responses: [
      editResponse('tira o cadastro', small, 'Tirei a parte do cadastro.'),
      editResponse('quase tudo', huge, 'Deixei só o final.'),
      editResponse('algo impossível', bad, 'Não consegui.'),
      editResponse('só conversa', [], 'Isso eu não consigo fazer com estas operações.')
    ]
  })
  const { page } = s
  await openEditor(s)
  await page.getByTestId('tab-ai').click()
  await expect(page.getByTestId('ai-input')).toBeVisible()
  const cutsBefore = readLong(s).cuts.length
  expect(cutsBefore).toBe(30)
  await expectNoVendor(page, 'aba IA')

  const ask = async (text: string): Promise<void> => {
    await page.getByTestId('ai-input').fill(text)
    await page.getByTestId('ai-ask').click()
  }
  const history = page.getByTestId('ai-history-item')

  // (1) pedido pequeno: aplicado, com resumo humano, e Ctrl+Z desfaz TUDO (um passo só)
  await ask('tira o cadastro dos clientes')
  await expect(history.first()).toHaveAttribute('data-status', 'applied')
  await expect(page.getByTestId('ai-history-text').first()).toContainText(/Cortei/)
  await expect(page.getByTestId('ai-history-text').first()).toContainText('Ctrl+Z desfaz')
  await expect.poll(() => readLong(s!).cuts.length).toBe(cutsBefore + 1)
  const applied = readLong(s)
  expect(applied.cuts.some((c) => c.reason === 'ai')).toBe(true)
  await shot(page, 'cortes-05-editar-pedindo')
  await page.getByTestId('tab-ai').click() // tira o foco do campo de texto
  await page.keyboard.press('Control+z')
  await expect.poll(() => readLong(s!).cuts.length).toBe(cutsBefore)
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => readLong(s!).cuts.length).toBe(cutsBefore + 1)
  await page.keyboard.press('Control+z')
  await expect.poll(() => readLong(s!).cuts.length).toBe(cutsBefore)

  // (2) tira mais de 20% do vídeo: espera confirmação; cancelar não muda nada; aplicar é UMA mudança
  await ask('tira quase tudo')
  await expect(page.getByTestId('ai-confirm')).toBeVisible()
  await expect(page.getByTestId('ai-confirm-body')).toContainText(/remove \d+% do vídeo/)
  await page.waitForTimeout(800)
  expect(readLong(s).cuts.length).toBe(cutsBefore)
  await page.getByTestId('ai-confirm-cancel').click()
  await expect(history.first()).toHaveAttribute('data-status', 'cancelled')
  expect(readLong(s).cuts.length).toBe(cutsBefore)
  await ask('tira quase tudo')
  await page.getByTestId('ai-confirm-ok').click()
  await expect(history.first()).toHaveAttribute('data-status', 'applied')
  await expect.poll(() => readLong(s!).cuts.length).toBe(cutsBefore + 1)
  await page.getByTestId('tab-ai').click()
  await page.keyboard.press('Control+z')
  await expect.poll(() => readLong(s!).cuts.length).toBe(cutsBefore)

  // (3) operações inválidas: recusadas com o motivo, nada aplicado pela metade
  await ask('faz algo impossível')
  await expect(history.first()).toHaveAttribute('data-status', 'refused')
  await page.getByTestId('ai-refused-toggle').first().click()
  await expect(page.getByTestId('ai-refused').first()).toContainText('Recusei:')
  await page.waitForTimeout(800)
  expect(readLong(s).cuts.length).toBe(cutsBefore)
  expect(readLong(s).layouts).toEqual([])

  // (4) o que a IA não sabe fazer vira uma resposta, sem mudança
  await ask('só conversa')
  await expect(history.first()).toHaveAttribute('data-status', 'noop')
  await expect(page.getByTestId('ai-history-text').first()).toContainText('não consigo fazer')
  await expectNoPanelOverflow(page, 'aba IA com o histórico')
  await expectNoVendor(page, 'aba IA com o histórico')
})

test('publicar: títulos, descrição, capítulos válidos para o YouTube, texto por corte, copiar', async () => {
  test.setTimeout(240_000)
  s = await launchLong({ responses: [...CLIPS_RESPONSES, PUBLISH_RESPONSE] })
  const { page } = s
  await openEditor(s)
  // os cortes primeiro: o texto de cada um sai junto
  await page.getByTestId('tab-clips').click()
  await suggestThree(page)

  await page.getByTestId('tab-publish').click()
  await expect(page.getByTestId('publish-generate')).toBeEnabled()
  await page.getByTestId('publish-generate').click()
  await expect(page.getByTestId('publish-title-input')).toHaveCount(3)
  await expect(page.getByTestId('publish-title-input').first()).toHaveValue(/Agenda de barbearia/)

  // capítulos: o primeiro em 00:00, pelo menos 3, cada um com 10 s ou mais, e a página diz que valem
  const chapters = page.getByTestId('publish-chapter')
  expect(await chapters.count()).toBeGreaterThanOrEqual(3)
  await expect(page.getByTestId('publish-chapter-time').first()).toHaveText('00:00')
  await expect(page.getByTestId('publish-chapters-ok')).toBeVisible()
  const lines = await page.getByTestId('publish-chapter-time').allTextContents()
  const secs = lines.map((l) => {
    const [m, sec] = l.split(':').map(Number)
    return m! * 60 + sec!
  })
  for (let k = 1; k < secs.length; k++) expect(secs[k]! - secs[k - 1]!, `capítulo ${k + 1} com menos de 10 s`).toBeGreaterThanOrEqual(10)
  const outMs = outputDuration(LONG_MS, readLong(s).cuts)
  expect(outMs / 1000 - secs[secs.length - 1]!).toBeGreaterThanOrEqual(10)
  await expect(page.getByTestId('publish-chapter-title').nth(1)).toHaveValue('Cadastro de clientes')

  // texto por corte (os dois que a IA escreveu; o terceiro cai no texto sem IA, e a tela avisa)
  const clipTexts = page.getByTestId('publish-clip')
  await expect(clipTexts).toHaveCount(3)
  await expect(clipTexts.nth(0).getByTestId('publish-clip-caption')).toHaveValue(/Agende em três cliques/)
  await expect(clipTexts.nth(2)).toContainText('Sem texto guardado')
  await expect(clipTexts.nth(0).getByTestId('publish-clip-shorts')).toHaveValue(/#agenda #Shorts/)

  // copiar: a descrição sai com os capítulos
  await page.getByTestId('publish-description-copy').click()
  const clip = await s.app.evaluate(({ clipboard }) => clipboard.readText())
  expect(clip).toContain('O Agendaí é uma agenda feita para barbearias')
  expect(clip).toMatch(/^00:00 \S/m)
  expect(clip).toContain('Relatório do mês')

  // usar um título como título do projeto
  await page.getByTestId('publish-title-use').nth(1).click()
  await expect(page.getByTestId('publish-title-use').nth(1)).toContainText('Usar como título do projeto')
  await expect.poll(() => readLong(s!).title).toBe('Cadastro, agenda, lembrete e relatório em 3 minutos')
  await expect(page.getByTestId('project-title')).toContainText('Cadastro, agenda, lembrete e relatório em 3 minutos')

  // tudo vai para o documento (volta a abrir igual)
  const saved = readLong(s)
  expect(saved.meta?.youtube?.titles).toHaveLength(3)
  expect(saved.meta?.youtube?.chapters?.length).toBeGreaterThanOrEqual(3)
  expect(saved.meta?.perClip?.['clip-1']?.caption).toContain('Agende em três cliques')
  await shot(page, 'cortes-06-publicar')
  await expectNoPanelOverflow(page, 'aba Publicar')
  await expectNoVendor(page, 'aba Publicar')
})

test('SEM IA: a heurística sugere cortes, os capítulos saem das pausas, e a interface explica por que a IA não está e como ligar', async () => {
  test.setTimeout(240_000)
  s = await launchLong({ llm: 'off' })
  const { page } = s
  await openEditor(s)

  // Cortes: o aviso, e "Sugerir cortes" cai na heurística com o motivo
  await page.getByTestId('tab-clips').click()
  await expect(page.getByTestId('clips-ai-off')).toContainText('Ajustes')
  await expect(page.getByTestId('clips-ai-off')).toContainText('desligada')
  await page.getByTestId('clips-suggest').click()
  await expect(page.getByTestId('clip-card').first()).toBeVisible()
  await expect(page.getByTestId('clips-last')).toHaveAttribute('data-source', 'heuristic')
  await expect(page.getByTestId('clips-notice')).toContainText('Sem IA')
  await expect(page.getByTestId('clips-notice')).toContainText('Ajustes')
  const n = await page.getByTestId('clip-card').count()
  expect(n).toBeGreaterThanOrEqual(1)
  for (let k = 0; k < n; k++) {
    const secs = secondsOf(await page.getByTestId('clip-duration').nth(k).textContent())
    expect(secs).toBeGreaterThanOrEqual(25)
    expect(secs).toBeLessThanOrEqual(65)
  }
  await shot(page, 'cortes-07-sem-ia')

  // Publicar: gerar com IA está desligado e explica; capítulos pelas pausas funcionam
  await page.getByTestId('tab-publish').click()
  await expect(page.getByTestId('publish-ai-off')).toContainText('Ajustes')
  await expect(page.getByTestId('publish-generate')).toBeDisabled()
  await page.getByTestId('publish-chapters-pauses').click()
  await expect(page.getByTestId('publish-chapter').first()).toBeVisible()
  expect(await page.getByTestId('publish-chapter').count()).toBeGreaterThanOrEqual(3)
  await expect(page.getByTestId('publish-chapter-time').first()).toHaveText('00:00')
  await expect(page.getByTestId('publish-chapters-ok')).toBeVisible()
  await expect(page.getByTestId('publish-chapters-pauses-note')).toBeVisible()

  // IA: indisponível, com o motivo e como ligar (e um botão para conferir de novo)
  await page.getByTestId('tab-ai').click()
  await expect(page.getByTestId('ai-panel')).toHaveAttribute('data-state', 'unavailable')
  await expect(page.getByTestId('ai-panel')).toContainText('Ajustes')
  await expect(page.getByTestId('ai-unavailable-why')).toContainText('desligada')
  await expect(page.getByTestId('ai-recheck')).toBeVisible()
  await expect(page.getByTestId('ai-input')).toHaveCount(0)
  await expectNoVendor(page, 'abas sem IA')
})

test('sem transcrição: Cortes, Publicar e IA explicam e levam à aba Texto', async () => {
  test.setTimeout(120_000)
  s = await launchLong({ transcript: false })
  const { page } = s
  await openEditor(s)
  for (const tab of ['clips', 'publish', 'ai'] as const) {
    await page.getByTestId(`tab-${tab}`).click()
    await expect(page.getByTestId(`${tab}-panel`)).toHaveAttribute('data-state', 'no-transcript')
    await expect(page.getByTestId(`${tab}-panel`)).toContainText('Transcreva o vídeo na aba Texto primeiro')
  }
  await page.getByTestId('ai-panel-goto-text').click()
  await expect(page.getByTestId('text-panel')).toBeVisible()
})
