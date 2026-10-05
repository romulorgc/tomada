/**
 * Descartar uma gravação (barra flutuante, "recomeçar", contagem cancelada) sem deixar nada para trás.
 *
 * Causa do teste e2e "descartar pela barra" que falhava ~1 em 7 e deixava a pasta da gravação sobrando:
 *  1. ORDEM: o main devolvia a janela (e a interface dava a gravação por descartada) ANTES de apagar a
 *     pasta; quem olhava o disco logo depois da janela voltar via a pasta ainda lá.
 *  2. PEDAÇO EM VOO: um pedaço do MediaRecorder que já estava a caminho abria o arquivo DEPOIS que o
 *     descarte tinha fechado os arquivos e levado a pasta: handle vazado (só fechava na coleta de lixo)
 *     e arquivo recriado dentro da pasta que estava sumindo.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { StartedInfo } from '../../src/shared/ipc'
import type { RecordRequest } from '../../src/shared/recording'
import { FIX, requireFfmpeg, useTmpDir } from '../helpers/env'
import { createFakeWorld } from '../helpers/recording'

const spy = vi.hoisted(() => ({ handles: [] as { fd: number }[] }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      spy.handles.push(handle)
      return handle
    }
  }
})

const tmp = useTmpDir()
const ff = requireFfmpeg()

const request: RecordRequest = {
  mode: 'screen-camera',
  sourceId: 'screen:0:0',
  fps: 30,
  cameraId: 'cam-1',
  micId: 'mic-1',
  systemAudio: false,
  showBubble: true,
  hideCursor: true
}

const started = (): StartedInfo => ({
  t0: 5_000_000,
  screenStartAt: 5_000_000,
  cameraStartAt: 5_000_000.4,
  startEventLagMs: { screen: 210, camera: 15 },
  frame: { w: 1920, h: 1080 },
  clockOffsetMs: 0,
  clockRttMs: 0.1,
  screenMime: 'video/webm;codecs=vp9',
  cameraMime: 'video/webm;codecs=vp9,opus',
  screenHasAudio: false,
  cursorHidden: false,
  cameraHasVideo: true,
  cameraHasAudio: true,
  cameraSize: { w: 640, h: 360 }
})

async function recordingWorld(over: Partial<Parameters<typeof createFakeWorld>[0]> = {}) {
  const root = join(tmp(), 'projetos')
  const world = createFakeWorld({ root, ffmpeg: ff, ...over })
  const prepared = await world.service.prepare(request)
  expect(await world.service.countdown()).toBe(true)
  await world.service.go()
  await world.service.started(started())
  return { world, root, folder: join(root, prepared.folder) }
}

describe('descartar', () => {
  it('a janela só volta DEPOIS de a pasta da gravação sair do disco', async () => {
    const { world, folder } = await recordingWorld({ trashDelayMs: 150 })
    await world.service.chunk('screen', Buffer.from('pedaço'))
    expect(existsSync(folder)).toBe(true)
    await world.service.abort('descartada pelo usuário')
    expect(existsSync(folder)).toBe(false)
    const calls = world.calls
    expect(calls.indexOf('trash:feito'), 'a pasta tinha de sumir antes').toBeGreaterThan(-1)
    expect(calls.indexOf('main restaurada')).toBeGreaterThan(calls.indexOf('trash:feito'))
    expect(world.service.status().status).toBe('idle')
  })

  it('contagem cancelada: idem, nada no disco quando a janela volta', async () => {
    const root = join(tmp(), 'projetos')
    const world = createFakeWorld({ root, ffmpeg: ff, trashDelayMs: 100 })
    await world.service.prepare(request)
    world.countdownResult.value = false
    expect(await world.service.countdown()).toBe(false)
    expect(world.calls.indexOf('main restaurada')).toBeGreaterThan(world.calls.indexOf('trash:feito'))
  })

  it('pedaços em voo no instante do descarte: nenhum arquivo fica aberto, nenhuma pasta sobra (60 rodadas)', async () => {
    const dir = tmp()
    mkdirSync(dir, { recursive: true })
    await ff.run(['-i', FIX.telaVfr, '-t', '1', '-c', 'copy', join(dir, 'tela.webm')])
    const chunk = readFileSync(join(dir, 'tela.webm')).subarray(0, 40_000)

    for (let i = 0; i < 60; i++) {
      spy.handles.length = 0
      const { world, folder } = await recordingWorld()
      // pedaços "no ar" (sem esperar) e o descarte logo atrás, como a interface faz
      const late = [world.service.chunk('screen', chunk), world.service.chunk('camera', chunk), world.service.chunk('screen', chunk)]
      if (i % 3 === 1) await new Promise((r) => setImmediate(r))
      if (i % 3 === 2) await new Promise((r) => setTimeout(r, 1))
      await world.service.abort('descartada pelo usuário')
      await Promise.allSettled(late)
      await new Promise((r) => setTimeout(r, 5)) // qualquer abertura atrasada já teria terminado
      expect(existsSync(folder), `rodada ${i}: a pasta sobrou`).toBe(false)
      const open = spy.handles.filter((h) => h.fd !== -1).length
      expect(open, `rodada ${i}: ${open} arquivo(s) ainda aberto(s)`).toBe(0)
      const failed = world.logger.entries.filter((e) => e.level === 'warn' && /apagar a pasta/.test(e.message))
      expect(failed, `rodada ${i}: apagar a pasta falhou`).toEqual([])
    }
  }, 120_000)

  it('pedaço que chega depois do descarte é ignorado sem erro', async () => {
    const { world } = await recordingWorld()
    await world.service.abort('descartada pelo usuário')
    await expect(world.service.chunk('screen', Buffer.from('atrasado'))).resolves.toBeUndefined()
  })
})
