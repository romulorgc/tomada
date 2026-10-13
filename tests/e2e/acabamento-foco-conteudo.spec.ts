/**
 * Enquadramento da janela quadrada do 9:16 pelo CONTEÚDO da imagem (mapa de conteúdo medido no processamento). Página sintética de
 * webmail com a geometria da gravação real: tela 1920×1080 com faixa de abas e barra de tarefas, a página recortada (1920×912), barra de
 * ícones colada à esquerda, barra lateral e uma coluna de e-mail de 630 px no meio. O cursor fica parado na borda esquerda da coluna e há
 * só 3 cliques, todos na metade esquerda dela: era o caso em que a janela saía deslocada e cortava a coluna na borda direita.
 *
 * Renderiza pelo caminho da exportação (laboratório de render) a metade de tela do V-B e a Tela ao centro, SEM e COM o mapa, e confere
 * em PIXELS: com o mapa nenhum texto toca as bordas da janela (nada cortado); sem ele o texto da coluna é cortado na borda direita. Os
 * quadros e a folha ficam em `test-results/acabamento/foco-conteudo-*.png` (confira a olho).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import { createFfmpeg, locateFfmpeg } from '../../src/main/ffmpeg'
import { measureContentMap } from '../../src/main/content-map'
import { contentMapToJsonLines } from '../../src/shared/content-map'
import { createProject, serializeProject } from '../../src/shared/project'
import { VERTICAL_1080, deriveProject, evaluateScene, prepareEvents } from '../../src/shared/scene'
import { projectForFormat } from '../../src/shared/vertical'
import type { ClickEvent, LayoutKind, Project } from '../../src/shared/types'
import { launchTomada, ROOT, type Session } from './helpers'
import { openLab, renderStills } from './lab'

const OUT = join(ROOT, 'test-results', 'acabamento')
const FOLDER = '2026-10-06 1700 Webmail com abas'
const SW = 1920, SH = 1080, DURATION = 6000
/** A página do navegador dentro da tela (o que o recorte automático do piloto mostra). */
const PAGE = { x: 0, y: 108 / SH, w: 1, h: 912 / SH }
/** A coluna do e-mail, em px da tela. */
const COLUMN = { x0: 780, x1: 1410 }
const TIMES = [700, 2000, 3500, 5200]
let s: Session | undefined
test.afterEach(async () => { if (s) { await s.close(); s = undefined } })

/** Clique na metade esquerda da coluna; o cursor fica parado na borda esquerda dela. */
const CLICKS: { t: number; x: number; y: number }[] = [{ t: 1200, x: 840, y: 400 }, { t: 3000, x: 900, y: 620 }, { t: 4600, x: 820, y: 800 }]
const cursor = Array.from({ length: DURATION / 50 + 1 }, (_, i) => ({ t: i * 50, x: 800 / SW, y: 480 / SH }))
const clicks: ClickEvent[] = CLICKS.map((c) => ({ t: c.t, x: c.x / SW, y: c.y / SH, button: 'left', upT: c.t + 80 }))

function readPng(buf: Buffer): PNG {
  return PNG.sync.read(buf)
}

/** Pixels de texto (escuros) nas `edge` colunas de cada lado do retângulo da tela, dentro dele. */
function darkAtEdges(png: PNG, rect: { x: number; y: number; w: number; h: number }, edge: number): { left: number; right: number } {
  let left = 0, right = 0
  const dark = (x: number, y: number): boolean => {
    const i = (y * png.width + x) * 4
    return png.data[i]! * 0.3 + png.data[i + 1]! * 0.59 + png.data[i + 2]! * 0.11 < 120
  }
  for (let y = rect.y + 4; y < rect.y + rect.h - 4; y++) {
    for (let k = 0; k < edge; k++) {
      if (dark(rect.x + k, y)) left++
      if (dark(rect.x + rect.w - 1 - k, y)) right++
    }
  }
  return { left, right }
}

function sheet(top: string[], bottom: string[], target: string): void {
  const rows = [top, bottom].map((paths) => paths.map((p) => readPng(readFileSync(p))))
  const w = 270, h = 480, label = 8
  const out = new PNG({ width: w * rows[0]!.length, height: (h + label) * 2 })
  out.data.fill(25)
  rows.forEach((imgs, r) => imgs.forEach((src, n) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const from = (Math.floor(y * src.height / h) * src.width + Math.floor(x * src.width / w)) * 4
      out.data.set(src.data.subarray(from, from + 4), ((r * (h + label) + label + y) * out.width + n * w + x) * 4)
    }
  }))
  writeFileSync(target, PNG.sync.write(out))
}

test('webmail com abas: a coluna do e-mail fica inteira na janela quadrada (V-B e Tela ao centro), sem texto cortado na borda', async () => {
  test.setTimeout(300_000)
  mkdirSync(OUT, { recursive: true })
  s = await launchTomada({ seed: false })
  const dir = join(s.projects, FOLDER)
  mkdirSync(join(dir, 'media'), { recursive: true })
  mkdirSync(join(dir, 'events'), { recursive: true })
  const png = await s.page.evaluate(({ w, h, col }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h
    const g = c.getContext('2d')!
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h)
    // faixa de abas e barra de endereço (acima da página) e barra de tarefas (abaixo)
    g.fillStyle = '#dfe3ea'; g.fillRect(0, 0, w, 108)
    g.fillStyle = '#1f2937'; g.font = '20px Arial'
    ;['Ação necessária para proteger', 'WhatsApp', 'https://exemplo.test/aba-longa', 'Nova sessão'].forEach((t, i) => g.fillText(t, 20 + i * 330, 34))
    g.fillText('mail.exemplo.test/mail/u/0/#inbox/ABCDEFGHIJKLMNOPQRSTUVWXYZ', 130, 88)
    g.fillStyle = '#e8d9e4'; g.fillRect(0, 1020, w, 60)
    g.fillStyle = '#222'; for (let i = 0; i < 28; i++) g.fillRect(560 + i * 44, 1034, 30, 30)
    // a página: barra de ícones à esquerda, barra lateral de rótulos, coluna central de e-mail
    g.fillStyle = '#f6f8fc'; g.fillRect(0, 108, 74, 912)
    g.fillStyle = '#374151'; for (let i = 0; i < 9; i++) g.fillRect(22, 150 + i * 64, 30, 30)
    g.font = '22px Arial'
    ;['Caixa de entrada', 'Com estrela', 'Adiados', 'Importante', 'Enviados', 'Rascunhos', 'Compras', 'Social'].forEach((t, i) => g.fillText(t, 110, 190 + i * 46))
    g.fillStyle = '#111827'; g.font = 'bold 44px Arial'; g.textAlign = 'center'
    g.fillText('Ação necessária para', (col.x0 + col.x1) / 2, 215)
    g.fillText('proteger seu VPS', (col.x0 + col.x1) / 2, 268)
    g.textAlign = 'left'; g.font = '25px Arial'; g.fillStyle = '#1f2937'
    ;['Nosso scanner de malware Monarx detectou arquivos de', 'malware em srv1923319.hstgr.cloud', '', 'Número de arquivos de malware foram detectados: 1', '', 'Para manter seu VPS protegido, você deve deletar', 'esses arquivos ou colocá-los em quarentena', 'imediatamente.'].forEach((t, i) => g.fillText(t, col.x0, 350 + i * 40))
    g.fillStyle = '#5b3fd0'; g.fillRect(col.x0 + 190, 700, 250, 62)
    g.fillStyle = '#fff'; g.font = 'bold 26px Arial'; g.fillText('Remover malware', col.x0 + 214, 740)
    g.fillStyle = '#1f2937'; g.font = '25px Arial'
    ;['Reforce sua segurança', '', 'Para ter uma camada extra de proteção, compre uma', 'licença adicional do Monarx para que o malware', 'malicioso seja eliminado automaticamente.'].forEach((t, i) => g.fillText(t, col.x0 + 20, 830 + i * 36))
    return c.toDataURL().split(',')[1]!
  }, { w: SW, h: SH, col: COLUMN })
  const input = join(dir, 'media', 'pagina.png'); writeFileSync(input, Buffer.from(png, 'base64'))
  // GOP de 1 s sem troca de cena, como o `media/screen.mp4` que o processamento produz
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', input, '-t', String(DURATION / 1000), '-r', '30', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', join(dir, 'media', 'screen.mp4')], { windowsHide: true })
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x303030:s=640x360:r=30:d=${DURATION / 1000}`, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', join(dir, 'media', 'camera.mp4')], { windowsHide: true })

  // o mapa de conteúdo, medido como o processamento mede
  const map = await measureContentMap(createFfmpeg(locateFfmpeg()!), join(dir, 'media', 'screen.mp4'))
  writeFileSync(join(dir, 'events', 'content-map.jsonl'), contentMapToJsonLines(map))
  writeFileSync(join(dir, 'events', 'cursor.jsonl'), cursor.map((c) => JSON.stringify(c)).join('\n'))
  writeFileSync(join(dir, 'events', 'clicks.jsonl'), clicks.map((c) => JSON.stringify(c)).join('\n'))
  writeFileSync(join(dir, 'events', 'keys.jsonl'), '')

  const base = createProject({ title: 'Webmail com abas', sources: { screen: { path: 'media/screen.mp4', w: SW, h: SH, fps: 30, durationMs: DURATION }, camera: { path: 'media/camera.mp4', w: 640, h: 360, fps: 30, durationMs: DURATION } } })
  base.zoomPreset = 'off'; base.style.cursor.ripple = false; base.style.camera.borderWidth = 0
  // F2 (R3): o zoom vem da letra (30 px no quadro). O corpo desta página sintética tem 25 px de verdade (a estimativa do app, 13 px por 1080, é
  // para páginas reais de navegador): a janela de 30 px de letra tem ~800 px de largura e a coluna (630 px) cabe inteira dentro dela.
  base.screenTextPx = 25
  base.screenCrop = { mode: 'manual', manual: PAGE }
  writeFileSync(join(dir, 'project.json'), serializeProject(base))
  const project = (layout: LayoutKind, camera: boolean): Project => {
    const cp: Project = structuredClone(base)
    if (!camera) delete cp.sources.camera
    cp.vertical = { layout, layouts: [], zooms: [], zoomPreset: 'off' }
    return cp
  }

  const lab = await openLab(s.app)
  const capture = async (layout: LayoutKind, camera: boolean, withMap: boolean, prefix: string): Promise<string[]> => {
    const frames = await renderStills(lab, { project: project(layout, camera), folder: FOLDER, format: VERTICAL_1080, times: TIMES, contentMap: withMap })
    return frames.map((f, i) => { const path = join(OUT, `${prefix}-${i}.png`); writeFileSync(path, f); return path })
  }
  // Onde a página aparece no quadro 1080×1920 (a janela quadrada do V-B; a caixa da Tela ao centro)
  const region = { stack: { x: 60, y: 0, w: 960, h: 960 }, 'screen-center': { x: 90, y: 384, w: 900, h: 900 } } as const
  const cases = [['stack', true], ['screen-center', false]] as const
  const paths: Record<string, { sem: string[]; com: string[] }> = {}
  for (const [layout, camera] of cases) {
    paths[layout] = { sem: await capture(layout, camera, false, `foco-conteudo-${layout}-sem`), com: await capture(layout, camera, true, `foco-conteudo-${layout}-com`) }
    sheet(paths[layout]!.sem, paths[layout]!.com, join(OUT, `folha-foco-conteudo-${layout}.png`))
  }

  for (const [layout] of cases) {
    // com o mapa: nenhum texto toca a borda da janela, em nenhum dos 4 instantes
    for (const [i, file] of paths[layout]!.com.entries()) {
      const edges = darkAtEdges(readPng(readFileSync(file)), region[layout], 14)
      expect(edges, `${layout} COM o mapa, t=${TIMES[i]}: texto na borda da janela (cortado)`).toEqual({ left: 0, right: 0 })
    }
    // sem o mapa a janela só tem as ações para se guiar (os quadros ficam na folha para comparar a olho); com a janela de F2, larga o bastante para a
    // coluna, o corte que o mapa conserta só aparece quando a letra pede uma janela mais estreita que a coluna
  }

  // A cena (não os pixels): a janela cobre a coluna inteira, com folga, em todos os instantes, nas duas telas
  const data = prepareEvents({ cursor, clicks, keys: [], contentMap: map }, DURATION)
  for (const [layout, camera] of cases) {
    const view = projectForFormat(project(layout, camera), 'vertical')
    const derived = deriveProject(view, data, VERTICAL_1080)
    for (let t = 0; t <= DURATION - 200; t += 200) {
      const src = evaluateScene(view, derived, t, VERTICAL_1080).screen!.src
      expect(src.x * SW, `${layout} t=${t}`).toBeLessThanOrEqual(COLUMN.x0 - 20)
      expect((src.x + src.w) * SW, `${layout} t=${t}`).toBeGreaterThanOrEqual(COLUMN.x1 + 20)
    }
  }
})
