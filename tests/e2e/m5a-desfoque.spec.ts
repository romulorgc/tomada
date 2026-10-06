import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import { createProject, serializeProject } from '../../src/shared/project'
import { deriveProject, evaluateScene, prepareEvents, HORIZONTAL_1080, VERTICAL_1080 } from '../../src/shared/scene'
import { displayRect } from '../../src/shared/blur'
import type { Project, Rect } from '../../src/shared/types'
import { projectForFormat } from '../../src/shared/vertical'
import { reviewDocument } from '../../src/shared/review'
import { compareGolden, openLab, renderStills, saveScreen } from './lab'
import { launchTomada, SCREENS_DIR, shot, type Session } from './helpers'
import { openEditor, readSaved, seekPausedTo, waitSaved, timelineGeometry, xOfDisplay } from './editor-helpers'
import { exportProject } from './export-helpers'

const FOLDER = '2026-10-05 1600 Privacidade'
const REGION: Rect = { x: .31, y: .3, w: .38, h: .25 }
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
  const png = await session.page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 2560; c.height = 1080
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#1c2840'; ctx.fillRect(0, 0, c.width, c.height)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(.31 * c.width, .3 * c.height, .38 * c.width, .25 * c.height)
    ctx.fillStyle = '#111111'; ctx.font = 'bold 100px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('SEGREDO 12345', 1280, .425 * c.height)
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 50px Arial'; ctx.fillText('Controle público · tela ultrawide', 1280, 900)
    return c.toDataURL('image/png').split(',')[1]!
  })
  const input = join(dir, 'media', 'known-text.png')
  writeFileSync(input, Buffer.from(png, 'base64'))
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', input, '-t', '6', '-r', '30', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '15', '-pix_fmt', 'yuv420p', join(dir, 'media', 'screen.mp4')], { windowsHide: true })
  const p = createProject({ title: 'Privacidade sintética', sources: { screen: { path: 'media/screen.mp4', w: 2560, h: 1080, fps: 30, durationMs: 6000 } } })
  p.style.defaultLayout = 'screen'; p.style.cursor.ripple = false; p.zoomPreset = 'off'
  p.vertical = { layout: 'screen-focus', layouts: [], zooms: [], zoomPreset: 'off', captions: { enabled: false } }
  writeFileSync(join(dir, 'events', 'cursor.jsonl'), JSON.stringify({ t: 0, x: .5, y: .5 }) + '\n')
  writeFileSync(join(dir, 'events', 'clicks.jsonl'), '')
  writeFileSync(join(dir, 'events', 'keys.jsonl'), '')
  writeFileSync(join(dir, 'project.json'), serializeProject(p))
  await session.page.reload()
  return p
}

function sharpEdges(png: Buffer, rect: Rect): number {
  const p = PNG.sync.read(png)
  const left = Math.max(1, Math.ceil(rect.x + 8)); const right = Math.min(p.width - 2, Math.floor(rect.x + rect.w - 8))
  const top = Math.max(1, Math.ceil(rect.y + 8)); const bottom = Math.min(p.height - 2, Math.floor(rect.y + rect.h - 8))
  let count = 0
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const i = (y * p.width + x) * 4
    if (Math.abs(p.data[i]! - p.data[i + 4]!) > 40 || Math.abs(p.data[i]! - p.data[i + p.width * 4]!) > 40) count++
  }
  return count
}
function destroyedInk(before: Buffer, after: Buffer, rect: Rect): { ink:number; destroyed:number } {
  const a = PNG.sync.read(before), b = PNG.sync.read(after)
  let ink = 0, destroyed = 0
  for (let y=Math.max(0,Math.ceil(rect.y+8));y<Math.min(a.height,Math.floor(rect.y+rect.h-8));y++) {
    for (let x=Math.max(0,Math.ceil(rect.x+8));x<Math.min(a.width,Math.floor(rect.x+rect.w-8));x++) {
      const i=(y*a.width+x)*4
      if (a.data[i]!<120) { ink++; if (b.data[i]!>a.data[i]!+80) destroyed++ }
    }
  }
  return {ink,destroyed}
}
const data = () => prepareEvents({ cursor: [{ t: 0, x: .5, y: .5 }], clicks: [], keys: [] }, 6000)
const exportPng = (path: string) => execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', path, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })

test('selecionar região, mover/redimensionar prévia e trilha, B até o fim, desfazer, exportar YouTube e corte com pixels destruídos', async () => {
  test.setTimeout(180000)
  s = await launchTomada({ seed: false })
  const p = await seed(s)
  await openEditor(s)
  const page = s.page
  await page.getByTestId('tab-blur').click()
  await page.getByTestId('blur-draw').click()
  const bounds = (await page.getByTestId('preview-canvas').boundingBox())!
  const scene = evaluateScene(p, deriveProject(p, data(), HORIZONTAL_1080), 0, HORIZONTAL_1080)
  const r = displayRect(REGION, scene.screen!)
  const x = (v: number) => bounds.x + v / 1920 * bounds.width
  const y = (v: number) => bounds.y + v / 1080 * bounds.height
  await page.mouse.move(x(r.x), y(r.y)); await page.mouse.down()
  await page.mouse.move(x(r.x + r.w), y(r.y + r.h), { steps: 8 }); await page.mouse.up()
  await expect(page.getByTestId('blur-selection')).toBeVisible()
  await waitSaved(s)
  let saved = readSaved(s, FOLDER)
  const id = saved.blurRegions![0]!.id
  expect(saved.blurRegions![0]!.rect.x).toBeCloseTo(REGION.x, 2)
  expect(saved.blurRegions![0]!.rect.w).toBeCloseTo(REGION.w, 2)
  await page.keyboard.press('b'); await waitSaved(s)
  expect(readSaved(s, FOLDER).blurRegions![0]!.end).toBe(6000)

  // Um gesto move a região, um desfazer devolve; a alça altera tamanho.
  const sel = (await page.getByTestId('blur-selection').boundingBox())!
  await page.mouse.move(sel.x + sel.width / 2, sel.y + sel.height / 2); await page.mouse.down()
  await page.mouse.move(sel.x + sel.width / 2 + 20, sel.y + sel.height / 2, { steps: 5 }); await page.mouse.up(); await waitSaved(s)
  expect(readSaved(s, FOLDER).blurRegions![0]!.rect.x).toBeGreaterThan(saved.blurRegions![0]!.rect.x)
  await page.keyboard.press('Control+z'); await waitSaved(s)
  const handle = (await page.getByTestId('blur-handle-se').boundingBox())!
  await page.mouse.move(handle.x + 5, handle.y + 5); await page.mouse.down()
  await page.mouse.move(handle.x + 25, handle.y + 15, { steps: 5 }); await page.mouse.up(); await waitSaved(s)
  expect(readSaved(s, FOLDER).blurRegions![0]!.rect.w).toBeGreaterThan(saved.blurRegions![0]!.rect.w)
  await page.keyboard.press('Control+z'); await waitSaved(s)

  // Mover e redimensionar o intervalo na trilha; desfazer restaura a proteção original.
  const g = await timelineGeometry(page); const track = (await page.getByTestId('track-blur').boundingBox())!
  await page.getByTestId('blur-end').fill('4000'); await page.getByTestId('tab-blur').click(); await waitSaved(s)
  await page.mouse.move(xOfDisplay(g, 2000), track.y + track.height / 2); await page.mouse.down()
  await page.mouse.move(xOfDisplay(g, 3000), track.y + track.height / 2, { steps: 5 }); await page.mouse.up(); await waitSaved(s)
  expect(readSaved(s, FOLDER).blurRegions![0]!.start).toBeGreaterThan(500)
  await page.keyboard.press('Control+z'); await waitSaved(s)
  await page.getByTestId('blur-until-end').click(); await waitSaved(s)
  await seekPausedTo(page, 1000)
  await shot(page, 'm5a-desfoque-editor')
  saved = readSaved(s, FOLDER)
  saved.clips = [{ id: 'privado', title: 'Corte protegido', hook: '', ranges: [{ start: 0, end: 6000 }], score: 80, reason: 'Teste sintético', format: 'vertical', layoutV: 'screen-focus', captionsEnabled: false }]
  await page.evaluate(({ id, p }) => window.tomada.projects.save(id, p), { id: FOLDER, p: saved })
  const lab = await openLab(s.app)
  const proof: unknown[] = []
  for (const f of [HORIZONTAL_1080, VERTICAL_1080]) {
    const view = projectForFormat(saved, f.kind)
    const sc = evaluateScene(view, deriveProject(view, data(), f), 1000, f)
    const region = displayRect(saved.blurRegions![0]!.rect, sc.screen!)
    const [before, preview] = await renderStills(lab, { project: { ...saved, blurRegions: [] }, folder: FOLDER, format: f, times: [1000] }).then(async plain => [...plain, ...(await renderStills(lab, { project: saved, folder: FOLDER, format: f, times: [1000] }))])
    const controlEdges = sharpEdges(before!, region)
    expect(controlEdges, 'texto grande de controle precisa ser legível e ter contornos').toBeGreaterThan(1000)
    const result = f.kind === 'horizontal' ? await exportProject(page, FOLDER) : await page.evaluate(async id => {
      const { exportId } = await window.tomada.exporter.start({ projectId: id, resolution: '1080p', fps: 30, clipId: 'privado' })
      for (;;) { await new Promise(r => setTimeout(r, 150)); const st = await window.tomada.exporter.status(); if (st?.exportId === exportId && ['done', 'error', 'cancelled'].includes(st.phase)) return st }
    }, FOLDER)
    expect(result.phase, result.message ?? '').toBe('done')
    const exported = exportPng(result.outputPath!)
    const edges = sharpEdges(exported, region)
    expect(edges, 'o arquivo não conserva os contornos das letras').toBeLessThan(controlEdges * .01)
    expect(sharpEdges(preview!, region)).toBeLessThan(controlEdges * .01)
    const ink = destroyedInk(before!,exported,region)
    expect(ink.ink).toBeGreaterThan(500)
    expect(ink.destroyed/ink.ink,'os pixels pretos do texto conhecido precisam ser substituídos').toBeGreaterThan(.95)
    const streams = JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',result.outputPath!],{windowsHide:true,encoding:'utf8'})).streams as {codec_type:string}[]
    expect(streams.filter(stream=>stream.codec_type==='video')).toHaveLength(1)
    expect(streams.some(stream=>stream.codec_type==='data')).toBe(false)
    copyFileSync(result.outputPath!,join(SCREENS_DIR,`m5a-desfoque-${f.kind}.mp4`))
    proof.push({format:f.kind,controlEdges,previewEdges:sharpEdges(preview!,region),exportedEdges:edges,...ink,streams:streams.map(stream=>stream.codec_type)})
    saveScreen(`m5a-desfoque-${f.kind}-controle`, before!)
    saveScreen(`m5a-desfoque-${f.kind}-exportado`, exported)
    console.log(`Desfoque ${f.kind}: controle ${controlEdges} contornos; prévia ${sharpEdges(preview!, region)}; MP4 ${edges}.`)
  }
  writeFileSync(join(SCREENS_DIR,'m5a-desfoque-contagens.json'),JSON.stringify(proof,null,2))
  await expect(page.getByTestId(`seg-blur-${id}`)).toBeVisible()
})

test('goldens: três modos, ultrawide horizontal, V-A e fundo do V-C protegidos', async () => {
  test.setTimeout(120000)
  s = await launchTomada({ seed: false })
  const p = await seed(s)
  const lab = await openLab(s.app)
  for (const mode of ['blur', 'pixelate', 'solid'] as const) for (const f of [HORIZONTAL_1080, VERTICAL_1080]) {
    p.blurRegions = [{ id: 'b1', start: 0, end: 6000, rect: REGION, mode }]
    const [png] = await renderStills(lab, { project: p, folder: FOLDER, format: f, times: [1000] })
    const name = `m5a-ultrawide-${f.kind}-${mode}`
    saveScreen(name, png!)
    expect(compareGolden(name, png!).ratio).toBeLessThanOrEqual(.004)
  }
  p.vertical!.layout = 'screen-wide'
  p.blurRegions![0]!.mode = 'blur'
  const [protectedWide] = await renderStills(lab, { project: p, folder: FOLDER, format: VERTICAL_1080, times: [1000] })
  saveScreen('m5a-desfoque-fundo-vc', protectedWide!)
  expect(compareGolden('m5a-desfoque-fundo-vc', protectedWide!).ratio).toBeLessThanOrEqual(.004)
  p.vertical!.layout = 'screen-focus'
  p.zoomPreset = 'moderate'
  p.zooms = [{id:'zoom',start:0,end:6000,scale:2,focus:{x:.5,y:.425},origin:'manual'}]
  const [zoomed] = await renderStills(lab,{project:p,folder:FOLDER,format:HORIZONTAL_1080,times:[3000]})
  saveScreen('m5a-desfoque-zoom',zoomed!)
  expect(compareGolden('m5a-desfoque-zoom',zoomed!).ratio).toBeLessThanOrEqual(.004)
  writeFileSync(join(SCREENS_DIR, 'm5a-desfoque-prova.json'), JSON.stringify({ source: '2560×1080 sintético', knownText: 'SEGREDO 12345', modes: ['blur', 'pixelate', 'solid'], information: 'Região substituída antes de qualquer recorte; forte no máximo 2×2 médias quantizadas; arquivo codifica somente composição.' }, null, 2))
})

test('disco: o diálogo mede o projeto pela pasta e considera a duração do corte aberto', async () => {
  test.setTimeout(90000)
  s = await launchTomada({seed:false})
  const p = await seed(s)
  p.clips = [{id:'privado',title:'Corte de três segundos',hook:'',ranges:[{start:1000,end:4000}],score:80,reason:'Teste sintético',format:'vertical',layoutV:'screen-focus',captionsEnabled:false}]
  expect(p.id).not.toBe(FOLDER)
  await s.page.evaluate(({id,p}) => window.tomada.projects.save(id,p),{id:FOLDER,p})
  await s.page.reload()
  await openEditor(s)
  await s.page.getByTestId('export-open').click()
  await expect(s.page.getByTestId('disk-space-notice')).toBeVisible()
  await expect(s.page.getByTestId('disk-space-notice')).toContainText('6 s')
  await shot(s.page,'m5a-disco-exportacao-projeto')
  await s.page.reload()
  await s.page.getByTestId('card-review').click()
  await s.page.getByTestId('review-item-privado').getByRole('button',{name:'Abrir no editor',exact:true}).click()
  await expect(s.page.getByTestId('preview-canvas')).toHaveAttribute('data-ready','true')
  await s.page.getByTestId('export-open').click()
  await expect(s.page.getByTestId('disk-space-notice')).toBeVisible()
  await expect(s.page.getByTestId('disk-space-notice')).toContainText('3 s')
  await shot(s.page,'m5a-disco-exportacao-corte')
})

test('desfoque criado no editor da Revisão permanece no documento comum e nas reexportações', async () => {
  test.setTimeout(180000)
  s = await launchTomada({seed:false})
  const p = await seed(s)
  p.clips = [{id:'privado',title:'Corte protegido',hook:'',ranges:[{start:0,end:6000}],score:80,reason:'Teste sintético',format:'vertical',layoutV:'screen-focus',captionsEnabled:false}]
  await s.page.evaluate(({id,p}) => window.tomada.projects.save(id,p),{id:FOLDER,p})
  await s.page.reload()
  await s.page.getByTestId('card-review').click()
  await s.page.getByTestId('review-item-privado').getByRole('button',{name:'Abrir no editor',exact:true}).click()
  await expect(s.page.getByTestId('preview-canvas')).toHaveAttribute('data-ready','true')
  await s.page.getByTestId('tab-blur').click()
  await s.page.getByTestId('blur-draw').click()
  const bounds = (await s.page.getByTestId('preview-canvas').boundingBox())!
  const vp = projectForFormat(reviewDocument(p,'privado'),'vertical')
  const sc = evaluateScene(vp,deriveProject(vp,data(),VERTICAL_1080),0,VERTICAL_1080)
  const rect = displayRect({x:.45,y:.3,w:.1,h:.25},sc.screen!)
  await s.page.mouse.move(bounds.x + rect.x /1080*bounds.width,bounds.y+rect.y/1920*bounds.height)
  await s.page.mouse.down()
  await s.page.mouse.move(bounds.x+(rect.x+rect.w)/1080*bounds.width,bounds.y+(rect.y+rect.h)/1920*bounds.height,{steps:8})
  await s.page.mouse.up()
  await expect(s.page.getByTestId('blur-selection')).toBeVisible()
  await s.page.keyboard.press('b')
  await waitSaved(s)
  const saved = readSaved(s,FOLDER)
  expect(saved.blurRegions).toHaveLength(1)
  expect(saved.blurRegions![0]!.end).toBe(6000)
  expect(saved.cuts).toEqual([])
  for (const item of ['youtube','privado']) expect(reviewDocument(saved,item).blurRegions).toEqual(saved.blurRegions)
  await s.page.evaluate(async id => { await window.tomada.review.export(id,'youtube'); await window.tomada.review.export(id,'privado') },FOLDER)
  await expect.poll(() => {
    const p = readSaved(s!,FOLDER)
    return [p.review?.items.youtube?.phase,p.review?.items.privado?.phase]
  },{timeout:120000}).toEqual(['ready','ready'])
  const after = readSaved(s,FOLDER)
  expect(after.review?.items.youtube?.phase).toBe('ready')
  expect(after.review?.items.privado?.phase).toBe('ready')
  const lab = await openLab(s.app)
  for (const [item,f] of [['youtube',HORIZONTAL_1080],['privado',VERTICAL_1080]] as const) {
    const view = projectForFormat(reviewDocument(after,item),f.kind)
    const sc = evaluateScene(view,deriveProject(view,data(),f),1000,f)
    const r = displayRect(saved.blurRegions![0]!.rect,sc.screen!)
    const [plain] = await renderStills(lab,{project:{...view,blurRegions:[]},folder:FOLDER,format:f,times:[1000]})
    const control = sharpEdges(plain!,r)
    expect(control).toBeGreaterThan(1000)
    const png = exportPng(join(s.projects,FOLDER,after.review!.items[item]!.exportPath!))
    expect(sharpEdges(png,r)).toBeLessThan(control*.01)
    saveScreen(`m5a-desfoque-revisao-${item}`,png)
  }
})
