/* Executado só na thread de áudio. Não monitora o microfone nos alto-falantes. */
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.commands = []
    this.active = false
    this.stopped = false
    this.expected = null
    this.block = new Float32Array(sampleRate)
    this.used = 0
    this.ready = false
    this.firstFrame = null
    this.lastFrame = null
    this.previousActiveFrame = null
    this.inputFrames = 0
    this.maxGapFrames = 0
    this.gapCount = 0
    this.port.onmessage = ({ data }) => this.commands.push(data)
  }
  flush() {
    if (!this.used) return
    const samples = this.block.slice(0, this.used)
    this.port.postMessage({ type: 'data', samples }, [samples.buffer])
    this.used = 0
  }
  append(value) {
    this.block[this.used++] = value
    if (this.used === this.block.length) this.flush()
  }
  fillUntil(frame) {
    if (this.expected === null || this.expected >= frame) return
    const missing = frame - this.expected
    // Silêncio mantém o eixo de tempo, mas não recupera fala perdida: a captura precisa avisar.
    if (missing >= sampleRate * 0.02) this.port.postMessage({ type: 'gap', frames: missing })
    while (this.expected < frame) { this.append(0); this.expected++ }
  }
  apply(command) {
    if (command.type === 'start' || command.type === 'resume') {
      this.active = true
      this.expected = command.frame
      this.previousActiveFrame = null
    } else {
      if (this.active) this.fillUntil(command.frame)
      this.active = false
      this.flush()
      if (command.type === 'stop') {
        this.stopped = true
        this.port.postMessage({ type: 'diagnostic', firstFrame: this.firstFrame, lastFrame: this.lastFrame,
          inputFrames: this.inputFrames, maxGapFrames: this.maxGapFrames, gapCount: this.gapCount })
        this.port.postMessage({ type: 'stopped' })
      }
    }
  }
  process(inputs) {
    if (!this.ready) { this.ready = true; this.port.postMessage({ type: 'ready' }) }
    if (this.stopped) return false
    const channels = inputs[0] || []
    const length = channels[0]?.length || 128
    for (let i = 0; i < length; i++) {
      const frame = currentFrame + i
      while (this.commands.length && this.commands[0].frame <= frame) this.apply(this.commands.shift())
      if (this.stopped) return false
      if (!this.active) continue
      if (this.firstFrame === null) this.firstFrame = frame
      if (this.previousActiveFrame !== null && frame > this.previousActiveFrame + 1) {
        this.maxGapFrames = Math.max(this.maxGapFrames, frame - this.previousActiveFrame - 1)
        this.gapCount++
      }
      this.lastFrame = frame
      this.previousActiveFrame = frame
      this.inputFrames++
      // IPC/thread ocupada no início: o espaço em branco preserva o carimbo do primeiro sample.
      this.fillUntil(frame)
      let value = 0
      for (const channel of channels) value += channel[i] || 0
      this.append(channels.length ? value / channels.length : 0)
      this.expected = frame + 1
    }
    return true
  }
}
registerProcessor('tomada-pcm', PcmProcessor)
