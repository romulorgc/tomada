/**
 * EXPORTAÇÃO VERTICAL 1080×1920 (M4a) de ponta a ponta, no Electron de verdade: o arquivo (ffprobe), a legenda do Destaque que
 * aparece NO QUADRO (um pixel do amarelo de destaque, só com a legenda ligada, e só dentro da caixa segura 65-940 × 270-1440),
 * a folha de contato do vertical exportado e o que acontece quando a transcrição não pode ser lida.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { outputDuration } from '../../src/shared/timeline'
import { frameRgb, probeJson } from '../helpers/media'
import { editProject, exportProject, listExports } from './export-helpers'
import { EXAMPLE_FOLDER, launchTomada, ROOT, SCREENS_DIR, type Session } from './helpers'

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
const W = 1080
const H = 1920
const SAFE = { x0: 65, x1: 940, y0: 270, y1: 1440 }
/** O amarelo de destaque do Destaque (#FFD93D). */
const YELLOW = { r: 255, g: 217, b: 61 }

/** Um corte que deixa só os 5,8 s do começo (a fala "Olá, pessoal. Hoje eu vou mostrar como gravar a tela."). */
const SHORT_CUT = { id: 'c1', start: 5800, end: 23_000, reason: 'manual' as const, enabled: true }

type Rgb = Uint8Array

const isYellow = (px: Rgb, i: number): boolean => Math.abs(px[i]! - YELLOW.r) <= 30 && Math.abs(px[i + 1]! - YELLOW.g) <= 30 && Math.abs(px[i + 2]! - YELLOW.b) <= 45

function yellowCount(px: Rgb, band = { y0: SAFE.y0, y1: SAFE.y1 }): number {
  let n = 0
  for (let y = band.y0; y < band.y1; y++) for (let x = 0; x < W; x++) if (isYellow(px, (y * W + x) * 3)) n++
  return n
}

/** A caixa dos pixels que mudaram MUITO entre dois quadros (linhas e colunas com pelo menos `min` deles: o ruído solto não conta). */
function changedBox(a: Rgb, b: Rgb, min = 6, strong = 60): { x0: number; x1: number; y0: number; y1: number; count: number } {
  const rows = new Array<number>(H).fill(0)
  const cols = new Array<number>(W).fill(0)
  let count = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      if (Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)) > strong) {
        rows[y]!++
        cols[x]!++
        count++
      }
    }
  }
  const first = (arr: number[]): number => arr.findIndex((v) => v >= min)
  const last = (arr: number[]): number => arr.length - 1 - [...arr].reverse().findIndex((v) => v >= min)
  return { x0: first(cols), x1: last(cols), y0: first(rows), y1: last(rows), count }
}

function contactSheet(video: string, name: string, cols: string, rows: string, width: string): string {
  const out = join(SCREENS_DIR, `${name}.png`)
  execFileSync('node', [join(ROOT, 'scripts', 'contact-sheet.mjs'), video, out, cols, rows, width], { windowsHide: true })
  return out
}

test('exporta o vertical 1080×1920 com a legenda Destaque: arquivo conferido, pixel amarelo no quadro, tudo dentro da caixa segura e folha de contato', async () => {
  test.setTimeout(300_000)
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)

  // (1) com legenda ligada
  editProject(s, (p) => {
    p.cuts = [SHORT_CUT]
    p.vertical = { layout: 'screen-focus', layouts: [], zooms: [], zoomPreset: 'off', captions: { enabled: true, style: 'highlight', wordsPerLine: 3 } }
  })
  const withCaptions = await exportProject(s.page, EXAMPLE_FOLDER, { resolution: '1080p', fps: 30, format: 'vertical' })
  expect(withCaptions.message ?? '').toBe('')
  expect(withCaptions.phase).toBe('done')
  const fileA = withCaptions.outputPath!
  expect(fileA).toContain(join(EXAMPLE_FOLDER, 'exports', 'Projeto de exemplo - Vertical.mp4'))

  // o arquivo: 1080×1920, H.264 High, 30 qps constantes, AAC 48 kHz, duração do documento, faststart
  const expectedMs = outputDuration(23_000, [{ start: 5800, end: 23_000, enabled: true }])
  expect(expectedMs).toBe(5800)
  const probe = probeJson(fileA)
  const video = probe.streams.find((x) => x.codec_type === 'video')!
  const audio = probe.streams.find((x) => x.codec_type === 'audio')!
  expect(video).toMatchObject({ codec_name: 'h264', profile: 'High', width: 1080, height: 1920, pix_fmt: 'yuv420p', r_frame_rate: '30/1', avg_frame_rate: '30/1' })
  expect(video.color_space).toBe('bt709')
  expect(audio).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })
  expect(Math.abs(Number(video.duration) * 1000 - expectedMs)).toBeLessThanOrEqual(FRAME_MS)
  expect(Math.abs(Number(audio.duration) - Number(video.duration)) * 1000).toBeLessThan(50)
  expect(withCaptions.report!.audioVideoDiffMs).toBeLessThan(50)
  expect(Number(probe.format.bit_rate)).toBeLessThan(10_500_000) // 10 Mbps pedidos
  expect(readFileSync(fileA).subarray(0, 4096).includes(Buffer.from('moov'))).toBe(true)
  // Pedido 320k é conferido na integração; o AAC nativo usa menos bits em voz com pausas.
  expect(Number(audio.bit_rate)).toBeGreaterThan(150_000)
  expect(Number(audio.bit_rate)).toBeLessThan(380_000)

  // (2) o MESMO vídeo sem legenda (a tela sintética já tem texto amarelo: só a diferença prova a legenda)
  editProject(s, (p) => {
    p.vertical = { ...p.vertical!, captions: { enabled: false, style: 'highlight', wordsPerLine: 3 } }
  })
  const without = await exportProject(s.page, EXAMPLE_FOLDER, { resolution: '1080p', fps: 30, format: 'vertical' })
  expect(without.phase).toBe('done')
  const fileB = without.outputPath!
  expect(fileB).not.toBe(fileA)
  expect(listExports(s).sort()).toEqual(['Projeto de exemplo - Vertical (2).mp4', 'Projeto de exemplo - Vertical.mp4'])

  // 3,2 s: a palavra "mostrar" (2912-3685 ms) está acesa
  const n = Math.round((3200 / 1000) * 30)
  const a = frameRgb(fileA, n, W, H)
  const b = frameRgb(fileB, n, W, H)
  const yellowA = yellowCount(a)
  const yellowB = yellowCount(b)
  console.log(`pixels amarelos (#FFD93D ±30) na área segura em 3,2 s: com legenda ${yellowA}, sem legenda ${yellowB}`)
  expect(yellowA - yellowB, 'a palavra acesa tem de pôr pelo menos 1.500 pixels do amarelo de destaque no quadro').toBeGreaterThan(1500)

  // o amarelo novo cai na faixa da legenda (y ≈ 1225 de 1920), não em outro lugar
  const bandA = yellowCount(a, { y0: 1050, y1: 1400 })
  const bandB = yellowCount(b, { y0: 1050, y1: 1400 })
  expect(bandA - bandB).toBeGreaterThan(1500)

  // tudo o que a legenda desenhou fica dentro da caixa segura 65-940 × 270-1440 (a tolerância de 6 px é a da compressão)
  const box = changedBox(a, b)
  console.log(`caixa do que a legenda mudou: x ${box.x0}–${box.x1}, y ${box.y0}–${box.y1} (${box.count} pixels)`)
  expect(box.count).toBeGreaterThan(5000)
  expect(box.x0).toBeGreaterThanOrEqual(SAFE.x0 - 6)
  expect(box.x1).toBeLessThanOrEqual(SAFE.x1 + 6)
  expect(box.y0).toBeGreaterThanOrEqual(SAFE.y0 - 6)
  expect(box.y1).toBeLessThanOrEqual(SAFE.y1 + 6)

  // antes da primeira palavra (a fala começa em 400 ms), sem legenda: nenhum pixel novo
  const quietIdx = Math.round((200 / 1000) * 30)
  const quietBox = changedBox(frameRgb(fileA, quietIdx, W, H), frameRgb(fileB, quietIdx, W, H))
  console.log(`aos 0,2 s (ninguém falou ainda): ${quietBox.count} pixels mudados`)
  expect(quietBox.count).toBeLessThan(500)

  // folha de contato do vertical exportado (6 × 2, 270 px de largura)
  const sheet = contactSheet(fileA, 'vertical-folha-de-contato', '6', '2', '270')
  expect(statSync(sheet).size).toBeGreaterThan(20_000)
  console.log(`folha de contato do vertical exportado: ${sheet}`)
})

test('exportar o vertical NÃO altera o project.json e gera os zooms e layouts sozinho na primeira vez; o 16:9 sai igual ao de sempre', async () => {
  test.setTimeout(300_000)
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  editProject(s, (p) => {
    p.cuts = [SHORT_CUT]
  })
  const file = join(s.projects, EXAMPLE_FOLDER, 'project.json')
  const before = readFileSync(file, 'utf8')
  expect(JSON.parse(before).vertical).toBeUndefined()

  const vertical = await exportProject(s.page, EXAMPLE_FOLDER, { resolution: '1080p', fps: 60, format: 'vertical' })
  expect(vertical.message ?? '').toBe('')
  expect(vertical.phase).toBe('done')
  expect(vertical.outputPath).toContain('Projeto de exemplo - Vertical 60.mp4')
  const v = probeJson(vertical.outputPath!).streams.find((x) => x.codec_type === 'video')!
  expect(v).toMatchObject({ width: 1080, height: 1920, r_frame_rate: '60/1' })
  expect(readFileSync(file, 'utf8')).toBe(before) // a exportação não escreve no documento

  const horizontal = await exportProject(s.page, EXAMPLE_FOLDER, { resolution: '1080p', fps: 30 })
  expect(horizontal.phase).toBe('done')
  const h = probeJson(horizontal.outputPath!).streams.find((x) => x.codec_type === 'video')!
  expect(h).toMatchObject({ width: 1920, height: 1080 })
  expect(readFileSync(file, 'utf8')).toBe(before)
})

test('transcrição ilegível com a legenda ligada: o vertical falha COM O MOTIVO (nunca sai sem legenda calado); o 16:9, sem legenda, exporta', async () => {
  test.setTimeout(300_000)
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  editProject(s, (p) => {
    p.cuts = [SHORT_CUT]
  })
  writeFileSync(join(s.projects, EXAMPLE_FOLDER, 'transcript.json'), '{ isto não é uma transcrição')

  const failure = await s.page.evaluate(async (projectId) => {
    try {
      await window.tomada.exporter.start({ projectId, resolution: '1080p', fps: 30, format: 'vertical' })
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }, EXAMPLE_FOLDER)
  expect(failure, 'o pedido tem de falhar, com o motivo').toMatch(/Não consegui ler a transcrição para as legendas/)
  expect(listExports(s)).toEqual([]) // nada pela metade

  const horizontal = await exportProject(s.page, EXAMPLE_FOLDER, { resolution: '1080p', fps: 30 })
  expect(horizontal.phase).toBe('done')
})
