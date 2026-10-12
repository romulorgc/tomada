/**
 * O RECORTE DO FUNDO EM PEDAÇOS, RETOMÁVEL (R1), no serviço da câmera com o motor de teste (que grava um arquivo por pedaço, avisa cada um e
 * para no fim do pedaço quando pedem) e o sistema de arquivos de verdade:
 *  - o andamento fica no projeto a cada pedaço e some quando o recorte termina;
 *  - fechar o app no meio deixa o aviso no log e, ao reabrir, continua do último pedaço inteiro (não do zero);
 *  - morte sem aviso, `.partial.mp4` de antes dos pedaços, pedaço faltando, câmera trocada: cada um tem o seu caminho e o seu aviso;
 *  - falha vira aviso com "tentar de novo" que continua; cancelar guarda os pedaços e não recomeça sozinho;
 *  - o recorte dá lugar à placa (exportação, transcrição, prévia): espera para começar e, no meio, para no fim do pedaço e volta depois.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CameraJob } from '@shared/camera-analysis'
import type { IpcEvents } from '@shared/ipc'
import { MATTE_FILE, MATTE_PARTIAL_FILE } from '@shared/matte'
import { matteChunkName, MATTE_PARTS_DIR, MATTE_PROGRESS_FILE, MATTE_PROGRESS_VERSION, parseMatteProgress, type MatteProgress } from '@shared/matte-parts'
import { parseProject } from '@shared/project'
import type { Project } from '@shared/types'
import { createMockCamera } from '../../src/main/camera/mock-engine'
import { MatteJoinError } from '../../src/main/camera/matte-join'
import { createCameraService, type CameraService } from '../../src/main/camera/service'
import type { CameraEngine, MakeMatteOptions } from '../../src/main/camera/types'
import type { GpuGate } from '../../src/main/gpu-queue'
import { createMemoryLogger } from '../../src/main/logger'
import { copyTree, FIX, useTmpDir } from '../helpers/env'

const tmp = useTmpDir()
/** A câmera do projeto de exemplo tem 22,7 s: com pedaços de 2 s são 12 pedaços. */
const CHUNK_S = 2
const TOTAL_CHUNKS = 12

/** Uma placa de mentira: o teste liga e desliga o "ocupado" e o serviço reage como reagiria à exportação. */
function fakeGate() {
  let reason: 'work' | 'preview' | null = null
  const listeners = new Set<() => void>()
  const waiters = new Set<() => void>()
  const gate: GpuGate = {
    busy: () => reason,
    whenIdle: (signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Error('Cancelado.'))
        if (reason === null) return resolve()
        const wake = (): void => {
          if (reason !== null) return
          waiters.delete(wake)
          signal.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = (): void => {
          waiters.delete(wake)
          reject(new Error('Cancelado.'))
        }
        waiters.add(wake)
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    onBusy: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
  return {
    gate,
    set(next: 'work' | 'preview' | null): void {
      const was = reason
      reason = next
      if (next && !was) for (const l of [...listeners]) l()
      if (!next) for (const w of [...waiters]) w()
    }
  }
}

type Calls = { doneAtStart: number[]; force: boolean[] }

function setup(opts: { delayMs?: number; failMatte?: boolean; engine?: (inner: CameraEngine, calls: Calls) => CameraEngine; gate?: GpuGate; stopGraceMs?: number } = {}) {
  const base = tmp()
  const dirs: Record<string, string> = { p1: join(base, 'p1'), p2: join(base, 'p2') }
  for (const d of Object.values(dirs)) copyTree(FIX.exemplo, d)
  const log = createMemoryLogger()
  const jobs: CameraJob[] = []
  const calls: Calls = { doneAtStart: [], force: [] }
  const read = async (id: string): Promise<{ project: Project; dir: string }> => {
    const dir = dirs[id]
    if (!dir) throw new Error(`Projeto não encontrado: ${id}`)
    return { project: parseProject(readFileSync(join(dir, 'project.json'), 'utf8')), dir }
  }
  /** Um app "aberto": serviço novo, motor novo, mesmo disco e mesmo log (como reabrir o programa). */
  const open = (over: { delayMs?: number; failMatte?: boolean } = {}): CameraService => {
    const mock = createMockCamera({ ready: true, delayMs: over.delayMs ?? opts.delayMs ?? 0, ...(over.failMatte ?? opts.failMatte ? { failMatte: true } : {}) })
    const spied: CameraEngine = {
      ...mock,
      makeMatte: (o: MakeMatteOptions) => {
        calls.doneAtStart.push(o.parts?.done.length ?? -1)
        return mock.makeMatte(o)
      }
    }
    return createCameraService({
      logger: log,
      engine: opts.engine ? opts.engine(spied, calls) : spied,
      read,
      emit: <K extends 'camera:prepare' | 'camera:job'>(channel: K, payload: IpcEvents[K]) => {
        if (channel === 'camera:job') jobs.push(payload as CameraJob)
      },
      chunkSeconds: CHUNK_S,
      stopGraceMs: opts.stopGraceMs ?? 20_000,
      ...(opts.gate ? { gpu: opts.gate } : {})
    })
  }
  const progressOf = (id: string): MatteProgress | null => {
    const file = join(dirs[id]!, MATTE_PROGRESS_FILE)
    return existsSync(file) ? parseMatteProgress(readFileSync(file, 'utf8')) : null
  }
  const partsOf = (id: string): string[] => {
    const dir = join(dirs[id]!, MATTE_PARTS_DIR)
    return existsSync(dir) ? readdirSync(dir).sort() : []
  }
  const messages = (level?: string): string[] => log.entries.filter((e) => !level || e.level === level).map((e) => e.message)
  const lastJob = (id: string): CameraJob | undefined => [...jobs].reverse().find((j) => j.projectId === id && j.kind === 'matte')
  return { open, dirs, log, jobs, calls, progressOf, partsOf, messages, lastJob }
}

const until = (fn: () => boolean, ms = 15_000): Promise<void> => vi.waitFor(() => { if (!fn()) throw new Error('ainda não') }, { timeout: ms, interval: 15 })

/** Escreve à mão o que um recorte interrompido deixa no projeto: pedaços inteiros e o andamento. */
function plant(dir: string, chunks: number, patch: Partial<MatteProgress> = {}, mtimeMs?: number): void {
  const parts = join(dir, MATTE_PARTS_DIR)
  mkdirSync(parts, { recursive: true })
  const list = []
  for (let i = 0; i < chunks; i++) {
    writeFileSync(join(parts, matteChunkName(i)), `pedaço ${i}`)
    list.push({ index: i, frames: CHUNK_S * 30, bytes: statSync(join(parts, matteChunkName(i))).size })
  }
  const cam = statSync(join(dir, 'media', 'camera.mp4'))
  const progress: MatteProgress = {
    version: MATTE_PROGRESS_VERSION,
    source: 'media/camera.mp4',
    sourceMtimeMs: mtimeMs ?? Math.trunc(cam.mtimeMs),
    chunkSeconds: CHUNK_S,
    chunks: list,
    status: 'running',
    fraction: (chunks * CHUNK_S) / 22.7,
    attempts: 1,
    startedAt: '2026-10-12T10:00:00.000Z',
    updatedAt: '2026-10-12T10:01:00.000Z',
    ...patch
  }
  writeFileSync(join(dir, MATTE_PROGRESS_FILE), JSON.stringify(progress))
}

describe('recorte em pedaços: andamento guardado no projeto', () => {
  it('grava um arquivo por pedaço, guarda o andamento a cada um e, no fim, junta e apaga os pedaços e o andamento', async () => {
    const t = setup({ delayMs: 1200 })
    const service = t.open()
    await service.analyze('p1', 'matte')
    await until(() => (t.progressOf('p1')?.chunks.length ?? 0) >= 3)
    const mid = t.progressOf('p1')!
    expect(mid).toMatchObject({ status: 'running', source: 'media/camera.mp4', chunkSeconds: CHUNK_S, attempts: 1 })
    expect(mid.chunks.map((c) => c.index)).toEqual([...mid.chunks.keys()])
    expect(t.partsOf('p1')).toContain('p0000.mp4')
    expect(existsSync(join(t.dirs.p1!, MATTE_FILE))).toBe(false)

    await service.idle()
    expect(t.lastJob('p1')).toMatchObject({ state: 'done', fraction: 1 })
    expect(existsSync(join(t.dirs.p1!, MATTE_FILE))).toBe(true)
    expect(existsSync(join(t.dirs.p1!, MATTE_PARTIAL_FILE))).toBe(false)
    expect(t.progressOf('p1')).toBeNull()
    expect(t.partsOf('p1')).toEqual([])
    const infos = t.messages('info')
    expect(infos.some((m) => m.includes('começando, em pedaços de 2 s'))).toBe(true)
    expect(infos.filter((m) => /pedaço \d+ pronto/.test(m))).toHaveLength(TOTAL_CHUNKS)
    expect(infos.some((m) => /Recorte do fundo do projeto p1: \d+ quadros em/.test(m))).toBe(true)
    expect(t.calls.doneAtStart).toEqual([0])
  })

  it('o andamento mostrado nunca anda para trás e sobe até 100%', async () => {
    const t = setup({ delayMs: 600 })
    const service = t.open()
    await service.analyze('p1', 'matte')
    await service.idle()
    const fractions = t.jobs.filter((j) => j.projectId === 'p1' && j.state === 'running').map((j) => j.fraction)
    expect(fractions.length).toBeGreaterThan(3)
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions)
    expect(t.lastJob('p1')!.fraction).toBe(1)
  })

  it('o pedido fica anotado no projeto assim que entra na fila (o app pode fechar antes de o recorte começar)', async () => {
    const t = setup({ delayMs: 1500 })
    const service = t.open()
    await service.analyze('p1', 'matte')
    await service.analyze('p2', 'matte') // p1 ocupa a fila; p2 espera
    const marker = t.progressOf('p2')
    expect(marker).toMatchObject({ status: 'running', chunks: [], attempts: 0 })
    service.cancel('p1', 'matte')
    service.cancel('p2', 'matte')
    await service.idle()
  })
})

describe('fechar o app no meio nunca é silencioso', () => {
  it('ao fechar: aviso no log, andamento anotado como interrompido; ao reabrir: continua do último pedaço inteiro e termina', async () => {
    const t = setup({ delayMs: 1500 })
    const first = t.open()
    await first.analyze('p1', 'matte')
    await until(() => (t.progressOf('p1')?.chunks.length ?? 0) >= 4)
    await first.shutdown()

    const stopped = t.progressOf('p1')!
    const doneBefore = stopped.chunks.length
    expect(doneBefore).toBeGreaterThanOrEqual(4)
    expect(doneBefore).toBeLessThan(TOTAL_CHUNKS)
    expect(stopped.status).toBe('interrupted')
    expect(stopped.error).toMatch(/fechado/)
    expect(existsSync(join(t.dirs.p1!, MATTE_FILE))).toBe(false)
    const closing = t.messages('warn').find((m) => m.includes('interrompido pelo fechamento do app'))
    expect(closing).toBeDefined()
    expect(closing).toContain(`${doneBefore} pedaço(s) prontos`)
    expect(closing).toContain(`continua do pedaço ${doneBefore + 1}`)

    // reabre o app: outro serviço, outro motor, o mesmo disco
    const second = t.open({ delayMs: 600 })
    expect(await second.recoverMatte('p1')).toBe('resumed')
    const heard = t.messages('warn').find((m) => m.includes('estava em andamento'))
    expect(heard).toContain(`${doneBefore} pedaço(s) prontos`)
    expect(heard).toContain(`vou continuar do pedaço ${doneBefore + 1}`)
    // o que o editor vê logo ao reabrir: já "continuando", com a porcentagem de onde parou
    await until(() => t.lastJob('p1')?.state === 'running' && t.lastJob('p1')?.resumed === true)
    expect(t.lastJob('p1')!.fraction).toBeGreaterThanOrEqual(doneBefore / TOTAL_CHUNKS - 0.1)
    await second.idle()

    // o motor da segunda vez começou DEPOIS dos pedaços prontos (não refez do zero)
    expect(t.calls.doneAtStart).toEqual([0, doneBefore])
    expect(t.lastJob('p1')).toMatchObject({ state: 'done', fraction: 1, resumed: true })
    expect(existsSync(join(t.dirs.p1!, MATTE_FILE))).toBe(true)
    expect(t.progressOf('p1')).toBeNull()
    expect(t.partsOf('p1')).toEqual([])
    expect(t.messages('info').some((m) => m.includes(`retomando do pedaço ${doneBefore + 1}`))).toBe(true)
    expect(t.messages('info').some((m) => /em 2 rodadas/.test(m))).toBe(true)
  })

  it('morte sem aviso (processo morto): sobra o andamento "em curso" e um pedaço pela metade; ao reabrir limpa o resto e continua do último inteiro', async () => {
    const t = setup({ delayMs: 600 })
    plant(t.dirs.p1!, 5)
    writeFileSync(join(t.dirs.p1!, MATTE_PARTS_DIR, 'p0005.mp4.tmp'), 'metade')
    const service = t.open()
    expect(await service.recoverMatte('p1')).toBe('resumed')
    await service.idle()
    expect(t.calls.doneAtStart).toEqual([5])
    expect(t.messages('warn').some((m) => m.includes('estava em andamento') && m.includes('5 pedaço(s) prontos'))).toBe(true)
    expect(t.lastJob('p1')).toMatchObject({ state: 'done' })
    expect(t.partsOf('p1')).toEqual([])
  })

  it('o app fecha com o recorte ainda NA FILA: o pedido continua anotado e, ao reabrir, começa', async () => {
    const t = setup({ delayMs: 1500 })
    const first = t.open()
    await first.analyze('p1', 'matte')
    await first.analyze('p2', 'matte')
    await until(() => (t.progressOf('p1')?.chunks.length ?? 0) >= 1)
    await first.shutdown()
    expect(t.messages('info').some((m) => m.includes('projeto p2: estava na fila e fica anotado'))).toBe(true)
    expect(t.progressOf('p2')).toMatchObject({ status: 'running', chunks: [] })

    const second = t.open({ delayMs: 0 })
    expect(await second.recoverMatte('p2')).toBe('resumed')
    expect(t.messages('info').some((m) => m.includes('projeto p2: estava na fila quando o app fechou'))).toBe(true)
    await second.idle()
    expect(existsSync(join(t.dirs.p2!, MATTE_FILE))).toBe(true)
  })
})

describe('projeto antigo e pedaços que não valem', () => {
  it('projeto com camera-matte.partial.mp4 de antes dos pedaços (sem índice, não abre): refaz sozinho ao abrir e apaga o parcial', async () => {
    const t = setup()
    const partial = join(t.dirs.p1!, MATTE_PARTIAL_FILE)
    writeFileSync(partial, Buffer.alloc(3_407_920, 7))
    const service = t.open()
    expect(await service.recoverMatte('p1')).toBe('regenerated')
    await service.idle()
    expect(t.messages('warn').some((m) => m.includes('parcial antigo') && m.includes('3.3 MB'))).toBe(true)
    expect(existsSync(partial)).toBe(false)
    expect(existsSync(join(t.dirs.p1!, MATTE_FILE))).toBe(true)
    expect(t.lastJob('p1')).toMatchObject({ state: 'done' })
    expect(t.calls.doneAtStart).toEqual([0])
  })

  it('um pedaço que sumiu no meio: aproveita só os que vêm antes dele e avisa no log', async () => {
    const t = setup()
    plant(t.dirs.p1!, 6)
    writeFileSync(join(t.dirs.p1!, MATTE_PARTS_DIR, matteChunkName(2)), '') // zerado = não vale
    const service = t.open()
    await service.recoverMatte('p1')
    await service.idle()
    expect(t.calls.doneAtStart).toEqual([2])
    expect(t.messages('warn').some((m) => m.includes('4 pedaço(s) do recorte não estavam inteiros'))).toBe(true)
    expect(existsSync(join(t.dirs.p1!, MATTE_FILE))).toBe(true)
  })

  it('pedaços de OUTRA câmera (arquivo trocado depois) são descartados, com aviso, e o recorte recomeça do zero', async () => {
    const t = setup()
    plant(t.dirs.p1!, 4, {}, 12345)
    const service = t.open()
    // o andamento é de outra câmera: não retoma sozinho; quem pede o recorte (o editor) recomeça do zero
    expect(await service.recoverMatte('p1')).toBe('idle')
    await service.analyze('p1', 'matte')
    await service.idle()
    expect(t.calls.doneAtStart).toEqual([0])
    expect(t.messages('warn').some((m) => m.includes('a câmera do projeto mudou'))).toBe(true)
    expect(t.lastJob('p1')).toMatchObject({ state: 'done' })
  })

  it('"Recortar de novo" (force) ignora os pedaços guardados', async () => {
    const t = setup()
    plant(t.dirs.p1!, 5)
    const service = t.open()
    await service.analyze('p1', 'matte', { force: true })
    await service.idle()
    expect(t.calls.doneAtStart).toEqual([0])
    expect(t.messages('warn').some((m) => m.includes('pedido de novo do zero'))).toBe(true)
  })

  it('recorte que já estava pronto e sobras de andamento: limpa as sobras e não refaz nada', async () => {
    const t = setup()
    const service = t.open()
    await service.analyze('p1', 'matte')
    await service.idle()
    plant(t.dirs.p1!, 3)
    expect(await service.recoverMatte('p1')).toBe('idle')
    expect(t.progressOf('p1')).toBeNull()
    expect(t.partsOf('p1')).toEqual([])
    expect(t.calls.doneAtStart).toEqual([0])
  })

  it('projeto sem nada pendente: não faz nada', async () => {
    const t = setup()
    expect(await t.open().recoverMatte('p1')).toBe('idle')
    expect(t.calls.doneAtStart).toEqual([])
  })
})

describe('falha e cancelamento', () => {
  it('falhou: o motivo vai para o log, o aviso tem "tentar de novo" e ele CONTINUA dos pedaços prontos', async () => {
    const t = setup({ failMatte: true })
    const service = t.open()
    await service.analyze('p1', 'matte')
    await service.idle()
    const failed = t.lastJob('p1')!
    expect(failed.state).toBe('error')
    expect(failed.error).toMatch(/Falha simulada/)
    expect(t.messages('error').some((m) => m.includes('Análise da câmera (matte) do projeto p1 falhou'))).toBe(true)
    const kept = t.progressOf('p1')!
    expect(kept.status).toBe('failed')
    expect(kept.error).toMatch(/Falha simulada/)
    expect(kept.chunks.length).toBeGreaterThanOrEqual(1)
    expect(t.partsOf('p1')).toContain('p0000.mp4')

    await service.analyze('p1', 'matte') // "Tentar de novo"
    await service.idle()
    expect(t.calls.doneAtStart).toEqual([0, kept.chunks.length])
    expect(t.lastJob('p1')).toMatchObject({ state: 'done' })
    expect(existsSync(join(t.dirs.p1!, MATTE_FILE))).toBe(true)
  })

  it('reabrir o app depois de uma falha: mostra a falha (com o motivo) e NÃO recomeça sozinho', async () => {
    const t = setup({ failMatte: true })
    const first = t.open()
    await first.analyze('p1', 'matte')
    await first.idle()
    const second = t.open()
    jobsReset(t)
    expect(await second.recoverMatte('p1')).toBe('failed')
    expect(t.lastJob('p1')).toMatchObject({ state: 'error' })
    expect(t.lastJob('p1')!.error).toMatch(/Falha simulada/)
    expect(t.calls.doneAtStart).toHaveLength(1)
  })

  it('cancelar guarda os pedaços prontos e deixa o motivo no log; reabrir não recomeça; pedir de novo continua', async () => {
    const t = setup({ delayMs: 1500 })
    const service = t.open()
    await service.analyze('p1', 'matte')
    await until(() => (t.progressOf('p1')?.chunks.length ?? 0) >= 3)
    service.cancel('p1', 'matte')
    await service.idle()
    const kept = t.progressOf('p1')!
    expect(kept.status).toBe('cancelled')
    expect(kept.chunks.length).toBeGreaterThanOrEqual(3)
    expect(t.messages('warn').some((m) => m.includes('cancelado em') && m.includes('ficam guardados'))).toBe(true)
    expect(t.lastJob('p1')).toMatchObject({ state: 'cancelled' })

    const reopened = t.open({ delayMs: 0 })
    expect(await reopened.recoverMatte('p1')).toBe('idle')
    expect(t.calls.doneAtStart).toHaveLength(1)
    await reopened.analyze('p1', 'matte')
    await reopened.idle()
    expect(t.calls.doneAtStart[1]).toBe(kept.chunks.length)
    expect(t.lastJob('p1')).toMatchObject({ state: 'done' })
  })

  it('cancelar na fila anota "cancelado": ao reabrir não começa sozinho', async () => {
    const t = setup({ delayMs: 1500 })
    const service = t.open()
    await service.analyze('p1', 'matte')
    await service.analyze('p2', 'matte')
    service.cancel('p2', 'matte')
    await until(() => t.progressOf('p2')?.status === 'cancelled')
    service.cancel('p1', 'matte')
    await service.idle()
    expect(await t.open().recoverMatte('p2')).toBe('idle')
  })

  it('a junção que não bate descarta os pedaços (não adianta continuar de pedaços ruins) e o próximo pedido recomeça do zero', async () => {
    let first = true
    const t = setup({
      engine: (inner) => ({
        ...inner,
        makeMatte: async (o) => {
          if (first) {
            first = false
            await inner.makeMatte(o)
            throw new MatteJoinError('A junção dos pedaços do recorte ficou com 3.00 s e eram esperados 22.70 s.')
          }
          return inner.makeMatte(o)
        }
      })
    })
    const service = t.open()
    await service.analyze('p1', 'matte')
    await service.idle()
    expect(t.lastJob('p1')).toMatchObject({ state: 'error' })
    expect(t.lastJob('p1')!.error).toMatch(/junção/)
    expect(t.progressOf('p1')).toBeNull()
    expect(t.partsOf('p1')).toEqual([])
    expect(t.messages('error').some((m) => m.includes('Os pedaços foram descartados'))).toBe(true)
    await service.analyze('p1', 'matte')
    await service.idle()
    expect(t.lastJob('p1')).toMatchObject({ state: 'done' })
  })
})

describe('o recorte dá lugar à placa (exportação, transcrição, prévia)', () => {
  it('placa ocupada na hora de começar: espera na fila ("na fila, dando lugar") e só começa quando ela fica livre', async () => {
    const g = fakeGate()
    g.set('work')
    const t = setup({ gate: g.gate })
    const service = t.open()
    await service.analyze('p1', 'matte')
    await until(() => t.lastJob('p1')?.waiting === 'gpu')
    expect(t.lastJob('p1')).toMatchObject({ state: 'queued', waiting: 'gpu' })
    expect(t.calls.doneAtStart).toEqual([])
    expect(t.messages('info').some((m) => m.includes('em espera, a placa está com uma exportação ou transcrição'))).toBe(true)
    g.set(null)
    await service.idle()
    expect(t.calls.doneAtStart).toEqual([0])
    expect(t.lastJob('p1')).toMatchObject({ state: 'done' })
    expect(t.messages('info').some((m) => m.includes('a placa ficou livre'))).toBe(true)
  })

  it('a prévia tocando também conta, com o motivo certo no log', async () => {
    const g = fakeGate()
    g.set('preview')
    const t = setup({ gate: g.gate })
    const service = t.open()
    await service.analyze('p1', 'matte')
    await until(() => t.lastJob('p1')?.waiting === 'gpu')
    expect(t.messages('info').some((m) => m.includes('a placa está com a prévia do editor'))).toBe(true)
    g.set(null)
    await service.idle()
    expect(t.lastJob('p1')).toMatchObject({ state: 'done' })
  })

  it('uma exportação chega no meio: o recorte para no fim do pedaço, espera, e continua do pedaço seguinte (sem refazer nada)', async () => {
    const g = fakeGate()
    const t = setup({ delayMs: 2400, gate: g.gate })
    const service = t.open()
    await service.analyze('p1', 'matte')
    await until(() => (t.progressOf('p1')?.chunks.length ?? 0) >= 3)
    g.set('work') // a exportação começou
    await until(() => t.lastJob('p1')?.waiting === 'gpu')
    const parked = t.progressOf('p1')!.chunks.length
    expect(parked).toBeLessThan(TOTAL_CHUNKS)
    expect(t.lastJob('p1')).toMatchObject({ state: 'queued', waiting: 'gpu', resumed: true })
    expect(t.messages('info').some((m) => m.includes('parou no pedaço') && m.includes('dar lugar a outro trabalho na placa'))).toBe(true)
    // enquanto a exportação roda, nada avança
    await new Promise((r) => setTimeout(r, 300))
    expect(t.progressOf('p1')!.chunks.length).toBe(parked)
    expect(t.calls.doneAtStart).toHaveLength(1)
    g.set(null)
    await service.idle()
    expect(t.calls.doneAtStart).toEqual([0, parked])
    expect(t.lastJob('p1')).toMatchObject({ state: 'done', fraction: 1 })
    expect(existsSync(join(t.dirs.p1!, MATTE_FILE))).toBe(true)
  })

  it('motor que não para sozinho: depois do prazo ele é encerrado à força e só se perde o pedaço em curso', async () => {
    const g = fakeGate()
    const t = setup({
      gate: g.gate,
      stopGraceMs: 80,
      engine: (inner) => {
        let stubborn = true
        return {
          ...inner,
          makeMatte: async (o) => {
            if (!stubborn || !o.parts) return inner.makeMatte(o)
            stubborn = false
            // grava três pedaços e depois ignora o pedido de parada: só sai quando é encerrado
            for (let i = 0; i < 3; i++) {
              const name = join(o.parts.dir, matteChunkName(i))
              mkdirSync(o.parts.dir, { recursive: true })
              writeFileSync(name, `pedaço ${i}`)
              o.parts.onChunk({ index: i, frames: CHUNK_S * 30, bytes: statSync(name).size })
            }
            writeFileSync(join(o.parts.dir, 'p0003.mp4.tmp'), 'pela metade')
            await new Promise<never>((_, reject) => {
              o.signal?.addEventListener('abort', () => reject(new Error('Cancelado.')), { once: true })
            })
            throw new Error('inalcançável')
          }
        }
      }
    })
    const service = t.open()
    await service.analyze('p1', 'matte')
    await until(() => (t.progressOf('p1')?.chunks.length ?? 0) >= 3)
    g.set('work')
    await until(() => t.lastJob('p1')?.waiting === 'gpu')
    expect(t.partsOf('p1')).toEqual(['p0000.mp4', 'p0001.mp4', 'p0002.mp4']) // o .tmp do pedaço em curso foi limpo
    g.set(null)
    await service.idle()
    // (a primeira chamada é do motor teimoso, que não passa pelo espião; a segunda começa DEPOIS dos três pedaços)
    expect(t.calls.doneAtStart).toEqual([3])
    expect(t.lastJob('p1')).toMatchObject({ state: 'done' })
  })

  it('fechar o app enquanto o recorte espera a placa: anotado como interrompido, sem erro', async () => {
    const g = fakeGate()
    g.set('work')
    const t = setup({ gate: g.gate })
    const service = t.open()
    await service.analyze('p1', 'matte')
    await until(() => t.lastJob('p1')?.waiting === 'gpu')
    await service.shutdown()
    expect(t.progressOf('p1')).toMatchObject({ status: 'interrupted', chunks: [] })
    expect(t.messages('error')).toEqual([])
    expect(t.messages('warn').some((m) => m.includes('interrompido pelo fechamento do app'))).toBe(true)
  })
})

describe('idle por tipo: quem não precisa do recorte não espera por ele', () => {
  it('idle({ kinds: ["face"] }) volta quando o rosto termina, com o recorte ainda rodando; idle() espera tudo', async () => {
    const t = setup({ delayMs: 1200 })
    const service = t.open()
    await service.analyze('p1', 'face')
    await service.analyze('p1', 'matte')
    await service.idle({ kinds: ['face'] })
    const faceDone = [...t.jobs].reverse().find((j) => j.kind === 'face' && j.state === 'done')
    expect(faceDone).toBeDefined()
    expect(t.lastJob('p1')!.state).not.toBe('done')
    // o recorte ainda não terminou, e quem só quer o rosto já pode seguir
    await service.idle({ kinds: ['matte'] })
    expect(t.lastJob('p1')).toMatchObject({ state: 'done' })
  })

  it('sem nada do tipo pedido na fila nem rodando, volta na hora (mesmo com outro tipo rodando)', async () => {
    const t = setup({ delayMs: 1500 })
    const service = t.open()
    await service.analyze('p1', 'matte')
    const started = Date.now()
    await service.idle({ kinds: ['face'] })
    expect(Date.now() - started).toBeLessThan(500)
    service.cancel('p1', 'matte')
    await service.idle()
  })
})

/** Esquece os trabalhos anunciados antes (para provar o que a abertura do app anuncia). */
function jobsReset(t: { jobs: CameraJob[] }): void {
  t.jobs.length = 0
}
