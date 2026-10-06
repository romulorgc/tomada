import { pcmWavHeader, PCM_SAMPLE_RATE } from '@shared/pcm'
import workletUrl from './pcm-worklet.js?url&no-inline'

/** O relógio do WAV começa na mesma chamada de start da voz antiga, sem latência de codec. */
export class PcmRecorder {
  private chain: Promise<void> = Promise.resolve()
  private stopResolve: (() => void) | null = null
  private failure: Error | null = null
  private disposed = false
  private clockTimer: number | null = null
  private state: 'ready' | 'recording' | 'paused' | 'stopped' = 'ready'
  private constructor(private ctx: AudioContext, private node: AudioWorkletNode, private source: AudioNode, private chunk: (data: ArrayBuffer) => Promise<void>, private onError: (err: Error) => void) {}

  /**
   * `makeSource` (só para provas): em vez do microfone do `stream`, usa o nó que a função devolve dentro do mesmo AudioContext do gravador.
   * Serve para provar o worklet e os pedaços sem o Chromium no meio, com o relógio de um contexto só.
   */
  static async open(stream: MediaStream | null, chunk: (data: ArrayBuffer) => Promise<void>, onError: (err: Error) => void, makeSource?: (context: AudioContext) => AudioNode): Promise<PcmRecorder> {
    const ctx = new AudioContext({ sampleRate: PCM_SAMPLE_RATE, latencyHint: 'interactive' })
    try {
      if (ctx.sampleRate !== PCM_SAMPLE_RATE) throw new Error('O microfone não pôde ser gravado em PCM a 48 kHz.')
      await ctx.audioWorklet.addModule(workletUrl)
      if (!stream && !makeSource) throw new Error('O gravador PCM precisa de um microfone.')
      const input = makeSource ? makeSource(ctx) : ctx.createMediaStreamSource(new MediaStream(stream!.getAudioTracks()))
      // Sem saída, é um nó de leitura automática (APN): continua processando sem áudio audível.
      // Um nó com saída zerada trocava para temporizador virtual após 30 s e perdia o relógio.
      const node = new AudioWorkletNode(ctx, 'tomada-pcm', { numberOfInputs: 1, numberOfOutputs: 0 })
      const recorder = new PcmRecorder(ctx, node, input, chunk, onError)
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('O gravador PCM não entregou amostras em 5 s.')), 5000)
        node.port.onmessage = ({ data }: MessageEvent<{ type: string; samples?: Float32Array; frames?: number }>) => {
          if (data.type === 'ready') { window.clearTimeout(timer); resolve() }
          else if (data.type === 'data' && data.samples) recorder.enqueue(data.samples.buffer as ArrayBuffer)
          else if (data.type === 'stopped') recorder.stopResolve?.()
          else if (data.type === 'gap' && data.frames) recorder.onError(new Error(`O áudio do microfone perdeu ${(data.frames / PCM_SAMPLE_RATE * 1000).toFixed(1)} ms. A gravação vai parar para preservar os trechos recebidos; confira a voz antes de publicar.`))
        }
        node.onprocessorerror = () => { const err = new Error('O gravador PCM do microfone parou de entregar amostras.'); recorder.fail(err); reject(err); window.clearTimeout(timer); recorder.stopResolve?.() }
        input.connect(node)
        void ctx.resume().catch(reject)
      })
      return recorder
    } catch (err) { await ctx.close(); throw err }
  }
  private fail(err: unknown): void {
    if (this.failure || this.disposed) return
    this.failure = err instanceof Error ? err : new Error(String(err))
    this.onError(this.failure)
  }
  private enqueue(data: ArrayBuffer): void {
    this.chain = this.chain.then(async () => { if (!this.disposed && !this.failure) await this.chunk(data) }).catch(err => this.fail(err))
  }
  private command(type: string, at: number): void {
    const now = performance.timeOrigin + performance.now()
    const frame = Math.round((this.ctx.currentTime + (at - now) / 1000) * PCM_SAMPLE_RATE)
    this.node.port.postMessage({ type, frame })
  }
  private watchClock(): void {
    if (this.clockTimer !== null) window.clearInterval(this.clockTimer)
    const wall = performance.timeOrigin + performance.now(), audio = this.ctx.currentTime
    this.clockTimer = window.setInterval(() => {
      if (this.disposed || this.state !== 'recording') return
      const expected = performance.timeOrigin + performance.now() - wall
      const actual = (this.ctx.currentTime - audio) * 1000
      if (Math.abs(expected - actual) < 100) return
      window.clearInterval(this.clockTimer!)
      this.clockTimer = null
      this.onError(new Error('O áudio do microfone perdeu a continuidade do relógio. A gravação vai parar para preservar os trechos recebidos; confira a voz antes de publicar.'))
    }, 1000)
  }
  start(at: number): void {
    if (this.state !== 'ready') throw new Error('O gravador PCM já começou.')
    this.enqueue(pcmWavHeader())
    this.state = 'recording'
    this.watchClock()
    this.command('start', at)
  }
  pause(at: number): void { if (this.state === 'recording') { this.state = 'paused'; this.command('pause', at) } }
  resume(at: number): void { if (this.state === 'paused') { this.state = 'recording'; this.watchClock(); this.command('resume', at) } }
  async stop(at: number): Promise<void> {
    if (this.state === 'ready' || this.state === 'stopped') return
    this.state = 'stopped'
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('O gravador PCM não confirmou o último pedaço em 5 s.')), 5000)
        this.stopResolve = () => { window.clearTimeout(timer); resolve() }
        this.command('stop', at)
      })
      await this.chain
      if (this.failure) throw this.failure
    } finally { this.release() }
  }
  release(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.clockTimer !== null) window.clearInterval(this.clockTimer)
    this.node.disconnect(); this.source.disconnect(); this.node.port.close()
    void this.ctx.close().catch(() => undefined)
  }
}
