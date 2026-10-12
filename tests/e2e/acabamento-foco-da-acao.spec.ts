/**
 * Acabamento C: enquadramento da tela no 9:16 (metade de tela do V-B e Tela ao centro). A janela quadrada foca onde está a AÇÃO
 * (clique, digitação, cursor parado), com permanência mínima e transição suave, sem ampliar além de 1:1 e sem cortar a coluna de
 * conteúdo onde a ação está. Página sintética no estilo de um webmail: barra lateral + coluna central de texto + botão.
 *
 * A primeira rodada guarda os quadros ANTES (cursor seguido o tempo todo, zooms de clique de até 1,35×) em
 * `test-results/acabamento/foco-*-antes-*.png`; as seguintes preservam essa evidência e geram os DEPOIS e as folhas.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import { createFfmpeg, locateFfmpeg } from '../../src/main/ffmpeg'
import { measureContentMap } from '../../src/main/content-map'
import { contentMapToJsonLines } from '../../src/shared/content-map'
import { createProject, serializeProject } from '../../src/shared/project'
import { VERTICAL_1080, deriveProject, evaluateScene, prepareEvents } from '../../src/shared/scene'
import { projectForFormat } from '../../src/shared/vertical'
import type { ClickEvent, KeyEvent, LayoutKind, Project, Zoom } from '../../src/shared/types'
import { launchTomada, ROOT, type Session } from './helpers'
import { openLab, renderStills } from './lab'

const OUT = join(ROOT, 'test-results', 'acabamento')
const FOLDER = '2026-10-06 1300 Webmail sintético'
const W = 1920, H = 1000, DURATION = 8000
/** A coluna de texto do "e-mail": é ela que não pode ser cortada onde a ação está. */
const COLUMN = { x0: 560, x1: 1360 }
/** A coluna nominal tem ~60 px de respiro à direita do texto mais largo (a linha mais comprida termina em ~1300): a janela pode terminar até 40 px antes dela. */
const COLUMN_PAD = 40
const TIMES = [1300, 3100, 4900, 6700]
let s: Session | undefined
test.afterEach(async () => { if (s) { await s.close(); s = undefined } })

function sheet(paths: string[], target: string): void {
  const imgs = paths.map((p) => PNG.sync.read(readFileSync(p)))
  const w = 360, h = 640, label = 32
  const out = new PNG({ width: w * imgs.length, height: h + label })
  out.data.fill(25)
  imgs.forEach((src, n) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const from = (Math.floor(y * src.height / h) * src.width + Math.floor(x * src.width / w)) * 4
      out.data.set(src.data.subarray(from, from + 4), ((y + label) * out.width + n * w + x) * 4)
    }
  })
  writeFileSync(target, PNG.sync.write(out))
}

/** Cliques no corpo do e-mail e no botão, uma digitação na resposta e o cursor andando entre eles. */
const CLICKS: { t: number; x: number; y: number }[] = [{ t: 1000, x: 700, y: 330 }, { t: 2600, x: 1180, y: 470 }, { t: 4300, x: 640, y: 800 }, { t: 5900, x: 1000, y: 900 }]
const KEYS: KeyEvent[] = Array.from({ length: 8 }, (_, i) => ({ t: 6200 + i * 140 }))
function eventData(): { cursor: { t: number; x: number; y: number }[]; clicks: ClickEvent[] } {
  const anchors = [{ t: 0, x: 960, y: 520 }, ...CLICKS, { t: DURATION, x: 1000, y: 900 }]
  const cursor: { t: number; x: number; y: number }[] = []
  for (let t = 0; t <= DURATION; t += 50) {
    const next = anchors.findIndex((a) => a.t >= t)
    const b = anchors[Math.max(1, next)]!, a = anchors[Math.max(0, next - 1)]!
    // anda até o próximo clique e fica um instante parado nele
    const u = Math.min(1, Math.max(0, (t - a.t) / Math.max(1, (b.t - a.t) * 0.6)))
    const e = u * u * (3 - 2 * u)
    cursor.push({ t, x: (a.x + (b.x - a.x) * e) / W, y: (a.y + (b.y - a.y) * e) / H })
  }
  const clicks: ClickEvent[] = CLICKS.map((c) => ({ t: c.t, x: c.x / W, y: c.y / H, button: 'left', upT: c.t + 80 }))
  return { cursor, clicks }
}

test('webmail sintético: a janela quadrada foca a ação, com a letra do corpo em 30 px (aqui 1:1) e sem cortar a coluna de texto', async () => {
  test.setTimeout(240_000)
  mkdirSync(OUT, { recursive: true })
  s = await launchTomada({ seed: false })
  const dir = join(s.projects, FOLDER)
  mkdirSync(join(dir, 'media'), { recursive: true })
  mkdirSync(join(dir, 'events'), { recursive: true })
  const png = await s.page.evaluate(({ w, h, col }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#f2f5fa'; ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, 72)
    ctx.fillStyle = '#1d3b53'; ctx.font = 'bold 30px Arial'; ctx.fillText('Caixa de entrada', 40, 47)
    ctx.fillStyle = '#e3eaf4'; ctx.fillRect(0, 72, 300, h - 72) // barra lateral
    ctx.fillStyle = '#2b4a63'; ctx.font = '26px Arial'
    ;['Entrada', 'Enviados', 'Rascunhos', 'Arquivados', 'Lixeira'].forEach((label, i) => ctx.fillText(label, 40, 140 + i * 62))
    ctx.fillStyle = '#ffffff'; ctx.fillRect(col.x0 - 30, 110, col.x1 - col.x0 + 60, 860) // coluna central do e-mail
    ctx.fillStyle = '#123653'; ctx.font = 'bold 40px Arial'; ctx.fillText('Reunião de segunda: pauta e prazos', col.x0, 200)
    ctx.fillStyle = '#6a8296'; ctx.font = '24px Arial'; ctx.fillText('Daniela Souza  ·  para você  ·  ontem, 18:42', col.x0, 245)
    ctx.fillStyle = '#243f55'; ctx.font = '30px Arial'
    ;['Olá! Segue a pauta da reunião de segunda-feira com os', 'prazos que combinamos. Confira cada item e responda', 'até quarta, para fecharmos o calendário da semana.', '', 'Primeiro, a revisão dos cadastros novos. Depois, o', 'fluxo de cobrança e a agenda dos atendimentos de', 'quinta. Por fim, os próximos passos do projeto.'].forEach((line, i) => ctx.fillText(line, col.x0, 330 + i * 52))
    ctx.fillStyle = '#168b82'; ctx.fillRect(col.x0, 740, 220, 76)
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 30px Arial'; ctx.fillText('Responder', col.x0 + 38, 788)
    ctx.strokeStyle = '#b9c8d6'; ctx.lineWidth = 2; ctx.strokeRect(col.x0, 850, col.x1 - col.x0, 90)
    ctx.fillStyle = '#9aaebf'; ctx.font = '26px Arial'; ctx.fillText('Escreva sua resposta…', col.x0 + 20, 905)
    ctx.fillStyle = '#e3eaf4'; ctx.fillRect(1420, 110, 440, 860) // painel de agenda, à direita
    ctx.fillStyle = '#2b4a63'; ctx.font = 'bold 28px Arial'; ctx.fillText('Agenda', 1450, 160)
    return c.toDataURL().split(',')[1]!
  }, { w: W, h: H, col: COLUMN })
  const input = join(dir, 'media', 'pagina.png'); writeFileSync(input, Buffer.from(png, 'base64'))
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', input, '-t', String(DURATION / 1000), '-r', '30', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', join(dir, 'media', 'screen.mp4')], { windowsHide: true })
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x303030:s=640x360:r=30:d=${DURATION / 1000}`, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', join(dir, 'media', 'camera.mp4')], { windowsHide: true })
  const p = createProject({ title: 'Webmail sintético', sources: { screen: { path: 'media/screen.mp4', w: W, h: H, fps: 30, durationMs: DURATION }, camera: { path: 'media/camera.mp4', w: 640, h: 360, fps: 30, durationMs: DURATION } } })
  p.zoomPreset = 'off'; p.style.cursor.ripple = false; p.style.camera.borderWidth = 0
  // F2 (R3): o zoom vem da LETRA (30 px no quadro). O corpo desta página sintética tem 30 px de verdade (a estimativa do app, 13 px por 1080,
  // é para páginas reais de navegador), então a letra de 30 px é exatamente 1:1 e o teto de ampliação continua valendo.
  p.screenTextPx = 30
  // o mapa de conteúdo, medido como o processamento mede (toda gravação nova o tem): é ele que diz onde está a coluna de texto
  const map = await measureContentMap(createFfmpeg(locateFfmpeg()!), join(dir, 'media', 'screen.mp4'))
  writeFileSync(join(dir, 'events', 'content-map.jsonl'), contentMapToJsonLines(map))
  const { cursor, clicks } = eventData()
  writeFileSync(join(dir, 'events', 'cursor.jsonl'), cursor.map((c) => JSON.stringify(c)).join('\n'))
  writeFileSync(join(dir, 'events', 'clicks.jsonl'), clicks.map((c) => JSON.stringify(c)).join('\n'))
  writeFileSync(join(dir, 'events', 'keys.jsonl'), KEYS.map((k) => JSON.stringify(k)).join('\n'))
  writeFileSync(join(dir, 'project.json'), serializeProject(p))
  const lab = await openLab(s.app)
  // zoom de clique em cada clique: antes subia até 1,35× (texto ampliado e mole); agora o teto é 1:1
  const zooms: Zoom[] = CLICKS.map((c, i) => ({ id: `clique-${i}`, start: c.t - 100, end: c.t + 1300, scale: 1.6, focus: 'auto', origin: 'auto' }))
  const project = (layout: LayoutKind, camera: boolean): Project => {
    const cp: Project = structuredClone(p)
    if (!camera) delete cp.sources.camera
    cp.vertical = { layout, layouts: [], zooms, zoomPreset: 'moderate', hook: 'Responda sem sair do e-mail' }
    return cp
  }
  const capture = async (layout: LayoutKind, camera: boolean, prefix: string): Promise<string[]> => {
    const frames = await renderStills(lab, { project: project(layout, camera), folder: FOLDER, format: VERTICAL_1080, times: TIMES, contentMap: true, words: [{ i: 0, text: 'Responda', start: 0, end: DURATION, prob: 1, kind: 'word' }] })
    return frames.map((f, i) => { const path = join(OUT, `${prefix}-${i}.png`); writeFileSync(path, f); return path })
  }
  // A primeira rodada registra a implementação anterior (cursor seguido, zoom até 1,35×); as seguintes preservam a evidência.
  if (!existsSync(join(OUT, 'foco-vb-antes-0.png'))) await capture('stack', true, 'foco-vb-antes')
  if (!existsSync(join(OUT, 'foco-centro-antes-0.png'))) await capture('screen-center', false, 'foco-centro-antes')
  const vbDepois = await capture('stack', true, 'foco-vb-depois')
  const centroDepois = await capture('screen-center', false, 'foco-centro-depois')
  sheet([...TIMES.map((_, i) => join(OUT, `foco-vb-antes-${i}.png`)), ...vbDepois], join(OUT, 'folha-foco-vb-antes-depois.png'))
  sheet([...TIMES.map((_, i) => join(OUT, `foco-centro-antes-${i}.png`)), ...centroDepois], join(OUT, 'folha-foco-centro-antes-depois.png'))

  // Medidas da cena (não de pixels): onde a janela cai e quanto o texto é ampliado.
  const data = prepareEvents({ cursor, clicks, keys: KEYS, contentMap: map }, DURATION)
  for (const [layout, camera] of [['stack', true], ['screen-center', false]] as const) {
    const view = projectForFormat(project(layout, camera), 'vertical')
    const derived = deriveProject(view, data, VERTICAL_1080)
    let peakMagnification = 0
    const missing: string[] = []
    for (let t = 0; t <= DURATION - 200; t += 100) {
      const screen = evaluateScene(view, derived, t, VERTICAL_1080).screen!
      const sourcePxW = screen.src.w * W
      peakMagnification = Math.max(peakMagnification, screen.dest.w / sourcePxW)
      // nos instantes de clique no corpo do e-mail, a janela inteira da coluna tem de estar visível
      const click = CLICKS.find((c) => t >= c.t + 500 && t <= c.t + 1000 && c.x >= COLUMN.x0 && c.x <= COLUMN.x1 && c.y < 840)
      if (click && (screen.src.x * W > COLUMN.x0 + 1 || (screen.src.x + screen.src.w) * W < COLUMN.x1 - COLUMN_PAD)) missing.push(`${layout} t=${t}: janela ${(screen.src.x * W).toFixed(0)}–${((screen.src.x + screen.src.w) * W).toFixed(0)} não cobre a coluna ${COLUMN.x0}–${COLUMN.x1}`)
    }
    expect(peakMagnification, `${layout}: ampliação máxima do texto (1,0 = 1:1)`).toBeLessThanOrEqual(1.001)
    expect(missing, `${layout}: coluna de conteúdo cortada onde há ação`).toEqual([])
  }
})
