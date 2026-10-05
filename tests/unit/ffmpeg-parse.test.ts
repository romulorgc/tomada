import { describe, expect, it } from 'vitest'
import { parseFrameRate, parseProbe, parseProgressBlock, parseVersion } from '../../src/main/ffmpeg'

describe('parseFrameRate', () => {
  it('fração', () => {
    expect(parseFrameRate('30/1')).toBe(30)
    expect(parseFrameRate('60/1')).toBe(60)
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2)
  })
  it('0/0, zero, vazio e lixo viram undefined', () => {
    expect(parseFrameRate('0/0')).toBeUndefined()
    expect(parseFrameRate('0/1')).toBeUndefined()
    expect(parseFrameRate('')).toBeUndefined()
    expect(parseFrameRate(undefined)).toBeUndefined()
    expect(parseFrameRate('abc/def')).toBeUndefined()
  })
  it('número simples', () => {
    expect(parseFrameRate('25')).toBe(25)
  })
})

describe('parseProbe', () => {
  const raw = {
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1', r_frame_rate: '30/1', duration: '23.000000', nb_frames: '690' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 1, duration: '22.700000' },
      { index: 2, codec_type: 'data', codec_name: 'bin_data' }
    ],
    format: { duration: '23.012000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', size: '1376196' }
  }

  it('resume vídeo, áudio e duração do formato em ms', () => {
    const p = parseProbe(raw)
    expect(p.durationMs).toBe(23_012)
    expect(p.sizeBytes).toBe(1_376_196)
    expect(p.video).toMatchObject({ type: 'video', codec: 'h264', width: 1920, height: 1080, fps: 30, nbFrames: 690 })
    expect(p.audio).toMatchObject({ type: 'audio', codec: 'aac', sampleRate: 48_000, channels: 1 })
    expect(p.streams).toHaveLength(3)
    expect(p.streams[2]?.type).toBe('other')
  })

  it('sem format.duration usa a maior duração entre as trilhas', () => {
    const p = parseProbe({ streams: raw.streams, format: {} })
    expect(p.durationMs).toBe(23_000)
  })

  it('fps cai para r_frame_rate quando a média é 0/0', () => {
    const p = parseProbe({ streams: [{ codec_type: 'video', codec_name: 'vp9', avg_frame_rate: '0/0', r_frame_rate: '60/1' }], format: {} })
    expect(p.video?.fps).toBe(60)
  })

  it('arquivo só de áudio não tem vídeo', () => {
    const p = parseProbe({ streams: [raw.streams[1]], format: { duration: '1.5' } })
    expect(p.video).toBeUndefined()
    expect(p.audio?.codec).toBe('aac')
    expect(p.durationMs).toBe(1500)
  })

  it('entrada vazia ou estranha não explode', () => {
    expect(parseProbe({}).durationMs).toBe(0)
    expect(parseProbe(null).streams).toEqual([])
  })
})

describe('parseProgressBlock', () => {
  it('lê tempo, quadro, fps e velocidade', () => {
    const p = parseProgressBlock([
      'frame=120',
      'fps=58.20',
      'out_time_us=4000000',
      'out_time=00:00:04.000000',
      'speed=1.94x',
      'progress=continue'
    ])
    expect(p).toEqual({ timeMs: 4000, frame: 120, fps: 58.2, speed: 1.94 })
  })
  it('speed=N/A vira null', () => {
    expect(parseProgressBlock(['out_time_us=1000', 'speed=N/A', 'progress=end'])?.speed).toBeNull()
  })
  it('sem tempo válido devolve null (ffmpeg ainda não começou)', () => {
    expect(parseProgressBlock(['frame=0', 'out_time_us=N/A', 'progress=continue'])).toBeNull()
    expect(parseProgressBlock([])).toBeNull()
  })
})

describe('parseVersion', () => {
  it('pega a versão da primeira linha', () => {
    expect(parseVersion('ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with gcc')).toBe(
      '8.1.1-full_build-www.gyan.dev'
    )
    expect(parseVersion('ffprobe version n7.0.2 Copyright')).toBe('n7.0.2')
  })
  it('texto desconhecido devolve null', () => {
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('outra coisa')).toBeNull()
  })
})
