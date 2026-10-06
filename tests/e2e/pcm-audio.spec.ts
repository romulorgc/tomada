import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchTomada, waitForAux } from './helpers'

test('PCM real: voz continua no relógio da câmera/tela, pausa não vira silêncio e WAV fica sem perda', async () => {
  test.setTimeout(120000)
  const s = await launchTomada({ seed: false, env: { TOMADA_TEST_AUTOSOURCE: 'screen' } })
  try {
    await s.page.getByTestId('nav-record').click()
    await expect(s.page.getByTestId('camera-preview')).toHaveAttribute('data-live', 'true', { timeout: 20000 })
    await s.page.getByTestId('record-start').click()
    const bar = await waitForAux(s.app, 'bar', 30000)
    await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'recording')
    await s.page.waitForTimeout(4300)
    await bar.getByTestId('bar-pause').click()
    await expect(bar.getByTestId('bar')).toHaveAttribute('data-status', 'paused')
    await s.page.waitForTimeout(1000)
    await bar.getByTestId('bar-pause').click()
    await s.page.waitForTimeout(3500)
    await bar.getByTestId('bar-stop').click()
    await expect(s.page.getByTestId('project-view')).toBeVisible({ timeout: 90000 })
    const dir = join(s.projects, readdirSync(s.projects)[0]!)
    const m = JSON.parse(readFileSync(join(dir, 'raw/recording.json'), 'utf8'))
    console.log(`[PCM] alinhamento persistido ${JSON.stringify(m.pcmAlignment)}; pausas ${JSON.stringify(m.pauses.map((p: { start: number; end: number }) => ({ start: p.start - m.clock.t0, end: p.end - m.clock.t0 })))}`)
    expect(m.micPcm).toBe(true)
    expect(m.clock.cameraStartAt - m.clock.screenStartAt).toBeLessThan(5)
    const probe = (rel: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', join(dir, rel)], { encoding: 'utf8' }))
    const raw = probe('raw/mic.wav'), normalized = probe('media/voice.wav')
    expect(raw.streams[0].codec_name).toBe('pcm_f32le')
    expect(Number(raw.streams[0].sample_rate)).toBe(48000)
    expect(normalized.streams[0].codec_name).toBe('pcm_f32le')
    expect(Math.abs(Number(raw.format.duration) * 1000 - m.recordedMs)).toBeLessThan(45)
    const cameraProbe = probe('raw/camera.webm')
    const audioStart = Number(cameraProbe.streams.find((t: { codec_type: string }) => t.codec_type === 'audio').start_time ?? 0)
    const videoStart = Number(cameraProbe.streams.find((t: { codec_type: string }) => t.codec_type === 'video').start_time ?? audioStart)
    const leading = Math.max(0, audioStart - Math.min(videoStart, audioStart))
    console.log(`[PCM] carimbos brutos câmera: vídeo ${videoStart * 1000}ms, áudio ${audioStart * 1000}ms; complemento da extração ${leading * 1000}ms`)
    const decode = (rel: string, lead = 0) => execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, rel), '-map', '0:a:0', '-af', `asetpts=PTS-STARTPTS+${lead}/TB,aresample=async=1:first_pts=0`, '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 10 * 1024 * 1024 })
    const a = decode('media/voice.wav'), b = decode('raw/camera.webm', leading)
    const correlate = (start: number, end: number) => {
      let best = { lag: 0, corr: -1 }
      for (let lag = -1600; lag <= 1600; lag++) {
        let aa = 0, bb = 0, ab = 0
        for (let i = Math.round(start * 8000); i < Math.round(end * 8000); i += 4) {
          const j = i + lag
          if ((i + 1) * 4 > a.length || j < 0 || (j + 1) * 4 > b.length) continue
          const x = a.readFloatLE(i * 4), y = b.readFloatLE(j * 4)
          aa += x * x; bb += y * y; ab += x * y
        }
        const corr = ab / Math.sqrt(aa * bb)
        if (corr > best.corr) best = { lag, corr }
      }
      return best
    }
    // Segmentos separados: uma duração correta não prova que a retomada conservou o tempo.
    const best = correlate(.5, 3.25)
    const pauseAt = (m.pauses[0].start - m.clock.cameraStartAt) / 1000
    const resumed = correlate(pauseAt + .3, pauseAt + 3)
    console.log(`[PCM] diferença da voz antiga ${(best.lag / 8).toFixed(3)} ms; correlação ${best.corr.toFixed(5)}; duração PCM ${raw.format.duration}s / relógio ${(m.recordedMs / 1000).toFixed(3)}s`)
    console.log(`[PCM] após retomar: ${(resumed.lag / 8).toFixed(3)} ms; correlação ${resumed.corr.toFixed(5)}`)
    expect(best.corr).toBeGreaterThan(0.92)
    expect(Math.abs(best.lag / 8)).toBeLessThanOrEqual(5)
    expect(resumed.corr).toBeGreaterThan(0.9)
    // O MediaRecorder da câmera retoma entre a chamada e o retorno de resume(); essa incerteza fica abaixo de meio quadro a 30 qps (16,7 ms).
    expect(Math.abs(resumed.lag / 8)).toBeLessThanOrEqual(16)
    expect(s.problems).toEqual([])
  } finally { await s.close() }
})
