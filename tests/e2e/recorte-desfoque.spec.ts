/**
 * Junção C1 × M5a: o recorte da tela muda o espaço de coordenadas, e o desfoque (região normalizada na tela GRAVADA) tem de continuar
 * cobrindo o mesmo pedaço. Prova com pixels de verdade, no Electron: uma tela sintética com uma caixa BRANCA conhecida; a tarja
 * sólida vai sobre ela (no quadro de origem) e o recorte é desenhado depois.
 *
 *  - cada formato (16:9 e vertical) × cada layout com câmera (tela só, quadro ao lado, Apresentador; V-A, V-B, V-D) ×
 *    recorte que contém a caixa e recorte que corta a caixa ao meio;
 *  - o que era branco no controle (sem proteção) não tem mais nenhum pixel branco; o retângulo do controle está todo na cor da
 *    tarja; e FORA dele a imagem é a mesma do controle (uma tarja deslocada deixaria branco e mexeria no que está em volta);
 *  - e o arquivo exportado (16:9 e vertical), não só os quadros avulsos, tem o mesmo comportamento.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import { createProject, serializeProject } from '../../src/shared/project'
import { HORIZONTAL_1080, VERTICAL_1080, type FormatSpec } from '../../src/shared/scene'
import type { LayoutKind, Project, Rect } from '../../src/shared/types'
import { launchTomada, SCREENS_DIR, type Session } from './helpers'
import { exportProject } from './export-helpers'
import { openLab, renderStills, saveScreen, writeMatte } from './lab'

const FOLDER = '2026-10-06 1000 Recorte e desfoque'
/** A caixa branca na tela gravada (2560×1080) e, por cima dela, a região protegida (a mesma). */
const BOX: Rect = { x: 0.31, y: 0.3, w: 0.38, h: 0.25 }
/** O recorte que contém a caixa inteira e o que a corta ao meio (só a metade da direita fica). */
const CROP_IN: Rect = { x: 0.2, y: 0.1, w: 0.6, h: 0.8 }
const CROP_CUT: Rect = { x: 0.5, y: 0.1, w: 0.4, h: 0.8 }
const SOLID: [number, number, number] = [17, 24, 39] // #111827, a cor da tarja
const H: FormatSpec = HORIZONTAL_1080
const V: FormatSpec = VERTICAL_1080

let s: Session | undefined
test.afterEach(async () => {
  if (!s) return
  const problems = s.problems
  await s.close()
  s = undefined
  expect(problems).toEqual([])
})

async function seed(session: Session): Promise<Project> {
  const dir = join(session.projects, FOLDER)
  mkdirSync(join(dir, 'media'), { recursive: true })
  mkdirSync(join(dir, 'events'), { recursive: true })
  const png = await session.page.evaluate((box) => {
    const c = document.createElement('canvas')
    c.width = 2560
    c.height = 1080
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#1c2840'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(box.x * c.width, box.y * c.height, box.w * c.width, box.h * c.height)
    ctx.fillStyle = '#111111'
    ctx.font = 'bold 110px Arial'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('SEGREDO 12345', (box.x + box.w / 2) * c.width, (box.y + box.h / 2) * c.height)
    // um marcador vermelho fora da caixa (existe em qualquer recorte que o contenha): não pode mudar com a proteção
    ctx.fillStyle = '#d33a3a'
    ctx.fillRect(0.82 * c.width, 0.6 * c.height, 0.06 * c.width, 0.12 * c.height)
    return c.toDataURL('image/png').split(',')[1]!
  }, BOX)
  const input = join(dir, 'media', 'known-box.png')
  writeFileSync(input, Buffer.from(png, 'base64'))
  const x264 = ['-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p']
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', input, '-t', '6', '-r', '30', ...x264, join(dir, 'media', 'screen.mp4')], { windowsHide: true })
  // a câmera: cinza escuro liso (nenhum pixel branco que confunda a conferência)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x303030:s=640x360:r=30:d=6', ...x264, join(dir, 'media', 'camera.mp4')], { windowsHide: true })
  const p = createProject({
    title: 'Recorte e desfoque',
    sources: {
      screen: { path: 'media/screen.mp4', w: 2560, h: 1080, fps: 30, durationMs: 6000 },
      camera: { path: 'media/camera.mp4', w: 640, h: 360, fps: 30, durationMs: 6000 }
    }
  })
  p.zoomPreset = 'off'
  p.style.cursor.ripple = false
  // sem borda branca na bolha da câmera (o V-A a desenha): só a caixa conhecida é branca na imagem
  p.style.camera.borderWidth = 0
  // nenhum desenho de cursor por cima (sem halo, sem cursor sintético): só a tela, a câmera e a proteção entram na conferência
  p.style.cursor.mode = 'real'
  p.style.cursor.halo = false
  // o cursor (só alimenta o acompanhamento do vertical) parado abaixo da caixa, e sem cliques
  writeFileSync(join(dir, 'events', 'cursor.jsonl'), JSON.stringify({ t: 0, x: 0.5, y: 0.78 }) + '\n')
  writeFileSync(join(dir, 'events', 'clicks.jsonl'), '')
  writeFileSync(join(dir, 'events', 'keys.jsonl'), '')
  writeFileSync(join(dir, 'project.json'), serializeProject(p))
  await session.page.reload()
  return p
}

type Bounds = { x0: number; y0: number; x1: number; y1: number; count: number }
const isWhite = (d: Buffer | Uint8Array, i: number): boolean => d[i]! > 200 && d[i + 1]! > 200 && d[i + 2]! > 200

/** O retângulo que envolve os pixels brancos (a caixa conhecida), ou null se não há nenhum. */
function whiteBounds(png: PNG): Bounds | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, count = 0
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (!isWhite(png.data, (y * png.width + x) * 4)) continue
      count++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return count === 0 ? null : { x0, y0, x1, y1, count }
}

/**
 * A borda da caixa no vídeo de origem é um degradê de 1 a 2 px da fonte (a compressão suaviza): no vertical, onde cada px da fonte vira
 * mais de 2 px do quadro, esse degradê é uma faixa que fica FORA da região (a caixa é exatamente a região). O que se confere dentro
 * é o miolo da caixa (sem essa faixa de `FRINGE` px); fora, a imagem tem de ser a mesma do controle.
 */
const FRINGE = 6
type Proof = { whiteBefore: number; whiteInnerAfter: number; innerTotal: number; solidShare: number; outsideChanged: number; outsideTotal: number }
const isSolid = (d: Buffer | Uint8Array, i: number): boolean => Math.abs(d[i]! - SOLID[0]) < 12 && Math.abs(d[i + 1]! - SOLID[1]) < 12 && Math.abs(d[i + 2]! - SOLID[2]) < 12
/** O controle (sem a proteção) × o protegido, no mesmo quadro. */
function prove(control: PNG, guarded: PNG): Proof {
  expect([guarded.width, guarded.height]).toEqual([control.width, control.height])
  const box = whiteBounds(control)
  expect(box, 'a caixa branca aparece no controle').not.toBeNull()
  let solid = 0, wasWhite = 0, inner = 0, whiteInner = 0, changed = 0, outside = 0
  const margin = 8
  for (let y = 0; y < control.height; y++) {
    for (let x = 0; x < control.width; x++) {
      const i = (y * control.width + x) * 4
      if (x >= box!.x0 + FRINGE && x <= box!.x1 - FRINGE && y >= box!.y0 + FRINGE && y <= box!.y1 - FRINGE) {
        inner++
        if (isWhite(guarded.data, i)) whiteInner++
        // o que era branco (a caixa; o que a pessoa do Apresentador cobre nunca foi branco) virou a cor da tarja
        if (isWhite(control.data, i)) {
          wasWhite++
          if (isSolid(guarded.data, i)) solid++
        }
      } else if (x < box!.x0 - margin || x > box!.x1 + margin || y < box!.y0 - margin || y > box!.y1 + margin) {
        outside++
        if (Math.abs(guarded.data[i]! - control.data[i]!) > 4 || Math.abs(guarded.data[i + 1]! - control.data[i + 1]!) > 4 || Math.abs(guarded.data[i + 2]! - control.data[i + 2]!) > 4) changed++
      }
    }
  }
  return { whiteBefore: box!.count, whiteInnerAfter: whiteInner, innerTotal: inner, solidShare: solid / wasWhite, outsideChanged: changed, outsideTotal: outside }
}

const CASES: Array<{ name: string; format: FormatSpec; layout: LayoutKind }> = [
  { name: '16:9 tela só', format: H, layout: 'screen' },
  { name: '16:9 quadro ao lado', format: H, layout: 'side-by-side' },
  { name: '16:9 Apresentador', format: H, layout: 'presenter' },
  { name: 'vertical V-A', format: V, layout: 'screen-focus' },
  { name: 'vertical V-B', format: V, layout: 'stack' },
  { name: 'vertical V-D (Apresentador)', format: V, layout: 'presenter' }
]

function docFor(base: Project, c: (typeof CASES)[number], crop: Rect, guarded: boolean): Project {
  const p: Project = structuredClone(base)
  p.screenCrop = { mode: 'manual', manual: crop }
  p.blurRegions = guarded ? [{ id: 'b1', start: 0, end: 6000, rect: BOX, mode: 'solid' }] : []
  if (c.format.kind === 'horizontal') p.style.defaultLayout = c.layout
  p.vertical = { layout: c.format.kind === 'vertical' ? c.layout : 'screen-focus', layouts: [], zooms: [], zoomPreset: 'off', captions: { enabled: false } }
  return p
}

test('o desfoque cobre o mesmo pedaço com o recorte ligado: dois formatos, três layouts com câmera, recorte inteiro e recorte que corta a caixa', async () => {
  test.setTimeout(240_000)
  s = await launchTomada({ seed: false })
  const base = await seed(s)
  const matteUrl = writeMatte(s, { durationS: 6 }, FOLDER)
  const lab = await openLab(s.app)
  mkdirSync(SCREENS_DIR, { recursive: true })
  const proofs: Record<string, Proof> = {}
  for (const [cropName, crop] of [['recorte inteiro', CROP_IN], ['recorte que corta a caixa', CROP_CUT]] as const) {
    for (const c of CASES) {
      const common = { folder: FOLDER, format: c.format, times: [1000], matteUrl }
      const [control] = await renderStills(lab, { project: docFor(base, c, crop, false), ...common })
      const [guarded] = await renderStills(lab, { project: docFor(base, c, crop, true), ...common })
      const tag = `recorte-desfoque-${c.format.kind}-${c.layout}-${crop === CROP_IN ? 'inteiro' : 'corta'}`
      saveScreen(`${tag}-controle`, control!)
      saveScreen(`${tag}-protegido`, guarded!)
      const proof = prove(PNG.sync.read(control!), PNG.sync.read(guarded!))
      proofs[`${c.name} (${cropName})`] = proof
      const label = `${c.name}, ${cropName}`
      expect(proof.whiteBefore, `${label}: a caixa branca é visível no controle`).toBeGreaterThan(2000)
      expect(proof.innerTotal, `${label}: há miolo da caixa para conferir`).toBeGreaterThan(1000)
      expect(proof.whiteInnerAfter, `${label}: não sobra pixel branco no miolo da caixa`).toBeLessThanOrEqual(proof.innerTotal * 0.001)
      expect(proof.solidShare, `${label}: tudo o que era branco no miolo da caixa virou a cor da tarja`).toBeGreaterThan(0.99)
      expect(proof.outsideChanged, `${label}: fora da caixa a imagem é a mesma do controle`).toBeLessThanOrEqual(proof.outsideTotal * 0.0005)
    }
  }
  writeFileSync(join(SCREENS_DIR, 'recorte-desfoque-contagens.json'), JSON.stringify(proofs, null, 2))
})

test('o arquivo exportado (16:9 e vertical) também cobre a caixa com o recorte ligado, e fora dela segue como o controle', async () => {
  test.setTimeout(300_000)
  s = await launchTomada({ seed: false })
  const base = await seed(s)
  const lab = await openLab(s.app)
  const frameOf = (path: string): PNG =>
    PNG.sync.read(execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', path, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }))
  for (const [cropName, crop] of [['recorte inteiro', CROP_IN], ['recorte que corta a caixa', CROP_CUT]] as const) {
    for (const c of [CASES[0]!, CASES[3]!]) {
      const control = docFor(base, c, crop, false)
      const guarded = docFor(base, c, crop, true)
      // o controle do mesmo quadro (a caixa visível), pelo desenho avulso; o arquivo vem da exportação de verdade
      const [reference] = await renderStills(lab, { project: control, folder: FOLDER, format: c.format, times: [1000] })
      const box = whiteBounds(PNG.sync.read(reference!))
      expect(box, `${cropName}: a caixa aparece no controle`).not.toBeNull()
      await s.page.evaluate(({ id, p }) => window.tomada.projects.save(id, p), { id: FOLDER, p: guarded })
      const result = await exportProject(s.page, FOLDER, { resolution: '1080p', fps: 30, format: c.format.kind })
      expect(result.phase, result.message ?? '').toBe('done')
      const exported = frameOf(result.outputPath!)
      const tag = `recorte-desfoque-exportado-${c.format.kind}-${crop === CROP_IN ? 'inteiro' : 'corta'}`
      saveScreen(tag, PNG.sync.write(exported))
      saveScreen(`${tag}-controle`, reference!)
      expect([exported.width, exported.height]).toEqual([c.format.w, c.format.h])
      // dentro do retângulo onde a caixa estava, o vídeo (com perdas) não traz mais nenhum pixel branco…
      let whiteInside = 0, total = 0
      for (let y = box!.y0 + FRINGE; y < box!.y1 - FRINGE; y++) {
        for (let x = box!.x0 + FRINGE; x < box!.x1 - FRINGE; x++) {
          total++
          if (isWhite(exported.data, (y * exported.width + x) * 4)) whiteInside++
        }
      }
      expect(total).toBeGreaterThan(2000)
      expect(whiteInside, `${c.name}, ${cropName}: o arquivo não tem a caixa branca onde ela estava (miolo)`).toBeLessThanOrEqual(total * 0.002)
      // …e o resto do quadro é o mesmo do controle (o recorte não deslocou nada): a média das cores fora da caixa difere pouco
      const ref = PNG.sync.read(reference!)
      let diff = 0, n = 0
      for (let y = 0; y < ref.height; y += 3) {
        for (let x = 0; x < ref.width; x += 3) {
          if (x >= box!.x0 - 12 && x <= box!.x1 + 12 && y >= box!.y0 - 12 && y <= box!.y1 + 12) continue
          const i = (y * ref.width + x) * 4
          diff += Math.abs(ref.data[i]! - exported.data[i]!) + Math.abs(ref.data[i + 1]! - exported.data[i + 1]!) + Math.abs(ref.data[i + 2]! - exported.data[i + 2]!)
          n++
        }
      }
      expect(diff / n / 3, `${c.name}, ${cropName}: o arquivo e o quadro avulso coincidem fora da caixa`).toBeLessThan(6)
    }
  }
})

test('o vertical ainda não gerado (exportação direta): um clique fora do recorte não abre zoom, um clique dentro abre', async () => {
  test.setTimeout(180_000)
  s = await launchTomada({ seed: false })
  const base = await seed(s)
  const lab = await openLab(s.app)
  const events = join(s.projects, FOLDER, 'events')
  const p: Project = structuredClone(base)
  p.screenCrop = { mode: 'manual', manual: CROP_IN }
  p.blurRegions = []
  delete p.vertical // nunca aberto no 9:16: quem gera os zooms e os layouts é a exportação (`ensureVertical`), como a prévia faria
  p.style.defaultLayout = 'screen'
  const clickAt = (x: number, y: number): void => writeFileSync(join(events, 'clicks.jsonl'), JSON.stringify({ t: 2000, x, y, button: 'left' }) + '\n')
  const still = async (): Promise<PNG> => PNG.sync.read((await renderStills(lab, { project: p, folder: FOLDER, format: V, times: [3000] }))[0]!)
  const differs = (a: PNG, b: PNG): number => {
    let n = 0
    for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i]! - b.data[i]!) > 6 || Math.abs(a.data[i + 1]! - b.data[i + 1]!) > 6 || Math.abs(a.data[i + 2]! - b.data[i + 2]!) > 6) n++
    return n
  }
  writeFileSync(join(events, 'clicks.jsonl'), '')
  const none = await still()
  clickAt(0.5, 0.04) // na barra de abas: acima do recorte (que começa em y = 0,10)
  const outside = await still()
  clickAt(0.5, 0.55) // dentro da página
  const inside = await still()
  saveScreen('recorte-zoom-vertical-sem-clique', PNG.sync.write(none))
  saveScreen('recorte-zoom-vertical-clique-fora', PNG.sync.write(outside))
  saveScreen('recorte-zoom-vertical-clique-dentro', PNG.sync.write(inside))
  expect(differs(none, outside), 'o clique fora do recorte não muda o quadro (não abriu zoom)').toBeLessThan(none.data.length / 4 * 0.0005)
  expect(differs(none, inside), 'o clique dentro do recorte abre zoom (o controle da conferência)').toBeGreaterThan(none.data.length / 4 * 0.02)
})
