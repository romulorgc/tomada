import { MIC_SPEECH_FLOOR_DBFS } from '@shared/mic-level'

const toDbfs = (amplitude: number): number => 20 * Math.log10(Math.max(amplitude, 1e-7))

/**
 * Pico (dBFS) do microfone ao longo do tempo, medido por um AnalyserNode lido a cada 40 ms (a janela de 2048 amostras cobre
 * ~43 ms: nenhum pico escapa entre uma leitura e outra). Não guarda áudio, só números. O stream é o de PRÉVIA da tela Gravar,
 * sem ganho automático: o pico reflete o volume de entrada do aparelho.
 */
export class MicPeakMeter {
  private readonly ctx: AudioContext
  private readonly analyser: AnalyserNode
  private readonly buffer = new Float32Array(2048)
  private readonly history: { t: number; peak: number }[] = []
  private timer: number | null
  private since = performance.now()

  constructor(stream: MediaStream, private readonly keepMs = 30_000) {
    this.ctx = new AudioContext()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = this.buffer.length
    this.ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(this.analyser)
    this.timer = window.setInterval(() => this.sample(), 40)
  }

  private sample(): void {
    this.analyser.getFloatTimeDomainData(this.buffer)
    let peak = 0
    for (const value of this.buffer) peak = Math.max(peak, Math.abs(value))
    const now = performance.now()
    this.history.push({ t: now, peak: toDbfs(peak) })
    while (this.history[0] && this.history[0].t < now - this.keepMs) this.history.shift()
  }

  /** Maior pico dos últimos `ms` (ou desde o começo/zerar, o que for mais recente); `null` = nada medido. */
  maxSince(ms: number): number | null {
    const from = Math.max(performance.now() - ms, this.since)
    let max: number | null = null
    for (const item of this.history) if (item.t >= from && (max === null || item.peak > max)) max = item.peak
    return max
  }

  /** Há quanto tempo o medidor escuta (até `ms`, desde o começo ou o último zerar). */
  observedMs(ms: number): number {
    return Math.min(ms, performance.now() - this.since)
  }

  /** Descarta o que foi medido antes (depois de mudar o volume do aparelho, a medida antiga não vale mais). */
  reset(): void {
    this.since = performance.now()
    this.history.length = 0
  }

  /** Quando houver fala (pico acima do silêncio da sala) depois de `after`; `null` se não vier em `timeoutMs`. */
  async waitForSpeech(timeoutMs: number, isCancelled: () => boolean): Promise<boolean> {
    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline) {
      if (isCancelled()) return false
      const recent = this.maxSince(200)
      if (recent !== null && recent > MIC_SPEECH_FLOOR_DBFS) return true
      await new Promise((resolve) => window.setTimeout(resolve, 60))
    }
    return false
  }

  close(): void {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    void this.ctx.close().catch(() => undefined)
  }
}
