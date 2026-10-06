import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeManifest, type RecordingManifest } from '../../src/main/manifest'

const io = vi.hoisted(() => ({
  stored: new Map<string, string>(),
  calls: [] as { path: string; data: string }[],
  block: null as null | { entered(): void; wait: Promise<void> }
}))
vi.mock('../../src/main/project-files', () => ({ resolveProjectFile: async (dir: string, rel: string) => join(dir, rel) }))
vi.mock('../../src/main/fs-utils', () => ({ writeFileAtomic: async (path: string, data: string) => {
  io.calls.push({ path, data })
  const block = io.block
  io.block = null
  if (block) { block.entered(); await block.wait }
  io.stored.set(path, data)
} }))

function gate() {
  let release!: () => void, reject!: (err: Error) => void, entered!: () => void
  const started = new Promise<void>((r) => { entered = r })
  const wait = new Promise<void>((r, j) => { release = r; reject = j })
  io.block = { entered, wait }
  return { started, release, reject }
}
const manifest = () => ({ version: 1, pauses: [], openPauseAt: null, notes: [] }) as unknown as RecordingManifest
const nextTurn = () => new Promise<void>((r) => setImmediate(r))
beforeEach(() => { io.stored.clear(); io.calls.length = 0; io.block = null })

describe('checkpoint atômico do manifesto', () => {
  it('uma escrita antiga bloqueada não sobrescreve a pausa nova, capturada no instante do pedido', async () => {
    const g = gate(), m = manifest(), dir = 'C:/teste-manifesto-ordem'
    const first = writeManifest(dir, m)
    await g.started
    m.openPauseAt = 200
    const second = writeManifest(dir, m)
    m.openPauseAt = 300 // mutação posterior não altera o checkpoint que já foi pedido
    await nextTurn()
    const callsBeforeRelease = io.calls.length
    g.release()
    await Promise.all([first, second])
    expect(callsBeforeRelease).toBe(1)
    expect(JSON.parse(io.stored.get(join(dir, 'raw/recording.json'))!).openPauseAt).toBe(200)
    expect(io.calls.slice(-2).map((c) => JSON.parse(c.data).openPauseAt)).toEqual([null, 200])
  })

  it('devolve o erro ao autor da escrita e permite o checkpoint seguinte e uma nova tentativa', async () => {
    const g = gate(), m = manifest(), dir = 'C:/teste-manifesto-erro'
    const first = writeManifest(dir, m)
    await g.started
    m.openPauseAt = 400
    const second = writeManifest(dir, m)
    const outcomes = Promise.allSettled([first, second])
    g.reject(new Error('disco indisponível'))
    expect(await outcomes).toEqual([{ status: 'rejected', reason: new Error('disco indisponível') }, { status: 'fulfilled', value: undefined }])
    m.openPauseAt = null
    await writeManifest(dir, m)
    expect(JSON.parse(io.stored.get(join(dir, 'raw/recording.json'))!).openPauseAt).toBeNull()
  })

  it('uma gravação bloqueada não impede checkpoints de outra pasta', async () => {
    const g = gate(), m = manifest()
    const first = writeManifest('C:/teste-manifesto-a', m)
    await g.started
    await writeManifest('C:/teste-manifesto-b', m)
    expect(io.stored.has(join('C:/teste-manifesto-b', 'raw/recording.json'))).toBe(true)
    g.release()
    await first
  })
})
