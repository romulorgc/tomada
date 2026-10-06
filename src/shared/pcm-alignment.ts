/** Correlação no mesmo microfone: Opus serve só como referência de TEMPO, nunca como voz final. */
export function correlatePcm(reference: Float32Array, pcm: Float32Array, sampleRate = 8000): { offsetMs: number; correlation: number } | null {
  const count = Math.min(reference.length, pcm.length, sampleRate * 8)
  const guard = Math.ceil(sampleRate * 0.3)
  if (count < guard * 3) return null
  const limit = Math.ceil(sampleRate * 0.25)
  const scores = new Float64Array(limit * 2 + 1)
  let best = { shift: 0, correlation: -1 }
  const score = (shift: number): void => {
    let aa = 0, bb = 0, ab = 0
    for (let i = guard; i < count - guard; i += 4) {
      const x = pcm[i]!, y = reference[i + shift]!
      aa += x * x; bb += y * y; ab += x * y
    }
    const correlation = aa > 1e-8 && bb > 1e-8 ? ab / Math.sqrt(aa * bb) : 0
    scores[shift + limit] = correlation
    if (correlation > best.correlation) best = { shift, correlation }
  }
  // Todas as amostras: ruído/fricativas também precisam de pico exato, não só vogais.
  const step = 1
  for (let shift = -limit; shift <= limit; shift += step) score(shift)
  const coarse = best.shift
  for (let shift = Math.max(-limit, coarse - step); shift <= Math.min(limit, coarse + step); shift++) score(shift)
  if (best.correlation < 0.85 || Math.abs(best.shift) >= limit - step) return null
  // Uma vogal/tom pode casar em vários ciclos: correlação alta sozinha não identifica tempo.
  const neighborhood = Math.ceil(sampleRate * 0.002)
  for (let shift = -limit; shift <= limit; shift++) {
    if (Math.abs(shift - best.shift) > neighborhood && scores[shift + limit]! >= best.correlation - 0.02) return null
  }
  return { offsetMs: best.shift * 1000 / sampleRate, correlation: best.correlation }
}
