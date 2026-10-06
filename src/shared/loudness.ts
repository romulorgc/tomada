/**
 * Volume integrado (LUFS) de um sinal MONO a 48 kHz, ITU-R BS.1770-4 com a porta de EBU R128: ponderação K, blocos de 400 ms
 * a cada 100 ms, porta absoluta em -70 LUFS e relativa 10 LU abaixo. Em fluxo (uma chamada por pedaço), sem DOM nem Node.
 *
 * Serve para o aviso "a voz bruta saiu baixa demais": o volume ANTES do `loudnorm`, que o tratamento no pós esconderia.
 * Conferido contra o `ebur128` do ffmpeg (tests/integration/loudness.test.ts).
 */

/** Coeficientes da ponderação K a 48 kHz (BS.1770-4, tabelas 1 e 2). */
const SHELF = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] } as const
const HIGH_PASS = { b: [1, -2, 1], a: [1, -1.99004745483398, 0.99007225036621] } as const

export const LOUDNESS_SAMPLE_RATE = 48_000
const HOP = LOUDNESS_SAMPLE_RATE / 10
const BLOCK_HOPS = 4
const ABSOLUTE_GATE_LUFS = -70
const OFFSET = -0.691

type Biquad = { x1: number; x2: number; y1: number; y2: number }
const stage = (c: { b: readonly number[]; a: readonly number[] }, s: Biquad, x: number): number => {
  const y = c.b[0]! * x + c.b[1]! * s.x1 + c.b[2]! * s.x2 - c.a[1]! * s.y1 - c.a[2]! * s.y2
  s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y
  return y
}

const lufs = (meanSquare: number): number => OFFSET + 10 * Math.log10(meanSquare)

export class IntegratedLoudness {
  private readonly shelf: Biquad = { x1: 0, x2: 0, y1: 0, y2: 0 }
  private readonly high: Biquad = { x1: 0, x2: 0, y1: 0, y2: 0 }
  private sum = 0
  private count = 0
  /** Média quadrática de cada pedaço de 100 ms. */
  private readonly hops: number[] = []

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const y = stage(HIGH_PASS, this.high, stage(SHELF, this.shelf, samples[i]!))
      this.sum += y * y
      if (++this.count === HOP) { this.hops.push(this.sum / HOP); this.sum = 0; this.count = 0 }
    }
  }

  /** `null` quando o sinal tem menos de 400 ms ou nenhum bloco passa da porta absoluta (silêncio). */
  finish(): number | null {
    const blocks: number[] = []
    for (let i = 0; i + BLOCK_HOPS <= this.hops.length; i++) {
      let sum = 0
      for (let k = 0; k < BLOCK_HOPS; k++) sum += this.hops[i + k]!
      blocks.push(sum / BLOCK_HOPS)
    }
    const audible = blocks.filter((z) => z > 0 && lufs(z) > ABSOLUTE_GATE_LUFS)
    if (!audible.length) return null
    const relative = lufs(audible.reduce((a, z) => a + z, 0) / audible.length) - 10
    const kept = audible.filter((z) => lufs(z) > relative)
    return kept.length ? lufs(kept.reduce((a, z) => a + z, 0) / kept.length) : null
  }
}
