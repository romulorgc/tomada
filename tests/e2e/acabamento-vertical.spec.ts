import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import { createProject, serializeProject } from '../../src/shared/project'
import { VERTICAL_1080, deriveProject, evaluateScene, prepareEvents } from '../../src/shared/scene'
import type { LayoutKind, Project } from '../../src/shared/types'
import { launchTomada, ROOT, type Session } from './helpers'
import { openLab, renderStills, writeMatte } from './lab'
import { exportProject } from './export-helpers'

const OUT=join(ROOT,'test-results','acabamento')
const FOLDER='2026-10-06 1100 Página sintética larga'
let s: Session|undefined
test.afterEach(async()=>{if(s){await s.close();s=undefined}})

function sheet(paths: string[], target:string) {
  const imgs=paths.map(p=>PNG.sync.read(readFileSync(p)))
  const w=360,h=640,label=32
  const out=new PNG({width:w*imgs.length,height:h+label})
  out.data.fill(25)
  imgs.forEach((src,n)=>{
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const from=(Math.floor(y*src.height/h)*src.width+Math.floor(x*src.width/w))*4
      const to=((y+label)*out.width+n*w+x)*4
      out.data.set(src.data.subarray(from,from+4),to)
    }
  })
  writeFileSync(target,PNG.sync.write(out))
}

test('página larga: folha ANTES × DEPOIS, quadrado central, V-B/V-D e limites C1',async()=>{
  test.setTimeout(180000)
  mkdirSync(OUT,{recursive:true})
  s=await launchTomada({seed:false})
  const dir=join(s.projects,FOLDER)
  mkdirSync(join(dir,'media'),{recursive:true});mkdirSync(join(dir,'events'),{recursive:true})
  const png=await s.page.evaluate(()=>{
    const c=document.createElement('canvas');c.width=1920;c.height=1200
    const ctx=c.getContext('2d')!
    ctx.fillStyle='#f4f7fa';ctx.fillRect(0,0,1920,1200)
    ctx.fillStyle='#ef007e';ctx.fillRect(0,0,1920,120) // barra do navegador: nunca pode aparecer
    ctx.fillStyle='#123653';ctx.fillRect(0,120,1920,74)
    ctx.font='bold 34px Arial';ctx.fillStyle='#fff';ctx.fillText('Página sintética • Produtos • Como funciona',440,169)
    ctx.textAlign='center';ctx.fillStyle='#123653';ctx.font='bold 54px Arial'
    ctx.fillText('O registro é com a gente.',960,390)
    ctx.fillText('Um título largo, inteiro e legível.',960,490)
    ctx.font='32px Arial';ctx.fillStyle='#324f65'
    ctx.fillText('Você fala. O sistema prepara. Você revisa.',960,580)
    ctx.fillStyle='#168b82';ctx.fillRect(570,690,780,190)
    ctx.fillStyle='#fff';ctx.font='bold 42px Arial';ctx.fillText('Uma página, sem dados reais',960,800)
    return c.toDataURL().split(',')[1]!
  })
  const input=join(dir,'media','pagina.png');writeFileSync(input,Buffer.from(png,'base64'))
  execFileSync('ffmpeg',['-v','error','-y','-loop','1','-i',input,'-t','6','-r','30','-an','-c:v','libx264','-preset','ultrafast','-crf','12','-pix_fmt','yuv420p',join(dir,'media','screen.mp4')],{windowsHide:true})
  execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=0x303030:s=640x360:r=30:d=6','-an','-c:v','libx264','-preset','ultrafast',join(dir,'media','camera.mp4')],{windowsHide:true})
  const p=createProject({title:'Página sintética',sources:{screen:{path:'media/screen.mp4',w:1920,h:1200,fps:30,durationMs:6000},camera:{path:'media/camera.mp4',w:640,h:360,fps:30,durationMs:6000}}})
  p.screenCrop={mode:'manual',manual:{x:0,y:0.1,w:1,h:0.9}}
  p.zoomPreset='off';p.style.cursor.ripple=false;p.style.camera.borderWidth=0
  const cursor=[{t:0,x:0.5,y:0.55},{t:2200,x:0.5,y:0.55},{t:4200,x:0.6,y:0.55},{t:6000,x:0.65,y:0.55}]
  writeFileSync(join(dir,'events','cursor.jsonl'),cursor.map(c=>JSON.stringify(c)).join('\n'))
  for(const f of ['clicks','keys'])writeFileSync(join(dir,'events',f+'.jsonl'),'')
  writeFileSync(join(dir,'project.json'),serializeProject(p))
  const matteUrl=writeMatte(s,{durationS:6},FOLDER),lab=await openLab(s.app)
  const times=[1000,3000,5000]
  const capture=async(layout:LayoutKind,prefix:string,hasCamera=true)=>{
    const cp:Project=structuredClone(p)
    if(!hasCamera)delete cp.sources.camera
    cp.vertical={layout,layouts:[],zooms:[{id:'clique',start:2400,end:4300,scale:1.6,focus:'auto',origin:'auto'}],zoomPreset:'off',hook:'Sua página inteira no vídeo'}
    const frames=await renderStills(lab,{project:cp,folder:FOLDER,format:VERTICAL_1080,times,matteUrl,words:[{i:0,text:'Página',start:0,end:6000,prob:1,kind:'word'}]})
    const files=frames.map((f,i)=>{const path=join(OUT,`${prefix}-${i}.png`);writeFileSync(path,f);return path})
    sheet(files,join(OUT,`folha-${prefix}.png`))
    for(const frame of frames){
      const rgb=PNG.sync.read(frame).data
      let browser=0
      for(let i=0;i<rgb.length;i+=4)if(rgb[i]!>180&&rgb[i+1]!<25&&rgb[i+2]!>85)browser++
      expect(browser,'nenhum pixel da barra do navegador C1').toBe(0)
    }
    return files
  }
  // O primeiro RED registra a implementação antiga. Rodadas seguintes preservam essa evidência.
  if(!existsSync(join(OUT,'folha-antes.png'))){
    await capture('screen-focus','antes')
    await capture('stack','vb-antes');await capture('presenter','vd-antes')
  }
  const center='screen-center' as LayoutKind
  const cp={...p,style:{...p.style,defaultLayout:center}}
  const scene=evaluateScene(cp,deriveProject(cp,prepareEvents({cursor,clicks:[],keys:[]},6000),VERTICAL_1080),1000,VERTICAL_1080)
  expect(scene.screen!.src.w*1920).toBeCloseTo(scene.screen!.src.h*1200,3)
  const after=await capture(center,'depois')
  const before=times.map((_,i)=>join(OUT,`antes-${i}.png`))
  sheet([...before,...after],join(OUT,'folha-antes-depois.png'))
  // V-A permanece idêntico para escolha manual: também serve de controle sem câmera.
  if(!existsSync(join(OUT,'folha-sem-camera-antes.png')))await capture('screen-focus','sem-camera-antes',false)
  const screenOnlyAfter=await capture(center,'sem-camera-depois',false)
  sheet([...times.map((_,i)=>join(OUT,`sem-camera-antes-${i}.png`)),...screenOnlyAfter],join(OUT,'folha-sem-camera-antes-depois.png'))
  await capture('stack','vb-depois');await capture('presenter','vd-depois')
  const output:Project=structuredClone(p)
  delete output.sources.camera
  output.vertical={layout:center,layouts:[],zooms:[],zoomPreset:'off',captions:{enabled:false}}
  output.clips=[{id:'sintetico',title:'Página sintética larga',hook:'Sua página inteira no vídeo',ranges:[{start:0,end:6000}],score:80,reason:'Conferência sintética',format:'vertical',layoutV:'screen-center',source:'manual'}]
  await s.page.evaluate(({id,project})=>window.tomada.projects.save(id,project),{id:FOLDER,project:output})
  const exported=await exportProject(s.page,FOLDER,{format:'vertical',resolution:'1080p',fps:30,clipId:'sintetico'})
  expect(exported.phase,exported.message).toBe('done')
  const video=join(OUT,'corte-vertical-sintetico.mp4');copyFileSync(exported.outputPath!,video)
  const videoFrames=times.map((t,i)=>{
    const path=join(OUT,`corte-exportado-${i}.png`)
    execFileSync('ffmpeg',['-v','error','-y','-ss',String(t/1000),'-i',video,'-frames:v','1',path],{windowsHide:true})
    return path
  })
  sheet(videoFrames,join(OUT,'folha-corte-exportado.png'))
})
