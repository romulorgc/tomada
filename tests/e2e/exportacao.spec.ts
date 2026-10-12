/**
 * EXPORTAÇÃO 16:9 de ponta a ponta, no Electron de verdade: áudio (ffmpeg) + vídeo (janela escondida,
 * mediabunny + WebCodecs) + mux + conferência. Cobre duração, taxa constante, trilhas, sincronia com
 * `flash-bipe`, estalo nas emendas, prévia × exportação, cancelamento, interface sem travar e velocidade.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { exportFileName, outputFrameCount } from '../../src/shared/export'
import { measureSeams, SEAM_LIMITS } from '../../src/shared/seam-proof'
import { keptRanges, outputDuration, sourceToOutput } from '../../src/shared/timeline'
import type { Project } from '../../src/shared/types'
import { copyTree, FIXTURES_DIR } from '../helpers/fs'
import { ensureLongProject, LONG_CUT_COUNT, LONG_CUT_MS, LONG_FOLDER, LONG_MS } from '../helpers/long-project'
import { audioPcm, frameRgb, imageToRgb, lumaSeries, onsets, probeJson, rgbDiff } from '../helpers/media'
import { E2E_HIDDEN, EXAMPLE_FOLDER, launchTomada, ROOT, SCREENS_DIR, shot, type Session } from './helpers'
import { editProject, exportProject, FLASH_FOLDER, listExports, listTexts, listVideos, seedFlashProject } from './export-helpers'
import { playState, seekPausedTo } from './editor-helpers'

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

function contactSheet(video: string, name: string): string {
  mkdirSync(SCREENS_DIR, { recursive: true })
  const out = join(SCREENS_DIR, `${name}.png`)
  execFileSync('node', [join(ROOT, 'scripts', 'contact-sheet.mjs'), video, out, '4', '3', '480'], { windowsHide: true })
  return out
}

/** Zooms e layout de teste (valem também para cortes que cruzam um zoom). */
function editExample(p: Project): void {
  p.cuts = [
    { id: 'c1', start: 2000, end: 4500, reason: 'manual', enabled: true },
    { id: 'c2', start: 9000, end: 9700, reason: 'silence', enabled: true },
    { id: 'c3', start: 20_000, end: 21_000, reason: 'manual', enabled: false } // desligado: não corta
  ]
  p.zoomPreset = 'moderate'
  p.zooms = [
    { id: 'z1', start: 2240, end: 4140, scale: 1.7, focus: 'auto', origin: 'auto' },
    { id: 'z2', start: 7300, end: 9200, scale: 1.7, focus: 'auto', origin: 'auto' },
    { id: 'z3', start: 13_280, end: 15_180, scale: 1.7, focus: 'auto', origin: 'auto' }
  ]
  p.layouts = [{ id: 'l1', start: 16_000, end: 19_000, layout: 'side-by-side' }]
}

test('exporta com cortes, zooms e layouts: duração, taxa constante, trilhas, nome e arquivos temporários', async () => {
  test.setTimeout(240_000)
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  editProject(s, editExample)

  const done = await exportProject(s.page, EXAMPLE_FOLDER)
  expect(done.message ?? '').toBe('')
  expect(done.phase).toBe('done')
  const report = done.report!
  const file = done.outputPath!
  expect(file).toContain(join(EXAMPLE_FOLDER, 'exports', 'Projeto de exemplo - YouTube 1080p.mp4'))
  expect(exportFileName('Projeto de exemplo', { resolution: '1080p', fps: 30 })).toBe('Projeto de exemplo - YouTube 1080p.mp4')

  // duração = outputDuration do documento ±1 quadro
  const expectedMs = outputDuration(23_000, [
    { start: 2000, end: 4500, enabled: true },
    { start: 9000, end: 9700, enabled: true },
    { start: 20_000, end: 21_000, enabled: false }
  ])
  expect(expectedMs).toBe(19_800)
  const probe = probeJson(file)
  const video = probe.streams.find((x) => x.codec_type === 'video')!
  const audio = probe.streams.find((x) => x.codec_type === 'audio')!
  expect(Math.abs(Number(video.duration) * 1000 - expectedMs)).toBeLessThanOrEqual(FRAME_MS)
  expect(Math.abs(Number(probe.format.duration) * 1000 - expectedMs)).toBeLessThanOrEqual(FRAME_MS)
  // 30 qps CONSTANTE
  expect(video.r_frame_rate).toBe('30/1')
  expect(video.avg_frame_rate).toBe('30/1')
  expect(Math.abs(Number(video.nb_frames) - outputFrameCount(expectedMs, 30))).toBeLessThanOrEqual(1)
  expect(video).toMatchObject({ codec_name: 'h264', profile: 'High', width: 1920, height: 1080, pix_fmt: 'yuv420p' })
  // Com a GPU o arquivo sai bt709; no compositor por software das janelas ocultas o Chromium marca o mesmo vídeo smpte170m.
  expect(E2E_HIDDEN ? ['bt709', 'smpte170m'] : ['bt709']).toContain(video.color_space)
  // áudio presente, AAC 48 kHz estéreo, com a mesma duração do vídeo
  expect(audio).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })
  expect(Math.abs(Number(audio.duration) - Number(video.duration)) * 1000).toBeLessThan(50)
  expect(report.audioVideoDiffMs).toBeLessThan(50)
  expect(report.hasAudio).toBe(true)
  // moov no começo (faststart): o ffprobe lê sem precisar buscar o fim
  const head = readFileSync(file).subarray(0, 64)
  expect(head.includes(Buffer.from('ftyp'))).toBe(true)
  expect(readFileSync(file).subarray(0, 4096).includes(Buffer.from('moov'))).toBe(true)
  // nenhum parcial ou temporário sobrou
  expect(listVideos(s)).toEqual(['Projeto de exemplo - YouTube 1080p.mp4'])
  expect(listExports(s).filter((n) => !n.endsWith('.mp4'))).toEqual(['Projeto de exemplo - YouTube.txt']) // o texto de publicação (M4b)
  expect(listTexts(s)).toHaveLength(1)
  // taxa de bits na faixa do YouTube (8 Mbps pedidos; o conteúdo sintético é leve, então não passa disso)
  expect(Number(probe.format.bit_rate)).toBeLessThan(9_000_000)

  const sheet = contactSheet(file, 'export-folha-de-contato')
  expect(statSync(sheet).size).toBeGreaterThan(20_000)
  console.log(`exportação: ${report.renderFps.toFixed(1)} qps, ${report.elapsedMs} ms no total, ${(report.bytes / 1e6).toFixed(1)} MB, áudio×vídeo ${report.audioVideoDiffMs} ms, folha: ${sheet}`)

  // a segunda exportação do mesmo nome não apaga a primeira
  const again = await exportProject(s.page, EXAMPLE_FOLDER)
  expect(again.phase).toBe('done')
  expect(again.outputPath).toContain('Projeto de exemplo - YouTube 1080p (2).mp4')
  expect(listVideos(s).sort()).toEqual(['Projeto de exemplo - YouTube 1080p (2).mp4', 'Projeto de exemplo - YouTube 1080p.mp4'])
})

test('SINCRONIA com flash-bipe: o clarão e o início do bipe caem juntos (< 1 quadro) depois dos cortes', async () => {
  test.setTimeout(240_000)
  s = await launchTomada({ seed: false })
  const cuts = [
    { start: 2300, end: 3500 },
    { start: 4500, end: 5500 },
    { start: 6400, end: 7600 }
  ]
  seedFlashProject(s, cuts)
  const done = await exportProject(s.page, FLASH_FOLDER)
  expect(done.message ?? '').toBe('')
  expect(done.phase).toBe('done')
  const file = done.outputPath!

  const kept = keptRanges(10_000, cuts.map((c) => ({ ...c, enabled: true })))
  const flashesInSource = [0, 2000, 4000, 6000, 8000].filter((t) => kept.some((r) => t >= r.start && t < r.end))
  const expected = flashesInSource.map((t) => sourceToOutput(t, kept))
  expect(expected).toEqual([0, 2000, 2800, 3800, 4600])

  // vídeo: luminância do centro de CADA quadro (o clarão enche a tela)
  const luma = lumaSeries(file, { x: 910, y: 510, w: 100, h: 60 })
  const videoOnsets: number[] = []
  for (let i = 0; i < luma.length; i++) if (luma[i]! > 128 && (i === 0 || luma[i - 1]! <= 128)) videoOnsets.push(i * FRAME_MS)
  // áudio: início de cada bipe
  const audioOnsets = onsets(audioPcm(file), 48_000, { relative: 0.2, quietMs: 300 })
  console.log(`sincronia: esperado ${JSON.stringify(expected)}\n  clarões ${JSON.stringify(videoOnsets.map((v) => Math.round(v)))}\n  bipes   ${JSON.stringify(audioOnsets)}`)
  expect(videoOnsets).toHaveLength(expected.length)
  expect(audioOnsets).toHaveLength(expected.length)
  const deviations: string[] = []
  expected.forEach((e, i) => {
    const v = videoOnsets[i]!
    const a = audioOnsets[i]!
    deviations.push(`${e}: clarão ${(v - e).toFixed(1)} ms, bipe ${(a - e).toFixed(1)} ms, clarão×bipe ${(v - a).toFixed(1)} ms`)
    expect(Math.abs(v - e), `clarão ${i} longe do esperado`).toBeLessThan(FRAME_MS)
    expect(Math.abs(a - v), `bipe ${i} fora de sincronia com o clarão`).toBeLessThan(FRAME_MS)
  })
  console.log(`desvios de sincronia (ms):\n  ${deviations.join('\n  ')}`)
})

test('SEM ESTALO e SEM BURACO nas emendas: o salto de amostra não destoa da vizinhança e o nível não cai mais de 6 dB', async () => {
  test.setTimeout(240_000)
  s = await launchTomada()
  await expect(s.page.getByTestId('project-card')).toHaveCount(1)
  // cortes NO MEIO da fala (a voz sintética do projeto de exemplo), para a emenda cair em cima de onda
  const gabarito = JSON.parse(readFileSync(join(FIXTURES_DIR, 'voz.json'), 'utf8')) as { phrases: { startMs: number; endMs: number }[] }
  const [p0, , p2] = gabarito.phrases as [{ startMs: number; endMs: number }, { startMs: number; endMs: number }, { startMs: number; endMs: number }]
  const cutA = { start: Math.round(p0.startMs + (p0.endMs - p0.startMs) * 0.3), end: Math.round(p0.startMs + (p0.endMs - p0.startMs) * 0.5) }
  const cutB = { start: Math.round(p2.startMs + (p2.endMs - p2.startMs) * 0.25), end: Math.round(p2.startMs + (p2.endMs - p2.startMs) * 0.6) }
  editProject(s, (p) => {
    p.zoomPreset = 'off'
    p.cuts = [cutA, cutB].map((c, i) => ({ id: `c${i}`, start: c.start, end: c.end, reason: 'filler' as const, enabled: true }))
  })
  const done = await exportProject(s.page, EXAMPLE_FOLDER)
  expect(done.phase).toBe('done')
  const pcm = audioPcm(done.outputPath!)
  const kept = keptRanges(23_000, [cutA, cutB].map((c) => ({ ...c, enabled: true })))
  const sr = 48
  const maxJump = (from: number, to: number): number => {
    let m = 0
    for (let n = Math.max(1, Math.round(from * sr)); n < Math.min(pcm.length, Math.round(to * sr)); n++) m = Math.max(m, Math.abs(pcm[n]! - pcm[n - 1]!))
    return m
  }
  const peakOf = (from: number, to: number): number => {
    let m = 0
    for (let n = Math.max(0, from); n < Math.min(pcm.length, to); n++) m = Math.max(m, Math.abs(pcm[n]!))
    return m
  }
  const peak = peakOf(0, 48_000 * 4)
  const proof = measureSeams(Float32Array.from(pcm, (v) => v / 32768), 48_000, [cutA, cutB].map((c) => sourceToOutput(c.start, kept)), pcm.length / 48)
  for (const [i, cut] of [cutA, cutB].entries()) {
    const seam = sourceToOutput(cut.start, kept) // instante de SAÍDA da emenda (ms)
    const atSeam = maxJump(seam - 1, seam + 1)
    const around = Math.max(maxJump(seam - 80, seam - 40), maxJump(seam + 40, seam + 80))
    // F1: a emenda é um cruzamento de potência igual, não um fade a zero: a queda de nível medida no arquivo (o mesmo medidor da
    // prova de emenda) fica dentro de 6 dB; o fade antigo deixava ~45 dB de buraco
    const drop = proof.measures[i]!.dropDb
    console.log(`emenda ${i + 1} em ${seam} ms: salto ${atSeam}, vizinhança ${around}, queda de nível ${drop.toFixed(1)} dB, pico ${peak}`)
    expect(around, 'a vizinhança precisa ter som (a emenda cai no meio da fala)').toBeGreaterThan(100)
    expect(atSeam).toBeLessThanOrEqual(around) // não destoa da vizinhança
    expect(drop, 'sem buraco no som').toBeLessThanOrEqual(SEAM_LIMITS.maxDropDb)
  }
})

test('PRÉVIA = EXPORTAÇÃO: o quadro da prévia e o do arquivo exportado, no mesmo instante, diferem menos de 2%', async () => {
  test.setTimeout(300_000)
  s = await launchTomada()
  const { page } = s
  await expect(page.getByTestId('project-card')).toHaveCount(1)
  await page.getByTestId('card-open').click()
  await expect(page.getByTestId('editor')).toBeVisible()
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 })
  // ao abrir sem zooms, o editor gera os do preset moderado e grava no project.json
  await page.getByTestId('tab-zoom').click()
  await expect(page.getByTestId('zoom-count')).toHaveText('1 zoom')
  const file = join(s.projects, EXAMPLE_FOLDER, 'project.json')
  await expect.poll(() => (JSON.parse(readFileSync(file, 'utf8')) as Project).zoomPreset, { timeout: 10_000 }).toBe('moderate')

  // INTERMITENTE (05/10): falhou 1× na bateria completa (a prévia "tocando" em 17,3 s, com "Pausar" visível, quando o teste esperava
  // a cabeça PARADA em 3 s) e nunca em ~20 execuções isoladas. A auditoria do código mostrou que a prévia só toca quando alguém pede
  // (Espaço, J/K/L ou o botão; nenhum código a faz tocar sozinha), então a CAUSA MAIS PROVÁVEL (inferida, não observada) é uma
  // tecla que não era do teste chegando à janela de teste, que fica em primeiro plano, no meio da bateria. O teste andava com
  // Shift+→ RELATIVO ao lugar onde a cabeça estava e dependia de ela estar parada. Agora cada instante é buscado por
  // `seekPausedTo` (Home, que também pausa, e Shift+→; confere que parou e refaz se a prévia tocou), e a prova abaixo reproduz o
  // defeito de propósito: uma tecla Espaço ANTES da busca e outra NO MEIO dela. A origem de cada pedido de tocar fica em
  // `data-play-source` do canvas, para a próxima falha dizer quem pediu.
  const strays: string[] = []
  await page.keyboard.press('Space') // a tecla perdida de antes
  await expect.poll(async () => (await playState(page)).playing, { timeout: 5000 }).toBe(true)
  await seekPausedTo(page, 8000, strays)
  expect(strays.join('; ')).toContain('key:Space') // o canvas disse quem pediu para tocar
  // a tecla perdida NO MEIO da busca: um Espaço que chega 30 ms depois de a busca começar
  await page.evaluate(() => {
    setTimeout(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })), 30)
  })
  await seekPausedTo(page, 3000, strays)
  expect((await playState(page)).playing).toBe(false)
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-source-ms', /^3000/)

  const times = [3000, 8000, 14_000] // dentro de um zoom e logo depois de um clique (ripple visível)
  const preview: Uint8Array[] = []
  for (const t of times) {
    await seekPausedTo(page, t, strays)
    // o canvas fica "contaminado" pelo vídeo do protocolo tomada-media (sem CORS): não dá para ler os pixels
    // por script, então a prévia é fotografada pelo Chromium (o que o usuário vê) e reduzida com média de área
    preview.push(imageToRgb(await page.getByTestId('preview-canvas').screenshot({ type: 'png' }), 320, 180))
  }
  await shot(page, '21-previa-no-zoom')

  const done = await exportProject(page, EXAMPLE_FOLDER)
  expect(done.phase).toBe('done')
  const results: string[] = []
  times.forEach((t, k) => {
    const exported = frameRgb(done.outputPath!, Math.round((t / 1000) * 30), 320, 180)
    const d = rgbDiff(preview[k]!, exported)
    results.push(`t=${t} ms: diferença média ${(d.mean * 100).toFixed(2)}%, pixels muito diferentes ${(d.strongRatio * 100).toFixed(2)}%`)
    expect(d.mean, `média em t=${t}`).toBeLessThan(0.02)
    expect(d.strongRatio, `pixels muito diferentes em t=${t}`).toBeLessThan(0.02)
  })
  console.log(`prévia × exportação (320×180):\n  ${results.join('\n  ')}`)
})

test('VELOCIDADE: 3 min sintéticos em 1080p30 (com 30 cortes e zooms) exportam a pelo menos 60 qps', async () => {
  test.skip(E2E_HIDDEN, 'Mede a velocidade da exportação com GPU; o compositor por software das janelas ocultas faz ~23 qps. Rodar com TOMADA_E2E_HIDDEN=0.')
  test.setTimeout(900_000)
  const src = ensureLongProject()
  s = await launchTomada({ seed: false })
  copyTree(src, join(s.projects, LONG_FOLDER))
  editProject(
    s,
    (p) => {
      p.zoomPreset = 'moderate'
      // zooms nos cliques (a cada 4 s), como o editor geraria
      p.zooms = Array.from({ length: 44 }, (_, i) => ({ id: `z${i}`, start: 2500 + i * 4000, end: 4400 + i * 4000, scale: 1.7, focus: 'auto' as const, origin: 'auto' as const }))
    },
    LONG_FOLDER
  )
  const done = await exportProject(s.page, LONG_FOLDER)
  expect(done.message ?? '').toBe('')
  expect(done.phase).toBe('done')
  const r = done.report!
  const outMs = LONG_MS - LONG_CUT_COUNT * LONG_CUT_MS
  const frames = outputFrameCount(outMs, 30)
  const wallFps = (frames / r.elapsedMs) * 1000
  console.log(
    `VELOCIDADE 1080p30: ${frames} quadros; render ${r.renderFps.toFixed(1)} qps (só o vídeo); total ${wallFps.toFixed(1)} qps em ${(r.elapsedMs / 1000).toFixed(1)} s ` +
      `(${(outMs / 60_000).toFixed(1)} min de vídeo => 10 min em ${((r.elapsedMs / outMs) * 600_000 / 60_000).toFixed(1)} min); arquivo ${(r.bytes / 1e6).toFixed(0)} MB; áudio×vídeo ${r.audioVideoDiffMs} ms
  ${r.timing ?? ''}`
  )
  expect(Math.abs(r.durationMs - outMs)).toBeLessThanOrEqual(FRAME_MS)
  expect(r.renderFps).toBeGreaterThanOrEqual(60)
  expect(r.audioVideoDiffMs).toBeLessThan(50)
})
