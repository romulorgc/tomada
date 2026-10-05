import { describe, expect, it } from 'vitest'
import {
  buildEncoderProbeArgs,
  buildExtractAudioArgs,
  buildNormalizeVideoArgs,
  buildThumbnailArgs,
  encoderArgs,
  MAX_TAIL_PAD_SECONDS
} from '../../src/main/ffmpeg-args'

/** Valor que vem logo depois de uma flag. */
const after = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

describe('buildNormalizeVideoArgs', () => {
  const base = { input: 'in.webm', output: 'out.mp4', fps: 30, encoder: 'libx264' as const }

  it('zera o PTS inicial, fixa o fps e força dimensões pares', () => {
    const args = buildNormalizeVideoArgs(base)
    const vf = after(args, '-vf')!
    expect(vf.split(',')).toEqual(['setpts=PTS-STARTPTS', 'fps=30', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', 'setsar=1'])
    expect(after(args, '-fps_mode')).toBe('cfr')
    expect(args).toContain('yuv420p')
  })

  it('o container sai do codec: MP4 explícito, faststart, nunca WebM', () => {
    const args = buildNormalizeVideoArgs(base)
    expect(after(args, '-f')).toBe('mp4')
    expect(after(args, '-movflags')).toBe('+faststart')
    expect(args[args.length - 1]).toBe('out.mp4')
  })

  it('GOP de 1 s (= fps quadros) e sem corte de cena, em libx264', () => {
    const args = buildNormalizeVideoArgs({ ...base, fps: 60 })
    expect(after(args, '-g')).toBe('60')
    expect(after(args, '-keyint_min')).toBe('60')
    expect(after(args, '-sc_threshold')).toBe('0')
  })

  it('GOP acompanha gopSeconds', () => {
    expect(after(buildNormalizeVideoArgs({ ...base, gopSeconds: 2 }), '-g')).toBe('60')
    expect(after(buildNormalizeVideoArgs({ ...base, fps: 24, gopSeconds: 0.5 }), '-g')).toBe('12')
  })

  it('sem áudio por padrão; com keepAudio traz AAC 192k e alinha o áudio ao zero', () => {
    expect(buildNormalizeVideoArgs(base)).toContain('-an')
    const args = buildNormalizeVideoArgs({ ...base, keepAudio: true })
    expect(args).not.toContain('-an')
    expect(after(args, '-c:a')).toBe('aac')
    expect(after(args, '-b:a')).toBe('192k')
    expect(after(args, '-af')).toContain('aresample=async=1:first_pts=0')
    expect(args).toContain('0:a:0?') // trilha opcional: não falha se não houver áudio
  })

  it('NVENC: qualidade constante, GOP de 1 s, IDR forçado', () => {
    const args = buildNormalizeVideoArgs({ ...base, encoder: 'h264_nvenc' })
    expect(after(args, '-c:v')).toBe('h264_nvenc')
    expect(after(args, '-rc')).toBe('vbr')
    expect(after(args, '-cq')).toBe('19')
    expect(after(args, '-b:v')).toBe('0')
    expect(after(args, '-g')).toBe('30')
    expect(after(args, '-forced-idr')).toBe('1')
    expect(args).not.toContain('libx264')
  })

  it('padToMs: repete o último quadro (tpad) e corta na duração pedida; sem ele nada disso entra', () => {
    const plain = buildNormalizeVideoArgs(base)
    expect(after(plain, '-vf')).not.toContain('tpad')
    expect(plain).not.toContain('-t')

    const args = buildNormalizeVideoArgs({ ...base, padToMs: 12_345.6 })
    const vf = after(args, '-vf')!.split(',')
    expect(vf).toContain(`tpad=stop_mode=clone:stop_duration=${MAX_TAIL_PAD_SECONDS}`)
    expect(vf.indexOf('fps=30')).toBeLessThan(vf.findIndex((x) => x.startsWith('tpad'))) // pad depois do fps constante
    expect(after(args, '-t')).toBe('12.346')
    expect(args.indexOf('-t')).toBeLessThan(args.length - 1) // opção de SAÍDA, antes do arquivo
    expect(args[args.length - 1]).toBe('out.mp4')

    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(buildNormalizeVideoArgs({ ...base, padToMs: bad })).not.toContain('-t')
  })

  it('fps inválido é erro, não argumento quebrado', () => {
    expect(() => buildNormalizeVideoArgs({ ...base, fps: 0 })).toThrow(RangeError)
    expect(() => buildNormalizeVideoArgs({ ...base, fps: Number.NaN })).toThrow(RangeError)
    expect(() => buildNormalizeVideoArgs({ ...base, fps: -30 })).toThrow(RangeError)
  })

  it('caminhos com espaço e acento passam intactos como UM argumento', () => {
    const args = buildNormalizeVideoArgs({ ...base, input: 'C:\\Users\\José\\a b\\tela.webm', output: 'C:\\x y\\ç.mp4' })
    expect(args).toContain('C:\\Users\\José\\a b\\tela.webm')
    expect(args[args.length - 1]).toBe('C:\\x y\\ç.mp4')
  })
})

describe('encoderArgs', () => {
  it('libx264 em qualidade alta para texto nítido', () => {
    const a = encoderArgs('libx264', 30)
    expect(after(a, '-crf')).toBe('18')
    expect(after(a, '-profile:v')).toBe('high')
  })
})

describe('buildExtractAudioArgs', () => {
  it('voice.wav: 48 kHz mono PCM 16 bits, sem vídeo', () => {
    const args = buildExtractAudioArgs({ input: 'camera.webm', output: 'voice.wav', channels: 1 })
    expect(after(args, '-ac')).toBe('1')
    expect(after(args, '-ar')).toBe('48000')
    expect(after(args, '-c:a')).toBe('pcm_s16le')
    expect(args).toContain('-vn')
    expect(after(args, '-map')).toBe('0:a:0')
    expect(after(args, '-f')).toBe('wav')
  })
  it('system.wav: estéreo e trilha escolhida', () => {
    const args = buildExtractAudioArgs({ input: 'tela.webm', output: 'system.wav', channels: 2, track: 1, sampleRate: 44_100 })
    expect(after(args, '-ac')).toBe('2')
    expect(after(args, '-ar')).toBe('44100')
    expect(after(args, '-map')).toBe('0:a:1')
  })
})

describe('buildThumbnailArgs', () => {
  it('busca antes da entrada (rápido), um quadro, largura 640 por padrão', () => {
    const args = buildThumbnailArgs({ input: 'a.mp4', output: 't.jpg', atMs: 3500 })
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(after(args, '-ss')).toBe('3.500')
    expect(after(args, '-frames:v')).toBe('1')
    expect(after(args, '-vf')).toBe('scale=640:-2')
  })
  it('tempo negativo vira zero; largura configurável', () => {
    const args = buildThumbnailArgs({ input: 'a.mp4', output: 't.jpg', atMs: -5, width: 320 })
    expect(after(args, '-ss')).toBe('0.000')
    expect(after(args, '-vf')).toBe('scale=320:-2')
  })
})

describe('buildEncoderProbeArgs', () => {
  it('usa as MESMAS opções do encoder real (para pegar opção não aceita) e escreve em null', () => {
    for (const enc of ['libx264', 'h264_nvenc'] as const) {
      const args = buildEncoderProbeArgs(enc)
      for (const piece of encoderArgs(enc, 30)) expect(args).toContain(piece)
      expect(args.slice(-3)).toEqual(['-f', 'null', '-'])
      expect(after(args, '-f')).toBe('lavfi')
      expect(after(args, '-i')).toMatch(/^color=/)
    }
  })
})
