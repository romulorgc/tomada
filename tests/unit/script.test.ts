import { describe, expect, it } from 'vitest'
import { parseScript, scriptPrompt, teleprompterLines } from '../../src/shared/script'

const valid = { title: '  Meu sistema  ', hook: 'Veja como agendar.', topics: ['Cadastro', 'Agenda', 'Relatórios'], closing: 'Experimente hoje.' }

describe('roteiro de gravação', () => {
  it('normaliza texto e mantém de três a seis tópicos editáveis', () => {
    expect(parseScript(valid)).toEqual({ ...valid, title: 'Meu sistema' })
  })
  it('recusa roteiro incompleto, tópicos vazios e listas grandes', () => {
    for (const raw of [{ ...valid, hook: '' }, { ...valid, topics: ['Um', 'Dois'] }, { ...valid, topics: ['Um', '', 'Três'] }, { ...valid, topics: Array(7).fill('Tópico') }]) {
      expect(() => parseScript(raw)).toThrow()
    }
  })
  it('gera pedido só textual e rejeita assunto vazio ou excessivo', () => {
    expect(scriptPrompt('  agenda para barbearia  ')).toContain('agenda para barbearia')
    expect(() => scriptPrompt(' ')).toThrow()
    expect(() => scriptPrompt('a'.repeat(2001))).toThrow()
  })
  it('teleprompter contém gancho, tópicos e fechamento na ordem da fala', () => {
    expect(teleprompterLines(parseScript(valid))).toEqual(['Veja como agendar.', 'Cadastro', 'Agenda', 'Relatórios', 'Experimente hoje.'])
  })
})
