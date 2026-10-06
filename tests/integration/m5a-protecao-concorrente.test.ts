import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createAutopilot, type AutopilotDeps } from '../../src/main/autopilot'
import { createMemoryLogger } from '../../src/main/logger'
import { DEFAULT_AUTOPILOT } from '../../src/shared/autopilot'
import { createProject } from '../../src/shared/project'
import { itemOf } from '../../src/shared/review'
import type { ExportProgress } from '../../src/shared/ipc'
import { createExportService, type ExportService } from '../../src/main/export-service'
import type { Ffmpeg } from '../../src/main/ffmpeg'
import { createOutputDirs } from '../../src/main/path-guard'
import { useTmpDir } from '../helpers/env'

const tmp = useTmpDir('tomada-m5a-protecao-')
const copyHook = vi.hoisted(() => ({ beforeCopy: null as null | (() => Promise<void>) }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
    await copyHook.beforeCopy?.()
    return actual.copyFile(...args)
  } }
})

it('proteção salva enquanto uma exportação está em voo impede publicar o arquivo da fotografia anterior', async () => {
  const dir = tmp()
  await mkdir(join(dir, 'exports'))
  const outputPath = join(dir, 'exports', 'sem-protecao.mp4')
  await writeFile(outputPath, 'Saída simulada; nenhum vídeo/dado do usuário.')
  const base = createProject({ id: 'concorrente', title: 'Demonstração sintética', sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: 2000 } } })
  let stored = structuredClone(base)
  let started!: () => void
  let finish!: () => void
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  const finishedPromise = new Promise<void>(resolve => { finish = resolve })
  let exporting = false
  let renderedProtection: typeof base.blurRegions
  const done: ExportProgress = { exportId: 'old', projectId: base.id, phase: 'done', fraction: 1, frame: 60, totalFrames: 60, renderFps: null, etaMs: 0, audioReady: true, outputPath }
  const deps = {
    store: { read: async () => ({ project: structuredClone(stored), dir }), write: async (_id: string, p: typeof base) => { stored = structuredClone(p) } },
    exporter: {
      start: async () => { renderedProtection = structuredClone(stored.blurRegions); exporting = true; started(); return { exportId: 'old' } },
      idle: async () => { if (exporting) await finishedPromise },
      status: () => done
    },
    transcription: { idle: async () => undefined }, derived: {}, llm: {}, logger: createMemoryLogger(),
    prefs: () => DEFAULT_AUTOPILOT, emit: vi.fn(), ready: vi.fn()
  } as unknown as AutopilotDeps
  const service = createAutopilot(deps)
  const pending = service.reexport(base.id, 'youtube').catch(() => undefined)
  await startedPromise
  expect(renderedProtection).toBeUndefined()
  try {
    await service.saveProject(base.id, { ...base, blurRegions: [{ id: 'b1', start: 0, end: 2000, rect: { x: .2, y: .2, w: .4, h: .4 }, mode: 'solid' }] }, base)
  } finally { finish() }
  await pending
  expect(stored.blurRegions).toHaveLength(1)
  expect(itemOf(stored, 'youtube').phase).toBe('error')
  expect(itemOf(stored, 'youtube').exportPath).toBeUndefined()
  expect(itemOf(stored, 'youtube').error).toContain('proteção')
})

it('proteção salva durante a cópia para postar impede entregar a pasta com o vídeo anterior', async () => {
  const dir = tmp()
  await mkdir(join(dir, 'exports'))
  await writeFile(join(dir, 'exports', 'anterior.mp4'), 'Arquivo sintético SEM proteção; nenhum dado do usuário.')
  const base = createProject({ id: 'postar-concorrente', title: 'Demonstração sintética', sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: 2000 } } })
  base.review = { items: { youtube: { decision: 'approved', origin: 'manual', phase: 'ready', exportPath: 'exports/anterior.mp4' } } }
  let stored = structuredClone(base)
  let reached!: () => void
  let release!: () => void
  const copying = new Promise<void>(resolve => { reached = resolve })
  const hold = new Promise<void>(resolve => { release = resolve })
  copyHook.beforeCopy = async () => { reached(); await hold }
  const service = createAutopilot({
    store: { read: async () => ({ project: structuredClone(stored), dir }), write: async (_id: string, p: typeof base) => { stored = structuredClone(p) } },
    exporter: { protectionChanged: vi.fn() },
    transcription: { getTranscript: async () => ({ words: [{ i: 0, text: 'Teste', start: 0, end: 1000, prob: 1, kind: 'word' }] }) },
    derived: {}, llm: {}, logger: createMemoryLogger(), prefs: () => DEFAULT_AUTOPILOT, emit: vi.fn(), ready: vi.fn()
  } as unknown as AutopilotDeps)
  const posting = service.postingFolder(base.id)
  // Anexa o tratamento antes da liberação: a correção deve rejeitar com motivo explícito.
  const outcome = posting.then(folder => ({ folder, error: null }), err => ({ folder: null, error: err as Error }))
  try {
    await copying
    await service.saveProject(base.id, { ...base, blurRegions: [{ id: 'b1', start: 0, end: 2000, rect: { x: .2, y: .2, w: .4, h: .4 }, mode: 'solid' }] }, base)
    release()
    const result = await outcome
    expect(itemOf(stored, 'youtube').phase).toBe('error')
    expect(result.folder).toBeNull()
    expect(result.error?.message).toContain('proteção')
    expect((await readdir(join(dir, 'exports', 'postar'))).filter(name => name.endsWith('.mp4'))).toEqual([])
    expect(await readFile(join(dir, 'exports', 'anterior.mp4'), 'utf8')).toContain('SEM proteção')
  } finally { release(); await outcome; copyHook.beforeCopy = null }
})

it('mudança de proteção avisada antes de reservar o render não pode se perder durante preparo e escrita pendente', async () => {
  const dir = tmp()
  await mkdir(join(dir, 'media'))
  await writeFile(join(dir, 'media', 'screen.mp4'), 'Fonte sintética; sem vídeo/dado do usuário.')
  const base = createProject({ id: 'preparo-concorrente', title: 'Preparação sintética', sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: 2000 } } })
  let stored = structuredClone(base)
  let reached!: () => void
  let release!: () => void
  const preparing = new Promise<void>(resolve => { reached = resolve })
  const hold = new Promise<void>(resolve => { release = resolve })
  const ff = {
    run: async (args: string[]) => { await writeFile(args.at(-1)!, 'Saída simulada de ffmpeg.'); return { stderr: '', stdout: '' } },
    probe: async () => ({ durationMs: 2000, streams: [{ type: 'video', durationMs: 2000, width: 1920, height: 1080, fps: 30, rFps: 30, nbFrames: 60 }, { type: 'audio', durationMs: 2000 }] })
  } as unknown as Ffmpeg
  let service!: ExportService
  service = createExportService({
    logger: createMemoryLogger(), read: async () => ({ dir, project: structuredClone(stored) }), outputDirs: createOutputDirs(), ffmpeg: () => ff,
    words: async () => { reached(); await hold; return null }, now: () => performance.now(), emit: () => undefined,
    openExporterWindow: exportId => { setTimeout(() => service.finish(exportId, { ok: true, frames: 60, encoder: 'simulado' }), 0); return { destroy: () => undefined } }
  })
  const attempt = service.start({ projectId: base.id, resolution: '1080p', fps: 30 }).then(value => ({ exportId: value.exportId, error: null }), error => ({ exportId: null, error: error as Error }))
  try {
    await preparing
    let becameIdle = false
    const idleWhilePreparing = service.idle().then(() => {becameIdle = true})
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(becameIdle,'O preparo também ocupa a exportação enquanto aguarda IO').toBe(false)
    // O save avisa sincronamente antes do write atômico; enquanto ele demora, read ainda devolve a fotografia anterior.
    service.protectionChanged(base.id)
    release()
    const started = await attempt
    await idleWhilePreparing
    await service.idle()
    stored = { ...base, blurRegions: [{ id: 'nova', start: 0, end: 2000, rect: { x: .2, y: .2, w: .4, h: .4 }, mode: 'solid' }] }
    if (started.exportId) expect(service.status(started.exportId)).toMatchObject({ phase: 'error', message: expect.stringContaining('proteção') })
    else expect(started.error?.message).toContain('proteção')
  } finally { release(); await attempt; await service.shutdown() }
})
