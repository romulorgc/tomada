/**
 * O gancho e a legenda do vertical não cobrem a página nem a boca ("Título de gancho"). Renderiza pelo MESMO caminho da
 * exportação (laboratório de render) o V-B (câmera embaixo e câmera em cima) e o V-D com uma página sintética (título grande no alto)
 * e uma pessoa sintética (cabeça, boca e tronco desenhados no formato da máscara de teste), no instante em que o gancho está inteiro
 * (1,5 s) e depois dele (5,2 s). Os quadros vão para `test-results/gancho/<fase>-<caso>-<instante>.png`; a fase vem de `GANCHO_FASE`
 * (`antes`, rodada no código velho, ou `depois`, o padrão). As asserções de geometria usam a cena de verdade.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createProject, serializeProject } from '../../src/shared/project'
import { VERTICAL_1080, deriveProject, evaluateScene, prepareEvents } from '../../src/shared/scene'
import { projectForFormat } from '../../src/shared/vertical'
import type { LayoutKind, Project, Word } from '../../src/shared/types'
import { launchTomada, ROOT, type Session } from './helpers'
import { openLab, renderStills, writeFace, writeMatte } from './lab'

const OUT = join(ROOT, 'test-results', 'gancho')
const FOLDER = '2026-10-06 1500 Gancho sintético'
const FASE = process.env.GANCHO_FASE === 'antes' ? 'antes' : 'depois'
const HOOK = 'Sua página inteira no vídeo'
const TIMES = [1500, 5200]
const WORDS: Word[] = [
  ['Veja', 900, 1400],
  ['como', 1400, 1900],
  ['funciona', 4800, 5300],
  ['por dentro', 5300, 5900]
].map(([text, start, end], i) => ({ i, text: text as string, start: start as number, end: end as number, prob: 1, kind: 'word' as const }))

let s: Session | undefined
test.afterEach(async () => {
  if (s) { await s.close(); s = undefined }
})

test('gancho e legenda: V-B (câmera embaixo e em cima) e V-D, antes × depois', async () => {
  test.setTimeout(240_000)
  mkdirSync(OUT, { recursive: true })
  s = await launchTomada({ seed: false })
  const dir = join(s.projects, FOLDER)
  mkdirSync(join(dir, 'media'), { recursive: true })
  mkdirSync(join(dir, 'events'), { recursive: true })

  // página sintética com o título no alto (a faixa que o gancho antigo cobria) e uma pessoa sintética no formato da máscara
  const [pagePng, personPng] = await s.page.evaluate(() => {
    const page = document.createElement('canvas'); page.width = 1920; page.height = 1080
    const g = page.getContext('2d')!
    g.fillStyle = '#f4f7fa'; g.fillRect(0, 0, 1920, 1080)
    g.fillStyle = '#123653'; g.fillRect(0, 0, 1920, 90)
    g.fillStyle = '#fff'; g.font = 'bold 30px Arial'; g.fillText('Página sintética  •  Entrada  •  Enviados', 540, 58)
    g.textAlign = 'center'; g.fillStyle = '#123653'; g.font = 'bold 64px Arial'
    g.fillText('TÍTULO DA PÁGINA', 960, 220)
    g.font = '34px Arial'; g.fillStyle = '#324f65'
    g.fillText('Subtítulo com o que o espectador precisa ler primeiro', 960, 290)
    for (let i = 0; i < 6; i++) { g.fillStyle = i % 2 ? '#e3ebf2' : '#d3dfea'; g.fillRect(560, 360 + i * 110, 800, 90) }
    g.fillStyle = '#168b82'; g.fillRect(760, 1000, 400, 60)

    const cam = document.createElement('canvas'); cam.width = 1280; cam.height = 720
    const c = cam.getContext('2d')!
    c.fillStyle = '#3b4252'; c.fillRect(0, 0, 1280, 720)
    c.fillStyle = '#2f6fb3'; c.beginPath(); c.ellipse(640, 792, 384, 504, 0, 0, Math.PI * 2); c.fill() // tronco (camisa)
    c.fillStyle = '#e0ac8b'; c.beginPath(); c.ellipse(640, 216, 115, 144, 0, 0, Math.PI * 2); c.fill() // cabeça
    c.fillStyle = '#3a2a22'; c.beginPath(); c.ellipse(640, 120, 118, 54, 0, Math.PI, Math.PI * 2); c.fill() // cabelo
    c.fillStyle = '#222'; c.beginPath(); c.ellipse(600, 196, 9, 11, 0, 0, Math.PI * 2); c.ellipse(680, 196, 9, 11, 0, 0, Math.PI * 2); c.fill()
    c.fillStyle = '#8a2b2b'; c.beginPath(); c.ellipse(640, 276, 34, 12, 0, 0, Math.PI * 2); c.fill() // boca
    return [page.toDataURL().split(',')[1]!, cam.toDataURL().split(',')[1]!]
  })
  writeFileSync(join(dir, 'media', 'pagina.png'), Buffer.from(pagePng, 'base64'))
  writeFileSync(join(dir, 'media', 'pessoa.png'), Buffer.from(personPng, 'base64'))
  const loop = (png: string, out: string): void => {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', join(dir, 'media', png), '-t', '6', '-r', '30', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', join(dir, 'media', out)], { windowsHide: true })
  }
  loop('pagina.png', 'screen.mp4')
  loop('pessoa.png', 'camera.mp4')

  const base = createProject({
    title: 'Gancho sintético',
    sources: {
      screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: 6000 },
      camera: { path: 'media/camera.mp4', w: 1280, h: 720, fps: 30, durationMs: 6000 }
    }
  })
  base.zoomPreset = 'off'
  base.style.cursor.ripple = false
  base.captions = { ...base.captions, enabled: true }
  const cursor = [{ t: 0, x: 0.5, y: 0.5 }, { t: 6000, x: 0.5, y: 0.5 }]
  writeFileSync(join(dir, 'events', 'cursor.jsonl'), cursor.map((c) => JSON.stringify(c)).join('\n'))
  for (const f of ['clicks', 'keys']) writeFileSync(join(dir, 'events', `${f}.jsonl`), '')
  writeFileSync(join(dir, 'project.json'), serializeProject(base))
  const faceUrl = writeFace(s, { cx: 0.5, cy: 0.3, w: 0.18, h: 0.4, durationMs: 6000 }, FOLDER)
  const matteUrl = writeMatte(s, { durationS: 6 }, FOLDER)
  const lab = await openLab(s.app)

  const casos: { id: string; layout: LayoutKind; cameraTop?: boolean }[] = [
    { id: 'vb', layout: 'stack' },
    { id: 'vb-camera-em-cima', layout: 'stack', cameraTop: true },
    { id: 'vd', layout: 'presenter' }
  ]
  for (const caso of casos) {
    const p: Project = structuredClone(base)
    p.vertical = { layout: caso.layout, layouts: [], zooms: [], zoomPreset: 'off', hook: HOOK, ...(caso.cameraTop ? { cameraTop: true } : {}), captions: { enabled: true } }
    const frames = await renderStills(lab, { project: p, folder: FOLDER, format: VERTICAL_1080, times: TIMES, faceUrl, matteUrl, words: WORDS })
    frames.forEach((f, i) => writeFileSync(join(OUT, `${FASE}-${caso.id}-${TIMES[i]}.png`), f))

    if (FASE === 'antes') continue
    // geometria da cena de verdade, no instante com o gancho inteiro
    const view = projectForFormat(p, 'vertical')
    const derived = deriveProject(view, prepareEvents({ cursor, clicks: [], keys: [] }, 6000), VERTICAL_1080, WORDS, null)
    const scene = evaluateScene(view, derived, TIMES[0]!, VERTICAL_1080)
    const hook = scene.hook!
    expect(hook.alpha).toBe(1)
    const page = scene.screen!.dest
    // o gancho nunca fica sobre a página
    expect(hook.style.bandBottom <= page.y || hook.style.bandTop >= page.y + page.h, `${caso.id}: gancho ${hook.style.bandTop}–${hook.style.bandBottom} sobre a página ${page.y}–${page.y + page.h}`).toBe(true)
    // e a legenda não pisa no gancho
    const cap = scene.captions!
    const capHalf = cap.style.fontPx * 0.75
    expect(cap.style.centerY + capHalf <= hook.style.bandTop || cap.style.centerY - capHalf >= hook.style.bandBottom, `${caso.id}: legenda em ${cap.style.centerY} × gancho ${hook.style.bandTop}–${hook.style.bandBottom}`).toBe(true)
  }
})
