import { describe, expect, it } from 'vitest'
import { samplesInBatches } from '../../src/renderer/export/bounded-samples'

function pump() {
  const state = { live: 0, peak: 0, batches: [] as number[], requested: [] as number[] }
  const retrieve = async function* (times: Iterable<number> | AsyncIterable<number>) {
    // Reproduz o sink all-intra: decodifica/empilha tudo antes do primeiro consumo.
    const samples: { time: number; closed: boolean; close(): void }[] = []
    for await (const time of times) {
      state.requested.push(time)
      state.live++
      state.peak = Math.max(state.peak, state.live)
      samples.push({ time, closed: false, close() { if (!this.closed) { this.closed = true; state.live-- } } })
    }
    state.batches.push(samples.length)
    try { yield* samples } finally { samples.forEach((sample) => sample.close()) }
  }
  return { state, retrieve }
}
const times = async function* (values: number[]) { yield* values }

describe('limite de amostras nativas da exportação longa', () => {
  it('mantém no máximo 32 timestamps em voo com pump agressivo, sem perder ou repetir quadros', async () => {
    const { state, retrieve } = pump()
    const values = Array.from({ length: 105 }, (_, i) => Math.floor(i / 30))
    const output: number[] = []
    for await (const sample of samplesInBatches(times(values), retrieve)) { output.push(sample.time); sample.close() }
    expect(output).toEqual(values)
    expect(state.requested).toEqual(values)
    expect(state.peak).toBeLessThanOrEqual(32)
    expect(state.batches).toEqual([32, 32, 32, 9])
    expect(state.live).toBe(0)
  })

  it('fecha o iterador do lote atual ao cancelar e não programa os próximos lotes', async () => {
    const { state, retrieve } = pump()
    let timesClosed = false
    const input = async function* () { try { yield* Array.from({ length: 100 }, (_, i) => i) } finally { timesClosed = true } }
    const iter = samplesInBatches(input(), retrieve)
    const first = await iter.next()
    if (first.done) throw new Error('O primeiro quadro faltou.')
    first.value.close()
    await iter.return()
    expect(state.batches).toEqual([32])
    expect(state.live).toBe(0)
    expect(timesClosed).toBe(true)
  })

  it('erro do consumidor fecha o lote e preserva a ordem nos saltos de cortes', async () => {
    const { state, retrieve } = pump()
    const values = [0, 0, 1, 25, 25, 60, 61]
    const output: number[] = []
    await expect((async () => {
      for await (const sample of samplesInBatches(times(values), retrieve, 3)) {
        output.push(sample.time)
        sample.close()
        if (output.length === 4) throw new Error('Cancelamento simulado')
      }
    })()).rejects.toThrow('Cancelamento simulado')
    expect(output).toEqual([0, 0, 1, 25])
    expect(state.batches).toEqual([3, 3])
    expect(state.peak).toBeLessThanOrEqual(3)
    expect(state.live).toBe(0)
  })
})
