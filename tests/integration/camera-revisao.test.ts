/**
 * O serviço da análise da câmera (`createCameraService`): os defeitos que a revisão independente achou no recorte do fundo.
 *  1. a limpeza do arquivo parcial não pode apagar a PRÓPRIA câmera (câmera que ocupa o lugar de um arquivo derivado);
 *  5. duas chamadas SIMULTÂNEAS não duplicam a análise, e cancelar alcança todas as entradas, inclusive a que está rodando;
 *  6. a limpeza do parcial que falha não é engolida: o motivo chega à pessoa.
 * (O encerramento da árvore de processos tem o teste dele em `tests/unit/process-runner-arvore.test.ts`.)
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CameraJob } from '@shared/camera-analysis'
import type { IpcEvents } from '@shared/ipc'
import { MATTE_FILE, MATTE_PARTIAL_FILE } from '@shared/matte'
import { parseProject } from '@shared/project'
import type { Project } from '@shared/types'
import { createMockCamera, type MockCameraOptions } from '../../src/main/camera/mock-engine'
import { createCameraService } from '../../src/main/camera/service'
import type { CameraEngine, MakeMatteOptions } from '../../src/main/camera/types'
import { locateFfmpeg } from '../../src/main/ffmpeg'
import { createMemoryLogger } from '../../src/main/logger'
import { copyTree, FIX, useTmpDir } from '../helpers/env'

const tmp = useTmpDir()
const ffmpegPath = (): string | null => locateFfmpeg()?.ffmpeg ?? null

function build(opts: { mock?: Partial<MockCameraOptions>; engine?: Partial<CameraEngine>; cameraPath?: string } = {}) {
  const base = tmp()
  const dir = join(base, 'p1')
  copyTree(FIX.exemplo, dir)
  const jobs: CameraJob[] = []
  const log = createMemoryLogger()
  const calls = { matte: 0, face: 0 }
  /** O caminho da câmera que o projeto declara AGORA (os testes podem mudá-lo no meio do caminho). */
  const state = { cameraPath: opts.cameraPath }
  const read = async (id: string): Promise<{ project: Project; dir: string }> => {
    if (id !== 'p1') throw new Error(`Projeto não encontrado: ${id}`)
    const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
    if (state.cameraPath && project.sources.camera) project.sources.camera.path = state.cameraPath
    return { project, dir }
  }
  const mock = createMockCamera({ ready: true, ffmpeg: ffmpegPath, ...opts.mock })
  const engine: CameraEngine = {
    ...mock,
    makeMatte: (o: MakeMatteOptions) => {
      calls.matte++
      return (opts.engine?.makeMatte ?? mock.makeMatte)(o)
    },
    detectFaces: (o) => {
      calls.face++
      return (opts.engine?.detectFaces ?? mock.detectFaces)(o)
    }
  }
  const service = createCameraService({
    logger: log,
    engine,
    read,
    emit: <K extends 'camera:prepare' | 'camera:job'>(channel: K, payload: IpcEvents[K]) => {
      if (channel === 'camera:job') jobs.push(payload as CameraJob)
    }
  })
  const last = (): CameraJob | undefined => jobs.at(-1)
  const waitFor = async (what: string, ok: () => boolean, ms = 10_000): Promise<void> => {
    const until = Date.now() + ms
    while (!ok()) {
      if (Date.now() > until) throw new Error(`esperei em vão: ${what}`)
      await new Promise((r) => setTimeout(r, 15))
    }
  }
  return { service, jobs, dir, log, calls, last, waitFor, setCameraPath: (rel: string) => (state.cameraPath = rel) }
}

/** O projeto do exemplo, mas com a câmera guardada em `rel` (a gravação é copiada para lá) e o `project.json` apontando para ele. */
function withCameraAt(rel: string) {
  const t = build({ cameraPath: rel })
  const src = join(t.dir, 'media', 'camera.mp4')
  const dest = join(t.dir, rel)
  mkdirSync(join(dest, '..'), { recursive: true })
  copyFileSync(src, dest)
  return { ...t, dest, original: readFileSync(dest) }
}

describe('1. câmera que ocupa o lugar de um arquivo que a análise grava: nada é apagado nem substituído', () => {
  const cases: [string, string, 'matte' | 'face'][] = [
    ['o arquivo parcial do recorte', MATTE_PARTIAL_FILE, 'matte'],
    ['o vídeo final do recorte', MATTE_FILE, 'matte'],
    ['o JSON do recorte', 'media/camera-matte.json', 'matte'],
    ['o JSON do rosto', 'media/camera-face.json', 'face']
  ]
  for (const [nome, rel, kind] of cases) {
    it(`a câmera guardada em ${rel} (${nome}): a análise ${kind} é RECUSADA com o motivo e a gravação fica intacta`, async () => {
      const t = withCameraAt(rel)
      await expect(t.service.analyze('p1', kind)).rejects.toThrow(/ocupa o lugar de um arquivo que esta análise grava/)
      await t.service.idle()
      expect(t.calls.matte + t.calls.face, 'o motor chegou a rodar').toBe(0)
      expect(existsSync(t.dest), 'a gravação da câmera sumiu').toBe(true)
      expect(readFileSync(t.dest).equals(t.original), 'a gravação da câmera foi sobrescrita').toBe(true)
    })
  }

  it('a mesma câmera por outro nome (atalho rígido para o parcial): também recusada, sem rodar o motor', async () => {
    const t = build()
    // o project.json guarda a câmera como media/camera.mp4, e o parcial é um segundo nome do MESMO arquivo no disco
    linkSync(join(t.dir, 'media', 'camera.mp4'), join(t.dir, MATTE_PARTIAL_FILE))
    await expect(t.service.analyze('p1', 'matte')).rejects.toThrow(/ocupa o lugar/)
    expect(t.calls.matte).toBe(0)
    expect(readFileSync(join(t.dir, 'media', 'camera.mp4')).length).toBeGreaterThan(1000)
  })

  it('o projeto mudou depois de enfileirar (a câmera passou a ser o JSON do rosto): o trabalho falha ANTES de gravar, com o motivo', async () => {
    const t = build({ mock: { delayMs: 500 } })
    await t.service.analyze('p1', 'matte') // ocupa o motor
    await t.waitFor('o recorte começar', () => t.jobs.some((j) => j.kind === 'matte' && j.state === 'running'))
    const queued = await t.service.analyze('p1', 'face') // espera a vez
    expect(queued.state).toBe('queued')
    const dest = join(t.dir, 'media', 'camera-face.json')
    copyFileSync(join(t.dir, 'media', 'camera.mp4'), dest)
    const original = readFileSync(dest)
    t.setCameraPath('media/camera-face.json') // quando a vez do rosto chegar, a câmera do projeto já é o arquivo que ele grava
    await t.service.idle()
    const face = t.jobs.filter((j) => j.kind === 'face').at(-1)!
    expect(face.state).toBe('error')
    expect(face.error).toMatch(/ocupa o lugar/)
    expect(t.calls.face).toBe(0)
    expect(readFileSync(dest).equals(original)).toBe(true)
  })

  it('projeto normal: a análise segue funcionando (a guarda não barra a câmera de sempre)', async () => {
    const t = build()
    await t.service.analyze('p1', 'matte')
    await t.service.idle()
    expect(t.last()).toMatchObject({ kind: 'matte', state: 'done' })
    expect(existsSync(join(t.dir, MATTE_FILE))).toBe(true)
    expect(existsSync(join(t.dir, 'media', 'camera.mp4'))).toBe(true)
  })

  it('no Windows o mesmo nome em outra caixa é o mesmo arquivo: também recusado', async () => {
    if (process.platform !== 'win32') return // só o Windows ignora a caixa do nome (o produto roda lá)
    const t = withCameraAt('media/CAMERA-MATTE.PARTIAL.MP4')
    await expect(t.service.analyze('p1', 'matte')).rejects.toThrow(/ocupa o lugar/)
    expect(readFileSync(t.dest).equals(t.original)).toBe(true)
  })
})

describe('5. chamadas simultâneas e cancelamento', () => {
  it('duas chamadas ao mesmo tempo: UMA análise só (o motor roda uma vez) e as duas recebem o mesmo trabalho', async () => {
    const t = build({ mock: { delayMs: 400 } })
    const [a, b] = await Promise.all([t.service.analyze('p1', 'matte'), t.service.analyze('p1', 'matte')])
    expect(a).toEqual(b)
    await t.service.idle()
    expect(t.calls.matte).toBe(1)
    expect(t.last()).toMatchObject({ state: 'done' })
  })

  it('cinco chamadas ao mesmo tempo, do rosto e do recorte: uma análise de cada tipo', async () => {
    const t = build({ mock: { delayMs: 200 } })
    await Promise.all([
      t.service.analyze('p1', 'matte'),
      t.service.analyze('p1', 'face'),
      t.service.analyze('p1', 'matte'),
      t.service.analyze('p1', 'face'),
      t.service.analyze('p1', 'matte')
    ])
    await t.service.idle()
    expect(t.calls).toEqual({ matte: 1, face: 1 })
  })

  it('"refazer" pedido junto com outra chamada ainda não duplica: espera a primeira e decide em cima dela', async () => {
    const t = build({ mock: { delayMs: 300 } })
    await Promise.all([t.service.analyze('p1', 'matte'), t.service.analyze('p1', 'matte', { force: true })])
    await t.service.idle()
    expect(t.calls.matte).toBe(1)
  })

  it('cancelar depois de duas chamadas simultâneas alcança a análise que está RODANDO (nada termina "pronto")', async () => {
    const t = build({ mock: { delayMs: 3000 } })
    await Promise.all([t.service.analyze('p1', 'matte'), t.service.analyze('p1', 'matte')])
    await t.waitFor('o trabalho começar', () => t.jobs.some((j) => j.state === 'running'))
    t.service.cancel('p1', 'matte')
    await t.service.idle()
    expect(t.last()).toMatchObject({ kind: 'matte', state: 'cancelled' })
    expect(t.jobs.some((j) => j.state === 'done')).toBe(false)
    expect(t.calls.matte).toBe(1)
    expect(existsSync(join(t.dir, MATTE_PARTIAL_FILE))).toBe(false)
  })

  it('cancelar ENQUANTO o pedido ainda se prepara (antes de entrar na fila): ele não entra', async () => {
    const t = build({ mock: { delayMs: 300 } })
    const pending = t.service.analyze('p1', 'matte')
    t.service.cancel('p1', 'matte') // o pedido ainda está consultando o motor e lendo o projeto
    const job = await pending
    await t.service.idle()
    expect(job.state).toBe('cancelled')
    expect(t.calls.matte).toBe(0)
    expect(t.last()?.state).toBe('cancelled')
  })

  it('depois de cancelado dá para pedir de novo e a análise roda', async () => {
    const t = build({ mock: { delayMs: 200 } })
    const pending = t.service.analyze('p1', 'matte')
    t.service.cancel('p1', 'matte')
    await pending
    const again = await t.service.analyze('p1', 'matte')
    expect(['queued', 'running']).toContain(again.state)
    await t.service.idle()
    expect(t.calls.matte).toBe(1)
    expect(t.last()).toMatchObject({ state: 'done' })
  })
})

describe('6. a limpeza do parcial que falha aparece (não é engolida)', () => {
  /** Um motor que deixa um DIRETÓRIO no lugar do parcial (que nenhum `rm` de arquivo apaga) e falha. */
  const stuckPartial = (message: string): Partial<CameraEngine> => ({
    makeMatte: async (o: MakeMatteOptions) => {
      mkdirSync(o.out, { recursive: true })
      throw new Error(message)
    }
  })

  it('o motor falha e o parcial não pode ser apagado: o erro do trabalho diz isso, com o arquivo e o que fazer', async () => {
    const t = build({ engine: stuckPartial('o motor caiu no meio') })
    await t.service.analyze('p1', 'matte')
    await t.service.idle()
    const job = t.last()!
    expect(job.state).toBe('error')
    expect(job.error).toMatch(/Não consegui apagar o arquivo parcial/)
    expect(job.error).toContain('camera-matte.partial.mp4')
    expect(job.error).toMatch(/tente de novo/)
  })

  it('cancelar e o parcial não sair: não vira "cancelado" em silêncio, avisa que sobrou arquivo', async () => {
    const t = build({
      engine: {
        makeMatte: async (o: MakeMatteOptions) => {
          mkdirSync(o.out, { recursive: true })
          await new Promise<void>((resolve) => o.signal?.addEventListener('abort', () => resolve(), { once: true }))
          throw new Error('Cancelado.')
        }
      }
    })
    await t.service.analyze('p1', 'matte')
    await t.waitFor('o motor começar', () => t.calls.matte === 1)
    t.service.cancel('p1', 'matte')
    await t.service.idle()
    expect(t.last()?.state).toBe('error')
    expect(t.last()?.error).toMatch(/arquivo parcial/)
  })

  it('o motor falha e o parcial sai normalmente: o erro é o do motor (sem aviso de limpeza)', async () => {
    const t = build({
      engine: {
        makeMatte: async (o: MakeMatteOptions) => {
          writeFileSync(o.out, 'pela metade')
          throw new Error('o motor caiu no meio')
        }
      }
    })
    await t.service.analyze('p1', 'matte')
    await t.service.idle()
    expect(t.last()).toMatchObject({ state: 'error', error: 'o motor caiu no meio' })
    expect(existsSync(join(t.dir, MATTE_PARTIAL_FILE))).toBe(false)
  })
})
