import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { pcmWavHeader } from '../../src/shared/pcm'

function worklet() {
  const sent: { type: string; samples?: Float32Array }[] = []
  let Processor: new () => { port: { onmessage: (e: { data: unknown }) => void }; process(i: Float32Array[][]): boolean }
  const env = { sampleRate: 48000, currentFrame: 0, AudioWorkletProcessor: class { port = { postMessage: (m: typeof sent[number]) => sent.push(m), onmessage: () => {} } }, registerProcessor: (_: string, p: typeof Processor) => { Processor = p } }
  runInNewContext(readFileSync('src/renderer/recording/pcm-worklet.js', 'utf8'), env)
  const processor = new Processor!()
  return {
    sent,
    command: (type: string, frame: number) => processor.port.onmessage({ data: { type, frame } }),
    quantum(frame: number): Float32Array {
      // Cada valor identifica o frame de origem: comprimento sozinho não prova o carimbo.
      const input = Float32Array.from({ length: 128 }, (_, i) => (frame + i + 1) / 100_000)
      env.currentFrame = frame
      processor.process([[input]])
      return input
    },
    samples: () => sent.filter(m => m.samples).flatMap(m => Array.from(m.samples!))
  }
}

type Recorder = { start(at: number): void; pause(at: number): void; resume(at: number): void; stop(at: number): Promise<void>; release(): void }
type RecorderClass = { open(stream: { getAudioTracks(): unknown[] }, chunk: (data: ArrayBuffer) => Promise<void>, onError: (error: Error) => void): Promise<Recorder> }
const recorderCode = transformSync(readFileSync('src/renderer/recording/pcm-recorder.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code

/** Executa a classe de produção; só dispositivos, relógios e transporte são controlados. */
function recorderHarness(config: { sampleRate?: number; ready?: boolean } = {}) {
  let wall = 0, nextTimer = 0
  const timers = new Map<number, { due: number; period: number | null; callback: () => void }>()
  const options: unknown[] = [], nodeOptions: unknown[] = [], modules: string[] = [], chunks: ArrayBuffer[] = [], errors: Error[] = []
  const source = { disconnects: 0, connections: [] as unknown[], connect(target: unknown) { this.connections.push(target) }, disconnect() { this.disconnects++ } }
  let resolveResumed!: () => void
  const resumed = new Promise<void>(resolve => { resolveResumed = resolve })
  class Context {
    currentTime = 0
    sampleRate = config.sampleRate ?? 48000
    destinationReads = 0
    closes = 0
    get destination() { this.destinationReads++; return { destinoFisico: true } }
    audioWorklet = { addModule: async (url: string) => { modules.push(url) } }
    constructor(opts: unknown) { options.push(opts) }
    createMediaStreamSource() { return source }
    async resume() {
      resolveResumed()
      if (config.ready !== false) queueMicrotask(() => node.port.onmessage?.({ data: { type: 'ready' } }))
    }
    async close() { this.closes++ }
  }
  let node: Node, context: Context
  class Node {
    disconnects = 0
    connections: unknown[] = []
    port = {
      onmessage: null as ((event: { data: { type: string; samples?: Float32Array } }) => void) | null,
      closes: 0,
      postMessage: (command: { type: string }) => {
        if (command.type === 'stop') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'stopped' } }))
      },
      close() { this.closes++ }
    }
    constructor(_ctx: unknown, name: string, options: unknown) { node = this; nodeOptions.push({ name, options }) }
    connect(target: unknown) { this.connections.push(target) }
    disconnect() { this.disconnects++ }
  }
  const module = { exports: {} as { PcmRecorder: RecorderClass } }
  const schedule = (callback: () => void, delay: number, period: number | null): number => {
    const id = ++nextTimer
    timers.set(id, { callback, due: wall + delay, period })
    return id
  }
  runInNewContext(recorderCode, {
    module, exports: module.exports,
    require: (name: string) => {
      if (name === '@shared/pcm') return { pcmWavHeader, PCM_SAMPLE_RATE: 48000 }
      if (name === './pcm-worklet.js?url&no-inline') return '/worklet-da-prova.js'
      throw new Error(`Importação não simulada: ${name}`)
    },
    AudioContext: class extends Context { constructor(opts: unknown) { super(opts); context = this } },
    AudioWorkletNode: Node,
    MediaStream: class { constructor(readonly tracks: unknown[]) {} },
    performance: { timeOrigin: 1_000_000, now: () => wall },
    window: {
      setTimeout: (callback: () => void, delay: number) => schedule(callback, delay, null),
      clearTimeout: (id: number) => timers.delete(id),
      setInterval: (callback: () => void, delay: number) => schedule(callback, delay, delay),
      clearInterval: (id: number) => timers.delete(id)
    }
  })
  return {
    options, nodeOptions, modules, chunks, errors, source, timers, resumed,
    get context() { return context },
    get node() { return node },
    now: () => 1_000_000 + wall,
    open: () => module.exports.PcmRecorder.open({ getAudioTracks: () => [{}] }, async data => { chunks.push(data.slice(0)) }, error => errors.push(error)),
    emit: (samples: Float32Array) => node.port.onmessage?.({ data: { type: 'data', samples } }),
    advance(ms: number, audioSeconds = ms / 1000) {
      const startWall = wall, startAudio = context.currentTime, target = wall + ms
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0]
        if (!due) break
        const [id, timer] = due
        wall = timer.due
        context.currentTime = startAudio + (wall - startWall) / ms * audioSeconds
        if (timer.period === null) timers.delete(id)
        else timer.due += timer.period
        timer.callback()
      }
      wall = target
      context.currentTime = startAudio + audioSeconds
    }
  }
}

describe('PcmRecorder real sem saída de áudio e com guarda de relógio', () => {
  it('abre contexto interactive e conecta somente a fonte ao worklet sem saídas', async () => {
    const h = recorderHarness(), recorder = await h.open()
    expect(h.options).toEqual([{ sampleRate: 48000, latencyHint: 'interactive' }])
    expect(h.nodeOptions).toEqual([{ name: 'tomada-pcm', options: { numberOfInputs: 1, numberOfOutputs: 0 } }])
    expect(h.source.connections).toEqual([h.node])
    expect(h.node.connections).toEqual([])
    expect(h.context.destinationReads).toBe(0)
    expect(h.modules).toEqual(['/worklet-da-prova.js'])
    expect(h.timers.size).toBe(0)
    recorder.release()
  })

  it('recusa taxa diferente de 48 kHz antes de carregar o worklet e fecha o contexto', async () => {
    const h = recorderHarness({ sampleRate: 44_100 })
    await expect(h.open()).rejects.toThrow(/48 kHz/)
    expect(h.context.closes).toBe(1)
    expect(h.modules).toEqual([])
    expect(h.timers.size).toBe(0)
  })

  it('sem mensagem ready, aguarda 5 s, rejeita com motivo e fecha o contexto', async () => {
    const h = recorderHarness({ ready: false })
    let rejected = false
    const opening = h.open()
    void opening.catch(() => { rejected = true })
    const rejection = expect(opening).rejects.toThrow(/não entregou amostras em 5 s/)
    await h.resumed
    h.advance(4999)
    await Promise.resolve()
    expect(rejected).toBe(false)
    expect(h.context.closes).toBe(0)
    h.advance(1)
    await rejection
    expect(h.context.closes).toBe(1)
    expect(h.chunks).toEqual([])
    expect(h.timers.size).toBe(0)
    expect(h.context.destinationReads).toBe(0)
  })

  it('10 s com parede e áudio avançando juntos não avisam e stop espera os dados', async () => {
    const h = recorderHarness(), recorder = await h.open()
    recorder.start(h.now())
    h.advance(10_000)
    const samples = new Float32Array([0.1234567, -0.2345678])
    h.emit(samples)
    await recorder.stop(h.now())
    expect(h.errors).toEqual([])
    expect(h.chunks).toHaveLength(2)
    expect(h.chunks[0]).toEqual(pcmWavHeader())
    expect(Array.from(new Float32Array(h.chunks[1]!))).toEqual(Array.from(samples))
    expect(h.timers.size).toBe(0)
  })

  it('áudio a 0,68 s por segundo avisa uma vez e mantém os chunks recebidos após o aviso', async () => {
    const h = recorderHarness(), recorder = await h.open()
    recorder.start(h.now())
    h.advance(1000, 0.68)
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]!.message).toMatch(/continuidade do relógio/)
    h.advance(9000, 6.12)
    const samples = new Float32Array([0.3456789, -0.456789])
    h.emit(samples)
    await recorder.stop(h.now())
    expect(h.errors).toHaveLength(1)
    expect(Array.from(new Float32Array(h.chunks[1]!))).toEqual(Array.from(samples))
    expect(h.timers.size).toBe(0)
  })

  it('o limite de 100 ms já aciona o aviso de descontinuidade', async () => {
    const h = recorderHarness(), recorder = await h.open()
    recorder.start(h.now())
    h.advance(1000, 0.9)
    expect(h.errors).toHaveLength(1)
    recorder.release()
  })

  it('pausa não avisa e resume recalibra a origem sem acumular o tempo pausado', async () => {
    const h = recorderHarness(), recorder = await h.open()
    recorder.start(h.now())
    h.advance(2000)
    recorder.pause(h.now())
    h.advance(5000, 0)
    expect(h.errors).toEqual([])
    recorder.resume(h.now())
    expect(h.timers.size).toBe(1)
    h.advance(10_000)
    await recorder.stop(h.now())
    expect(h.errors).toEqual([])
    expect(h.timers.size).toBe(0)
  })

  it('release limpa o timer e desconecta cada recurso uma única vez', async () => {
    const h = recorderHarness(), recorder = await h.open()
    recorder.start(h.now())
    h.advance(500)
    expect(h.timers.size).toBe(1)
    recorder.release()
    recorder.release()
    expect(h.timers.size).toBe(0)
    expect(h.context.closes).toBe(1)
    expect(h.node.disconnects).toBe(1)
    expect(h.node.port.closes).toBe(1)
    expect(h.source.disconnects).toBe(1)
    h.advance(10_000, 6.8)
    expect(h.errors).toEqual([])
  })
})

describe('PCM sem perda e relógio de amostras', () => {
  it('WAV mono IEEE float32 a 48 kHz, sem quantização', () => {
    const header = new DataView(pcmWavHeader(48000))
    expect(header.getUint16(20, true)).toBe(3)
    expect(header.getUint32(24, true)).toBe(48000)
    expect(header.getUint16(34, true)).toBe(32)
  })
  it('pedaços concatenam amostras exatas; atraso na entrega não move t0; pausa some e stop entrega o resto', () => {
    const sent: { type: string; samples?: Float32Array }[] = []
    let Processor: new () => { port: { onmessage: (e: { data: unknown }) => void }; process(i: Float32Array[][]): boolean }
    const env = { sampleRate: 48000, currentFrame: 0, AudioWorkletProcessor: class { port = { postMessage: (m: typeof sent[number]) => sent.push(m), onmessage: () => {} } }, registerProcessor: (_: string, p: typeof Processor) => { Processor = p } }
    runInNewContext(readFileSync('src/renderer/recording/pcm-worklet.js', 'utf8'), env)
    const p = new Processor!()
    const command = (type: string, frame: number) => p.port.onmessage({ data: { type, frame } })
    // Comando chegou uma quantum depois: preencher o buraco, nunca adiantar a voz.
    command('start', 0)
    env.currentFrame = 128
    p.process([[new Float32Array(128).fill(0.1234567)]])
    command('pause', 256)
    env.currentFrame = 256; p.process([[new Float32Array(128).fill(0.8)]])
    command('resume', 384)
    env.currentFrame = 384; p.process([[new Float32Array(128).fill(-0.2345678)]])
    command('stop', 512)
    env.currentFrame = 512; p.process([[new Float32Array(128).fill(0.9)]])
    const samples = sent.filter(m => m.samples).flatMap(m => Array.from(m.samples!))
    expect(samples).toHaveLength(384)
    expect(samples.slice(0, 128)).toEqual(Array(128).fill(0))
    expect(samples.slice(128, 256)).toEqual(Array.from(new Float32Array(128).fill(0.1234567)))
    expect(samples.slice(256)).toEqual(Array.from(new Float32Array(128).fill(-0.2345678)))
    expect(sent.at(-1)?.type).toBe('stopped')
  })

  it('salto no meio mantém os carimbos e preenche só os frames ausentes, inclusive entre pedaços de 1 s', () => {
    const w = worklet()
    w.command('start', 0)
    const first = w.quantum(0), second = w.quantum(128)
    const last = w.quantum(48_128)
    w.command('stop', 48_256)
    w.quantum(48_256)

    const samples = w.samples()
    expect(samples).toHaveLength(48_256)
    expect(samples.slice(0, 128)).toEqual(Array.from(first))
    expect(samples.slice(128, 256)).toEqual(Array.from(second))
    expect(samples.slice(256, 48_128)).toEqual(Array(47_872).fill(0))
    expect(samples.slice(48_128)).toEqual(Array.from(last))
    expect(w.sent.at(-1)?.type).toBe('stopped')
  })

  it('salto que atravessa stop completa até o frame de parada e não inclui o bloco posterior', () => {
    const w = worklet()
    w.command('start', 0)
    const first = w.quantum(0)
    w.command('stop', 384)
    w.quantum(640)

    const samples = w.samples()
    expect(samples).toHaveLength(384)
    expect(samples.slice(0, 128)).toEqual(Array.from(first))
    expect(samples.slice(128)).toEqual(Array(256).fill(0))
    expect(w.sent.at(-1)?.type).toBe('stopped')
  })

  it('salto até pause termina na fronteira; atraso após resume preenche só o trecho ativo', () => {
    const w = worklet()
    w.command('start', 0)
    const first = w.quantum(0)
    w.command('pause', 384)
    w.quantum(640)
    w.command('resume', 896)
    const resumed = w.quantum(1152)
    w.command('stop', 1280)
    w.quantum(1280)

    // Ativo [0,384) e [896,1280): os 512 frames da pausa não entram no WAV.
    const samples = w.samples()
    expect(samples).toHaveLength(768)
    expect(samples.slice(0, 128)).toEqual(Array.from(first))
    expect(samples.slice(128, 384)).toEqual(Array(256).fill(0))
    expect(samples.slice(384, 640)).toEqual(Array(256).fill(0))
    expect(samples.slice(640)).toEqual(Array.from(resumed))
  })

  it('resume após pausa longa ignora todos os frames da pausa e preserva as amostras retomadas', () => {
    const w = worklet()
    w.command('start', 0)
    const first = w.quantum(0)
    w.command('pause', 128)
    w.quantum(128)
    w.quantum(48_000)
    w.quantum(65_536)
    w.command('resume', 70_000)
    const resumed = w.quantum(70_000)
    w.command('stop', 70_128)
    w.quantum(70_128)

    expect(w.samples()).toEqual([...first, ...resumed])
    expect(w.sent.at(-1)?.type).toBe('stopped')
  })
})
