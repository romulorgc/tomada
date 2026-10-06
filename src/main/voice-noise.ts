import type { Word } from '@shared/types'
import { spawn } from 'node:child_process'
import { FfmpegError, type Ffmpeg } from './ffmpeg'
import { assertFfmpegPath } from './ffmpeg-path'

const SAMPLE_RATE = 48_000
const FRAME_MS = 20
const FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000
const WORD_GUARD_MS = 150
const MIN_SILENCE_MS = 300
type NoiseFrame = { db: number; power: number; periodic: boolean }

export type VoiceNoiseMeasure = {
  noiseFloorDb: number | null
  measuredDb: number | null
  silenceMs: number
  source: 'transcript' | 'vad' | 'none'
}

/**
 * Lê a voz ORIGINAL, antes de cortar: cortes automáticos podem retirar justamente o silêncio necessário.
 * Decodificação em fluxo com memória de um quadro PCM e uma estatística por 20 ms; nenhum arquivo novo.
 * O chamador resolve o caminho dentro do projeto; aqui protocolos e caminhos relativos são recusados.
 */
export async function measureVoiceNoise(ff: Ffmpeg, opts: { voicePath: string; words?: readonly Word[] | null; offsetMs?: number; signal?: AbortSignal; timeoutMs?: number }): Promise<VoiceNoiseMeasure> {
  const path = assertFfmpegPath(opts.voicePath, 'voz para medir ruído')
  if (opts.signal?.aborted) throw new FfmpegError('Medição de ruído cancelada.', null, '')
  return new Promise((resolve, reject) => {
    const child = spawn(ff.paths.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-vn',
      '-af', 'highpass=f=80', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const meter = new VoiceNoiseMeter()
    let pending = Buffer.alloc(0), stderr = ''
    let cancelled = false, timedOut = false, spawnError: Error | null = null
    const onAbort = (): void => { cancelled = true; child.kill() }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, opts.timeoutMs ?? 900_000)
    child.stdout.on('data', (chunk: Buffer) => {
      const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk
      const count = Math.floor(bytes.length / 4)
      const samples = new Float32Array(count)
      for (let i = 0; i < count; i++) samples[i] = bytes.readFloatLE(i * 4)
      meter.push(samples)
      pending = Buffer.from(bytes.subarray(count * 4))
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4096) })
    child.on('error', (err: Error) => { spawnError = err })
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (cancelled) reject(new FfmpegError('Medição de ruído cancelada.', code, stderr))
      else if (timedOut) reject(new FfmpegError('O ffmpeg passou do tempo limite ao medir o ruído da voz.', code, stderr))
      else if (spawnError || code !== 0) reject(new FfmpegError(`Não consegui medir o ruído da voz com ffmpeg: ${spawnError?.message ?? stderr}`, code, stderr))
      else resolve(meter.finish(opts))
    })
  })
}

export class VoiceNoiseMeter {
  private readonly frames: NoiseFrame[] = []
  private readonly pending = new Float32Array(FRAME_SAMPLES)
  private count = 0

  /** PCM mono 48 kHz, já passado pelo mesmo highpass de 80 Hz da cadeia final. */
  push(samples: Float32Array): void {
    let pos = 0
    while (pos < samples.length) {
      const n = Math.min(FRAME_SAMPLES - this.count, samples.length - pos)
      this.pending.set(samples.subarray(pos, pos + n), this.count)
      this.count += n
      pos += n
      if (this.count < FRAME_SAMPLES) continue
      let power = 0
      for (const x of this.pending) power += x * x
      power /= FRAME_SAMPLES

      // VAD acústico local: periodicidade de 80-500 Hz protege vogais mesmo muito baixas.
      // A energia continua medida em TODA a banda de 48 kHz, sem perder o chiado acima de 8 kHz.
      const pitch = new Float32Array(FRAME_SAMPLES / 3)
      for (let i = 0; i < pitch.length; i++) pitch[i] = (this.pending[i * 3]! + this.pending[i * 3 + 1]! + this.pending[i * 3 + 2]!) / 3
      let periodic = false
      if (power > 0 && Number.isFinite(power)) {
        for (let lag = 32; lag <= 200 && !periodic; lag += 4) {
          let dot = 0, a = 0, b = 0
          for (let i = lag; i < pitch.length; i += 2) {
            const x = pitch[i]!, y = pitch[i - lag]!
            dot += x * y; a += x * x; b += y * y
          }
          periodic = a > 0 && b > 0 && dot / Math.sqrt(a * b) > 0.6
        }
      }
      this.frames.push({ power, db: power > 0 ? 10 * Math.log10(power) : -Infinity, periodic })
      this.count = 0
    }
  }

  finish(opts: { words?: readonly Word[] | null; offsetMs?: number } = {}): VoiceNoiseMeasure {
    const empty: VoiceNoiseMeasure = { noiseFloorDb: null, measuredDb: null, silenceMs: 0, source: 'none' }
    if (this.frames.length * FRAME_MS < MIN_SILENCE_MS) return empty
    const sorted = this.frames.map(f => f.db).filter(Number.isFinite).sort((a, b) => a - b)
    // Limiar RELATIVO ao percentil inferior da própria gravação, sem dBFS presumido.
    const low = sorted[Math.floor(sorted.length * 0.2)] ?? -Infinity
    const quiet = this.frames.map(f => !f.periodic && f.db <= low + 4)
    const offset = opts.offsetMs ?? 0
    const words = (opts.words ?? []).filter(w => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
      .map(w => ({ start: w.start - offset - WORD_GUARD_MS, end: w.end - offset + WORD_GUARD_MS }))
      .sort((a, b) => a.start - b.start)
    const mask = [...quiet]
    let cursor = 0
    for (let i = 0; i < mask.length; i++) {
      const start = i * FRAME_MS, end = start + FRAME_MS
      while (cursor < words.length && words[cursor]!.end <= start) cursor++
      if (words[cursor] && words[cursor]!.start < end) mask[i] = false
    }

    const collect = (allowed: boolean[]): number[] => {
      const accepted: number[] = []
      for (let i = 0; i < allowed.length;) {
        if (!allowed[i]) { i++; continue }
        const start = i
        while (i < allowed.length && allowed[i]) i++
        // Exclui as bordas para não aprender respiração, ataque de consoante ou estalo.
        if ((i - start) * FRAME_MS >= MIN_SILENCE_MS) {
          const first = start === 0 ? start : start + 3
          const last = i === allowed.length ? i : i - 3
          for (let k = first; k < last; k++) accepted.push(k)
        }
      }
      return accepted
    }
    // Palavras conhecidas nunca deixam de ser fala: VAD só é fallback quando falta transcrição.
    // Descartar a máscara aqui aprenderia sussurros/fricativas como piso de ruído.
    const accepted = collect(words.length ? mask : quiet)
    const source: VoiceNoiseMeasure['source'] = words.length ? 'transcript' : 'vad'
    if (accepted.length * FRAME_MS < MIN_SILENCE_MS) return empty
    const power = accepted.reduce((sum, i) => sum + this.frames[i]!.power, 0) / accepted.length
    const measuredDb = power > 0 && Number.isFinite(power) ? 10 * Math.log10(power) : null
    // Fora da faixa aceita pelo afftdn não se inventa um nf: gravação muda/limpa ou silêncio inseguro.
    const noiseFloorDb = measuredDb !== null && measuredDb >= -80 && measuredDb <= -20 ? measuredDb : null
    return { noiseFloorDb, measuredDb, silenceMs: accepted.length * FRAME_MS, source }
  }
}
