/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference path="../../src/renderer/env.d.ts" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../../src/shared/project'
import type { ExportJob } from '../../src/shared/ipc'
import { renderVideoJob } from '../../src/renderer/export/exporter'

const state = vi.hoisted(() => ({
  failHardware: true,
  failSoftware: false,
  failDecode: false,
  failScreenDecode: false,
  tracks: 0,
  outputs: [] as { cancelled: boolean; finalized: boolean }[],
  adds: [] as { hardware: string; at: number }[],
  samples: [] as { closed: boolean; kind: string }[],
  frames: [] as { closed: boolean }[],
  disposed: 0
}))
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  UrlSource: class {},
  Input: class {
    kind = state.tracks++ === 0 ? 'screen' : 'camera'
    async getPrimaryVideoTrack() { return { canDecode: async () => true, kind: this.kind } }
    dispose() { state.disposed++ }
  },
  VideoSampleSink: class {
    kind: string
    constructor(track: { kind: string }) { this.kind = track.kind }
    async *samplesAtTimestamps(times: AsyncIterable<number>) {
      let index = 0
      for await (const _time of times) {
        if (state.failScreenDecode && this.kind === 'screen') throw new Error('A tela falhou ao decodificar')
        if (index++ === 1 && state.failDecode) throw new Error('Falha de decodificação simulada')
        const sample = { closed: false, kind: this.kind }
        state.samples.push(sample)
        yield {
          close: () => { sample.closed = true },
          toVideoFrame: () => {
            const frame = { closed: false }
            state.frames.push(frame)
            return { displayWidth: 640, displayHeight: 360, close: () => { frame.closed = true } }
          }
        }
      }
    }
  },
  CanvasSource: class {
    hardware: string
    constructor(_canvas: unknown, options: { hardwareAcceleration: string }) { this.hardware = options.hardwareAcceleration }
    async add(at: number) {
      state.adds.push({ hardware: this.hardware, at })
      if (this.hardware === 'prefer-hardware' && state.failHardware) throw new Error('Encoding error')
      if (this.hardware === 'no-preference' && state.failSoftware) throw new Error('Sem encoder disponível')
    }
  },
  Output: class {
    current = { cancelled: false, finalized: false }
    constructor() { state.outputs.push(this.current) }
    addVideoTrack() {}
    async start() {}
    async cancel() { this.current.cancelled = true }
    async finalize() { this.current.finalized = true }
  },
  Mp4OutputFormat: class {},
  StreamTarget: class {}
}))
vi.mock('@shared/render', () => ({ createRenderCache: () => ({ images: new Map() }), renderFrame: () => {}, drawShadow: () => {}, roundedRectPath: () => {} }))
vi.mock('@shared/scene', () => ({ prepareEvents: () => ({}), evaluateScene: () => ({}), deriveProject: () => ({ kept: [{ start: 0, end: 100 }], outputDurationMs: 100 }) }))
vi.mock('../../src/renderer/fonts', () => ({ ensureCaptionFonts: async () => {}, captionFontsLoaded: () => true }))

const project = createProject({ id: 'teste', title: 'Teste', sources: { screen: { path: 'media/screen.mp4', w: 640, h: 360, fps: 30, durationMs: 100 } } })
const job = { projectId: 'Teste', project, width: 1920, height: 1080, fps: 30, bitrate: 20_000_000, screenUrl: 'tomada-media://project/Teste/media/screen.mp4', cameraUrl: null, eventUrls: { cursor: null, clicks: null, keys: null } } as unknown as ExportJob
beforeEach(() => {
  Object.assign(state, { failHardware: true, failSoftware: false, failDecode: false, failScreenDecode: false, tracks: 0, outputs: [], adds: [], samples: [], frames: [], disposed: 0 })
  vi.stubGlobal('VideoEncoder', { isConfigSupported: async () => ({ supported: true }) })
  vi.stubGlobal('OffscreenCanvas', class { getContext() { return {} } })
})
afterEach(() => vi.unstubAllGlobals())

describe('encoder inicial e limpeza da exportação', () => {
  it('tenta o encoder oferecido pelo navegador se hardware falha no primeiro add, conservando o quadro zero', async () => {
    const result = await renderVideoJob(job, { write: async () => {} })
    expect(result.frames).toBe(3)
    expect(state.adds).toEqual([
      { hardware: 'prefer-hardware', at: 0 },
      { hardware: 'no-preference', at: 0 },
      { hardware: 'no-preference', at: 1 / 30 },
      { hardware: 'no-preference', at: 2 / 30 }
    ])
    expect(state.outputs).toEqual([{ cancelled: true, finalized: false }, { cancelled: false, finalized: true }])
    expect(state.frames.every((frame) => frame.closed)).toBe(true)
    expect(state.samples.every((sample) => sample.closed)).toBe(true)
    expect(state.disposed).toBe(1)
  })

  it('mantém a falha visível e fecha holds, amostras prefetched e output se ambos os encoders falham', async () => {
    state.failSoftware = true
    await expect(renderVideoJob(job, { write: async () => {} })).rejects.toThrow('Sem encoder disponível')
    expect(state.outputs.every((output) => output.cancelled)).toBe(true)
    expect(state.frames.every((frame) => frame.closed)).toBe(true)
    expect(state.samples.every((sample) => sample.closed)).toBe(true)
    expect(state.disposed).toBe(1)
  })

  it('observa a rejeição do prefetch mesmo quando a codificação falha antes do próximo await', async () => {
    state.failDecode = true
    await expect(renderVideoJob(job, { write: async () => {} })).rejects.toThrow('Falha de decodificação simulada')
    expect(state.outputs.every((output) => output.cancelled)).toBe(true)
    expect(state.frames.every((frame) => frame.closed)).toBe(true)
    expect(state.disposed).toBe(1)
  })

  it('fecha a amostra da câmera já resolvida se somente a tela falhar no prefetch paralelo', async () => {
    state.failScreenDecode = true
    await expect(renderVideoJob({ ...job, cameraUrl: 'tomada-media://project/Teste/media/camera.mp4' }, { write: async () => {} })).rejects.toThrow('A tela falhou ao decodificar')
    expect(state.samples).toEqual([{ closed: true, kind: 'camera' }])
    expect(state.outputs.every((output) => output.cancelled)).toBe(true)
    expect(state.disposed).toBe(2)
  })
})
