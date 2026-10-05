/**
 * O serviço da análise da câmera (M4c) com o motor de TESTE: a preparação (progresso, falha num passo e "tentar de novo"), a fila de
 * uma análise por vez, o resultado guardado em `media/camera-face.json` dentro do projeto e o CACHE (só refaz se a câmera mudou ou se
 * foi pedido). O motor de verdade (OpenCV) tem o teste dele em `camera-motor.test.ts`.
 */
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CameraJob } from '@shared/camera-analysis'
import { FACE_FILE, parseFaceTrack } from '@shared/face'
import type { IpcEvents } from '@shared/ipc'
import { parseProject, serializeProject } from '@shared/project'
import type { PrepareSnapshot } from '@shared/transcription'
import type { Project } from '@shared/types'
import { createMockCamera, type MockCameraOptions } from '../../src/main/camera/mock-engine'
import { createCameraService } from '../../src/main/camera/service'
import type { CameraEngine } from '../../src/main/camera/types'
import { createMemoryLogger } from '../../src/main/logger'
import { copyTree, FIX, useTmpDir } from '../helpers/env'

const tmp = useTmpDir()

type Events = { prepare: PrepareSnapshot[]; jobs: CameraJob[] }

function build(opts: { engine?: CameraEngine; mock?: Partial<MockCameraOptions>; mutate?: (p: Project) => void } = {}) {
  const base = tmp()
  const dirs: Record<string, string> = { p1: join(base, 'p1'), p2: join(base, 'p2') }
  for (const d of Object.values(dirs)) copyTree(FIX.exemplo, d)
  const events: Events = { prepare: [], jobs: [] }
  const log = createMemoryLogger()
  const read = async (id: string): Promise<{ project: Project; dir: string }> => {
    const dir = dirs[id]
    if (!dir) throw new Error(`Projeto não encontrado: ${id}`)
    const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
    opts.mutate?.(project)
    return { project, dir }
  }
  const engine = opts.engine ?? createMockCamera({ ready: true, ...opts.mock })
  const calls = { detect: 0 }
  const counted: CameraEngine = {
    ...engine,
    check: () => engine.check(),
    prepare: (t, s) => engine.prepare(t, s),
    detectFaces: (o) => {
      calls.detect++
      return engine.detectFaces(o)
    }
  }
  const service = createCameraService({
    logger: log,
    engine: counted,
    read,
    emit: <K extends 'camera:prepare' | 'camera:job'>(channel: K, payload: IpcEvents[K]) => {
      if (channel === 'camera:prepare') events.prepare.push(payload as PrepareSnapshot)
      else events.jobs.push(payload as CameraJob)
    }
  })
  return { service, events, dirs, log, calls }
}

describe('serviço da câmera: preparação', () => {
  it('motor sem preparar: o estado diz o que falta e analisar é recusado com o motivo', async () => {
    const { service } = build({ mock: { ready: false } })
    const view = await service.view()
    expect(view).toMatchObject({ engine: 'mock', prepare: null, jobs: [] })
    expect(view.face).toMatchObject({ state: 'missing' })
    expect(view.face.detail).toMatch(/preparada/)
    await expect(service.analyze('p1', 'face')).rejects.toThrow(/preparada/)
  })

  it('prepara com progresso real (passos, fração crescente), termina "pronta" e aí analisa', async () => {
    const { service, events } = build({ mock: { ready: false, stepMs: 20 } })
    await service.prepare()
    await service.idle()
    const fractions = events.prepare.map((s) => s.fraction)
    expect(fractions.length).toBeGreaterThan(4)
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions)
    expect(events.prepare.at(-1)).toMatchObject({ status: 'done', fraction: 1, engine: 'camera' })
    expect((await service.view()).face.state).toBe('ready')
    await expect(service.analyze('p1', 'face')).resolves.toMatchObject({ projectId: 'p1', kind: 'face' })
    await service.idle()
  })

  it('falha num passo: o erro aparece com o passo, o estado vira "error" e "tentar de novo" termina', async () => {
    const { service, events } = build({ mock: { ready: false, stepMs: 20, failStep: 'model' } })
    await service.prepare()
    await service.idle()
    expect(events.prepare.at(-1)).toMatchObject({ status: 'error', error: { step: 'model' } })
    const view = await service.view()
    expect(view.face.state).toBe('error')
    expect(view.face.detail).toMatch(/model/)
    await service.prepare()
    await service.idle()
    expect(events.prepare.at(-1)).toMatchObject({ status: 'done' })
    expect((await service.view()).face.state).toBe('ready')
  })

  it('cancelar a preparação deixa o estado "cancelada" e nada fica pela metade', async () => {
    const { service, events } = build({ mock: { ready: false, stepMs: 400 } })
    await service.prepare()
    service.cancelPrepare()
    await service.idle()
    expect(events.prepare.at(-1)?.status).toBe('cancelled')
    expect((await service.view()).face.state).toBe('missing')
  })
})

describe('serviço da câmera: o rosto de um projeto', () => {
  it('analisa, grava media/camera-face.json DENTRO do projeto e avisa com a URL e o resumo', async () => {
    const { service, events, dirs } = build({ mock: { from: 0.3, to: 0.7 } })
    const job = await service.analyze('p1', 'face')
    expect(['queued', 'running']).toContain(job.state)
    await service.idle()
    const done = events.jobs.at(-1)!
    expect(done).toMatchObject({ projectId: 'p1', kind: 'face', state: 'done', fraction: 1 })
    expect(done.url).toMatch(/^tomada-media:\/\/project\/p1\/media\/camera-face\.json\?v=\d+$/)
    expect(done.faces).toBeGreaterThan(50)
    expect(done.coverage).toBeGreaterThan(0.95)
    const file = join(dirs.p1!, FACE_FILE)
    expect(existsSync(file)).toBe(true)
    const track = parseFaceTrack(readFileSync(file, 'utf8'))
    expect(track.boxes.length).toBe(done.faces)
    expect(track.boxes[0]!.x + track.boxes[0]!.w / 2).toBeCloseTo(0.3, 2)
    expect(track.boxes.at(-1)!.x + track.boxes.at(-1)!.w / 2).toBeCloseTo(0.7, 1)
    // as outras pastas não foram tocadas
    expect(existsSync(join(dirs.p2!, FACE_FILE))).toBe(false)
    // a marca da câmera de onde saiu (para o cache) está no arquivo
    const head = JSON.parse(readFileSync(file, 'utf8')) as { source?: string; sourceMtimeMs?: number }
    expect(head.source).toBe('media/camera.mp4')
    expect(head.sourceMtimeMs).toBeGreaterThan(0)
  })

  it('progresso real da análise (sobe sem andar para trás) e o resultado chega por `result`', async () => {
    const { service, events } = build({ mock: { delayMs: 100 } })
    expect(await service.result('p1', 'face')).toBeNull()
    await service.analyze('p1', 'face')
    await service.idle()
    const fr = events.jobs.filter((j) => j.projectId === 'p1').map((j) => j.fraction)
    expect(fr.length).toBeGreaterThan(3)
    expect([...fr].sort((a, b) => a - b)).toEqual(fr)
    expect(await service.result('p1', 'face')).toMatch(/camera-face\.json\?v=\d+$/)
  })

  it('CACHE: pedir de novo com o resultado válido volta na hora, sem rodar o motor; `force` e câmera nova refazem', async () => {
    const { service, events, dirs, calls } = build()
    await service.analyze('p1', 'face')
    await service.idle()
    expect(calls.detect).toBe(1)

    const again = await service.analyze('p1', 'face')
    expect(again.state).toBe('done')
    expect(again.url).toBeDefined()
    await service.idle()
    expect(calls.detect).toBe(1) // não rodou o motor

    await service.analyze('p1', 'face', { force: true })
    await service.idle()
    expect(calls.detect).toBe(2)

    // a câmera mudou (a data do arquivo): o resultado guardado já não vale e a análise refaz
    const cam = join(dirs.p1!, 'media', 'camera.mp4')
    const later = new Date(Date.now() + 60_000)
    utimesSync(cam, later, later)
    expect(await service.result('p1', 'face')).toBeNull()
    await service.analyze('p1', 'face')
    await service.idle()
    expect(calls.detect).toBe(3)
    expect(events.jobs.at(-1)?.state).toBe('done')
    expect(await service.result('p1', 'face')).not.toBeNull()
  })

  it('uma análise por vez: a segunda espera na fila e a mesma pedida duas vezes roda uma vez só', async () => {
    const { service, events, calls } = build({ mock: { delayMs: 150 } })
    const a = await service.analyze('p1', 'face')
    const b = await service.analyze('p2', 'face')
    const dup = await service.analyze('p1', 'face')
    expect(dup.projectId).toBe('p1')
    expect(b.state).toBe('queued')
    expect(['queued', 'running']).toContain(a.state)
    await service.idle()
    expect(calls.detect).toBe(2)
    const order = events.jobs.filter((j) => j.state === 'done').map((j) => j.projectId)
    expect(order).toEqual(['p1', 'p2'])
    // nunca duas rodando ao mesmo tempo
    let running = 0
    let maxRunning = 0
    const state = new Map<string, string>()
    for (const j of events.jobs) {
      state.set(j.projectId, j.state)
      running = [...state.values()].filter((s) => s === 'running').length
      maxRunning = Math.max(maxRunning, running)
    }
    expect(maxRunning).toBe(1)
  })

  it('cancelar: o que está na fila sai dela e o que roda para; o resultado antigo continua', async () => {
    const { service, events, dirs, calls } = build({ mock: { delayMs: 400 } })
    await service.analyze('p1', 'face')
    await service.analyze('p2', 'face')
    service.cancel('p2', 'face') // ainda na fila
    expect(events.jobs.at(-1)).toMatchObject({ projectId: 'p2', state: 'cancelled' })
    await new Promise((r) => setTimeout(r, 50))
    service.cancel('p1', 'face') // rodando
    await service.idle()
    expect(events.jobs.filter((j) => j.projectId === 'p1').at(-1)).toMatchObject({ state: 'cancelled', error: 'Análise cancelada.' })
    expect(calls.detect).toBe(1)
    expect(existsSync(join(dirs.p1!, FACE_FILE))).toBe(false) // cancelada: nada gravado
  })

  it('projeto sem câmera: recusa com o motivo e não grava nada', async () => {
    const { service, dirs } = build({
      mutate: (p) => {
        delete p.sources.camera
      }
    })
    await expect(service.analyze('p1', 'face')).rejects.toThrow(/não tem o vídeo da câmera/)
    expect(existsSync(join(dirs.p1!, FACE_FILE))).toBe(false)
  })

  it('o motor falha: o trabalho termina em "error" com o motivo e o log guarda o detalhe; dá para tentar de novo', async () => {
    let fail = true
    const base = createMockCamera({ ready: true })
    const engine: CameraEngine = {
      ...base,
      detectFaces: async (o) => {
        if (fail) throw new Error('O OpenCV não abriu o vídeo.')
        return base.detectFaces(o)
      }
    }
    const { service, events, log } = build({ engine })
    await service.analyze('p1', 'face')
    await service.idle()
    expect(events.jobs.at(-1)).toMatchObject({ state: 'error', error: 'O OpenCV não abriu o vídeo.' })
    expect(log.entries.some((e) => e.level === 'error' && /Análise da câmera \(face\) do projeto p1 falhou/.test(e.message) && /OpenCV/.test(e.detail ?? ''))).toBe(true)
    fail = false
    await service.analyze('p1', 'face')
    await service.idle()
    expect(events.jobs.at(-1)?.state).toBe('done')
  })

  it('gravação sem rosto: o arquivo é gravado vazio (não refaz a cada abertura) e o resumo diz 0', async () => {
    const { service, events, calls } = build({ mock: { noFace: true } })
    await service.analyze('p1', 'face')
    await service.idle()
    expect(events.jobs.at(-1)).toMatchObject({ state: 'done', faces: 0, coverage: 0 })
    await service.analyze('p1', 'face')
    await service.idle()
    expect(calls.detect).toBe(1)
  })

  it('o arquivo da análise corrompido não vale (refaz) e tipo de análise desconhecido é recusado', async () => {
    const { service, dirs, calls } = build()
    await service.analyze('p1', 'face')
    await service.idle()
    writeFileSync(join(dirs.p1!, FACE_FILE), '{ nao e json')
    expect(await service.result('p1', 'face')).toBeNull()
    await service.analyze('p1', 'face')
    await service.idle()
    expect(calls.detect).toBe(2)
    await expect(service.analyze('p1', 'xyz' as never)).rejects.toThrow(/desconhecido/)
  })

  it('o projeto de um terceiro com a câmera apontando para fora da pasta é recusado (nunca analisa fora)', async () => {
    const { service, dirs } = build()
    const file = join(dirs.p1!, 'project.json')
    const p = parseProject(readFileSync(file, 'utf8'))
    p.sources.camera!.path = '../p2/media/camera.mp4'
    writeFileSync(file, serializeProject(p))
    await expect(service.analyze('p1', 'face')).rejects.toThrow(/fora da pasta/)
  })
})
