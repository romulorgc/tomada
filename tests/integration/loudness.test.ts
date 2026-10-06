import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectProjectAudioQuality } from '../../src/main/audio-quality'
import { IntegratedLoudness } from '../../src/shared/loudness'
import { audioQualityWarningMessages } from '../../src/shared/audio-quality-messages'
import { FIX, requireFfmpeg } from '../helpers/env'

const ff = requireFfmpeg()

async function floats(path: string): Promise<Float32Array> {
  const bytes = await readFile(path), out = new Float32Array(bytes.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = bytes.readFloatLE(i * 4)
  return out
}
const ebur128 = async (file: string): Promise<number> => {
  const run = await ff.run(['-loglevel', 'info', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'])
  const match = /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+) LUFS/.exec(run.stderr)
  if (!match) throw new Error(`ebur128 sem resultado: ${run.stderr.slice(-400)}`)
  return Number(match[1])
}
async function workspace(job: (dir: string) => Promise<void>): Promise<void> {
  const root = resolve('test-results/tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'loudness-'))
  try { await mkdir(join(dir, 'media')); await job(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

describe('volume integrado conferido com o ebur128 do ffmpeg', () => {
  it.each([0, -12, -30, -48])('a voz Maria com %i dB de ganho mede o mesmo que o ffmpeg (±0,1 LU)', async (gain) => workspace(async (dir) => {
    const wav = join(dir, 'media/voice.wav'), raw = join(dir, 'media/voice.f32')
    await ff.run(['-i', FIX.voz, '-af', `volume=${gain}dB`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_f32le', wav])
    await ff.run(['-i', wav, '-f', 'f32le', raw])
    const meter = new IntegratedLoudness()
    meter.push(await floats(raw))
    expect(Math.abs(meter.finish()! - await ebur128(wav))).toBeLessThan(0.1)
  }), 60_000)
})

describe('CASO DE ACEITE (gravação real do usuário, 06/10/2026): voz bruta a -58 LUFS e pico -38 dBFS', () => {
  it('o projeto guarda o volume bruto e o aviso explica o motivo e o que fazer; voz normal não avisa', async () => workspace(async (dir) => {
    // A voz Maria reduzida até o pico ficar em -38 dBFS: o mesmo pico da gravação real do microfone com 0% de volume de entrada.
    const peak = await ff.run(['-loglevel', 'info', '-i', FIX.voz, '-af', 'volumedetect', '-f', 'null', '-'])
    const maxVolume = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(peak.stderr)![1])
    await ff.run(['-i', FIX.voz, '-af', `volume=${-38 - maxVolume}dB`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_f32le', join(dir, 'media/voice.wav')])
    const quiet = await inspectProjectAudioQuality(dir)
    expect(quiet.peakDbfs!).toBeCloseTo(-38, 0)
    expect(quiet.integratedLufs!).toBeLessThan(-40)
    expect(quiet.integratedLufs!).toBeGreaterThan(-62)
    expect(quiet.warnings).toContain('very-low-level')
    const messages = audioQualityWarningMessages(quiet)
    // Uma mensagem só (a de "muito baixa" já cobre "voz baixa"), com o número, o motivo e a ação.
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('LUFS')
    expect(messages[0]).toContain('volume de ENTRADA')
    expect(messages[0]).toContain('Ajustar sozinho')
    console.log(`[aceite] voz bruta ${quiet.integratedLufs!.toFixed(1)} LUFS, pico ${quiet.peakDbfs!.toFixed(1)} dBFS (caso real: -58,3 LUFS, -38 dBFS): ${quiet.warnings.join(', ')}`)

    await ff.run(['-i', FIX.voz, '-af', `volume=${-12 - maxVolume}dB`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_f32le', join(dir, 'media/voice.wav'), '-y'])
    const normal = await inspectProjectAudioQuality(dir)
    expect(normal.integratedLufs!).toBeGreaterThan(-40)
    expect(normal.warnings).not.toContain('very-low-level')
    expect(audioQualityWarningMessages(normal)).toEqual([])
  }), 60_000)

  it('relatório salvo antes do campo (sem integratedLufs) continua válido', async () => {
    const { audioQualitySchema } = await import('../../src/shared/audio-quality')
    const old = { version: 1, sampleRate: 48000, durationMs: 1000, peakDbfs: -3, clippingMs: 0, activeMs: 500, activeRmsDbfs: -20, noiseFloorDbfs: -60, warnings: [] }
    expect(audioQualitySchema.parse(old).integratedLufs).toBeUndefined()
  })
})
