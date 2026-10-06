import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectProjectAudioQuality } from '../../src/main/audio-quality'

/** WAV sintético com um chunk desconhecido ímpar antes do fmt, como arquivos de dispositivos/ffmpeg. */
function wav(format: 1 | 3, samples: number[], channels = 1): Buffer {
  const width = format === 1 ? 2 : 4
  const data = Buffer.alloc(samples.length * width)
  samples.forEach((s, i) => format === 1 ? data.writeInt16LE(Math.round(s * 32767), i * width) : data.writeFloatLE(s, i * width))
  const header = Buffer.alloc(54)
  header.write('RIFF', 0); header.writeUInt32LE(header.length + data.length - 8, 4); header.write('WAVE', 8)
  header.write('JUNK', 12); header.writeUInt32LE(1, 16); header[20] = 7
  header.write('fmt ', 22); header.writeUInt32LE(16, 26); header.writeUInt16LE(format, 30); header.writeUInt16LE(channels, 32)
  header.writeUInt32LE(48_000, 34); header.writeUInt32LE(48_000 * channels * width, 38); header.writeUInt16LE(channels * width, 42); header.writeUInt16LE(width * 8, 44)
  header.write('data', 46); header.writeUInt32LE(data.length, 50)
  return Buffer.concat([header, data])
}

async function workspace(job: (dir: string) => Promise<void>): Promise<void> {
  const root = resolve('test-results/tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'audio-quality-'))
  try { await mkdir(join(dir, 'media')); await job(dir) }
  finally { await rm(dir, { recursive: true, force: true }) }
}

describe('análise do WAV no projeto', () => {
  it.each([1, 3] as const)('lê PCM formato %i com chunks extras e mantém o limiar de 100 ms', async (format) => workspace(async (dir) => {
    const samples = Array<number>(48_000).fill(0)
    samples.fill(0.95, 0, 2400); samples.fill(-0.95, 24_000, 26_400)
    await writeFile(join(dir, 'media/voice.wav'), wav(format, samples))
    const quality = await inspectProjectAudioQuality(dir)
    expect(quality.sampleRate).toBe(48_000)
    expect(quality.durationMs).toBe(1000)
    expect(quality.clippingMs).toBe(100)
    expect(quality.warnings).toEqual(['clipping'])
  }))

  it('processa mais de um pedaço sem perder amostras nem o bloco final', async () => workspace(async (dir) => {
    const samples = Array<number>(48_000 * 2 + 144).fill(0)
    samples.fill(0.95, 47_900, 52_700)
    await writeFile(join(dir, 'media/voice.wav'), wav(3, samples))
    const quality = await inspectProjectAudioQuality(dir)
    expect(quality.durationMs).toBe(2003)
    expect(quality.clippingMs).toBe(100)
    expect(quality.warnings).toEqual(['clipping'])
  }))

  it('lê cabeçalho PCM extensível float32 com GUID padrão', async () => workspace(async (dir) => {
    const plain = wav(3, Array<number>(4800).fill(0.95))
    const extensible = Buffer.concat([plain.subarray(0, 46), Buffer.alloc(24), plain.subarray(46)])
    extensible.writeUInt32LE(extensible.length - 8, 4)
    extensible.writeUInt32LE(40, 26)
    extensible.writeUInt16LE(0xfffe, 30)
    extensible.writeUInt16LE(22, 46)
    extensible.writeUInt16LE(32, 48)
    extensible.writeUInt32LE(4, 50) // speaker front-center, mono
    Buffer.from('0300000000001000800000aa00389b71', 'hex').copy(extensible, 54)
    await writeFile(join(dir, 'media/voice.wav'), extensible)
    expect((await inspectProjectAudioQuality(dir)).warnings).toEqual(['clipping'])
  }))

  it('aceita fala contínua confirmada e rejeita fuga para fora da pasta antes de ler', async () => workspace(async (dir) => {
    const samples = Array.from({ length: 48_000 }, (_, i) => 0.01 * Math.SQRT2 * Math.sin(2 * Math.PI * 200 * i / 48_000))
    await writeFile(join(dir, 'media/voice.wav'), wav(3, samples))
    const quality = await inspectProjectAudioQuality(dir, 'media/voice.wav', { activeRanges: [{ start: 0, end: 1000 }] })
    expect(quality.activeRmsDbfs).toBeCloseTo(-40, 3)
    expect(quality.warnings).toEqual(['low-voice'])
    await expect(inspectProjectAudioQuality(dir, '../../settings.json')).rejects.toThrow(/fora|relativo/i)
  }))

  it('rejeita WAV truncado, formato comprimido, estéreo e PCM não finito com motivo', async () => workspace(async (dir) => {
    const file = join(dir, 'media/voice.wav')
    const good = wav(3, [0, 0.1])
    await writeFile(file, good.subarray(0, good.length - 1))
    await expect(inspectProjectAudioQuality(dir)).rejects.toThrow(/incompleto|truncado/i)
    const compressed = Buffer.from(good); compressed.writeUInt16LE(6, 30)
    await writeFile(file, compressed)
    await expect(inspectProjectAudioQuality(dir)).rejects.toThrow(/PCM/i)
    await writeFile(file, wav(3, [0, 0.1], 2))
    await expect(inspectProjectAudioQuality(dir)).rejects.toThrow(/mono/i)
    await writeFile(file, wav(3, [NaN]))
    await expect(inspectProjectAudioQuality(dir)).rejects.toThrow(/amostra/i)
  }))
})
