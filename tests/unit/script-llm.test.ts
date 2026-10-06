import { describe, expect, it } from 'vitest'
import { generateScript } from '../../src/main/llm/script'
import { createMockProvider } from '../../src/main/llm/mock'

describe('roteiro pela IA de texto', () => {
  it('devolve roteiro validado e transmite só assunto e contrato textual', async () => {
    const requests: { task: string; system: string; prompt: string }[] = []
    const provider = createMockProvider({ onAsk: (req) => requests.push(req) })
    const result = await generateScript(provider, 'agenda de clientes')
    expect(result.topics).toHaveLength(3)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.task).toBe('script')
    expect(requests[0]?.prompt).toContain('agenda de clientes')
    expect(Object.keys(requests[0] ?? {}).sort()).toEqual(['prompt', 'system', 'task'])
  })
  it('resposta malformada não chega à tela, mesmo depois da nova tentativa', async () => {
    const provider = createMockProvider({ recorded: [{ task: 'script', match: '', response: { title: 'Inválido', topics: [] } }] })
    await expect(generateScript(provider, 'agenda')).rejects.toThrow('não consegui usar')
  })
})
