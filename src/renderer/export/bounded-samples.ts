/** A fila nativa do sink precisa de um fim para fazer flush; entrega lotes finitos. */
export async function* samplesInBatches<T>(
  times: AsyncIterable<number>,
  retrieve: (times: Iterable<number> | AsyncIterable<number>) => AsyncIterable<T>,
  batchSize = 32
): AsyncGenerator<T, void, unknown> {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('O lote de quadros precisa de um tamanho positivo.')
  let batch: number[] = []
  for await (const time of times) {
    batch.push(time)
    if (batch.length === batchSize) {
      // yield* também encaminha return/throw ao sink interno. Ao cancelar,
      // ele fecha os frames ainda enfileirados e nenhum lote futuro começa.
      yield* retrieve(batch)
      batch = []
    }
  }
  if (batch.length) yield* retrieve(batch)
}
