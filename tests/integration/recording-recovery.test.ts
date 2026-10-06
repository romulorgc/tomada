import { copyFile, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { createFakeWorld } from '../helpers/recording'
import { FIX, requireFfmpeg, useTmpDir } from '../helpers/env'
import { createProcessContext, runProcessing } from '../../src/main/processing'
import { readManifest, writeManifest, type RecordingManifest } from '../../src/main/manifest'
import * as manifestModule from '../../src/main/manifest'
import { parseProject, serializeProject } from '../../src/shared/project'
import { createMemoryLogger } from '../../src/main/logger'

const tmp = useTmpDir()
const ff = requireFfmpeg()
async function seed(root: string): Promise<string> {
  const dir = join(root, 'Recuperar gravação')
  await mkdir(join(dir, 'raw'), { recursive: true })
  await copyFile(FIX.camera, join(dir, 'raw/camera.webm'))
  const manifest: RecordingManifest = { version: 1, sessionId: 'resume-test', folder: 'Recuperar gravação', title: 'Agenda', createdAt: '2026-10-05T12:00:00Z', mode: 'camera', fps: 30, screen: null, camera: { file: 'raw/camera.webm', mime: 'video/webm', hasVideo: true, hasAudio: true, size: { w: 640, h: 360 } }, clock: { t0: 0, cameraStartAt: 0, screenStartAt: null, offsetMs: 0, rttMs: 1 }, pauses: [], endedAt: 1000, stopReason: 'user', recordedMs: 1000, notes: [], saved: null, processedAt: null, script: { title: 'Agenda', hook: 'Comece.', topics: ['Um', 'Dois', 'Três'], closing: 'Experimente.' }, retakeMarks: [{ t: 700 }] }
  await writeManifest(dir, manifest)
  return dir
}

describe('recuperação do processamento', () => {
  it('ffmpeg ausente expõe falha recuperável e emitir progresso habilita a nova tentativa', async () => {
    const root = tmp(), dir = await seed(root)
    const deps = { root, ffmpeg: null as typeof ff | null }
    const world = createFakeWorld(deps)
    await world.service.recover()
    expect(world.service.status().processing).toMatchObject({ status: 'failed', error: { step: 'save', message: expect.stringContaining('ffmpeg') } })
    expect(world.emitted.some((e) => e.channel === 'process:progress' && e.payload.status === 'failed')).toBe(true)
    deps.ffmpeg = ff
    await world.service.retry('resume-test')
    expect(world.service.status().processing?.status).toBe('done')
    expect((await readManifest(dir)).processedAt).not.toBeNull()
  })
  it('checkpoint que não grava deixa a etapa incompleta e retry refaz a mídia removida', async () => {
    const dir = await seed(tmp())
    const ctx = createProcessContext({ dir, manifest: await readManifest(dir), rawEvents: null })
    const realWrite = manifestModule.writeManifest
    let failed = false
    const spy = vi.spyOn(manifestModule, 'writeManifest').mockImplementation(async (path, manifest) => {
      if (!failed && manifest.processing?.done.includes('voice')) { failed = true; throw new Error('disco falhou no checkpoint') }
      return realWrite(path, manifest)
    })
    try {
      const first = await runProcessing(ctx, { ff, logger: createMemoryLogger(), onProgress: () => undefined })
      expect(first.status).toBe('failed')
      expect(ctx.done.has('voice')).toBe(false)
      expect(existsSync(join(dir, 'media/voice.wav'))).toBe(false)
      const second = await runProcessing(ctx, { ff, logger: createMemoryLogger(), onProgress: () => undefined })
      expect(second.status).toBe('done')
      expect(existsSync(join(dir, 'media/voice.wav'))).toBe(true)
      expect(parseProject(await readFile(join(dir, 'project.json'), 'utf8')).sources.voice).toBeDefined()
    } finally { spy.mockRestore() }
  })
  it('guarda passos e mídias e retoma após recriar o contexto', async () => {
    const dir = await seed(tmp())
    const manifest = await readManifest(dir)
    const ctx = createProcessContext({ dir, manifest, rawEvents: null })
    const first = await runProcessing(ctx, { ff, logger: createMemoryLogger(), onProgress: () => undefined, beforeStep: (id) => { if (id === 'voice') throw new Error('interrupção') } })
    expect(first.status).toBe('failed')
    const stored = await readManifest(dir)
    expect(stored.processing?.done).toEqual(['save', 'camera'])
    expect(stored.processing?.sources.camera?.path).toBe('media/camera.mp4')
    const resumed = createProcessContext({ dir, manifest: stored, rawEvents: null })
    const second = await runProcessing(resumed, { ff, logger: createMemoryLogger(), onProgress: () => undefined, beforeStep: (id) => { if (id === 'save' || id === 'camera') throw new Error('passo já pronto repetido') } })
    expect(second.status).toBe('done')
    expect(parseProject(await readFile(join(dir, 'project.json'), 'utf8')).retakeMarks).toEqual([{ t: 700 }])
  })
  it('ao concluir, o manifesto leva a intenção do piloto junto com processedAt (e antes disso não leva)', async () => {
    const dir = await seed(tmp())
    const ctx = createProcessContext({ dir, manifest: await readManifest(dir), rawEvents: null })
    const first = await runProcessing(ctx, { ff, logger: createMemoryLogger(), onProgress: () => undefined, beforeStep: (id) => { if (id === 'project') throw new Error('interrupção antes de fechar') } })
    expect(first.status).toBe('failed')
    const midway = await readManifest(dir)
    expect(midway.processedAt).toBeNull()
    expect(midway.autopilotPending).toBeUndefined()
    const second = await runProcessing(createProcessContext({ dir, manifest: midway, rawEvents: null }), { ff, logger: createMemoryLogger(), onProgress: () => undefined })
    expect(second.status).toBe('done')
    const done = await readManifest(dir)
    expect(done.processedAt).not.toBeNull()
    expect(done.autopilotPending).toBe(true)
  })
  it('serviço recupera gravação parada e não reescreve o documento já editado', async () => {
    const root = tmp(), dir = await seed(root)
    const world = createFakeWorld({ root, ffmpeg: ff })
    await world.service.recover()
    const edited = parseProject(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(edited.script?.title).toBe('Agenda')
    edited.title = 'Título alterado à mão'
    edited.cuts.push({ id: 'manual-test', start: 100, end: 200, reason: 'manual', enabled: true, origin: 'manual' })
    const before = serializeProject(edited)
    await writeFile(join(dir, 'project.json'), before)
    await createFakeWorld({ root, ffmpeg: ff }).service.recover()
    expect(await readFile(join(dir, 'project.json'), 'utf8')).toBe(before)
  })
  it('recusa caminhos de bruto que tentam escapar', async () => {
    const root = tmp(), dir = await seed(root)
    const manifest = await readManifest(dir)
    manifest.camera!.file = '../fora.webm' as 'raw/camera.webm'
    await writeManifest(dir, manifest)
    const world = createFakeWorld({ root, ffmpeg: ff })
    await world.service.recover()
    expect(world.service.status().processing).toBeNull()
    expect(world.emitted.some((e) => e.channel === 'record:notice' && e.payload.kind === 'error')).toBe(true)
  })
  it('deixa gravação sem instante de parada quieta', async () => {
    const root = tmp(), dir = await seed(root)
    const manifest = await readManifest(dir)
    manifest.endedAt = null
    await writeManifest(dir, manifest)
    const world = createFakeWorld({ root, ffmpeg: ff })
    await world.service.recover()
    expect(world.service.status().processing).toBeNull()
    expect((await readManifest(dir)).processedAt).toBeNull()
  })
})
