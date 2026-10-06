/**
 * A exportação grava o vídeo, o áudio e o parcial numa pasta temporária EXCLUSIVA (nome sorteado pelo sistema, criada agora, vazia),
 * nunca numa de nome previsível: nem o link plantado no nome antigo (`exports/.tmp-<8 primeiros do id>`) recebe o que o ffmpeg e a
 * janela de vídeo escrevem. Com o serviço de exportação de verdade e o ffmpeg de verdade; a janela de vídeo é simulada.
 *
 * O `randomUUID` fixo é de propósito: com o id conhecido, o teste planta o link exatamente onde o código antigo escrevia.
 */
import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { outputFrameCount } from '@shared/export'
import type { ExportProgress } from '@shared/ipc'
import { projectDurationMs } from '@shared/project'
import { outputDuration } from '@shared/timeline'
import { createExportService, type ExportService } from '../../src/main/export-service'
import { createMemoryLogger } from '../../src/main/logger'
import { createOutputDirs } from '../../src/main/path-guard'
import { createProjectStore } from '../../src/main/projects'
import { copyTree, FIX, requireFfmpeg, useTmpDir } from '../helpers/env'

const FIXED_ID = 'abcdef12-0000-4000-8000-000000000000'
vi.mock('node:crypto', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:crypto')>()), randomUUID: () => 'abcdef12-0000-4000-8000-000000000000' }))

const tmp = useTmpDir()
const ID = 'exemplo'
const INTACT = 'NAO MEXER'
const intact = (file: string): boolean => readFileSync(file).equals(Buffer.from(INTACT))

function fakeVideo(file: string, frames: number): Buffer {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=180x320:r=30', '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', file], { windowsHide: true })
  return readFileSync(file)
}

function build() {
  const base = tmp()
  const root = join(base, 'projetos')
  const dir = join(root, ID)
  copyTree(FIX.exemplo, dir)
  const logger = createMemoryLogger()
  const store = createProjectStore({ root: () => root, logger, trash: async () => undefined, openFolder: async () => undefined })
  const ff = requireFfmpeg()
  const events: ExportProgress[] = []
  const seenTmp: string[][] = []
  const ref: { svc: ExportService | null } = { svc: null }
  const exporter = createExportService({
    logger,
    outputDirs: createOutputDirs(),
    read: (id) => store.read(id),
    words: async () => null,
    ffmpeg: () => ff,
    openExporterWindow: (id) => {
      const svc = ref.svc!
      setTimeout(() => {
        void (async () => {
          // o que há em exports/ ENQUANTO a exportação roda: a pasta temporária que o serviço criou
          seenTmp.push(readdirSync(join(dir, 'exports')).filter((n) => n.startsWith('.tmp')))
          const job = svc.job(id)
          const frames = outputFrameCount(outputDuration(projectDurationMs(job.project), job.project.cuts), job.fps)
          await svc.write(id, 0, new Uint8Array(fakeVideo(join(base, 'video.mp4'), frames)))
          svc.finish(id, { ok: true, frames, encoder: 'teste' })
        })()
      }, 20)
      return { destroy: () => undefined }
    },
    emit: (p) => events.push(p),
    now: () => performance.now()
  })
  ref.svc = exporter
  const run = async (): Promise<ExportProgress> => {
    const { exportId } = await exporter.start({ projectId: ID, resolution: '1080p', fps: 30 })
    await exporter.idle()
    const last = [...events].reverse().find((e) => e.exportId === exportId)
    if (!last) throw new Error('sem progresso')
    return last
  }
  return { base, dir, logger, run, seenTmp }
}

const outsideFile = (name: string): string => {
  const file = join(tmp(), name)
  writeFileSync(file, INTACT)
  return file
}

describe('exportação: pasta temporária exclusiva', () => {
  it('o video.mp4, o audio.m4a e o saida.parcial plantados como links físicos no nome antigo NÃO são sobrescritos', async () => {
    const { dir, run } = build()
    const planted = join(dir, 'exports', `.tmp-${FIXED_ID.slice(0, 8)}`)
    mkdirSync(planted, { recursive: true })
    const files = { 'video.mp4': outsideFile('fora-video.bin'), 'audio.m4a': outsideFile('fora-audio.bin'), 'saida.parcial': outsideFile('fora-parcial.bin') }
    for (const [name, outside] of Object.entries(files)) linkSync(outside, join(planted, name))
    const done = await run()
    for (const [name, outside] of Object.entries(files)) expect(intact(outside), `${name} de fora foi sobrescrito`).toBe(true)
    expect(done.message ?? '').toBe('')
    expect(done.phase).toBe('done')
  }, 120_000)

  it('a pasta temporária plantada como junção para fora, no nome antigo, não recebe nada', async () => {
    const { dir, run } = build()
    const outside = join(tmp(), 'pasta-de-fora')
    mkdirSync(outside)
    mkdirSync(join(dir, 'exports'), { recursive: true })
    symlinkSync(outside, join(dir, 'exports', `.tmp-${FIXED_ID.slice(0, 8)}`), 'junction')
    const done = await run()
    expect(readdirSync(outside), 'a exportação escreveu fora do projeto').toEqual([])
    expect(done.phase, done.message).toBe('done')
  }, 120_000)

  it('o nome da pasta temporária NÃO se deduz do id da exportação, e ela some no fim', async () => {
    const { dir, run, seenTmp } = build()
    const done = await run()
    expect(done.phase, done.message).toBe('done')
    expect(seenTmp).toHaveLength(1)
    expect(seenTmp[0]).toHaveLength(1)
    expect(seenTmp[0]![0]).not.toBe(`.tmp-${FIXED_ID.slice(0, 8)}`)
    expect(readdirSync(join(dir, 'exports')).filter((n) => n.startsWith('.tmp')), 'a pasta temporária ficou para trás').toEqual([])
  }, 120_000)
})
