/** Detector real na GPU; o exemplo público e os modelos vivem nas ferramentas, nunca no git. */
import { join } from 'node:path'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ensureToolsDir } from '../../src/main/transcription/tools-dir'
import { runProcess } from '../../src/main/process-runner'
import { createFfmpeg, locateFfmpeg } from '../../src/main/ffmpeg'
import { ROOT } from '../helpers/fs'
import { clapMedia } from '../helpers/clap-media'

type Measurement = { offsetMs: number | null; confidence: number; provider: string; segments: { offsetMs: number; confidence: number }[] }

describe('SyncNet real, validado antes de confiar na estimativa', () => {
  it('mede +100 e −100 ms injetados por ffmpeg e a correção deixa residual de um quadro', async () => {
    const base = ensureToolsDir()
    const ff = createFfmpeg(locateFfmpeg()!)
    const example = join(base, 'lip-sync', 'example.avi')
    expect(createHash('sha256').update(await readFile(example)).digest('hex')).toBe('1724121b3a50141cfc9e77c034f7de914024d015b92762ae12d3e1a7151b8621')
    const temporary = join(base, 'tmp', 's1-detector-integracao')
    await mkdir(temporary, { recursive: true })
    const measure = async (video: string, audio?: string): Promise<Measurement> => {
      const run = await runProcess(join(base, 'python', 'Scripts', 'python.exe'), ['-I', join(ROOT, 'resources', 'lip_sync.py')], {
        stdin: JSON.stringify({ video, audio, ffmpeg: ff.paths.ffmpeg, model: join(base, 'lip-sync', 'syncnet_v2.model'), preCropped: true }),
        env: { PYTHONUTF8: '1', HF_HUB_OFFLINE: '1' }, timeoutMs: 120_000
      })
      return JSON.parse(run.stdout) as Measurement
    }
    try {
      const baseline = await measure(example)
      expect(baseline.provider).toBe('CUDAExecutionProvider')
      expect(baseline.confidence).toBeGreaterThan(3)
      expect(typeof baseline.offsetMs).toBe('number')
      // O próprio projeto SyncNet fornece +3 quadros (120 ms) como resposta deste exemplo.
      expect(Math.abs(baseline.offsetMs! - 120)).toBeLessThanOrEqual(33)
      const injections = []
      for (const delayMs of [100, -100]) {
        const audio = join(temporary, `voz-${delayMs}.wav`)
        const filter = delayMs > 0 ? 'adelay=100:all=1' : 'atrim=start=0.1,asetpts=PTS-STARTPTS,apad=pad_dur=0.1'
        await ff.run(['-i', example, '-vn', '-af', filter, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio])
        const shifted = await measure(example, audio)
        expect(shifted.confidence).toBeGreaterThan(3)
        expect(typeof shifted.offsetMs).toBe('number')
        const measuredDelta = shifted.offsetMs! - baseline.offsetMs!
        expect(Math.abs(measuredDelta + delayMs)).toBeLessThanOrEqual(33)
        injections.push({ audioDelayMs: delayMs, cameraOffsetMs: shifted.offsetMs, measuredDeltaMs: measuredDelta })
      }
      // Avança apenas a IMAGEM. O áudio original permanece no mesmo tempo.
      const corrected = join(temporary, 'camera-corrigida.mp4')
      await ff.run(['-i', example, '-an', '-vf', `trim=start=${baseline.offsetMs! / 1000},setpts=PTS-STARTPTS`, '-r', '25', '-c:v', 'libx264', '-crf', '18', corrected])
      const residual = await measure(corrected, example)
      expect(residual.confidence).toBeGreaterThan(3)
      expect(typeof residual.offsetMs).toBe('number')
      expect(Math.abs(residual.offsetMs!)).toBeLessThanOrEqual(33)
      const evidence = { baselineMs: baseline.offsetMs, confidence: baseline.confidence, injections, residualMs: residual.offsetMs }
      await mkdir(join(ROOT, 'test-results'), { recursive: true })
      await writeFile(join(ROOT, 'test-results', 's1-detector.json'), JSON.stringify(evidence, null, 2))
      console.log('[S1 detector] ' + JSON.stringify(evidence))
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }, 180_000)

  it('as contas de MFCC e de sinal do offset passam em quatro gabaritos sem mídia pessoal', async () => {
    const base = ensureToolsDir()
    const result = await runProcess(join(base, 'python', 'Scripts', 'python.exe'), [join(ROOT, 'tests', 'helpers', 'lip_sync_checks.py')], { env: { PYTHONUTF8: '1' }, timeoutMs: 60_000 })
    expect(result.stderr).toContain('Ran 4 tests')
    expect(result.stderr).toContain('OK')
  })

  it.each(['lip_sync_prepare_checks.py', 'lip_sync_clap_checks.py'])('gabaritos conservadores offline: %s', async (helper) => {
    const base = ensureToolsDir()
    const result = await runProcess(join(base, 'python', 'Scripts', 'python.exe'), [join(ROOT, 'tests', 'helpers', helper)], { timeoutMs: 60_000 })
    expect(result.stderr).toContain(`Ran ${helper === 'lip_sync_clap_checks.py' ? 6 : 4} tests`)
    expect(result.stderr).toContain('OK')
  })
  it('palma localizada mede 0 e ±80 ms, mantém início WebM e rejeita movimento alheio', async () => {
    const base = ensureToolsDir()
    const ff = createFfmpeg(locateFfmpeg()!)
    const temporary = join(base, 'tmp', 's1-calibracao-integracao')
    await mkdir(temporary, { recursive: true })
    const measure = async (video: string) => {
      const result = await runProcess(join(base, 'python', 'Scripts', 'python.exe'), ['-I', join(ROOT, 'resources', 'lip_sync.py')], {
        stdin: JSON.stringify({ mode: 'clap', video, ffmpeg: ff.paths.ffmpeg }), env: { PYTHONUTF8: '1' }, timeoutMs: 60_000
      })
      return JSON.parse(result.stdout) as { offsetMs: number | null; confidence: number }
    }
    try {
      for (const options of [
        { offset: 0 }, { offset: 80 }, { offset: -80 },
        { webm: true, videoStart: 80 }, { webm: true, audioStart: 80 },
        { lowFace: true, offset: 0 }, { lowFace: true, offset: 80 }, { lowFace: true, offset: -80 },
        { lowFace: true, fps: 30, offset: 0 }, { lowFace: true, fps: 30, offset: 80 }, { lowFace: true, fps: 30, offset: -80 }
      ]) {
        const video = await clapMedia(ff, temporary, `palma-${JSON.stringify(options).replace(/\W/g, '')}`, options)
        if (options.webm) {
          const probe = await ff.probe(video)
          const streamDelta = probe.video!.startTimeMs! - probe.audio!.startTimeMs!
          expect(Math.abs(streamDelta)).toBeGreaterThanOrEqual(70)
          expect(Math.sign(streamDelta)).toBe(Math.sign((options.videoStart ?? 0) - (options.audioStart ?? 0)))
        }
        const result = await measure(video)
        const expected = (options.offset ?? 0) + (options.videoStart ?? 0) - (options.audioStart ?? 0)
        expect(typeof result.offsetMs).toBe('number')
        expect(Math.abs(result.offsetMs! - expected)).toBeLessThanOrEqual(options.fps === 30 ? 33 : 10)
        expect(result.confidence).toBeGreaterThan(3)
        console.log(`[palma] esperado=${expected} ms; medido=${result.offsetMs} ms`)
      }
      for (const kind of ['head', 'flash', 'silent', 'double'] as const) {
        const video = await clapMedia(ff, temporary, kind, { kind })
        expect((await measure(video)).offsetMs).toBeNull()
      }
      const lowHead = await clapMedia(ff, temporary, 'cabeca-baixa-sem-maos', { kind: 'head', lowFace: true })
      expect((await measure(lowHead)).offsetMs).toBeNull()
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }, 180_000)
})
