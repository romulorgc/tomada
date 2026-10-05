/**
 * Silenciar muletas na EXPORTAÇÃO: o ffmpeg de verdade cala só o trecho pedido (com rampa de 15 ms, sem estalo) e
 * deixa o resto do áudio intacto, inclusive quando o trecho cai no meio de um corte e com o deslocamento da voz.
 */
import { describe, expect, it } from 'vitest'
import { computeLevels } from '@shared/levels'
import { MUTE_RAMP_MS, buildAudioGraph, muteFilters, segmentChain } from '../../src/main/audio-graph'
import { run } from '../helpers/media'

const SR = 48_000

/** PCM do trecho `range` de um tom de 1 kHz de 3 s, depois da cadeia de trecho (cortar + silenciar + fade). */
function render(chain: string): Int16Array {
  const buf = run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=${SR}:duration=3`, '-af', chain, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'])
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2))
}

const dbAt = (pcm: Int16Array, fromMs: number, toMs: number): number => {
  const part = pcm.slice(Math.round((fromMs / 1000) * SR), Math.round((toMs / 1000) * SR))
  return computeLevels(part, SR, toMs - fromMs)[0]!
}

describe('muteFilters (texto)', () => {
  it('um filtro `volume` por até 40 trechos; sem trecho, nenhum', () => {
    expect(muteFilters([])).toEqual([])
    expect(muteFilters([{ start: 10, end: 10 }])).toEqual([])
    const many = Array.from({ length: 95 }, (_, i) => ({ start: i * 100, end: i * 100 + 50 }))
    expect(muteFilters(many)).toHaveLength(3)
    expect(muteFilters([{ start: 1000, end: 2000 }])[0]).toMatch(/^volume='1-min\(1,clip\(min\(\(t-1\.000000\)\/0\.015,\(2\.000000-t\)\/0\.015\),0,1\)\)':eval=frame$/)
  })

  it('o grafo da exportação só cala a VOZ (o som do computador não leva o filtro)', () => {
    const graph = buildAudioGraph({
      kept: [{ start: 0, end: 5000 }],
      voice: { input: 0, offsetMs: 0, channels: 1 },
      system: { input: 1, offsetMs: 0, channels: 2 },
      mode: 'final',
      voiceMutes: [{ start: 1000, end: 1500 }]
    }).graph
    const lines = graph.split(';\n')
    expect(lines.filter((l) => l.includes('volume=\'1-min')).length).toBe(1)
    expect(lines.find((l) => l.includes('volume=\'1-min'))).toContain('[vs0]')
  })
})

describe('silenciar com o ffmpeg de verdade', () => {
  it('cala só o trecho; antes e depois o tom segue inteiro', () => {
    const pcm = render(segmentChain({ start: 0, end: 3000 }, 0, [{ start: 1000, end: 2000 }]))
    expect(pcm.length).toBeGreaterThan(SR * 2.9)
    expect(dbAt(pcm, 100, 900)).toBeGreaterThan(-25) // o `sine` do ffmpeg sai a ~ -21 dBFS de RMS
    expect(dbAt(pcm, 1100, 1900)).toBeLessThan(-90) // mudo
    expect(dbAt(pcm, 2100, 2900)).toBeGreaterThan(-25)
  })

  it('as bordas têm rampa: o nível cai em ~15 ms, sem salto de amostra', () => {
    const pcm = render(segmentChain({ start: 0, end: 3000 }, 0, [{ start: 1000, end: 2000 }]))
    const from = Math.round(0.995 * SR)
    const to = Math.round(1.02 * SR)
    // o maior salto entre amostras vizinhas fica longe do que um corte seco faria (o tom de 1 kHz muda até ~ 8 000 por amostra)
    let maxStep = 0
    for (let k = from + 1; k < to; k++) maxStep = Math.max(maxStep, Math.abs(pcm[k]! - pcm[k - 1]!))
    expect(maxStep).toBeLessThan(9000)
    expect(MUTE_RAMP_MS).toBe(15)
    // e a rampa existe: 1 ms antes da borda o tom já está atenuado menos que na borda
    expect(dbAt(pcm, 1000, 1005)).toBeGreaterThan(dbAt(pcm, 1010, 1015))
  })

  it('o trecho é relativo ao pedaço mantido: um corte antes não desloca o silenciamento', () => {
    // mantém de 500 a 3000; a muleta está de 1000 a 1500 no relógio da gravação: no pedaço, de 500 a 1000
    const pcm = render(segmentChain({ start: 500, end: 3000 }, 0, [{ start: 1000, end: 1500 }]))
    expect(dbAt(pcm, 100, 400)).toBeGreaterThan(-25)
    expect(dbAt(pcm, 550, 950)).toBeLessThan(-90)
    expect(dbAt(pcm, 1100, 2000)).toBeGreaterThan(-25)
  })

  it('só os silenciamentos que caem no pedaço entram', () => {
    const chain = segmentChain({ start: 0, end: 1000 }, 0, [{ start: 5000, end: 6000 }])
    expect(chain).not.toContain('volume=')
  })
})
