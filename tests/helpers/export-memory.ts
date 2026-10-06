type MemoryObservation = {
  phase: string
  frame: number
  processes: { pid: number; type: string }[]
}

/** Compara renderização aquecida com a mesma população, sem contar sua saída como crescimento. */
export function warmedRenderingSamples<T extends MemoryObservation>(samples: readonly T[]): T[] {
  const rendering = samples.filter((sample) => sample.frame >= 3000 && sample.phase === 'rendering')
  const population = (sample: T): string => sample.processes.filter((process) => process.type === 'Tab').map((process) => process.pid).sort((a, b) => a - b).join(',')
  const first = rendering[0]
  if (!first) return []
  const cohort = population(first)
  return rendering.filter((sample) => population(sample) === cohort)
}
