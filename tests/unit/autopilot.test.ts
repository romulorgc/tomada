import { describe, expect, it } from 'vitest'
import { newPipeline, runPipeline, PIPELINE_STEPS } from '../../src/shared/autopilot'

describe('piloto automático', () => {
  it('executa em ordem e isola uma falha sem impedir a exportação e os textos', async () => {
    const calls: string[] = []
    const saved: string[] = []
    const state = newPipeline('gravação', 100)
    await runPipeline(state, { save: async (s) => { saved.push(JSON.stringify(s)) }, run: async (id) => { calls.push(id); if (id === 'clean') throw new Error('falha local') }, enabled: () => true, now: () => 200 })
    expect(calls).toEqual(PIPELINE_STEPS)
    expect(state.steps.find((s) => s.id === 'clean')).toMatchObject({ status: 'error', detail: 'falha local' })
    expect(state.steps.find((s) => s.id === 'youtube')?.status).toBe('done')
    expect(state.status).toBe('done')
    expect(saved.length).toBeGreaterThan(PIPELINE_STEPS.length)
  })
  it('retoma só os passos interrompidos e pendentes; erro requer nova tentativa explícita', async () => {
    const state = newPipeline('gravação', 100)
    state.steps[0]!.status = 'done'
    state.steps[1]!.status = 'running'
    state.steps[2]!.status = 'error'
    const calls: string[] = []
    await runPipeline(state, { save: async () => {}, run: async (id) => { calls.push(id) }, enabled: () => true, now: () => 300 })
    expect(calls).toEqual(PIPELINE_STEPS.slice(1).filter((s) => s !== 'zooms'))
    expect(state.elapsedMs).toBe(200)
  })
  it('pula etapas desligadas', async () => {
    const state = newPipeline('gravação')
    const calls: string[] = []
    await runPipeline(state, { save: async () => {}, run: async (id) => { calls.push(id) }, enabled: (id) => id !== 'youtube' && id !== 'clipExports' })
    expect(calls).not.toContain('youtube')
    expect(state.steps.find((s) => s.id === 'youtube')?.status).toBe('skipped')
  })
})
