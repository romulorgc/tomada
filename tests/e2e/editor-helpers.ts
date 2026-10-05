/**
 * Ajudantes dos testes do editor: abrir o projeto, e mexer na linha do tempo como a pessoa mexe (mouse e
 * teclado de verdade, nas posições que a escala atual da régua dá).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'
import type { Project } from '../../src/shared/types'
import { parseProject } from '../../src/shared/project'
import { EXAMPLE_FOLDER, type Session } from './helpers'

/** Abre o primeiro projeto da biblioteca e espera a prévia desenhar o primeiro quadro. */
export async function openEditor(session: Session): Promise<void> {
  const { page } = session
  await expect(page.getByTestId('project-card')).toHaveCount(1)
  await page.getByTestId('card-open').click()
  await expect(page.getByTestId('editor')).toBeVisible()
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
}

/** O `project.json` como está no disco agora. */
export function readSaved(session: Session, folder = EXAMPLE_FOLDER): Project {
  return parseProject(readFileSync(join(session.projects, folder, 'project.json'), 'utf8'))
}

/** Espera o salvamento automático chegar ao disco (e a interface dizer "Salvo"). */
export async function waitSaved(session: Session): Promise<void> {
  await expect(session.page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved', { timeout: 10_000 })
}

export type TimelineGeometry = { pxPerMs: number; scrollLeft: number; contentX: number; rulerY: number; hide: boolean }

/** Escala, rolagem e origem (x da tela) da linha do tempo agora. */
export async function timelineGeometry(page: Page): Promise<TimelineGeometry> {
  const scroll = page.getByTestId('timeline-scroll')
  const content = await page.getByTestId('timeline-content').boundingBox()
  const ruler = await page.getByTestId('timeline-ruler').boundingBox()
  if (!content || !ruler) throw new Error('A linha do tempo não está visível.')
  return {
    pxPerMs: Number(await scroll.getAttribute('data-px-per-ms')),
    scrollLeft: Number(await scroll.getAttribute('data-scroll-left')),
    contentX: content.x,
    rulerY: ruler.y + ruler.height / 2,
    hide: (await scroll.getAttribute('data-hide-cuts')) === 'true'
  }
}

/** x da tela de um instante do eixo de EXIBIÇÃO (ms). */
export const xOfDisplay = (g: TimelineGeometry, displayMs: number): number => g.contentX + displayMs * g.pxPerMs

/** Leva a cabeça de reprodução a `displayMs` clicando na régua. */
export async function seekByRuler(page: Page, displayMs: number): Promise<void> {
  const g = await timelineGeometry(page)
  await page.mouse.click(xOfDisplay(g, displayMs), g.rulerY)
}

/**
 * Leva a cabeça de reprodução a `displayMs` pela régua (sem cortes escondidos: exibição = origem) e devolve o
 * instante de ORIGEM exato, com fração, em que a prévia parou (espera ela desenhar o quadro).
 */
export async function seekTo(page: Page, displayMs: number): Promise<number> {
  await seekByRuler(page, displayMs)
  const canvas = page.getByTestId('preview-canvas')
  await expect
    .poll(async () => Math.abs(Number(await canvas.getAttribute('data-source-ms')) - displayMs), { timeout: 10_000 })
    .toBeLessThan(150)
  return Number(await canvas.getAttribute('data-source-ms'))
}

/** Arrasta com o mouse numa trilha, de `fromMs` a `toMs` (eixo de exibição), em passos. */
export async function dragOnTrack(page: Page, track: 'track-video' | 'track-zoom' | 'track-layout', fromMs: number, toMs: number): Promise<void> {
  const g = await timelineGeometry(page)
  const box = await page.getByTestId(track).boundingBox()
  if (!box) throw new Error(`A trilha ${track} não está visível.`)
  const y = box.y + box.height / 2
  await page.mouse.move(xOfDisplay(g, fromMs), y)
  await page.mouse.down()
  const mid = (fromMs + toMs) / 2
  await page.mouse.move(xOfDisplay(g, mid), y, { steps: 5 })
  await page.mouse.move(xOfDisplay(g, toMs), y, { steps: 5 })
  await page.mouse.up()
}

/** Instante de ORIGEM (ms) mostrado agora pela cabeça de reprodução. */
export async function playheadMs(page: Page): Promise<number> {
  return Number(await page.getByTestId('playhead').getAttribute('data-source-ms'))
}

/** Duração de SAÍDA (ms) que o relógio mostra. */
export async function outputTotalMs(page: Page): Promise<number> {
  return Number(await page.getByTestId('current-time').getAttribute('data-total-ms'))
}

export async function outputMs(page: Page): Promise<number> {
  return Number(await page.getByTestId('current-time').getAttribute('data-ms'))
}

/** Pixels do canvas da prévia (o que a pessoa vê), reduzidos: serve para provar que "mudou". */
export async function previewShot(page: Page): Promise<Buffer> {
  return page.getByTestId('preview-canvas').screenshot({ type: 'png' })
}

/** A reprodução da prévia agora (o botão de tocar diz; o canvas guarda quantos pedidos de tocar já houve e de onde veio o último). */
export async function playState(page: Page): Promise<{ playing: boolean; playCount: number; playSource: string }> {
  const playing = (await page.getByTestId('play-toggle').getAttribute('data-playing')) === 'true'
  const canvas = page.getByTestId('preview-canvas')
  return { playing, playCount: Number((await canvas.getAttribute('data-play-count')) ?? '0'), playSource: (await canvas.getAttribute('data-play-source')) ?? '' }
}

/**
 * Leva a prévia, PARADA, ao instante `ms` de saída (sem cortes saída = origem; `ms` múltiplo de 1 s) de um jeito que não depende
 * do estado de antes: `Home` (que também PAUSA) e um Shift+→ por segundo (cada um anda 1 s a partir de onde está). Confere que parou
 * em `ms` e que a prévia não está tocando; se estiver (uma tecla que não é do teste chegou à janela no meio do caminho), pausa e
 * refaz, até 4 vezes, anotando em `strays` o que viu, com a origem do pedido, em vez de falhar por um relógio que andou sozinho.
 * Esta prévia só toca quando alguém pede (Espaço, J/K/L ou o botão): qualquer pedido que o teste não fez é anotado.
 */
export async function seekPausedTo(page: Page, ms: number, strays: string[] = []): Promise<void> {
  const canvas = page.getByTestId('preview-canvas')
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.keyboard.press('Home')
    for (let n = 0; n < ms / 1000; n++) await page.keyboard.press('Shift+ArrowRight')
    const settled = await expect
      .poll(async () => Number(await canvas.getAttribute('data-source-ms')), { timeout: 3000 })
      .toBeCloseTo(ms, 0)
      .then(
        () => true,
        () => false
      )
    if (settled) {
      await expect(canvas).toHaveAttribute('data-ready', 'true', { timeout: 15_000 })
      await page.waitForTimeout(250) // o quadro novo do <video> chega e é desenhado
      const st = await playState(page)
      if (!st.playing) {
        if (st.playCount > 0) strays.push(`${st.playCount} pedido(s) de tocar que o teste não fez (o último veio de "${st.playSource}"); a prévia já estava parada`)
        return
      }
    }
    const st = await playState(page)
    strays.push(`tentativa ${attempt}: a prévia estava tocando (pedidos de tocar: ${st.playCount}, o último veio de "${st.playSource || 'nenhum'}")`)
    if (st.playing) await page.getByTestId('play-toggle').click()
  }
  throw new Error(`A prévia não ficou parada em ${ms} ms depois de 4 tentativas: ${JSON.stringify(await playState(page))}; ${strays.join('; ')}`)
}
