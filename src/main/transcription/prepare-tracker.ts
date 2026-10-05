/**
 * Acompanha a preparação de primeira vez de um motor (criar o venv, instalar, baixar o modelo): passos com peso,
 * fração total e o texto do que está acontecendo. Alimenta a barra de progresso REAL da interface.
 */
import type { EngineId, PrepareSnapshot, PrepareStep, PrepareStepId } from '@shared/transcription'

export type StepSpec = { id: PrepareStepId; weight: number }

export interface PrepareTracker {
  begin(id: PrepareStepId, detail?: string): void
  /** `fraction` 0..1 do passo. */
  progress(id: PrepareStepId, fraction: number, detail?: string): void
  done(id: PrepareStepId, detail?: string): void
  fail(id: PrepareStepId, message: string): void
  note(message: string): void
  cancelled(): void
  finish(): void
  snapshot(): PrepareSnapshot
}

export function createPrepareTracker(engine: EngineId, specs: readonly StepSpec[], emit: (snapshot: PrepareSnapshot) => void, now: () => number = Date.now): PrepareTracker {
  const total = specs.reduce((a, s) => a + s.weight, 0) || 1
  const steps: PrepareStep[] = specs.map((s) => ({ id: s.id, status: 'pending', fraction: 0 }))
  const notes: string[] = []
  let status: PrepareSnapshot['status'] = 'running'
  let error: PrepareSnapshot['error']
  const startedAt = now()
  let lastEmit = 0

  const step = (id: PrepareStepId): PrepareStep => {
    const s = steps.find((x) => x.id === id)
    if (!s) throw new Error(`Passo de preparação desconhecido: ${id}`)
    return s
  }
  const fraction = (): number => specs.reduce((acc, spec) => acc + spec.weight * step(spec.id).fraction, 0) / total
  const snapshot = (): PrepareSnapshot => ({
    engine,
    status,
    fraction: status === 'done' ? 1 : Math.min(0.999, fraction()),
    steps: steps.map((s) => ({ ...s })),
    ...(error ? { error } : {}),
    notes: [...notes],
    startedAt
  })
  const send = (force: boolean): void => {
    const t = now()
    if (!force && t - lastEmit < 120) return
    lastEmit = t
    emit(snapshot())
  }

  return {
    begin(id, detail) {
      const s = step(id)
      s.status = 'running'
      if (detail !== undefined) s.detail = detail
      send(true)
    },
    progress(id, f, detail) {
      const s = step(id)
      s.status = 'running'
      s.fraction = Math.min(1, Math.max(0, f))
      if (detail !== undefined) s.detail = detail
      send(false)
    },
    done(id, detail) {
      const s = step(id)
      s.status = 'done'
      s.fraction = 1
      if (detail !== undefined) s.detail = detail
      send(true)
    },
    fail(id, message) {
      const s = step(id)
      s.status = 'error'
      s.detail = message
      status = 'error'
      error = { step: id, message }
      send(true)
    },
    note(message) {
      notes.push(message)
      if (notes.length > 20) notes.shift()
      send(true)
    },
    cancelled() {
      status = 'cancelled'
      send(true)
    },
    finish() {
      status = 'done'
      send(true)
    },
    snapshot
  }
}

/** "412 MB de 1,5 GB" (base 1024, vírgula decimal). */
export function bytesLine(received: number, total: number | null): string {
  const f = (n: number): string => {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} GB`
    return `${Math.round(n / 1024 ** 2)} MB`
  }
  return total ? `${f(received)} de ${f(total)}` : f(received)
}
