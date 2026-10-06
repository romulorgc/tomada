import { copyFile, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { measureVoiceNoise } from '../../src/main/voice-noise'
import { FIX, requireFfmpeg } from '../helpers/env'
import { run, probeJson } from '../helpers/media'
import { buildAudioArgs, buildAudioGraph, buildMeasureArgs, parseLoudnormMeasure, voiceChainCompensated } from '../../src/main/audio-graph'
import { createDerivedMedia } from '../../src/main/derived-media'
import { createExportService, type ExportService } from '../../src/main/export-service'
import { createMemoryLogger } from '../../src/main/logger'
import { createOutputDirs } from '../../src/main/path-guard'
import { parseProject } from '../../src/shared/project'
import { parseTranscript } from '../../src/shared/transcript'
import type { Ffmpeg } from '../../src/main/ffmpeg'
import { correlatePcm } from '../../src/shared/pcm-alignment'

const ff = requireFfmpeg()
const dir = resolve('test-results', `audio-pos-${randomUUID()}`)
const voice = join(dir, 'voz.wav')
const evidence: Record<string, unknown> = {}
beforeAll(async () => {
  await mkdir(dir, { recursive: true })
  // Tom periódico representa fala; chiado uniforme conhecido continua nas pausas.
  await ff.run(['-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.008:seed=173:sample_rate=48000:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=200:sample_rate=48000:duration=4',
    '-filter_complex', "[1:a]volume='between(t,1,3)':eval=frame[v];[0:a][v]amix=inputs=2:normalize=0[out]",
    '-map', '[out]', '-c:a', 'pcm_f32le', voice])
})
afterAll(async () => {
  await writeFile(resolve('test-results/audio-pos-medidas.json'), JSON.stringify(evidence, null, 2))
  if (!dir.startsWith(resolve('test-results') + '\\')) throw new Error('Pasta de teste fora do repositório')
  await rm(dir, { recursive: true, force: true })
})

describe('pós real, sem monitoramento ou dispositivo de áudio', () => {
  it('transcrição que chega durante a prévia faz o segundo pedido aguardar e reconstruir com a máscara atual', async () => {
    const projectDir = join(dir, 'corrida-transcricao')
    await mkdir(join(projectDir, 'media'), { recursive: true })
    await copyFile(voice, join(projectDir, 'media/voice.wav'))
    const project = parseProject(await readFile(join(FIX.exemplo, 'project.json'), 'utf8'))
    project.sources = { voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs: 4000 } }
    project.sync.cameraOffsetMs = 0
    const transcript = join(projectDir, 'transcript.json')
    await writeFile(transcript, JSON.stringify({ words: [{ text: 'teste', start: 900, end: 3100 }] }))
    const graphs: string[] = []
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>(r => { release = r })
    const started = new Promise<void>(r => { entered = r })
    const delayed: Ffmpeg = { ...ff, run: async (args, opts) => {
      const index = args.indexOf('-/filter_complex')
      if (index >= 0) {
        graphs.push(await readFile(args[index + 1]!, 'utf8'))
        if (graphs.length === 1) { entered(); await blocked }
      }
      return ff.run(args, opts)
    } }
    const derived = createDerivedMedia({ read: async () => ({ project, dir: projectDir }), logger: createMemoryLogger(), ffmpeg: () => delayed })
    const first = derived.previewAudio('teste')
    try {
      await started
      // A transcrição nova protege inclusive voz/fricativas nas regiões antes consideradas silêncio.
      await writeFile(transcript, JSON.stringify({ words: [{ text: 'fala contínua', start: 0, end: 4000 }] }))
      const future = new Date(Date.now() + 2000)
      await utimes(transcript, future, future)
      const second = derived.previewAudio('teste')
      release()
      const [old, fresh] = await Promise.all([first, second])
      expect(old).not.toBeNull(); expect(fresh).not.toBeNull()
      expect(graphs).toHaveLength(4)
      expect(graphs[0]).toContain('afftdn=')
      expect(graphs[1]).toContain('afftdn=')
      expect(graphs[2]).not.toContain('afftdn=')
      expect(graphs[3]).not.toContain('afftdn=')
      expect(fresh!.url).not.toBe(old!.url)
      evidence.previewRace = { initialDenoise: true, rebuiltAfterTranscript: true }
    } finally { release(); await first }
  })

  it('prévia e exportação medem a fonte antes dos cortes e usam exatamente o mesmo nf nos dois passes e formatos', async () => {
    const projectDir = join(dir, 'projeto')
    await mkdir(join(projectDir, 'media'), { recursive: true })
    await copyFile(voice, join(projectDir, 'media/voice.wav'))
    const project = parseProject(await readFile(join(FIX.exemplo, 'project.json'), 'utf8'))
    await ff.run(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30', '-frames:v', '120', '-c:v', 'libx264', join(projectDir, 'media/camera.mp4')])
    project.sources = { voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs: 4000 }, camera: { path: 'media/camera.mp4', w: 160, h: 90, fps: 30, durationMs: 4000 } }
    project.cuts = [{ id: 'inicio', start: 0, end: 1000, reason: 'silence', enabled: true }, { id: 'fim', start: 3000, end: 4000, reason: 'silence', enabled: true }]
    project.sync.cameraOffsetMs = 0
    const words = [{ i: 0, text: 'teste', start: 900, end: 3100, prob: 1, kind: 'word' as const }]
    await writeFile(join(projectDir, 'transcript.json'), JSON.stringify({ words }))
    const graphs: string[] = [], bitrates: string[] = []
    const recording: Ffmpeg = { ...ff, run: async (args, opts) => {
      const graphIndex = args.indexOf('-/filter_complex')
      if (graphIndex >= 0) graphs.push(await readFile(args[graphIndex + 1]!, 'utf8'))
      const bitrateIndex = args.indexOf('-b:a')
      if (bitrateIndex >= 0) bitrates.push(args[bitrateIndex + 1]!)
      return ff.run(args, opts)
    } }
    const logger = createMemoryLogger()
    const derived = createDerivedMedia({ read: async () => ({ project, dir: projectDir }), logger, ffmpeg: () => recording })
    expect(await derived.previewAudio('teste')).not.toBeNull()
    let svc: ExportService
    svc = createExportService({ read: async () => ({ project, dir: projectDir }), words: async () => words,
      logger, ffmpeg: () => recording, outputDirs: createOutputDirs(), now: () => performance.now(), emit: () => undefined,
      openExporterWindow: id => {
        queueMicrotask(() => { void (async () => {
          const video = join(dir, 'video-teste.mp4')
          await ff.run(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30', '-frames:v', '60', '-c:v', 'libx264', video])
          await svc.write(id, 0, new Uint8Array(await readFile(video)))
          svc.finish(id, { ok: true, frames: 60, encoder: 'teste CPU' })
        })().catch(err => svc.finish(id, { ok: false, message: String(err) })) })
        return { destroy: () => undefined }
      }
    })
    for (const format of ['horizontal', 'vertical'] as const) {
      const { exportId } = await svc.start({ projectId: 'teste', resolution: '1080p', fps: 30, format })
      await svc.idle()
      expect(svc.status(exportId)?.phase, svc.status(exportId)?.message).toBe('done')
    }
    expect(graphs).toHaveLength(6)
    const floors = graphs.map(graph => graph.match(/afftdn=nr=6:nf=([^:]+):/u)?.[1])
    expect(floors[0]).toBeDefined()
    expect(new Set(floors).size).toBe(1)
    expect(graphs.every(graph => (graph.match(/afftdn=/g) ?? []).length === 1)).toBe(true)
    expect(bitrates).toEqual(['320k', '320k', '320k'])
  })

  it('decodifica float32 em fluxo, mede o piso após highpass e distingue silêncio de voz', async () => {
    const result = await measureVoiceNoise(ff, { voicePath: voice, words: [{ i: 0, text: 'teste', start: 900, end: 3100, prob: 1, kind: 'word' }] })
    // Ruído uniforme [-0.008,0.008]: RMS = 0.008/sqrt(3), aproximadamente -46.71 dBFS.
    expect(result.source).toBe('transcript')
    expect(result.noiseFloorDb).toBeGreaterThan(-47.2)
    expect(result.noiseFloorDb).toBeLessThan(-46.4)
    const fallback = await measureVoiceNoise(ff, { voicePath: voice })
    expect(fallback.source).toBe('vad')
    expect(fallback.noiseFloorDb).toBeCloseTo(result.noiseFloorDb!, 0)
    evidence.floor = { transcript: result, vad: fallback }
  })

  it('cancelamento, fonte corrompida e protocolo externo rejeitam, sem processo pendurado', async () => {
    const abort = new AbortController(); abort.abort()
    await expect(measureVoiceNoise(ff, { voicePath: voice, signal: abort.signal })).rejects.toThrow(/cancelad/i)
    const broken = join(dir, 'corrompido.wav')
    await writeFile(broken, 'não é mídia')
    await expect(measureVoiceNoise(ff, { voicePath: broken })).rejects.toThrow(/ffmpeg/i)
    await expect(measureVoiceNoise(ff, { voicePath: 'https://example.com/voz.wav' })).rejects.toThrow(/completo/)
  })

  it('redução moderada diminui chiado preservando a voz e duração exata com 1200 amostras compensadas', async () => {
    const noise = await measureVoiceNoise(ff, { voicePath: voice })
    const render = (chain: string): Float32Array => {
      const bytes = run('ffmpeg', ['-v', 'error', '-i', voice, '-af', chain, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'])
      return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
    }
    const raw = render('highpass=f=80')
    const clean = render(voiceChainCompensated(4000, noise.noiseFloorDb))
    const rms = (pcm: Float32Array, from: number, to: number) => {
      let energy = 0
      for (let i = from; i < to; i++) energy += pcm[i]! ** 2
      return Math.sqrt(energy / (to - from))
    }
    expect(clean.length).toBe(192_000)
    const noiseReductionDb = 20 * Math.log10(rms(raw, 12_000, 36_000) / rms(clean, 12_000, 36_000))
    const voiceGainDb = 20 * Math.log10(rms(clean, 60_000, 132_000) / rms(raw, 60_000, 132_000))
    expect(noiseReductionDb).toBeGreaterThan(3)
    expect(voiceGainDb).toBeGreaterThan(-2)
    let dot = 0, a = 0, b = 0
    for (let i = 60_000; i < 132_000; i++) { dot += raw[i]! * clean[i]!; a += raw[i]! ** 2; b += clean[i]! ** 2 }
    expect(dot / Math.sqrt(a * b)).toBeGreaterThan(0.97)
    evidence.tone = { noiseReductionDb, voiceGainDb, correlation: dot / Math.sqrt(a * b), samples: clean.length }
  })

  it('a compensação de 1200 amostras conserva também a fala nos últimos 25 ms', async () => {
    const bytes = run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=200:sample_rate=48000:duration=1',
      '-af', voiceChainCompensated(1000, -50), '-f', 'f32le', '-'])
    const pcm = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
    let energy = 0
    for (let i = 47_040; i < 48_000; i++) energy += pcm[i]! ** 2
    expect(Math.sqrt(energy / 960)).toBeGreaterThan(0.06)
    expect(pcm.length).toBe(48_000)
    evidence.tailRms = Math.sqrt(energy / 960)
  })

  it('sinal não periódico com silêncio medido prova a sincronia do afftdn ativo e acusa compensação ausente/errada', async () => {
    const input = join(dir, 'sincronia-aperiodica.wav')
    await ff.run(['-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.008:seed=613:sample_rate=48000:duration=4',
      '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.16:seed=1729:sample_rate=48000:duration=4',
      '-filter_complex', "[1:a]lowpass=f=3500,highpass=f=120,volume='between(t,1,3)':eval=frame[v];[0:a][v]amix=inputs=2:normalize=0[a]",
      '-map', '[a]', '-c:a', 'pcm_f32le', input])
    const noise = await measureVoiceNoise(ff, { voicePath: input, words: [{ i: 0, text: 'referência', start: 900, end: 3100, prob: 1, kind: 'word' }] })
    expect(noise.noiseFloorDb).not.toBeNull()
    const chain = voiceChainCompensated(4000, noise.noiseFloorDb)
    expect(chain).toContain('afftdn=')
    const render = (filters: string): Float32Array => {
      const bytes = run('ffmpeg', ['-v', 'error', '-i', input, '-af', filters, '-ar', '8000', '-ac', '1', '-f', 'f32le', '-'])
      return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
    }
    // A referência recebe somente highpass, sem reutilizar o redutor/compensação sob teste.
    const reference = render('highpass=f=80')
    const correct = correlatePcm(reference, render(chain))
    const missing = correlatePcm(reference, render(chain.replace('atrim=start_sample=1200,', '')))
    const wrong = correlatePcm(reference, render(chain.replace('atrim=start_sample=1200', 'atrim=start_sample=1000')))
    expect(correct).not.toBeNull()
    expect(Math.abs(correct!.offsetMs)).toBeLessThanOrEqual(2)
    expect(correct!.correlation).toBeGreaterThan(0.94)
    // Mutações executadas de verdade provam que o teste enxerga 25 ms e erro de 200 amostras.
    expect(Math.abs(missing!.offsetMs)).toBeGreaterThan(24)
    expect(Math.abs(wrong!.offsetMs)).toBeGreaterThan(3)
    evidence.aperiodicSync = { noise, correct, missingCompensation: missing, wrongCompensation1000: wrong }
  })

  it('voz Maria com chiado conhecido mantém correlação e distorção medidas, e AAC final respeita LUFS/pico', async () => {
    const maria = join(dir, 'maria-ruido.wav')
    const durationMs = (await ff.probe(FIX.voz)).durationMs
    await ff.run(['-i', FIX.voz, '-f', 'lavfi', '-i', `anoisesrc=color=white:amplitude=0.004:seed=923:sample_rate=48000:duration=${durationMs / 1000}`,
      '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]', '-map', '[a]', '-c:a', 'pcm_f32le', maria])
    const words = parseTranscript(await readFile(join(FIX.exemplo, 'transcript.json'), 'utf8')).words
    const noise = await measureVoiceNoise(ff, { voicePath: maria, words })
    expect(noise.source).toBe('transcript')
    expect(noise.noiseFloorDb).toBeGreaterThan(-53.5)
    expect(noise.noiseFloorDb).toBeLessThan(-52.3)
    const decode = (path: string, chain: string): Float32Array => {
      const buf = run('ffmpeg', ['-v', 'error', '-i', path, '-af', chain, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'])
      return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
    }
    const reference = decode(FIX.voz, 'highpass=f=80')
    const raw = decode(maria, 'highpass=f=80')
    const clean = decode(maria, voiceChainCompensated(durationMs, noise.noiseFloorDb))
    let dot = 0, a = 0, b = 0, quietRaw = 0, quietClean = 0
    for (let i = 28_800; i < 259_200; i++) { dot += reference[i]! * clean[i]!; a += reference[i]! ** 2; b += clean[i]! ** 2 }
    for (let i = 288_000; i < 326_400; i++) { quietRaw += raw[i]! ** 2; quietClean += clean[i]! ** 2 }
    const correlation = dot / Math.sqrt(a * b)
    const gain = dot / a
    let error = 0
    for (let i = 28_800; i < 259_200; i++) error += (clean[i]! - reference[i]! * gain) ** 2
    const distortionDb = 10 * Math.log10(a * gain ** 2 / error)
    const noiseReductionDb = 10 * Math.log10(quietRaw / quietClean)
    expect(correlation).toBeGreaterThan(0.94)
    expect(distortionDb).toBeGreaterThan(9)
    expect(noiseReductionDb).toBeGreaterThan(3)

    const common = { kept: [{ start: 0, end: durationMs }], voice: { input: 0, offsetMs: 0, channels: 1 as const }, system: null, noiseFloorDb: noise.noiseFloorDb }
    const graph1 = join(dir, 'maria-medir.txt'), graph2 = join(dir, 'maria-final.txt'), output = join(dir, 'maria.m4a')
    await writeFile(graph1, buildAudioGraph({ ...common, mode: 'measure' }).graph)
    const measured = parseLoudnormMeasure((await ff.run(buildMeasureArgs({ inputs: [maria], graphFile: graph1 }))).stderr)
    expect(measured).not.toBeNull()
    await writeFile(graph2, buildAudioGraph({ ...common, mode: 'final', measured }).graph)
    await ff.run(buildAudioArgs({ inputs: [maria], graphFile: graph2, output, durationMs }))
    const encoded = parseLoudnormMeasure((await ff.run(['-loglevel', 'info', '-i', output, '-af', 'loudnorm=I=-14:TP=-1:print_format=json', '-f', 'null', '-'])).stderr)!
    evidence.maria = { noise, correlation, distortionDb, noiseReductionDb, firstPass: measured, encoded }
    expect(Number(encoded.input_i)).toBeGreaterThanOrEqual(-14.5)
    expect(Number(encoded.input_i)).toBeLessThanOrEqual(-13.5)
    expect(Number(encoded.input_tp)).toBeLessThanOrEqual(-1)
  })

  it('dois passes reais geram AAC 48 kHz com -14 LUFS e pico verdadeiro <= -1 dBTP', async () => {
    const noise = await measureVoiceNoise(ff, { voicePath: voice })
    const common = { kept: [{ start: 0, end: 4000 }], voice: { input: 0, offsetMs: 0, channels: 1 as const }, system: null, noiseFloorDb: noise.noiseFloorDb }
    const graph1 = join(dir, 'medir.txt'), graph2 = join(dir, 'final.txt'), output = join(dir, 'audio.m4a')
    await writeFile(graph1, buildAudioGraph({ ...common, mode: 'measure' }).graph)
    const first = await ff.run(buildMeasureArgs({ inputs: [voice], graphFile: graph1 }))
    const measured = parseLoudnormMeasure(first.stderr)
    expect(measured).not.toBeNull()
    await writeFile(graph2, buildAudioGraph({ ...common, mode: 'final', measured }).graph)
    await ff.run(buildAudioArgs({ inputs: [voice], graphFile: graph2, output, durationMs: 4000 }))
    const encoded = probeJson(output).streams.find(s => s.codec_type === 'audio')!
    expect(encoded.codec_name).toBe('aac')
    expect(encoded.sample_rate).toBe('48000')
    // O bitrate pedido é 320k; sinal simples pode usar menos bits pelo codificador AAC.
    expect(Number(encoded.bit_rate)).toBeGreaterThan(192_000)
    const check = await ff.run(['-loglevel', 'info', '-i', output, '-af', 'loudnorm=I=-14:TP=-1:print_format=json', '-f', 'null', '-'])
    const result = parseLoudnormMeasure(check.stderr)!
    expect(Number(result.input_i)).toBeGreaterThanOrEqual(-14.5)
    expect(Number(result.input_i)).toBeLessThanOrEqual(-13.5)
    expect(Number(result.input_tp)).toBeLessThanOrEqual(-1)
    expect((await readFile(output)).length).toBeGreaterThan(60_000)
    evidence.aacTone = { measured, encoded: result, bitrate: encoded.bit_rate }
  })
})
