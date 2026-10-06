/** Medições locais da prova. Não há reprodução nem envio de áudio. */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { pcmWavHeader } from '../../src/shared/pcm'

export const SR = 48_000
export const db = (power: number): number => power > 0 ? 10 * Math.log10(power) : -200
export function decode(file: string, filter?: string): Float32Array {
  // Canal esquerdo, sem mistura: o downmix padrão do ffmpeg para mono soma +3 dB em canais idênticos e inventaria clipping.
  const chain = ['pan=mono|c0=c0', ...(filter ? [filter] : [])].join(',')
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-vn',
    '-af', chain, '-ar', String(SR), '-f', 'f32le', 'pipe:1'],
  { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`Falha na decodificação: ${result.stderr?.toString()}`)
  const data = result.stdout
  const values = new Float32Array(Math.floor(data.length / 4))
  for (let i = 0; i < values.length; i++) values[i] = data.readFloatLE(i * 4)
  return values
}
export function wav(file: string, values: Float32Array): void {
  const header = Buffer.from(pcmWavHeader(SR, values.length * 4))
  const bytes = Buffer.alloc(values.length * 4)
  for (let i = 0; i < values.length; i++) bytes.writeFloatLE(values[i]!, i * 4)
  writeFileSync(file, Buffer.concat([header, bytes]))
}
export function finishWav(file: string, chunks: string[]): void {
  const data = Buffer.concat(chunks.map(chunk => Buffer.from(chunk, 'base64')))
  data.writeUInt32LE(data.length - 8, 4)
  data.writeUInt32LE(data.length - 44, 40)
  writeFileSync(file, data)
}
export function waveFormat(file: string): { format: number; channels: number; rate: number; bits: number; dataBytes: number } {
  const data = readFileSync(file)
  let format = 0, channels = 0, rate = 0, bits = 0, dataBytes = 0
  for (let position = 12; position + 8 <= data.length;) {
    const tag = data.toString('ascii', position, position + 4), size = data.readUInt32LE(position + 4), payload = position + 8
    if (tag === 'fmt ') {
      format = data.readUInt16LE(payload); channels = data.readUInt16LE(payload + 2); rate = data.readUInt32LE(payload + 4); bits = data.readUInt16LE(payload + 14)
      // WAVE_FORMAT_EXTENSIBLE guarda o subtipo PCM/IEEE na GUID.
      if (format === 0xfffe && size >= 40) format = data.readUInt16LE(payload + 24)
    }
    if (tag === 'data') { dataBytes = size; break }
    position = payload + size + size % 2
  }
  if (!format || !dataBytes) throw new Error('WAV sem fmt/data válidos na prova.')
  return { format, channels, rate, bits, dataBytes }
}
export function level(values: Float32Array): { rmsDbfs: number; peakDbfs: number; clippedSamples: number; samples: number; durationMs: number } {
  let power = 0, peak = 0, clipped = 0
  for (const value of values) { power += value * value; peak = Math.max(peak, Math.abs(value)); if (Math.abs(value) >= 1) clipped++ }
  return { rmsDbfs: db(power / values.length), peakDbfs: db(peak * peak), clippedSamples: clipped, samples: values.length, durationMs: values.length / 48 }
}
/** Alinhamento cíclico: primeiro em blocos médios de 1 ms; depois amostra a amostra. */
export function cyclicOffset(observed: Float32Array, cycle: Float32Array): number {
  const hop = 48, n = Math.min(observed.length, SR * 6)
  const smooth = (values: Float32Array): Float64Array => {
    const out = new Float64Array(Math.floor(values.length / hop))
    for (let i = 0; i < out.length; i++) { let sum = 0; for (let j = 0; j < hop; j++) sum += values[i * hop + j]!; out[i] = sum / hop }
    return out
  }
  const a = smooth(observed.subarray(0, n)), b = smooth(cycle)
  let best = -Infinity, coarse = 0
  // Uma leitura a cada 2 ms basta na busca longa; o refinamento usa toda a banda.
  for (let at = 0; at < b.length; at++) {
    let dot = 0, energy = 0
    for (let i = 0; i < a.length; i += 2) { const x = b[(i + at) % b.length]!; dot += a[i]! * x; energy += x * x }
    const score = energy ? dot / Math.sqrt(energy) : 0
    if (score > best) { best = score; coarse = at * hop }
  }
  best = -Infinity
  let fine = coarse
  for (let at = coarse - hop * 2; at <= coarse + hop * 2; at++) {
    let dot = 0, energy = 0
    for (let i = 0; i < n; i += 3) { const x = cycle[((i + at) % cycle.length + cycle.length) % cycle.length]!; dot += observed[i]! * x; energy += x * x }
    const score = energy ? dot / Math.sqrt(energy) : 0
    if (score > best) { best = score; fine = at }
  }
  return (fine % cycle.length + cycle.length) % cycle.length
}
export function repeatAligned(cycle: Float32Array, offset: number, count: number): Float32Array {
  const values = new Float32Array(count)
  for (let i = 0; i < count; i++) values[i] = cycle[(i + offset) % cycle.length]!
  return values
}
/** Apenas atraso fracionário: sinc de 129 taps, janela Hann e ganho DC unitário. */
function delayKernel(fraction: number): Float64Array {
  const radius = 64, kernel = new Float64Array(radius * 2 + 1)
  let sum = 0
  for (let tap = -radius; tap <= radius; tap++) {
    const x = fraction - tap
    const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
    const weight = sinc * (.5 + .5 * Math.cos(Math.PI * tap / radius))
    kernel[tap + radius] = weight; sum += weight
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] = kernel[i]! / sum
  return kernel
}
function interpolated(cycle: Float32Array, at: number, kernel: Float64Array): number {
  let value = 0
  for (let tap = -64; tap <= 64; tap++) value += cycle[((at + tap) % cycle.length + cycle.length) % cycle.length]! * kernel[tap + 64]!
  return value
}
export function repeatFractional(cycle: Float32Array, offset: number, count: number): Float32Array {
  const whole = Math.round(offset), kernel = delayKernel(offset - whole), values = new Float32Array(count)
  for (let i = 0; i < count; i++) values[i] = interpolated(cycle, whole + i, kernel)
  return values
}
/** Ajusta só ±0,5 amostra em torno da fase inteira; não corrige drift nem altera a banda. */
export function fractionalOffset(observed: Float32Array, cycle: Float32Array, whole: number): number {
  const n = Math.min(observed.length, SR * 6)
  const score = (fraction: number): number => {
    const kernel = delayKernel(fraction)
    let xy = 0, xx = 0, yy = 0
    // Passo coprimo a 48 para não observar sempre a mesma fase das sondas.
    for (let i = 0; i < n; i += 23) { const x = interpolated(cycle, whole + i, kernel), y = observed[i]!; xy += x * y; xx += x * x; yy += y * y }
    return xx && yy ? xy / Math.sqrt(xx * yy) : 0
  }
  let best = -Infinity, coarse = 0
  for (let index = -10; index <= 10; index++) { const fraction = index / 20, value = score(fraction); if (value > best) { best = value; coarse = fraction } }
  let result = coarse
  for (let index = -10; index <= 10; index++) {
    const fraction = coarse + index / 200
    if (Math.abs(fraction) > .5) continue
    const value = score(fraction)
    if (value > best) { best = value; result = fraction }
  }
  return whole + result
}
/** Alinha saída e referência em ±50 ms. A defasagem continua explícita nas métricas. */
export function relativeDelay(observed: Float32Array, reference: Float32Array): number {
  const span = 2400, n = Math.min(observed.length, reference.length, SR * 8)
  const coarseSeries = (values: Float32Array): Float64Array => {
    const out = new Float64Array(Math.floor(n / 48))
    for (let i = 0; i < out.length; i++) { let sum = 0; for (let k = 0; k < 48; k++) sum += values[i * 48 + k]!; out[i] = sum / 48 }
    return out
  }
  const a = coarseSeries(observed), b = coarseSeries(reference)
  let coarseScore = -Infinity, coarse = 0
  for (let delay = -50; delay <= 50; delay++) {
    let xy = 0, xx = 0, yy = 0
    for (let i = 50; i < b.length - 50; i++) { const x = b[i]!, y = a[i + delay]!; xy += x * y; xx += x * x; yy += y * y }
    const value = xx && yy ? xy / Math.sqrt(xx * yy) : 0
    if (value > coarseScore) { coarseScore = value; coarse = delay * 48 }
  }
  const score = (delay: number, stride: number): number => {
    let xy = 0, xx = 0, yy = 0
    for (let i = span; i < n - span; i += stride) { const x = reference[i]!, y = observed[i + delay]!; xy += x * y; xx += x * x; yy += y * y }
    return xx && yy ? xy / Math.sqrt(xx * yy) : 0
  }
  let best = -Infinity, result = coarse
  for (let delay = Math.max(-span, coarse - 96); delay <= Math.min(span, coarse + 96); delay++) { const value = score(delay, 3); if (value > best) { best = value; result = delay } }
  return result
}
/** Ganho de mínimos quadrados; o resíduo conta também distorção, não apenas ruído. */
export function compare(observed: Float32Array, reference: Float32Array, mask?: Uint8Array): { correlation: number; gain: number; residualSnrDb: number; residualRmsDbfs: number; signalRmsDbfs: number; usedSamples: number } {
  let xy = 0, xx = 0, yy = 0, count = 0
  const n = Math.min(observed.length, reference.length)
  for (let i = 0; i < n; i++) { if (mask && !mask[i]) continue; const x = reference[i]!, y = observed[i]!; xy += x * y; xx += x * x; yy += y * y; count++ }
  const gain = xx ? xy / xx : 0
  const residual = Math.max(0, yy - 2 * gain * xy + gain * gain * xx)
  const signal = gain * gain * xx
  return { correlation: xx && yy ? xy / Math.sqrt(xx * yy) : 0, gain, residualSnrDb: db(signal / Math.max(residual, 1e-20)),
    residualRmsDbfs: db(residual / count), signalRmsDbfs: db(signal / count), usedSamples: count }
}
export function maskedPower(values: Float32Array, mask: Uint8Array): number {
  let power = 0, count = 0
  for (let i = 0; i < Math.min(values.length, mask.length); i++) if (mask[i]) { power += values[i]! ** 2; count++ }
  return power / count
}
export function floorBlocks(values: Float32Array): { p20Dbfs: number; medianDbfs: number; p95Dbfs: number } {
  const blocks: number[] = []
  for (let start = 0; start + 960 <= values.length; start += 960) { let power = 0; for (let i = start; i < start + 960; i++) power += values[i]! ** 2; blocks.push(db(power / 960)) }
  blocks.sort((a, b) => a - b)
  return { p20Dbfs: blocks[Math.floor(blocks.length * .2)]!, medianDbfs: blocks[Math.floor(blocks.length * .5)]!, p95Dbfs: blocks[Math.floor(blocks.length * .95)]! }
}
export function toneAmplitude(values: Float32Array, frequency: number, start: number, count: number): number {
  let real = 0, imaginary = 0
  for (let i = start; i < start + count; i++) { real += values[i]! * Math.cos(2 * Math.PI * frequency * i / SR); imaginary += values[i]! * Math.sin(2 * Math.PI * frequency * i / SR) }
  return 2 * Math.hypot(real, imaginary) / count
}
export function loudness(file: string): { lufs: number; truePeakDbtp: number; lra: number } {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', file, '-vn', '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`Falha ao medir LUFS: ${result.stderr}`)
  const json = /\{\s*"input_i"[\s\S]*?\}/.exec(result.stderr)?.[0]
  if (!json) throw new Error('O ffmpeg não devolveu a medição de LUFS.')
  const data = JSON.parse(json) as Record<string, string>
  return { lufs: Number(data.input_i), truePeakDbtp: Number(data.input_tp), lra: Number(data.input_lra) }
}
/**
 * Atraso inteiro (amostras) de `observed` em relação a `reference`, buscado em [0, maxLag]. Grosso pelo ENVELOPE (média de |x[i]-x[i-1]| a
 * cada 1 ms) e fino amostra a amostra sobre a diferença primeira. A diferença primeira tira o zumbido de 50 Hz: periódico, ele produz
 * picos de correlação iguais a cada 20 ms e já fez a busca cair em um deles; ruído branco e fala têm um pico só.
 */
export function exactLag(observed: Float32Array, reference: Float32Array, maxLag = SR * 2): number {
  const hop = 48, blocks = Math.min(Math.floor(reference.length / hop), 6000), total = blocks + Math.ceil(maxLag / hop) + 2
  const envelope = (values: Float32Array, count: number): Float64Array => {
    const out = new Float64Array(count)
    for (let k = 0; k < count; k++) { let sum = 0; for (let j = 0; j < hop; j++) { const i = k * hop + j; sum += Math.abs((values[i] ?? 0) - (values[i - 1] ?? 0)) } out[k] = sum / hop }
    return out
  }
  const want = envelope(reference, blocks), seen = envelope(observed, total)
  const centered = (values: Float64Array, from: number, count: number): number[] => { let mean = 0; for (let k = 0; k < count; k++) mean += values[from + k] ?? 0; mean /= count; return Array.from({ length: count }, (_, k) => (values[from + k] ?? 0) - mean) }
  const target = centered(want, 0, blocks)
  let best = -Infinity, coarse = 0
  for (let lag = 0; lag <= Math.ceil(maxLag / hop); lag++) {
    const window = centered(seen, lag, blocks)
    let xy = 0, xx = 0, yy = 0
    for (let k = 0; k < blocks; k++) { xy += target[k]! * window[k]!; xx += target[k]! ** 2; yy += window[k]! ** 2 }
    const score = xx && yy ? xy / Math.sqrt(xx * yy) : 0
    if (score > best) { best = score; coarse = lag * hop }
  }
  best = -Infinity
  let fine = coarse
  const count = Math.min(reference.length - 1, SR * 4)
  for (let lag = Math.max(0, coarse - hop * 2); lag <= coarse + hop * 2; lag++) {
    let xy = 0, xx = 0, yy = 0
    for (let i = 1; i < count; i++) { const x = reference[i]! - reference[i - 1]!, y = (observed[i + lag] ?? 0) - (observed[i + lag - 1] ?? 0); xy += x * y; xx += x * x; yy += y * y }
    const score = xx && yy ? xy / Math.sqrt(xx * yy) : 0
    if (score > best) { best = score; fine = lag }
  }
  return fine
}
