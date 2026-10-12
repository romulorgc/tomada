/**
 * F1 · emenda de áudio com o ffmpeg de verdade: o grafo novo (cruzamento de potência igual com alças reais) contra o antigo (fade a zero
 * de 30 ms + concat), medidos pelo mesmo medidor da prova de emenda. Sinal sintético: rajadas de ruído de "fala" e pausas de chiado.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAudioGraph, buildMeasureArgs, parseLoudnormMeasure } from '../../src/main/audio-graph'
import { measureSeams } from '../../src/shared/seam-proof'
import { planSeams } from '../../src/shared/seams'
import { requireFfmpeg, useTmpDir } from '../helpers/env'
import { run } from '../helpers/media'

const ff = requireFfmpeg()
const tmp = useTmpDir('tomada-emenda-')
const SR = 48_000
const PROOF_SR = 8000

/** Rajadas de 0,6 s a −19 dBFS a cada 0,85 s (pausas de 0,25 s a −58 dBFS): a pausa k vai de 0,9 + 0,85k a 1,15 + 0,85k. */
function voiceFile(dir: string, seconds: number): string {
  const n = seconds * SR
  const x = new Float32Array(n)
  let s = 12345
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return (s / 0x100000000) * 2 - 1
  }
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const phase = (t - 0.3) % 0.85
    const speaking = t >= 0.3 && phase < 0.6
    x[i] = rnd() * (speaking ? 0.2 : 0.0008)
  }
  const raw = join(dir, 'voz.f32')
  writeFileSync(raw, Buffer.from(x.buffer))
  const wav = join(dir, 'voz.wav')
  run('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', raw, '-c:a', 'pcm_f32le', wav])
  return wav
}

/** O grafo de ANTES: cada trecho com fade de 30 ms a zero nas duas pontas e `concat`. */
function oldGraph(kept: { start: number; end: number }[]): string {
  const sec = (ms: number): string => (ms / 1000).toFixed(6)
  const lines = [`[0:a]asplit=${kept.length}${kept.map((_, i) => `[s${i}]`).join('')}`]
  kept.forEach((r, i) => {
    const len = r.end - r.start
    lines.push(`[s${i}]atrim=start=${sec(r.start)}:end=${sec(r.end)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.03,afade=t=out:st=${sec(len - 30)}:d=0.03[c${i}]`)
  })
  lines.push(`${kept.map((_, i) => `[c${i}]`).join('')}concat=n=${kept.length}:v=0:a=1[aout]`)
  return lines.join(';\n')
}

function decode(file: string): Float32Array {
  const buf = run('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(PROOF_SR), '-f', 'f32le', '-'])
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
}

describe('emenda de áudio (ffmpeg real)', () => {
  it('cruzamento com alças reais: a queda de nível em cada emenda fica ≤ 6 dB; o fade a zero + concat de antes passa de 15 dB (no meio de uma pausa; colado na fala, ~45)', async () => {
    const dir = tmp()
    mkdirSync(dir, { recursive: true })
    const voice = voiceFile(dir, 16)
    // cortes de pausa a pausa, com a folga da limpeza (100 ms depois da última palavra e 50 ms antes da próxima): a pausa 2 vai de
    // 2,60 a 2,85 s e a 6 de 6,00 a 6,25 s; a 9 de 8,55 a 8,80 s e a 10 de 9,40 a 9,65 s
    const kept = [
      { start: 0, end: 2700 },
      { start: 6200, end: 8650 },
      { start: 9600, end: 16_000 }
    ]
    const seams = planSeams(kept)
    expect(seams.map((s) => s.halfMs)).toEqual([35, 35])

    // novo: o grafo de produção, em dois passes (como a exportação)
    const inputs = [voice]
    const input = { input: 0, offsetMs: 0, channels: 1 as const }
    const g1 = join(dir, 'g1.txt')
    writeFileSync(g1, buildAudioGraph({ kept, voice: input, system: null, mode: 'measure' }).graph)
    const measure = parseLoudnormMeasure((await ff.run(buildMeasureArgs({ inputs, graphFile: g1 }), {})).stderr)
    expect(measure).not.toBeNull()
    const g2 = join(dir, 'g2.txt')
    writeFileSync(g2, buildAudioGraph({ kept, voice: input, system: null, mode: 'final', measured: measure }).graph)
    const novo = join(dir, 'novo.wav')
    await ff.run(['-i', voice, '-/filter_complex', g2, '-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', '48000', novo], {})

    // antigo: fade a zero + concat
    const g3 = join(dir, 'g3.txt')
    writeFileSync(g3, oldGraph(kept))
    const antigo = join(dir, 'antigo.wav')
    await ff.run(['-i', voice, '-/filter_complex', g3, '-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', '48000', antigo], {})

    const outMs = kept.reduce((a, r) => a + r.end - r.start, 0)
    const times = seams.map((s) => s.outMs)
    const loose = { limits: { minSegmentMs: 100, maxSeamsPerMin: 1000, maxInSpeech: 99 } } as const
    const depois = measureSeams(decode(novo), PROOF_SR, times, outMs, loose)
    const antes = measureSeams(decode(antigo), PROOF_SR, times, outMs, loose)

    writeFileSync(join(dir, 'resultado.json'), JSON.stringify({ antes: antes.measures, depois: depois.measures }, null, 1))
    expect(depois.maxDropDb!).toBeLessThanOrEqual(6)
    expect(antes.maxDropDb!).toBeGreaterThan(15)
    // o comprimento não muda: o cruzamento não encurta o vídeo nem tira o som de lugar
    const lenNovo = decode(novo).length / PROOF_SR
    expect(Math.abs(lenNovo * 1000 - outMs)).toBeLessThan(60)
  })
})
