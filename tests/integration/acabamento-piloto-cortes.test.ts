import { describe, expect, it } from 'vitest'
import { createMockProvider } from '../../src/main/llm/mock'
import { clipResponse, pilotWorld } from '../helpers/autopilot-acabamento'

describe('quantidade e nota dos cortes no piloto', () => {
  it('faz uma segunda sugestão automática pelo fluxo da etapa e entrega a quantidade pedida', async () => {
    const prompts: string[] = []
    const provider = createMockProvider({ onAsk: (r) => prompts.push(r.prompt), recorded: [
      { task: 'clips', match: '', times: 1, response: { clips: [clipResponse(83, 0)] } },
      { task: 'clips', match: '', response: { clips: [clipResponse(90, 0), clipResponse(85, 1), clipResponse(80, 2)] } }
    ] })
    const w = await pilotWorld({ provider })
    await w.service.start('acabamento')
    expect(w.project().clips.map((c) => c.score)).toEqual([90, 85, 80])
    expect(prompts).toHaveLength(2)
    expect(prompts.every((p) => p.includes('Sugira de 3 a 3 cortes.'))).toBe(true)
    await w.service.retry('acabamento', 'clips')
    expect(w.project().clips).toHaveLength(3)
    expect(prompts).toHaveLength(3)
  })

  it('depois de duas sugestões escassas entrega até dois melhores acima de 50 com aviso visível salvo', async () => {
    const prompts: string[] = []
    const provider = createMockProvider({ onAsk: (r) => prompts.push(r.prompt), recorded: [{ task: 'clips', match: '', response: { clips: [clipResponse(65, 0), clipResponse(58, 1), clipResponse(49, 2)] } }] })
    const w = await pilotWorld({ provider })
    await w.service.start('acabamento')
    const doc = w.project()
    expect(doc.clips.map((c) => c.score)).toEqual([65, 58])
    expect(doc.clips.every((c) => doc.review?.items[c.id]?.lowScore)).toBe(true)
    expect(prompts).toHaveLength(2)
    expect(doc.autopilot?.steps.find((s) => s.id === 'clips')?.detail).toContain('Nota baixa: revise antes de postar')
  })

  it('respeita a nota configurada e não marca como baixa a nota que a alcança', async () => {
    const provider = createMockProvider({ recorded: [{ task: 'clips', match: '', response: { clips: [clipResponse(68, 0), clipResponse(61, 1), clipResponse(55, 2)] } }] })
    const w = await pilotWorld({ provider })
    w.prefs.minScore = 60
    await w.service.start('acabamento')
    expect(w.project().clips.map((c) => c.score)).toEqual([68, 61])
    expect(w.project().clips.every((c) => !w.project().review?.items[c.id]?.lowScore)).toBe(true)
  })
})
