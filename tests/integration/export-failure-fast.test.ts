import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createExportService, type ExportService } from '../../src/main/export-service'
import type { Ffmpeg } from '../../src/main/ffmpeg'
import { createMemoryLogger } from '../../src/main/logger'
import { createOutputDirs } from '../../src/main/path-guard'
import { createProject } from '../../src/shared/project'
import { useTmpDir } from '../helpers/env'

const tmp = useTmpDir()

it('falha do codec interrompe o áudio em andamento e mostra o motivo sem esperar uma gravação longa', async () => {
  const dir = tmp()
  await mkdir(join(dir,'media'))
  await writeFile(join(dir,'media','screen.mp4'),'fixture sintético; a janela reporta falha antes de renderizar')
  const project = createProject({title:'Falha sintética',sources:{screen:{path:'media/screen.mp4',w:640,h:360,fps:30,durationMs:3_600_000}}})
  let audioAborted = false
  const ff = {run: (_args: string[], options: {signal:AbortSignal}) => new Promise((_resolve,reject) => {
    const abort = () => { audioAborted = true; reject(new Error('Áudio interrompido')) }
    if (options.signal.aborted) abort()
    else options.signal.addEventListener('abort',abort,{once:true})
  })} as unknown as Ffmpeg
  let service!: ExportService
  service = createExportService({logger:createMemoryLogger(),read:async () => ({dir,project}),ffmpeg:() => ff,outputDirs:createOutputDirs(),now:() => performance.now(),emit:() => undefined,
    openExporterWindow: id => {setTimeout(() => service.finish(id,{ok:false,message:'Encoding error sintético'}),20);return {destroy:() => undefined}}
  })
  try {
    await service.start({projectId:'p',resolution:'1080p',fps:30})
    const completed = await Promise.race([service.idle().then(() => true),new Promise<boolean>(resolve => setTimeout(() => resolve(false),500))])
    expect(completed,'A falha do vídeo precisa interromper o áudio pendente').toBe(true)
    expect(audioAborted).toBe(true)
    expect(service.status()).toMatchObject({phase:'error',message:'Encoding error sintético'})
  } finally {await service.shutdown()}
})
