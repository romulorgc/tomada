import { describe, expect, it } from 'vitest'
import {
  FADE_MS,
  buildAudioArgs,
  buildAudioGraph,
  buildMeasureArgs,
  buildMuxArgs,
  buildSilentAudioArgs,
  cadeiaDeVoz,
  loudnormFilter,
  parseLoudnormMeasure,
  segmentChain,
  type LoudnormMeasure
} from '../../src/main/audio-graph'

const kept = [
  { start: 0, end: 2000 },
  { start: 3500, end: 6000 },
  { start: 6800, end: 10_000 }
]
const voice = { input: 0, offsetMs: 0, channels: 1 as const }
const system = { input: 1, offsetMs: 0, channels: 2 as const }
const measure: LoudnormMeasure = { input_i: '-23.40', input_tp: '-4.10', input_lra: '6.20', input_thresh: '-33.90', target_offset: '0.30' }

describe('trecho de áudio', () => {
  it('atrim + fade de 30 ms nas duas bordas + duração exata do trecho', () => {
    const c = segmentChain({ start: 3500, end: 6000 }, 0)
    expect(c).toContain('atrim=start=3.500000:end=6.000000')
    expect(c).toContain('afade=t=in:st=0:d=0.030000')
    expect(c).toContain(`afade=t=out:st=${((2500 - FADE_MS) / 1000).toFixed(6)}:d=0.030000`)
    expect(c).toContain('apad=whole_dur=2.500000')
    expect(c).toContain('atrim=end=2.500000')
    expect(FADE_MS).toBe(30)
  })

  it('o deslocamento da fonte entra no corte (tempo da gravação − offset)', () => {
    const c = segmentChain({ start: 3500, end: 6000 }, 250)
    expect(c).toContain('atrim=start=3.250000:end=5.750000')
  })

  it('trecho que começa antes do arquivo ganha silêncio na frente (adelay) em vez de perder sincronia', () => {
    const c = segmentChain({ start: 0, end: 1000 }, 120)
    expect(c).toContain('atrim=start=0.000000:end=0.880000')
    expect(c).toContain('adelay=delays=120:all=1')
    expect(c).toContain('apad=whole_dur=1.000000')
  })

  it('trecho mais curto que 60 ms usa fade de metade da duração', () => {
    const c = segmentChain({ start: 0, end: 40 }, 0)
    expect(c).toContain('afade=t=in:st=0:d=0.020000')
    expect(c).toContain('afade=t=out:st=0.020000:d=0.020000')
  })
})

describe('grafo de áudio', () => {
  it('voz + som do sistema: asplit, atrim, concat, limpeza só na voz, −9 dB no sistema, mistura e loudnorm', () => {
    const g = buildAudioGraph({ kept, voice, system, mode: 'final', measured: measure })
    expect(g.out).toBe('aout')
    expect(g.graph).toContain('[0:a]asplit=3[vs0][vs1][vs2]')
    expect(g.graph).toContain('[1:a]asplit=3[ys0][ys1][ys2]')
    expect(g.graph.match(/concat=n=3:v=0:a=1/g)).toHaveLength(2)
    // a limpeza da voz desconta a latência do afftdn (1200 amostras) e fecha na duração exata (2000 + 2500 + 3200 ms)
    expect(g.graph).toContain(
      'highpass=f=80,afftdn=nr=12:nf=-45,atrim=start_sample=1200,asetpts=PTS-STARTPTS,deesser=i=0.4,acompressor=threshold=-18dB:ratio=3:attack=15:release=180,apad=whole_dur=7.700000,atrim=end=7.700000,asetpts=PTS-STARTPTS,pan=stereo|c0=c0|c1=c0[voz]'
    )
    expect(g.graph).toContain('highpass=f=60,volume=-9dB[sis]')
    expect(g.graph).not.toMatch(/\[ycat\]highpass=f=80/) // o som do sistema não leva compressor nem deesser
    expect(g.graph).toContain('[voz][sis]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[mix]')
    expect(g.graph).toContain('loudnorm=I=-14:TP=-1:LRA=11:measured_I=-23.40:measured_TP=-4.10:measured_LRA=6.20:measured_thresh=-33.90:offset=0.30:linear=true')
    expect(g.graph).toContain('aresample=48000')
    // o corte vem ANTES do loudnorm (armadilha do legado)
    expect(g.graph.indexOf('atrim=')).toBeLessThan(g.graph.indexOf('loudnorm='))
    expect(g.graph.lastIndexOf('atrim=')).toBeLessThan(g.graph.indexOf('loudnorm='))
  })

  it('primeiro passe só mede (print_format=json); sem medição válida o final é passe único', () => {
    const m = buildAudioGraph({ kept, voice, system: null, mode: 'measure' })
    expect(m.graph).toContain('loudnorm=I=-14:TP=-1:LRA=11:print_format=json')
    expect(m.graph).not.toContain('measured_I')
    const single = buildAudioGraph({ kept, voice, system: null, mode: 'final', measured: null })
    expect(single.graph).toMatch(/loudnorm=I=-14:TP=-1:LRA=11,aresample/)
    expect(single.graph).not.toContain('measured_I')
    expect(single.graph).not.toContain('amix') // sem som do sistema, sem mistura
  })

  it('um trecho só não usa asplit nem concat', () => {
    const g = buildAudioGraph({ kept: [{ start: 0, end: 5000 }], voice, system: null, mode: 'final' })
    expect(g.graph).not.toContain('asplit')
    expect(g.graph).not.toContain('concat')
    expect(g.graph).toContain('[0:a]anull[vs0]')
  })

  it('só som do sistema também funciona; sem faixa nenhuma ou sem trechos lança', () => {
    const g = buildAudioGraph({ kept, voice: null, system, mode: 'final' })
    expect(g.graph).toContain('[1:a]asplit=3')
    expect(g.graph).not.toContain('afftdn')
    expect(() => buildAudioGraph({ kept, voice: null, system: null, mode: 'final' })).toThrow(RangeError)
    expect(() => buildAudioGraph({ kept: [], voice, system: null, mode: 'final' })).toThrow(RangeError)
  })

  it('centenas de trechos estouram os 32 mil caracteres, por isso o grafo vai em arquivo', () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ start: i * 1000, end: i * 1000 + 700 }))
    const g = buildAudioGraph({ kept: many, voice, system, mode: 'final', measured: measure })
    expect(g.graph.length).toBeGreaterThan(32_000)
    const args = buildAudioArgs({ inputs: ['C:/p/media/voice.wav', 'C:/p/media/system.wav'], graphFile: 'C:/tmp/g.txt', output: 'C:/tmp/a.m4a' })
    expect(args.join(' ').length).toBeLessThan(500) // a linha de comando só leva o CAMINHO do arquivo
    expect(args).toContain('-/filter_complex')
    expect(args[args.indexOf('-/filter_complex') + 1]).toBe('C:/tmp/g.txt')
    // 600 segmentos = 600 ramos de cada faixa
    expect(g.graph).toContain('asplit=600')
    expect((g.graph.match(/concat=n=600/g) ?? []).length).toBe(2)
  })

  it('argumentos: medição, AAC 48 kHz 384 kbps, trilha muda e mux com faststart', () => {
    const measureArgs = buildMeasureArgs({ inputs: ['C:/t/v.wav'], graphFile: 'C:/t/g.txt' })
    expect(measureArgs).toEqual(expect.arrayContaining(['-loglevel', 'info', '-f', 'null']))
    expect(measureArgs.indexOf('-loglevel')).toBeLessThan(measureArgs.indexOf('-i'))
    const audio = buildAudioArgs({ inputs: ['C:/t/v.wav'], graphFile: 'C:/t/g.txt', output: 'C:/t/a.m4a' })
    expect(audio).toEqual(expect.arrayContaining(['-c:a', 'aac', '-b:a', '384k', '-ar', '48000']))
    expect(audio[audio.length - 1]).toBe('C:/t/a.m4a')
    const silent = buildSilentAudioArgs({ durationMs: 12_345, output: 'C:/t/s.m4a' })
    expect(silent).toEqual(expect.arrayContaining(['anullsrc=r=48000:cl=stereo', '12.345000']))
    const mux = buildMuxArgs({ video: 'C:/t/v.mp4', audio: 'C:/t/a.m4a', output: 'C:/t/f.mp4' })
    expect(mux).toEqual(expect.arrayContaining(['-c', 'copy', '-movflags', '+faststart']))
    expect(mux.indexOf('-i')).toBeLessThan(mux.lastIndexOf('-i'))
  })
})

describe('loudnorm', () => {
  it('lê a medição do stderr do primeiro passe', () => {
    const stderr = `[Parsed_loudnorm_0 @ 0000] \n{\n\t"input_i" : "-23.45",\n\t"input_tp" : "-4.00",\n\t"input_lra" : "5.10",\n\t"input_thresh" : "-34.00",\n\t"output_i" : "-14.10",\n\t"output_tp" : "-1.50",\n\t"output_lra" : "4.00",\n\t"output_thresh" : "-24.10",\n\t"normalization_type" : "dynamic",\n\t"target_offset" : "0.10"\n}\n`
    expect(parseLoudnormMeasure(stderr)).toEqual({ input_i: '-23.45', input_tp: '-4.00', input_lra: '5.10', input_thresh: '-34.00', target_offset: '0.10' })
  })

  it('faixa muda devolve -inf: NÃO vai ao segundo passe (null)', () => {
    const silent = `{\n"input_i" : "-inf",\n"input_tp" : "-inf",\n"input_lra" : "0.00",\n"input_thresh" : "-70.00",\n"target_offset" : "inf"\n}`
    expect(parseLoudnormMeasure(silent)).toBeNull()
    expect(parseLoudnormMeasure('sem json nenhum')).toBeNull()
    expect(parseLoudnormMeasure('{ "target_offset": quebrado }')).toBeNull()
  })

  it('o filtro do segundo passe é linear e carrega os números medidos', () => {
    expect(loudnormFilter({ measured: measure })).toBe('loudnorm=I=-14:TP=-1:LRA=11:measured_I=-23.40:measured_TP=-4.10:measured_LRA=6.20:measured_thresh=-33.90:offset=0.30:linear=true')
    expect(loudnormFilter()).toBe('loudnorm=I=-14:TP=-1:LRA=11')
  })

  it('a cadeia de voz é a mesma do legado (cadeiaDeVoz de legado/lib/composicao.mjs)', async () => {
    // o legado é JavaScript sem tipos: o caminho em variável evita o erro de declaração do TypeScript
    const caminho = '../../legado/lib/composicao.mjs'
    const legado = (await import(/* @vite-ignore */ caminho)) as { cadeiaDeVoz: (o?: unknown) => string }
    expect(cadeiaDeVoz()).toBe(legado.cadeiaDeVoz())
    expect(cadeiaDeVoz({ ganhoDb: 3 })).toBe(legado.cadeiaDeVoz({ ganhoDb: 3 }))
    const medido = { input_i: '-20', input_tp: '-3', input_lra: '4', input_thresh: '-30', target_offset: '0.5' }
    expect(cadeiaDeVoz({ medido })).toBe(legado.cadeiaDeVoz({ medido }))
  })
})
