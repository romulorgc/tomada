import { copyFile, mkdir, readFile, realpath, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readManifest, writeManifest, type RecordingManifest } from '../../src/main/manifest'
import { parseProject } from '../../src/shared/project'
import { createFakeWorld } from '../helpers/recording'
import { FIX, requireFfmpeg, useTmpDir } from '../helpers/env'

const tmp = useTmpDir('tomada-m5a-recovery-')
const ff = requireFfmpeg()

async function seed(root: string, over: Partial<RecordingManifest> = {}) {
  const folder = 'Gravação interrompida'
  const dir = join(root, folder)
  await mkdir(join(dir, 'raw'), { recursive: true })
  await ff.run(['-i', FIX.camera, '-t', '1.2', '-c', 'copy', join(dir, 'raw/camera.webm')])
  const manifest: RecordingManifest = {
    version: 1, sessionId: 'interrupted-1', folder, title: 'Teste sintético', createdAt: '2026-10-05T12:00:00Z', mode: 'camera', fps: 30,
    screen: null, camera: { file: 'raw/camera.webm', mime: 'video/webm', hasVideo: true, hasAudio: true, size: { w: 640, h: 360 } },
    clock: { t0: 100_000, screenStartAt: null, cameraStartAt: 100_000, offsetMs: 0, rttMs: 1 },
    pauses: [{ start: 100_400, end: 100_600 }], endedAt: null, stopReason: null, recordedMs: null, notes: [], saved: null, processedAt: null,
    ...over
  }
  await writeManifest(dir, manifest)
  const old = new Date(Date.now() - 20000)
  await utimes(join(dir, 'raw/camera.webm'), old, old)
  return { dir, folder }
}

describe('gravações interrompidas', () => {
  it('grava checkpoints da pausa aberta, das pausas fechadas e do último pedaço antes de fechar', async () => {
    const root = tmp(), world = createFakeWorld({ root, ffmpeg: ff })
    const prepared = await world.service.prepare({ mode: 'screen', sourceId: 'screen:0:0', fps: 30, cameraId: null, micId: null, systemAudio: false, showBubble: false, hideCursor: true })
    await world.service.countdown(); await world.service.go()
    await world.service.started({ t0: 1_000_000, screenStartAt: 1_000_000, cameraStartAt: null, frame: { w: 640, h: 360 }, clockOffsetMs: 0, clockRttMs: 1, screenMime: 'video/webm', cameraMime: null, screenHasAudio: false, cursorHidden: false, cameraHasVideo: false, cameraHasAudio: false, cameraSize: null, startEventLagMs: { screen: 0, camera: null } })
    const dir = join(root, prepared.folder)
    await world.service.chunk('screen', new Uint8Array([1, 2, 3]))
    await expect.poll(async () => (await readManifest(dir)).lastChunkAt).toBeGreaterThan(1_000_000)
    await world.service.pause(1_000_100)
    await expect.poll(async () => (await readManifest(dir)).openPauseAt).toBe(1_000_100)
    await world.service.resume(1_000_200)
    await expect.poll(async () => (await readManifest(dir)).pauses).toEqual([{ start: 1_000_100, end: 1_000_200 }])
    await world.service.pause(1_000_300)
    await world.service.shutdown()
    expect((await readManifest(dir)).openPauseAt).toBe(1_000_300)
    expect((await stat(join(dir, 'raw/screen.webm'))).size).toBe(3)
    expect(world.trackers[0]!.running).toBe(false)
  })

  it('oferece o bruto sem modificá-lo nem processar antes da decisão', async () => {
    const root = tmp(), { dir, folder } = await seed(root)
    const before = await readFile(join(dir, 'raw/recording.json'), 'utf8')
    const world = createFakeWorld({ root, ffmpeg: ff })
    await world.service.recover()
    const list = await world.service.listInterrupted()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: folder, sessionId: 'interrupted-1', title: 'Teste sintético' })
    expect(list[0]!.bytes).toBe((await stat(join(dir, 'raw/camera.webm'))).size)
    expect(await readFile(join(dir, 'raw/recording.json'), 'utf8')).toBe(before)
    expect(world.service.status().processing).toBeNull()
  })

  it('recupera a duração da mídia sem acrescentar o tempo que o app ficou fechado', async () => {
    const root = tmp(), { dir, folder } = await seed(root, { openPauseAt: 101_500, lastChunkAt: 101_500 })
    const world = createFakeWorld({ root, ffmpeg: ff })
    await world.service.recoverInterrupted(folder)
    const manifest = await readManifest(dir)
    expect(manifest.recordedMs).toBeGreaterThanOrEqual(1200)
    expect(manifest.recordedMs).toBeLessThan(1600)
    expect(manifest.pauses).toContainEqual({ start: 100_400, end: 100_600 })
    expect(manifest.openPauseAt).toBeNull()
    expect(world.service.status().processing?.status).toBe('done')
    const project = parseProject(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(project.sources.camera!.durationMs).toBeLessThan(1600)
    expect(await world.service.listInterrupted()).toEqual([])
    expect((await stat(join(dir, 'raw/camera.webm'))).size).toBeGreaterThan(0)
  })

  it('recupera WebM aberto cujo cabeçalho não tem Duration, só pelos pacotes gravados', async () => {
    const root = tmp(), { dir, folder } = await seed(root)
    await ff.run(['-i', FIX.camera, '-t', '1.2', '-c', 'copy', '-live', '1', join(dir, 'raw/camera.webm')])
    const old = new Date(Date.now() - 20000)
    await utimes(join(dir, 'raw/camera.webm'), old, old)
    expect((await ff.probe(join(dir, 'raw/camera.webm'))).durationMs).toBe(0)
    const world = createFakeWorld({ root, ffmpeg: ff })
    await world.service.recoverInterrupted(folder)
    expect((await readManifest(dir)).recordedMs).toBeGreaterThanOrEqual(1200)
    expect(world.service.status().processing?.status).toBe('done')
  })

  it('falha visível mantém bruto e decisão, e outra tentativa termina', async () => {
    const root = tmp(), { dir, folder } = await seed(root)
    const world = createFakeWorld({ root, ffmpeg: ff, env: { TOMADA_TEST_FAIL_STEP: 'camera' } })
    await world.service.recoverInterrupted(folder)
    expect(world.service.status().processing?.status).toBe('failed')
    expect((await world.service.listInterrupted())[0]?.error).toContain('camera')
    expect((await stat(join(dir, 'raw/camera.webm'))).size).toBeGreaterThan(0)
    await world.service.recoverInterrupted(folder)
    expect(world.service.status().processing?.status).toBe('done')
  })

  it('duas decisões simultâneas não processam nem apagam a mesma gravação em paralelo', async () => {
    const root = tmp(), { dir, folder } = await seed(root)
    const world = createFakeWorld({ root, ffmpeg: ff })
    const recovering = world.service.recoverInterrupted(folder)
    await expect(world.service.discardInterrupted(folder)).rejects.toThrow('Espere')
    await expect(world.service.recoverInterrupted(folder)).rejects.toThrow('Espere')
    await recovering
    expect(world.service.status().processing?.status).toBe('done')
    expect((await stat(join(dir, 'raw/camera.webm'))).size).toBeGreaterThan(0)
  })

  it('reserva a preparação antes de ler o disco e impede outra gravação ou recuperação concorrente', async () => {
    const root = tmp(), { folder } = await seed(root)
    const world = createFakeWorld({ root, ffmpeg: ff })
    const request = { mode: 'screen' as const, sourceId: 'screen:0:0', fps: 30 as const, cameraId: null, micId: null, systemAudio: false, showBubble: false, hideCursor: true }
    const results = await Promise.allSettled([
      world.service.prepare(request),
      world.service.recoverInterrupted(folder),
      world.service.prepare(request)
    ])
    await world.service.abort('teste')
    expect(results[0].status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('Espere') }) })
    expect(results[2]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('andamento') }) })
  })

  it('repetir processamento não reabre arquivos durante um descarte já aceito', async () => {
    const root = tmp(), { dir, folder } = await seed(root)
    const world = createFakeWorld({ root, ffmpeg: ff, env: { TOMADA_TEST_FAIL_STEP: 'camera' }, trashDelayMs: 100 })
    await world.service.recoverInterrupted(folder)
    expect(world.service.status().processing?.status).toBe('failed')
    const results = await Promise.allSettled([
      world.service.discardInterrupted(folder),
      world.service.retry('interrupted-1')
    ])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('Espere') }) })
    await expect(stat(dir)).rejects.toThrow()
    expect(world.service.status().processing).toBeNull()
  })

  it('descartar exige id dentro da raiz e só remove a gravação escolhida', async () => {
    const root = tmp(), { dir, folder } = await seed(root)
    const other = join(root, 'Outro projeto')
    await mkdir(other)
    await writeFile(join(other, 'nao-apagar.txt'), 'preservar')
    const world = createFakeWorld({ root, ffmpeg: ff })
    const expectedDir = await realpath(dir)
    await expect(world.service.discardInterrupted('../fora')).rejects.toThrow()
    await world.service.discardInterrupted(folder)
    await expect(stat(dir)).rejects.toThrow()
    expect(await readFile(join(other, 'nao-apagar.txt'), 'utf8')).toBe('preservar')
    expect(world.trashed).toEqual([expectedDir])
  })

  it('recusa bruto e manifesto em junções externas antes de ler, recuperar ou descartar', async () => {
    const root = tmp(), outside = tmp(), { dir, folder } = await seed(root)
    await copyFile(join(dir, 'raw/camera.webm'), join(outside, 'camera.webm'))
    const manifest = await readManifest(dir)
    manifest.camera!.file = '../camera.webm' as 'raw/camera.webm'
    await writeManifest(dir, manifest)
    const world = createFakeWorld({ root, ffmpeg: ff })
    await expect(world.service.recoverInterrupted(folder)).rejects.toThrow()
    await symlink(outside, join(root, 'Junção externa'), 'junction')
    await expect(world.service.discardInterrupted('Junção externa')).rejects.toThrow()
    expect(await readFile(join(outside, 'camera.webm'))).toHaveLength((await stat(join(outside, 'camera.webm'))).size)
    expect(world.service.status().processing).toBeNull()
  })
})
