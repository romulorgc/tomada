import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { parseProject } from '../../src/shared/project'
import { keptRanges } from '../../src/shared/timeline'
import { newPipeline } from '../../src/shared/autopilot'
import { parseTranscript } from '../../src/shared/transcript'
import { EXAMPLE_FOLDER, launchTomada, ROOT, SCREENS_DIR, shot, waitForAux, type Session } from './helpers'

let s:Session|undefined
test.afterEach(async () => { if(s) { const problems=s.problems; await s.close(); s=undefined; expect(problems).toEqual([]) } })
const readDoc = (folder:string) => parseProject(readFileSync(join(folder,'project.json'),'utf8'))
const probe = (file:string) => JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'})) as {streams:{codec_type:string;width?:number;height?:number}[];format:{duration:string}}

test('grava com motor real, marca errei e chega sem clique à Revisão com YouTube e corte prontos; ajusta só um e monta a pasta dos aprovados',async () => {
  test.setTimeout(360000)
  mkdirSync(SCREENS_DIR,{recursive:true})
  const responses=join(ROOT,'test-results','m4d-respostas.json')
  writeFileSync(responses,JSON.stringify([
    {task:'clips',match:'',response:{clips:[]}}, {task:'retakes',match:'',response:{retakes:[]}},
    {task:'publish',match:'',response:{titles:['Cadastro pronto para publicar'],description:'Demonstração sintética para conferir a gravação e as saídas.',tags:['cadastro','demonstração'],chapters:[],clips:[]}},
    {task:'edit',match:'',response:{ops:[{op:'title',text:'Título ajustado na revisão'}],reply:'Troquei o título.'}}
  ]))
  s=await launchTomada({seed:false,autopilot:true,env:{TOMADA_TEST_AUTOSOURCE:'screen',TOMADA_TRANSCRIBER:'faster-whisper',TOMADA_TOOLS_DIR:'',TOMADA_LLM:'mock',TOMADA_LLM_RESPONSES:responses}})
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
  expect(doc.clips.length).toBeGreaterThanOrEqual(1)
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
  expect(youtube.streams.find((s) => s.codec_type==='video')).toMatchObject({width:1920,height:1080})
  expect(vertical.streams.find((s) => s.codec_type==='video')).toMatchObject({width:1080,height:1920})
  expect(vertical.streams.some((s) => s.codec_type==='audio')).toBe(true)
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
