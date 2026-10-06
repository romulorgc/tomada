/**
 * O RECORTE DO FUNDO da câmera (M4c, `kind: 'matte'`) no serviço, com o motor de TESTE que grava a máscara com o ffmpeg de verdade (a
 * silhueta conhecida de uma pessoa): o vídeo da máscara dentro do projeto (mesmo tamanho proporcional, mesmos quadros da câmera), o
 * cache pela câmera de onde saiu, cancelar sem deixar arquivo pela metade, a falha com "tentar de novo". O motor de verdade (RVM na
 * placa) tem o teste dele em `camera-motor.test.ts`.
 */
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CameraJob } from '@shared/camera-analysis'
import type { IpcEvents } from '@shared/ipc'
import { MATTE_FILE, MATTE_META_FILE, MATTE_PARTIAL_FILE, MATTE_VERSION, matteIsFresh, parseMatteMeta } from '@shared/matte'
import { parseProject, serializeProject } from '@shared/project'
import { createMockCamera, MOCK_SILHOUETTE, type MockCameraOptions } from '../../src/main/camera/mock-engine'
import { createCameraService } from '../../src/main/camera/service'
import type { CameraEngine } from '../../src/main/camera/types'
import { locateFfmpeg } from '../../src/main/ffmpeg'
import { createMemoryLogger } from '../../src/main/logger'
import { copyTree, FIX, useTmpDir } from '../helpers/env'
import { lumaSeries, probeJson } from '../helpers/media'
import type { Project } from '@shared/types'

const tmp = useTmpDir()
const ffmpegPath = (): string | null => locateFfmpeg()?.ffmpeg ?? null

function build(opts: { mock?: Partial<MockCameraOptions>; mutate?: (p: Project) => void; engine?: CameraEngine } = {}) {
  const base = tmp()
  const dirs: Record<string, string> = { p1: join(base, 'p1'), p2: join(base, 'p2') }
  for (const d of Object.values(dirs)) copyTree(FIX.exemplo, d)
  const jobs: CameraJob[] = []
  const log = createMemoryLogger()
  const read = async (id: string): Promise<{ project: Project; dir: string }> => {
    const dir = dirs[id]
    if (!dir) throw new Error(`Projeto não encontrado: ${id}`)
    const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
    opts.mutate?.(project)
    return { project, dir }
  }
  const engine = opts.engine ?? createMockCamera({ ready: true, ffmpeg: ffmpegPath, ...opts.mock })
  const calls = { matte: 0 }
  const counted: CameraEngine = {
    ...engine,
    check: () => engine.check(),
    prepare: (t, s) => engine.prepare(t, s),
    detectFaces: (o) => engine.detectFaces(o),
    makeMatte: (o) => {
      calls.matte++
      return engine.makeMatte(o)
    }
  }
  const service = createCameraService({
    logger: log,
    engine: counted,
    read,
    emit: <K extends 'camera:prepare' | 'camera:job'>(channel: K, payload: IpcEvents[K]) => {
      if (channel === 'camera:job') jobs.push(payload as CameraJob)
    }
  })
  return { service, jobs, dirs, log, calls }
}

describe('recorte do fundo: o vídeo da máscara dentro do projeto', () => {
  it('grava media/camera-matte.mp4 (cinza, mesmos quadros da câmera) e o camera-matte.json, e avisa com a URL', async () => {
    const { service, jobs, dirs } = build()
    const job = await service.analyze('p1', 'matte')
    expect(['queued', 'running']).toContain(job.state)
    await service.idle()
    const done = jobs.at(-1)!
    expect(done).toMatchObject({ projectId: 'p1', kind: 'matte', state: 'done', fraction: 1 })
    expect(done.url).toMatch(/^tomada-media:\/\/project\/p1\/media\/camera-matte\.mp4\?v=\d+$/)

    const file = join(dirs.p1!, MATTE_FILE)
    const cam = probeJson(join(dirs.p1!, 'media', 'camera.mp4')).streams.find((s) => s.codec_type === 'video')!
    const m = probeJson(file).streams.find((s) => s.codec_type === 'video')!
    expect(m.codec_name).toBe('h264')
    expect(m.pix_fmt).toBe('yuv420p')
    // mesma taxa e mesmo número de quadros da câmera (um quadro de máscara para cada quadro de câmera)
    expect(m.r_frame_rate).toBe(cam.r_frame_rate)
    expect(Math.abs(Number(m.nb_frames) - Number(cam.nb_frames))).toBeLessThanOrEqual(1)
    // a mesma proporção da câmera (16:9)
    expect(m.width! / m.height!).toBeCloseTo(cam.width! / cam.height!, 2)

    const meta = parseMatteMeta(readFileSync(join(dirs.p1!, MATTE_META_FILE), 'utf8'))
    expect(meta).toMatchObject({ version: MATTE_VERSION, source: 'media/camera.mp4', engine: 'teste' })
    expect(meta.frames).toBeGreaterThan(100)
    // as outras pastas não foram tocadas e não sobrou arquivo parcial
    expect(existsSync(join(dirs.p2!, MATTE_FILE))).toBe(false)
    expect(existsSync(join(dirs.p1!, MATTE_PARTIAL_FILE))).toBe(false)
  })

  it('a máscara é a silhueta conhecida: branco na cabeça e no tronco, preto nos cantos (conferido pelo brilho do vídeo)', async () => {
    const { service, dirs } = build()
    await service.analyze('p1', 'matte')
    await service.idle()
    const file = join(dirs.p1!, MATTE_FILE)
    const info = probeJson(file).streams.find((s) => s.codec_type === 'video')!
    const W = info.width!
    const H = info.height!
    const at = (nx: number, ny: number, size = 8): number => {
      const x = Math.round(nx * W - size / 2)
      const y = Math.round(ny * H - size / 2)
      const series = lumaSeries(file, { x, y, w: size, h: size })
      return series[Math.floor(series.length / 2)]!
    }
    const { head, body } = MOCK_SILHOUETTE
    expect(at(head.cx, head.cy)).toBeGreaterThan(235) // cabeça
    expect(at(body.cx, 0.9)).toBeGreaterThan(235) // tronco, embaixo
    expect(at(0.04, 0.05)).toBeLessThan(25) // canto de cima: fundo
    expect(at(0.95, 0.5)).toBeLessThan(25) // lado direito: fundo
    // a borda é suave (não é serrilhada em 0/255): há tons intermediários entre o fundo e a pessoa
    const edge = at(head.cx + head.rx, head.cy, 4)
    expect(edge).toBeGreaterThan(10)
    expect(edge).toBeLessThan(245)
  })

  it('CACHE: pedir de novo com a máscara válida volta na hora, sem rodar o motor; `force` e câmera nova refazem', async () => {
    const { service, dirs, calls, jobs } = build()
    await service.analyze('p1', 'matte')
    await service.idle()
    expect(calls.matte).toBe(1)
    const again = await service.analyze('p1', 'matte')
    expect(again.state).toBe('done')
    expect(again.url).toBeDefined()
    expect(calls.matte).toBe(1)
    expect(await service.result('p1', 'matte')).toMatch(/camera-matte\.mp4\?v=\d+$/)

    await service.analyze('p1', 'matte', { force: true })
    await service.idle()
    expect(calls.matte).toBe(2)

    // a câmera mudou (data do arquivo): a máscara guardada já não vale
    const cam = join(dirs.p1!, 'media', 'camera.mp4')
    const later = new Date(Date.now() + 60_000)
    utimesSync(cam, later, later)
    expect(await service.result('p1', 'matte')).toBeNull()
    await service.analyze('p1', 'matte')
    await service.idle()
    expect(calls.matte).toBe(3)
    expect(jobs.at(-1)?.state).toBe('done')
    expect(await service.result('p1', 'matte')).not.toBeNull()
  })

  it('o camera-matte.json corrompido, de outra câmera ou de outra versão não vale (refaz); o arquivo vazio também não', async () => {
    const { service, dirs, calls } = build()
    await service.analyze('p1', 'matte')
    await service.idle()
    const meta = join(dirs.p1!, MATTE_META_FILE)
    const good = readFileSync(meta, 'utf8')
    for (const bad of ['{ nao e json', JSON.stringify({ ...JSON.parse(good), version: 99 }), JSON.stringify({ ...JSON.parse(good), source: 'media/outra.mp4' })]) {
      writeFileSync(meta, bad)
      expect(await service.result('p1', 'matte')).toBeNull()
    }
    writeFileSync(meta, good)
    expect(await service.result('p1', 'matte')).not.toBeNull()
    writeFileSync(join(dirs.p1!, MATTE_FILE), '')
    expect(await service.result('p1', 'matte')).toBeNull()
    await service.analyze('p1', 'matte')
    await service.idle()
    expect(calls.matte).toBe(2)
    expect(statSync(join(dirs.p1!, MATTE_FILE)).size).toBeGreaterThan(1000)
  })

  it('progresso real (sobe sem andar para trás) e a máscara não aparece antes de terminar inteira', async () => {
    const { service, jobs, dirs } = build({ mock: { delayMs: 200 } })
    await service.analyze('p1', 'matte')
    // no meio do trabalho o arquivo definitivo ainda não existe
    await new Promise((r) => setTimeout(r, 60))
    expect(existsSync(join(dirs.p1!, MATTE_FILE))).toBe(false)
    await service.idle()
    const fr = jobs.filter((j) => j.projectId === 'p1').map((j) => j.fraction)
    expect(fr.length).toBeGreaterThan(3)
    expect([...fr].sort((a, b) => a - b)).toEqual(fr)
    expect(existsSync(join(dirs.p1!, MATTE_FILE))).toBe(true)
  })

  it('cancelar no meio: para, o estado é "cancelada" e não sobra arquivo nenhum (nem parcial); a máscara antiga continua', async () => {
    const { service, jobs, dirs } = build({ mock: { delayMs: 600 } })
    await service.analyze('p1', 'matte', { force: true })
    await service.idle()
    const before = statSync(join(dirs.p1!, MATTE_FILE)).mtimeMs
    await service.analyze('p1', 'matte', { force: true })
    await new Promise((r) => setTimeout(r, 100))
    service.cancel('p1', 'matte')
    await service.idle()
    expect(jobs.at(-1)).toMatchObject({ kind: 'matte', state: 'cancelled', error: 'Análise cancelada.' })
    expect(existsSync(join(dirs.p1!, MATTE_PARTIAL_FILE))).toBe(false)
    expect(statSync(join(dirs.p1!, MATTE_FILE)).mtimeMs).toBe(before)
  })

  it('o motor falha: o trabalho termina em "error" com o motivo, nada fica pela metade e dá para tentar de novo', async () => {
    const { service, jobs, dirs, log } = build({ mock: { failMatte: true } })
    await service.analyze('p1', 'matte')
    await service.idle()
    expect(jobs.at(-1)).toMatchObject({ state: 'error', error: expect.stringMatching(/Falha simulada no recorte do fundo/) })
    expect(existsSync(join(dirs.p1!, MATTE_PARTIAL_FILE))).toBe(false)
    expect(existsSync(join(dirs.p1!, MATTE_FILE))).toBe(false)
    expect(log.entries.some((e) => e.level === 'error' && /Análise da câmera \(matte\)/.test(e.message))).toBe(true)
    await service.analyze('p1', 'matte') // a falha simulada é uma vez só
    await service.idle()
    expect(jobs.at(-1)?.state).toBe('done')
    expect(existsSync(join(dirs.p1!, MATTE_FILE))).toBe(true)
  })

  it('motor sem o recorte preparado recusa com o motivo; projeto sem câmera ou com a câmera fora da pasta também', async () => {
    const notReady = build({ mock: { ready: false } })
    await expect(notReady.service.analyze('p1', 'matte')).rejects.toThrow(/preparada/)
    const noCam = build({
      mutate: (p) => {
        delete p.sources.camera
      }
    })
    await expect(noCam.service.analyze('p1', 'matte')).rejects.toThrow(/não tem o vídeo da câmera/)
    const { service, dirs } = build()
    const file = join(dirs.p1!, 'project.json')
    const p = parseProject(readFileSync(file, 'utf8'))
    p.sources.camera!.path = '../p2/media/camera.mp4'
    writeFileSync(file, serializeProject(p))
    await expect(service.analyze('p1', 'matte')).rejects.toThrow(/fora da pasta/)
  })

  it('o rosto e o recorte do mesmo projeto entram na MESMA fila (uma análise por vez)', async () => {
    const { service, jobs } = build({ mock: { delayMs: 150 } })
    const a = await service.analyze('p1', 'matte')
    const b = await service.analyze('p1', 'face')
    expect(['queued', 'running']).toContain(a.state)
    expect(b.state).toBe('queued')
    await service.idle()
    expect(jobs.filter((j) => j.state === 'done').map((j) => j.kind)).toEqual(['matte', 'face'])
  })
})

describe('camera-matte.json (puro)', () => {
  it('lê o arquivo bom e recusa o ruim com o motivo; vale só para a mesma câmera (caminho e data)', () => {
    const meta = { version: MATTE_VERSION, engine: 'rvm-resnet50', source: 'media/camera.mp4', sourceMtimeMs: 1000, frames: 90, fps: 30, frame: { w: 1280, h: 720 }, createdAt: 'x' }
    const parsed = parseMatteMeta(JSON.stringify(meta))
    expect(matteIsFresh(parsed, 'media/camera.mp4', 1000)).toBe(true)
    expect(matteIsFresh(parsed, 'media/camera.mp4', 1001)).toBe(false)
    expect(matteIsFresh(parsed, 'media/outra.mp4', 1000)).toBe(false)
    expect(() => parseMatteMeta('x')).toThrow(/JSON/)
    expect(() => parseMatteMeta(JSON.stringify({ ...meta, version: 2 }))).toThrow(/outra versão/)
    expect(() => parseMatteMeta(JSON.stringify({ ...meta, frames: 0 }))).toThrow(/incompleto/)
  })
})
