import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { parseProject } from '../../src/shared/project'
import { keptRanges, outputDuration } from '../../src/shared/timeline'
import { cameraVideoOffsetMs } from '../../src/shared/camera-sync'
import { projectDurationMs } from '../../src/shared/project'
import { reviewDocument } from '../../src/shared/review'
import { newPipeline } from '../../src/shared/autopilot'
import { parseTranscript } from '../../src/shared/transcript'
import { EXAMPLE_FOLDER, launchTomada, ROOT, SCREENS_DIR, shot, waitForAux, type Session } from './helpers'

let s:Session|undefined
test.afterEach(async () => { if(s) { const problems=s.problems; await s.close(); s=undefined; expect(problems).toEqual([]) } })
const readDoc = (folder:string) => parseProject(readFileSync(join(folder,'project.json'),'utf8'))
// Marcador visual sintético na câmera falsa: um y4m próprio que pinta o quadro todo com uma cor nova a cada 0,5 s (8 quadros a
// 16 qps), numa sequência que não se repete em 60 s. Cada instante da gravação tem então uma cor própria, e o vídeo exportado só
// pode mostrar a cor certa naquele ponto se o trecho do "errei" foi tirado do lugar certo (e não de outro trecho do mesmo tamanho).
// (A "tela" do teste é o padrão falso do Chromium e não leva marcador; a câmera sai do arquivo y4m que o teste escolhe.)
const MARKER_RGB = [[255,0,0],[255,140,0],[255,255,0],[0,255,255],[0,0,255],[140,0,255],[255,0,255]]
const MARKER_W=160, MARKER_H=90, MARKER_FPS=16, MARKER_SECONDS=60
const markerIndex = (block:number):number => (block+Math.floor(block/7))%7
function markerY4m():string {
  const file=join(tmpdir(),'tomada-fakes','marcador-cores.y4m')
  const frame=MARKER_W*MARKER_H*3/2, expected=`YUV4MPEG2 W${MARKER_W} H${MARKER_H} F${MARKER_FPS}:1 Ip A1:1 C420jpeg XYSCSS=420JPEG\n`.length+MARKER_FPS*MARKER_SECONDS*(frame+6)
  if(existsSync(file) && statSync(file).size===expected) return file
  mkdirSync(join(tmpdir(),'tomada-fakes'),{recursive:true})
  const parts:Buffer[]=[Buffer.from(`YUV4MPEG2 W${MARKER_W} H${MARKER_H} F${MARKER_FPS}:1 Ip A1:1 C420jpeg XYSCSS=420JPEG\n`)]
  const yuv=MARKER_RGB.map(([r,g,b]) => [0.299*r!+0.587*g!+0.114*b!,128-0.168736*r!-0.331264*g!+0.5*b!,128+0.5*r!-0.418688*g!-0.081312*b!].map((v) => Math.max(0,Math.min(255,Math.round(v)))))
  for(let n=0;n<MARKER_FPS*MARKER_SECONDS;n++) {
    const [y,u,v]=yuv[markerIndex(Math.floor(n/(MARKER_FPS/2)))]!
    parts.push(Buffer.from('FRAME\n'),Buffer.alloc(MARKER_W*MARKER_H,y),Buffer.alloc(MARKER_W*MARKER_H/4,u),Buffer.alloc(MARKER_W*MARKER_H/4,v))
  }
  writeFileSync(file,Buffer.concat(parts))
  return file
}
/** Cor do marcador que domina o quadro de `file` em `ms` (índice em MARKER_RGB), ou -1 se nenhuma domina com folga. */
function markerAt(file:string,ms:number):number {
  const raw = execFileSync('ffmpeg',['-v','error','-ss',(Math.max(0,ms)/1000).toFixed(3),'-i',file,'-frames:v','1','-vf','scale=160:90','-f','rawvideo','-pix_fmt','rgb24','-'],{maxBuffer:1<<22})
  const count = MARKER_RGB.map(() => 0)
  for (let i=0;i+2<raw.length;i+=3) {
    let best=-1,bestDistance=90*90
    MARKER_RGB.forEach((rgb,k) => { const d=(raw[i]!-rgb[0]!)**2+(raw[i+1]!-rgb[1]!)**2+(raw[i+2]!-rgb[2]!)**2; if(d<bestDistance){ bestDistance=d; best=k } })
    if(best>=0) count[best]!++
  }
  const order = count.map((n,k) => [n,k] as const).sort((a,b) => b[0]-a[0])
  return order[0]![0] >= 120 && order[0]![0] >= 2*order[1]![0] ? order[0]![1] : -1
}
const probe = (file:string) => JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'})) as {streams:{codec_type:string;width?:number;height?:number}[];format:{duration:string}}

test('grava com motor real, marca errei e chega sem clique à Revisão com YouTube e corte prontos; ajusta só um e monta a pasta dos aprovados',async () => {
  test.setTimeout(360000)
  mkdirSync(SCREENS_DIR,{recursive:true})
  const responses=join(ROOT,'test-results','m4d-respostas.json')
  writeFileSync(responses,JSON.stringify([
    {task:'dictionary',match:'',response:{corrections:[]}},
    {task:'clips',match:'',response:{clips:[]}}, {task:'retakes',match:'',response:{retakes:[]}},
    {task:'publish',match:'',response:{titles:['Cadastro pronto para publicar'],description:'Demonstração sintética para conferir a gravação e as saídas.',tags:['cadastro','demonstração'],chapters:[],clips:[]}},
    {task:'edit',match:'',response:{ops:[{op:'title',text:'Título ajustado na revisão'}],reply:'Troquei o título.'}}
  ]))
  s=await launchTomada({seed:false,autopilot:true,env:{TOMADA_TEST_AUTOSOURCE:'screen',TOMADA_TRANSCRIBER:'faster-whisper',TOMADA_TOOLS_DIR:'',TOMADA_LLM:'mock',TOMADA_LLM_RESPONSES:responses},args:[`--use-file-for-fake-video-capture=${markerY4m()}`]})
  const {page,app}=s
  await page.getByTestId('nav-record').click()
  await expect(page.getByTestId('camera-preview')).toHaveAttribute('data-live','true',{timeout:30000})
  await page.getByTestId('record-start').click()
  const bar=await waitForAux(app,'bar',40000)
  await expect(bar.getByTestId('bar')).toHaveAttribute('data-status','recording')
  await page.waitForTimeout(10000)
  await bar.getByTestId('bar-retake').click()
  await page.waitForTimeout(11500)
  const stoppedAt=Date.now()
  await bar.getByTestId('bar-stop').click()
  // Nenhuma ação na janela após parar até as duas saídas estarem prontas.
  await expect(page.getByTestId('review-view')).toHaveAttribute('data-status','done',{timeout:240000})
  const dir=join(s.projects,readdirSync(s.projects)[0]!)
  const doc=readDoc(dir)
  const clip=doc.clips[0]!
  expect(doc.clips.length, `etapas do piloto: ${JSON.stringify(doc.autopilot?.steps)}`).toBeGreaterThanOrEqual(1)
  expect(doc.autopilot?.steps.filter((p) => p.status==='error')).toEqual([])
  expect(doc.review?.items.youtube?.phase).toBe('ready')
  expect(doc.review?.items[clip.id]?.phase).toBe('ready')
  expect(doc.retakeMarks).toHaveLength(1)
  const retake=doc.cuts.find((c) => c.id.startsWith('retake-mark-'))!
  expect(retake.enabled).toBe(true)
  expect(keptRanges(doc.sources.screen!.durationMs,doc.cuts).some((r) => r.start<retake.end && r.end>retake.start)).toBe(false)
  expect(doc.meta?.youtube?.description).toBeTruthy()
  const youtube=probe(join(dir,doc.review!.items.youtube!.exportPath!))
  const vertical=probe(join(dir,doc.review!.items[clip.id]!.exportPath!))
  expect(youtube.streams.find((s) => s.codec_type==='video')).toMatchObject({width:2560,height:1440}) // o padrão do piloto é 1440p (acabamento D)
  expect(vertical.streams.find((s) => s.codec_type==='video')).toMatchObject({width:1080,height:1920})
  expect(vertical.streams.some((s) => s.codec_type==='audio')).toBe(true)
  // O trecho do "errei" saiu do vídeo exportado: duração e marcador audiovisual (a cor de cada instante).
  const recordedMs=projectDurationMs(doc)
  const youtubeCuts=reviewDocument(doc,'youtube').cuts
  const expectedMs=outputDuration(recordedMs,youtubeCuts)
  const exportedMs=Number(youtube.format.duration)*1000
  expect(Math.abs(exportedMs-expectedMs)).toBeLessThan(250)
  expect(recordedMs-exportedMs).toBeGreaterThan((retake.end-retake.start)-250)
  const verticalCuts=reviewDocument(doc,clip.id).cuts
  expect(Math.abs(Number(vertical.format.duration)*1000-outputDuration(recordedMs,verticalCuts))).toBeLessThan(250)
  const cameraFile=join(dir,doc.sources.camera!.path), youtubeFile=join(dir,doc.review!.items.youtube!.exportPath!)
  const cameraDelay=cameraVideoOffsetMs(doc) // o motor busca o quadro da câmera em (tempo de origem − isto)
  const kept=keptRanges(recordedMs,youtubeCuts)
  const sourceAt=(out:number):number => { let before=0; for(const r of kept) { if(out<before+(r.end-r.start)) return r.start+(out-before)-cameraDelay; before+=r.end-r.start } return kept[kept.length-1]!.end-cameraDelay }
  let compared=0, discriminating=0
  const mismatches:string[]=[], trace:string[]=[]
  for(const [name,file,at] of [['gravacao',cameraFile,3000],['youtube',youtubeFile,3000]] as const) execFileSync('ffmpeg',['-v','error','-y','-ss',String(at/1000),'-i',file,'-frames:v','1',join(SCREENS_DIR,`m4d-marcador-${name}.png`)])
  // passo de 210 ms (era 420): a limpeza nova corta menos (pausas só a partir de 0,6 s, no máximo 6 emendas por minuto), e com menos
  // cortes há menos pontos em que um exportador que ignorasse o "errei" mostraria outra cor; mais pontos mantêm o teste capaz de ver a diferença
  for(let out=800;out<expectedMs-1200;out+=210) {
    const exported=[-60,0,60].map((d) => markerAt(youtubeFile,out+d))
    const source=[-60,0,60].map((d) => markerAt(cameraFile,sourceAt(out+d)))
    trace.push(`${out}: exportado ${exported.join(',')} | gravação ${source.join(',')}`)
    // Só compara onde as duas pontas estão estáveis (longe da troca de cor de 500 ms) e a câmera aparece no quadro.
    if(exported.some((c) => c<0 || c!==exported[0]) || source.some((c) => c<0 || c!==source[0])) continue
    compared++
    if(exported[0]!==source[0]) mismatches.push(`${out} ms: exportado ${exported[0]}, gravação no ponto certo ${source[0]}`)
    // Um exportador que ignorasse os cortes mostraria aqui a cor do instante sem corte; o teste tem de poder enxergar a diferença.
    if(markerAt(cameraFile,out-cameraDelay)!==source[0]) discriminating++
  }
  expect(mismatches,trace.join('\n')).toEqual([])
  expect(compared,trace.join('\n')).toBeGreaterThanOrEqual(8)
  expect(discriminating,trace.join('\n')).toBeGreaterThanOrEqual(3)
  const resultDir=join(ROOT,'test-results','m4d-gravacao')
  mkdirSync(resultDir,{recursive:true})
  // Só dados sintéticos desta gravação: a prova local dos motores não depende da cópia original do usuário.
  copyFileSync(join(dir,'media','camera.mp4'),join(resultDir,'camera.mp4'))
  copyFileSync(join(dir,doc.review!.items.youtube!.exportPath!),join(resultDir,'youtube.mp4'))
  copyFileSync(join(dir,doc.review!.items[clip.id]!.exportPath!),join(resultDir,'vertical.mp4'))
  const transcript=parseTranscript(readFileSync(join(dir,'transcript.json'),'utf8'))
  expect(transcript.engine).toBe('faster-whisper')
  expect(transcript.words.length).toBeGreaterThan(8)
  writeFileSync(join(ROOT,'test-results','m4d-medicao.json'),JSON.stringify({recordedMs:doc.sources.screen?.durationMs,pipelineMs:doc.autopilot?.elapsedMs,wallAfterStopMs:Date.now()-stoppedAt,engine:transcript.engine,words:transcript.words.length,clips:doc.clips.length,retakeMs:retake.end-retake.start,steps:doc.autopilot?.steps},null,2))
  await expect(page.getByTestId('review-youtube-player')).toBeVisible()
  await page.getByTestId('review-youtube-player').evaluate((v) => { (v as HTMLVideoElement).currentTime=.5 })
  await page.getByTestId(`review-${clip.id}-player`).evaluate((v) => { (v as HTMLVideoElement).currentTime=.5 })
  await page.waitForTimeout(500)
  await shot(page,'m4d-revisao')
  await page.getByTestId('review-youtube-approve').click()
  await page.getByTestId(`review-${clip.id}-discard`).click()
  await expect(page.getByTestId(`review-item-${clip.id}`)).toHaveAttribute('data-decision','discarded')
  const clipPath=readDoc(dir).review!.items[clip.id]!.exportPath
  const youtubePath=readDoc(dir).review!.items.youtube!.exportPath
  await page.getByTestId('review-youtube-instruction').fill('troca o título')
  await page.getByTestId('review-youtube-ask').click()
  await page.getByTestId('review-youtube-apply').click()
  await expect.poll(() => readDoc(dir).review?.items.youtube?.exportPath,{timeout:120000}).not.toBe(youtubePath)
  expect(readDoc(dir).review?.items[clip.id]?.exportPath).toBe(clipPath)
  expect(readDoc(dir).review?.items.youtube?.decision).toBe('approved')
  await expect(page.getByTestId('review-youtube-text')).toHaveValue(/Título ajustado na revisão/)
  await page.getByTestId('review-post').click()
  await expect.poll(() => existsSync(join(dir,'exports','postar','YouTube.txt'))).toBe(true)
  const files=readdirSync(join(dir,'exports','postar'))
  expect(files.filter((p) => p.endsWith('.mp4'))).toHaveLength(1)
  expect(files).not.toContain('TikTok.txt')
  await expect.poll(() => page.getByTestId('review-youtube-player').evaluate((v) => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
  await page.getByTestId('review-youtube-player').evaluate((v) => { (v as HTMLVideoElement).currentTime=.5 })
  await page.waitForTimeout(500)
  await shot(page,'m4d-revisao-ajustada')
})

test('retoma etapas pendentes ao reabrir sem apagar os ajustes manuais nem exportar em Só preparar',async () => {
  test.setTimeout(120000)
  s=await launchTomada({autopilot:true})
  const dir=join(s.projects,EXAMPLE_FOLDER)
  const doc=readDoc(dir)
  doc.autopilot=newPipeline(EXAMPLE_FOLDER)
  doc.autopilot.steps[0]!.status='done'
  doc.layouts=[{id:'meu-layout',start:0,end:20000,layout:'screen',origin:'manual'}]
  doc.zoomPreset='off'
  writeFileSync(join(dir,'project.json'),JSON.stringify(doc))
  writeFileSync(join(s.userData,'settings.json'),JSON.stringify({autopilot:{mode:'prepare',captionsHorizontal:false,captionsVertical:false}}))
  const base=s.base
  await s.close({keep:true})
  s=await launchTomada({base,autopilot:true})
  await expect(s.page.getByTestId('review-view')).toHaveAttribute('data-status','done',{timeout:90000})
  const next=readDoc(dir)
  expect(next.layouts.find((s) => s.id==='meu-layout')).toMatchObject({layout:'screen',origin:'manual'})
  expect(next.zooms).toEqual([])
  expect(next.autopilot?.steps.find((s) => s.id==='youtube')?.status).toBe('skipped')
  expect(next.vertical?.captions?.enabled).toBe(false)
  expect(next.review?.items.youtube?.exportPath).toBeUndefined()
})
