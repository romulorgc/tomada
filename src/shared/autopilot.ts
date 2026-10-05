/** Piloto automático persistente. A fila do main injeta os serviços, este núcleo decide ordem e retomada. */
import { z } from 'zod'

export const PIPELINE_STEPS = ['transcribe', 'clean', 'zooms', 'layouts', 'captions', 'youtube', 'clips', 'clipExports', 'publish', 'notify'] as const
export type PipelineStepId = typeof PIPELINE_STEPS[number]
export type PipelineStep = { id: PipelineStepId; status: 'pending' | 'running' | 'done' | 'error' | 'skipped'; detail?: string; elapsedMs?: number }
export type PipelineState = { projectId: string; status: 'running' | 'done'; startedAt: number; elapsedMs: number; steps: PipelineStep[] }
export const autopilotPrefsSchema = z.object({
  mode: z.enum(['everything', 'prepare', 'nothing']).default('everything'),
  steps: z.partialRecord(z.enum(PIPELINE_STEPS), z.boolean()).default({}),
  captionsHorizontal: z.boolean().default(false),
  captionsVertical: z.boolean().default(true),
  maxClips: z.number().int().min(3).max(5).default(3),
  minScore: z.number().min(0).max(100).default(70)
})
export type AutopilotPrefs = Omit<z.infer<typeof autopilotPrefsSchema>, 'steps'> & { steps: Partial<Record<PipelineStepId, boolean>> }
export const DEFAULT_AUTOPILOT: AutopilotPrefs = { mode: 'everything', steps: {}, captionsHorizontal: false, captionsVertical: true, maxClips: 3, minScore: 70 }
export const pipelineSchema = z.looseObject({
  projectId: z.string(), status: z.enum(['running', 'done']), startedAt: z.number(), elapsedMs: z.number(),
  steps: z.array(z.looseObject({ id: z.enum(PIPELINE_STEPS), status: z.enum(['pending', 'running', 'done', 'error', 'skipped']), detail: z.string().optional(), elapsedMs: z.number().optional() }))
})
export function newPipeline(projectId: string, startedAt = Date.now()): PipelineState {
  return { projectId, status: 'running', startedAt, elapsedMs: 0, steps: PIPELINE_STEPS.map((id) => ({ id, status: 'pending' })) }
}
export async function runPipeline(state: PipelineState, deps: {
  run(id: PipelineStepId): Promise<string | void>; save(state: PipelineState): Promise<void>; enabled(id: PipelineStepId): boolean; now?(): number; stopped?(): boolean
}): Promise<void> {
  const now = deps.now ?? Date.now
  state.status = 'running'
  for (const step of state.steps) {
    if (deps.stopped?.()) return
    if (step.status === 'done' || step.status === 'error' || step.status === 'skipped') continue
    if (!deps.enabled(step.id)) { step.status = 'skipped'; await deps.save(state); continue }
    step.status = 'running'
    delete step.detail
    const started = now()
    await deps.save(state)
    try { const detail = await deps.run(step.id); step.status = 'done'; if (detail) step.detail = detail }
    catch (err) { step.status = 'error'; step.detail = err instanceof Error ? err.message : String(err) }
    step.elapsedMs = now() - started
    state.elapsedMs = now() - state.startedAt
    await deps.save(state)
  }
  if (deps.stopped?.()) return
  state.status = 'done'
  state.elapsedMs = now() - state.startedAt
  await deps.save(state)
}
