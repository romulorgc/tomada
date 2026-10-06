import { describe, expect, it } from 'vitest'
import { warmedRenderingSamples } from '../helpers/export-memory'

const observation = (frame: number, total: number, phase = 'rendering', pids = [1, 2]) => ({ frame, phase, total, processes: pids.map((pid) => ({ pid, type: 'Tab' })) })

describe('medição de memória com população constante durante rendering', () => {
  it('não conta a liberação do worker no mux/done como crescimento da renderização', () => {
    const samples = [observation(1000, 630_000), observation(3290, 619_288), observation(107_513, 550_000), observation(108_000, 193_984, 'muxing', [1]), observation(108_000, 196_100, 'done', [1])]
    const warmed = warmedRenderingSamples(samples)
    expect(warmed.map((sample) => sample.frame)).toEqual([3290, 107_513])
    expect(Math.max(...warmed.map((sample) => sample.total)) - Math.min(...warmed.map((sample) => sample.total))).toBe(69_288)
  })

  it('não mistura observações de populações diferentes nem depende da ordem dos PIDs', () => {
    const samples = [observation(3000, 500_000), observation(4000, 520_000, 'rendering', [2, 1]), observation(5000, 200_000, 'rendering', [1])]
    expect(warmedRenderingSamples(samples)).toEqual(samples.slice(0, 2))
  })

  it('conserva crescimento real acima do limite em rendering', () => {
    const samples = [observation(3000, 500_000), observation(9000, 950_000), observation(108_000, 200_000, 'done', [1])]
    const warmed = warmedRenderingSamples(samples)
    expect(Math.max(...warmed.map((sample) => sample.total)) - Math.min(...warmed.map((sample) => sample.total))).toBeGreaterThan(300_000)
  })
})
