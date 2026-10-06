import { copyFile, mkdir, readFile, symlink } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createExportService } from '../../src/main/export-service'
import { createMemoryLogger } from '../../src/main/logger'
import { createOutputDirs } from '../../src/main/path-guard'
import { parseProject } from '../../src/shared/project'
import { checkDiskSpace } from '../../src/main/disk-space'
import { FIX, useTmpDir } from '../helpers/env'
import { createFakeWorld } from '../helpers/recording'

const tmp = useTmpDir('tomada-m5a-disk-')
const disk = vi.hoisted(() => ({ low: false }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, statfs: async (...args: Parameters<typeof fs.statfs>) => disk.low ? { type: 1, bsize: 4096, blocks: 10, bfree: 1, bavail: 1, files: 10, ffree: 1 } : actual.statfs(...args) }
})
describe('disco antes de começar', () => {
  it('espaço livre vem do sistema de arquivos mesmo antes da pasta de saída existir', async () => {
    const result = await checkDiskSpace(join(tmp(), 'ainda', 'nao', 'existe'), 300_000_000, 30_000, 'Vídeo e mux')
    expect(result.freeBytes).toBeGreaterThan(0)
    expect(result.estimatedBytes).toBe(300_000_000)
  })
  it('disco baixo avisa a estimativa e o motivo antes da gravação, sem impedir', async () => {
    disk.low = true
    try {
      const world = createFakeWorld({ root: tmp(), ffmpeg: {} as never })
      const request = { mode: 'screen' as const, sourceId: 'screen:0:0', fps: 30 as const, cameraId: null, micId: null, systemAudio: false, showBubble: false, hideCursor: true }
      const estimate = await world.service.diskSpace(request)
      expect(estimate.status).toBe('low')
      expect(estimate.durationMs).toBe(3_600_000)
      expect(estimate.estimatedBytes).toBeGreaterThan(10_000_000_000)
      await world.service.prepare(request)
      const notice = world.emitted.find((e) => e.channel === 'record:notice')
      expect(notice?.payload).toMatchObject({ text: expect.stringContaining('normalizada') })
      expect(world.service.status().status).toBe('preparing')
      await world.service.abort()
    } finally { disk.low = false }
  })
  it('exportação estima a duração após cortes e recusa pastas sem autorização ou junções externas', async () => {
    const dir = tmp(), outside = tmp()
    await mkdir(join(dir, 'media'))
    await copyFile(join(FIX.exemplo, 'media/screen.mp4'), join(dir, 'media/screen.mp4'))
    const project = parseProject(await readFile(join(FIX.exemplo, 'project.json'), 'utf8'))
    project.sources = { screen: { ...project.sources.screen!, durationMs: 3_600_000 } }
    project.cuts = [{ id: 'c', start: 60_000, end: 3_600_000, reason: 'manual', enabled: true }]
    const service = createExportService({ read: async () => ({ dir, project }), ffmpeg: () => null, outputDirs: createOutputDirs(), logger: createMemoryLogger(), now: () => Date.now(), emit: () => undefined, openExporterWindow: () => { throw new Error('A estimativa não inicia renderização') } })
    const estimate = await service.diskSpace({ projectId: 'p', resolution: '1080p', fps: 30 })
    expect(estimate.durationMs).toBe(60_000)
    expect(estimate.estimatedBytes).toBeLessThan(400_000_000)
    await expect(service.diskSpace({ projectId: 'p', resolution: '1080p', fps: 30, dir: outside })).rejects.toThrow('não foi escolhida')
    await fs.rm(join(dir, 'exports'), { recursive: true, force: true })
    await symlink(outside, join(dir, 'exports'), 'junction')
    await expect(service.diskSpace({ projectId: 'p', resolution: '1080p', fps: 30 })).rejects.toThrow('fora da pasta')
  })
})
