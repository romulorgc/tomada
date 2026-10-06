import { mkdir, open, readFile, realpath, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as manifests from '../../src/main/manifest'
import * as files from '../../src/main/fs-utils'
import { finalizeInterrupted } from '../../src/main/recording-recovery'
import type { Ffmpeg } from '../../src/main/ffmpeg'
import { createFakeWorld } from '../helpers/recording'
import { requireFfmpeg, useTmpDir } from '../helpers/env'

const tmp = useTmpDir('tomada-m5a-checkpoint-')
afterEach(() => vi.restoreAllMocks())
async function recording(clock?: () => number, failTracker = false) {
  const root = tmp(), world = createFakeWorld({ root, ffmpeg: requireFfmpeg(), clock, failTracker })
  world.trackerResult.raw = { cursor: [1000010, 10, 20], clicks: [{ t: 1000020, x: 10, y: 20, button: 'left' }], keys: [1000030], windowRects: [] }
  const p = await world.service.prepare({ mode: 'screen', sourceId: 'screen:0:0', fps: 30, cameraId: null, micId: null, systemAudio: false, showBubble: false, hideCursor: true })
  await world.service.countdown(); await world.service.go()
  await world.service.started({ t0: 1000000, screenStartAt: 1000000, cameraStartAt: null, frame: { w: 640, h: 360 }, clockOffsetMs: 0, clockRttMs: 1, screenMime: 'video/webm', cameraMime: null, screenHasAudio: false, cursorHidden: false, cameraHasVideo: false, cameraHasAudio: false, cameraSize: null, startEventLagMs: { screen: 0, camera: null } })
  return { root, world, dir: join(root, p.folder), folder: p.folder }
}
async function oldRaw(dir: string) { const date = new Date(Date.now() - 20000); await utimes(join(dir, 'raw/screen.webm'), date, date) }
it('outra sessão não oferece nem recupera ou descarta bruto ainda vivo', async () => {
  const { root, dir, folder, world } = await recording()
  try {
    await world.service.chunk('screen', new Uint8Array([1, 2, 3]))
    const second = createFakeWorld({ root, ffmpeg: null })
    expect(await second.service.listInterrupted()).toEqual([])
    await expect(second.service.recoverInterrupted(folder)).rejects.toThrow(/uso|ativa/)
    await expect(second.service.discardInterrupted(folder)).rejects.toThrow(/uso|ativa/)
    expect((await stat(join(dir, 'raw/screen.webm'))).size).toBe(3)
  } finally { await world.service.shutdown() }
})
it('shutdown guarda cursor, cliques e teclas no bruto', async () => {
  const { dir, world } = await recording()
  await world.service.shutdown()
  expect(JSON.parse(await readFile(join(dir, 'raw/events.json'), 'utf8'))).toEqual(world.trackerResult.raw)
})
it('checkpoint periódico preserva eventos antes de stop e shutdown', async () => {
  const { dir, world } = await recording()
  try {
    await new Promise(r => setTimeout(r, 1500))
    expect(JSON.parse(await readFile(join(dir, 'raw/events.json'), 'utf8'))).toEqual(world.trackerResult.raw)
    expect(world.trackers[0]!.running).toBe(true)
  } finally { await world.service.shutdown() }
})
it('checkpoint lento de eventos não bloqueia pedaço de vídeo aceito durante shutdown', async () => {
  const { dir, world } = await recording()
  const write = files.writeFileAtomic
  let release!: () => void, began!: () => void
  const entered = new Promise<void>(r => { began = r })
  const pending = new Promise<void>(r => { release = r })
  let delayed = false
  const spy = vi.spyOn(files, 'writeFileAtomic').mockImplementation(async (path, content) => {
    if (/events\.json$/.test(path) && !delayed) { delayed = true; began(); await pending }
    return write(path, content)
  })
  try {
    await entered
    const chunk = world.service.chunk('screen', new Uint8Array([1, 2, 3]))
    const shutdown = world.service.shutdown()
    const written = await Promise.race([chunk.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 200))])
    release(); await chunk; await shutdown
    expect(written).toBe(true)
    expect((await readFile(join(dir, 'raw/screen.webm'))).length).toBe(3)
  } finally { release(); spy.mockRestore(); await world.service.shutdown() }
})
it('checkpoint lento do manifesto não bloqueia mídia e shutdown drena todos os pedaços aceitos', async () => {
  const { dir, world } = await recording()
  const write = manifests.writeManifest
  let release!: () => void, began!: () => void, delayed = false
  const entered = new Promise<void>(r => { began = r })
  const pending = new Promise<void>(r => { release = r })
  const spy = vi.spyOn(manifests, 'writeManifest').mockImplementation(async (...args) => {
    if (!delayed) { delayed = true; began(); await pending }
    return write(...args)
  })
  try {
    const first = world.service.chunk('screen', new Uint8Array([1, 2]))
    await entered
    const second = world.service.chunk('screen', new Uint8Array([3, 4]))
    const shutdown = world.service.shutdown()
    const written = await Promise.race([Promise.all([first, second]).then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 200))])
    release(); await first; await second; await shutdown
    expect(written).toBe(true)
    expect((await readFile(join(dir, 'raw/screen.webm'))).length).toBe(4)
  } finally { release(); spy.mockRestore(); await world.service.shutdown() }
})
it.each(['pause', 'resume'] as const)('%s responde mesmo com manifesto pendente', async action => {
  const { world } = await recording()
  if (action === 'resume') await world.service.pause(1000100)
  const write = manifests.writeManifest
  let release!: () => void
  const pending = new Promise<void>(r => { release = r })
  const spy = vi.spyOn(manifests, 'writeManifest').mockImplementation(async (...args) => { await pending; return write(...args) })
  try {
    const command = world.service[action](1000200)
    const answered = await Promise.race([command.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 200))])
    release(); await command
    expect(answered).toBe(true)
    expect(world.service.status().status).toBe(action === 'pause' ? 'paused' : 'recording')
  } finally { release(); spy.mockRestore(); await world.service.shutdown() }
})
it.each([false, true])('pausa continua tentando metadados e avisa após 30 s mesmo sem novos pedaços (rastreador indisponível: %s)', async (failTracker) => {
  let now = 1000000
  const { world } = await recording(() => now, failTracker)
  const spy = vi.spyOn(manifests, 'writeManifest').mockRejectedValue(new Error('EPERM durante pausa'))
  try {
    await world.service.pause(1000100)
    now += 31000
    await new Promise(r => setTimeout(r, 1500))
    expect(spy.mock.calls.length).toBeGreaterThan(1)
    expect(world.emitted.filter(e => e.channel === 'record:notice' && /30 s/.test(e.payload.text))).toHaveLength(1)
    expect(world.service.status().status).toBe('paused')
  } finally { spy.mockRestore(); await world.service.shutdown() }
})
it('ausência de eventos é avisada na oferta antes da decisão', async () => {
  const { root, dir, world } = await recording()
  await world.service.chunk('screen', new Uint8Array([1])); await world.service.shutdown(); await oldRaw(dir)
  const { rm } = await import('node:fs/promises'); await rm(join(dir, 'raw/events.json'), { force: true })
  const list = await createFakeWorld({ root, ffmpeg: null }).service.listInterrupted()
  expect(list[0]).toMatchObject({ warning: expect.stringMatching(/cursor, cliques e teclas/) })
})
it('falha do checkpoint não rejeita pedaço nem interrompe vídeo e tenta no próximo', async () => {
  const { dir, world } = await recording()
  const realWrite = manifests.writeManifest
  const spy = vi.spyOn(manifests, 'writeManifest').mockRejectedValueOnce(new Error('EPERM metadado')).mockImplementation(realWrite)
  try {
    await expect(world.service.chunk('screen', new Uint8Array([1, 2]))).resolves.toBeUndefined()
    await world.service.chunk('screen', new Uint8Array([3, 4]))
    expect(world.service.status().status).toBe('recording')
    expect((await readFile(join(dir, 'raw/screen.webm'))).length).toBe(4)
    expect(world.logger.entries.some(e => e.level === 'warn' && /checkpoint/i.test(e.message))).toBe(true)
    expect(world.emitted.filter(e => e.channel === 'record:notice' && /vai parar/.test(e.payload.text))).toEqual([])
    expect(spy).toHaveBeenCalledTimes(2)
  } finally { spy.mockRestore(); await world.service.shutdown() }
})
it('manifesto inválido aparece com erro e log, pasta comum sem gravação é ignorada', async () => {
  const { root, dir, world } = await recording()
  await world.service.chunk('screen', new Uint8Array([1])); await world.service.shutdown(); await oldRaw(dir)
  await writeFile(join(dir, 'raw/recording.json'), '{ inválido')
  await mkdir(join(root, 'pasta comum'))
  const second = createFakeWorld({ root, ffmpeg: null })
  const list = await second.service.listInterrupted()
  expect(list).toHaveLength(1)
  expect(list[0]?.error).toMatch(/bruto.*ler/)
  expect(second.logger.entries.some(e => e.level === 'warn' && e.detail)).toBe(true)
})
it('checkpoint falhando por 30 s avisa uma vez, vídeo continua e sucesso reinicia a tolerância', async () => {
  let now = 1000000
  const { dir, world } = await recording(() => now)
  const realWrite = manifests.writeManifest
  const spy = vi.spyOn(manifests, 'writeManifest').mockRejectedValue(new Error('EPERM metadado'))
  try {
    await world.service.chunk('screen', new Uint8Array([1]))
    expect(world.emitted.filter(e => e.channel === 'record:notice')).toEqual([])
    now += 31000; await world.service.chunk('screen', new Uint8Array([2]))
    await world.service.chunk('screen', new Uint8Array([3]))
    expect(world.emitted.filter(e => e.channel === 'record:notice')).toHaveLength(1)
    expect(world.service.recording).toBe(true)
    spy.mockImplementation(realWrite); await world.service.chunk('screen', new Uint8Array([4]))
    spy.mockRejectedValue(new Error('EPERM outra vez')); now += 10000
    await world.service.chunk('screen', new Uint8Array([5]))
    expect(world.emitted.filter(e => e.channel === 'record:notice')).toHaveLength(1)
    expect((await stat(join(dir, 'raw/screen.webm'))).size).toBe(5)
  } finally { spy.mockRestore(); await world.service.shutdown() }
})
it('Parar com checkpoint ainda falhando libera a sessão e oferece processamento com retry', async () => {
  const { world } = await recording()
  const spy = vi.spyOn(manifests, 'writeManifest').mockRejectedValue(new Error('EPERM persistente'))
  try {
    await world.service.chunk('screen', new Uint8Array([1, 2, 3]))
    await expect(world.service.stop({ endedAt: 1001000, reason: 'user', frame: { w: 640, h: 360 }, notes: [] })).resolves.toMatchObject({ sessionId: expect.any(String) })
    expect(world.service.status().status).toBe('idle')
    await expect.poll(() => world.service.status().processing?.status).toBe('failed')
    expect(world.service.status().processing?.error).toBeDefined()
  } finally { spy.mockRestore(); await world.service.shutdown() }
})
it('descartar o bruto ilegível oferecido funciona após confirmação sem depender de ler seu manifesto', async () => {
  const { root, dir, folder, world } = await recording()
  await world.service.chunk('screen', new Uint8Array([1])); await world.service.shutdown(); await oldRaw(dir)
  await writeFile(join(dir, 'raw/recording.json'), '{ inválido')
  const second = createFakeWorld({ root, ffmpeg: null })
  const expectedDir = await realpath(dir)
  expect((await second.service.listInterrupted())[0]?.error).toBeDefined()
  await expect(second.service.discardInterrupted(folder)).resolves.toBeUndefined()
  expect(second.trashed).toEqual([expectedDir])
  await expect(stat(dir)).rejects.toThrow()
})
it('medição de WebM grande sem Duration dá tempo proporcional ao tamanho', async () => {
  const { dir, world } = await recording(); await world.service.shutdown()
  const file = await open(join(dir, 'raw/screen.webm'), 'w'); await file.truncate(2 * 1024 ** 3); await file.close()
  const manifest = await manifests.readManifest(dir)
  let timeout = 0
  const ff = { probe: async () => ({ durationMs: 0 }), run: async (_args: string[], opts: { timeoutMs: number; onProgress: (p: { timeMs: number }) => void }) => { timeout = opts.timeoutMs; opts.onProgress({ timeMs: 3600000 }); return { stderr: '', stdout: '' } } } as unknown as Ffmpeg
  await finalizeInterrupted(dir, manifest, ff)
  expect(timeout).toBeGreaterThanOrEqual(300000)
  expect(manifest.recordedMs).toBe(3600000)
})
