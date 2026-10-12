import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DICTIONARY_MAX_LENGTH, DICTIONARY_MAX_TERMS, normalizeDictionary, parseDictionaryText } from '@shared/dictionary'
import { correctionPrompt, extractJsonText, LlmError, parseLlmJson } from '@shared/llm-json'
import { RETAKES_OVERLAP, RETAKES_WINDOW, RETAKES_SYSTEM, buildRetakePrompts, retakesSchema } from '@shared/retakes-prompt'
import { LEVEL_FRAME_MS, SILENT_DB, alignLevels, computeLevels } from '@shared/levels'
import type { Word } from '@shared/types'
import { createAnthropicApiProvider, API_URL } from '../../src/main/llm/anthropic-api'
import { claudeArgs, createClaudeCliProvider } from '../../src/main/llm/claude-cli'
import { createMockProvider, parseRecorded } from '../../src/main/llm/mock'
import { providerFromAsk } from '../../src/main/llm/provider'
import { detectRetakes } from '../../src/main/llm/retakes'
import { ProcessError, type runProcess } from '../../src/main/process-runner'

const schema = z.object({ ok: z.boolean() })

describe('extractJsonText / parseLlmJson', () => {
  it('JSON puro, com cerca de código, com conversa em volta', () => {
    expect(parseLlmJson('{"ok":true}', schema)).toEqual({ ok: true, value: { ok: true } })
    expect(parseLlmJson('```json\n{"ok": true}\n```', schema)).toMatchObject({ ok: true })
    expect(parseLlmJson('Claro! Aqui está:\n{"ok": false}\nEspero ter ajudado.', schema)).toEqual({ ok: true, value: { ok: false } })
    expect(extractJsonText('texto [1,2,3] fim')).toBe('[1,2,3]')
  })

  it('quebrado: devolve o motivo, nunca lança', () => {
    const a = parseLlmJson('{"ok": tru', schema)
    expect(a.ok).toBe(false)
    expect(a.ok ? '' : a.error).toMatch(/JSON válido/)
    const b = parseLlmJson('{"ok": "sim"}', schema)
    expect(b.ok ? '' : b.error).toMatch(/formato pedido/)
    expect(parseLlmJson('sem json nenhum', schema).ok).toBe(false)
  })

  it('o pedido de correção repete o original, a resposta e o erro', () => {
    const p = correctionPrompt('PEDIDO', 'x'.repeat(2000), 'não é um JSON válido')
    expect(p).toContain('PEDIDO')
    expect(p).toContain('não é um JSON válido')
    expect(p.length).toBeLessThan(2400)
    expect(p).toMatch(/SOMENTE com o JSON corrigido/)
  })
})

describe('providerFromAsk: JSON quebrado → UMA nova tentativa → erro visível', () => {
  const req = { task: 't', system: 's', prompt: 'p', schema }

  it('resposta boa de primeira: uma pergunta só', async () => {
    const asked: string[] = []
    const provider = providerFromAsk('mock', async ({ prompt }) => (asked.push(prompt), '{"ok":true}'))
    expect(await provider.complete(req)).toEqual({ ok: true })
    expect(asked).toHaveLength(1)
  })

  it('quebrada na primeira, certa na segunda: a segunda pergunta traz a correção', async () => {
    const asked: string[] = []
    const answers = ['{"ok": tru', '{"ok":true}']
    const provider = providerFromAsk('mock', async ({ prompt }) => (asked.push(prompt), answers.shift()!))
    expect(await provider.complete(req)).toEqual({ ok: true })
    expect(asked).toHaveLength(2)
    expect(asked[1]).toContain('Sua resposta anterior não pôde ser usada')
    expect(asked[1]).toContain('{"ok": tru')
  })

  it('quebrada duas vezes: erro visível, sem terceira tentativa', async () => {
    let calls = 0
    const provider = providerFromAsk('mock', async () => (calls++, 'lixo'))
    await expect(provider.complete(req)).rejects.toThrow(/mesmo depois de pedir de novo/)
    expect(calls).toBe(2)
  })

  it('erro do fornecedor passa direto (nada de repetir pergunta)', async () => {
    let calls = 0
    const provider = providerFromAsk('mock', async () => {
      calls++
      throw new LlmError('sem rede', true)
    })
    await expect(provider.complete(req)).rejects.toThrow('sem rede')
    expect(calls).toBe(1)
  })
})

describe('ClaudeCliProvider (processo filho)', () => {
  const okRun =
    (stdoutOf: (stdin: string) => string, seen: { args: string[]; stdin: string; cwd?: string | undefined; timeoutMs?: number | undefined }[]): typeof runProcess =>
    async (_exe, args, opts) => {
      seen.push({ args: [...args], stdin: opts?.stdin ?? '', cwd: opts?.cwd, timeoutMs: opts?.timeoutMs })
      return { stdout: stdoutOf(opts?.stdin ?? ''), stderr: '', exitCode: 0 }
    }
  const envelope = (result: string, extra: object = {}): string => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, ...extra })

  it('o prompt vai pelo stdin e NUNCA na linha de comando; sem ferramentas, sem sessão, pasta vazia, com tempo limite', async () => {
    const seen: { args: string[]; stdin: string; cwd?: string | undefined; timeoutMs?: number | undefined }[] = []
    const provider = createClaudeCliProvider({ exe: 'C:/x/claude.exe', cwd: 'C:/tmp/vazia', run: okRun(() => envelope('{"ok":true}'), seen) })
    const SEGREDO = 'TRANSCRIÇÃO-QUE-NAO-PODE-IR-NA-LINHA-DE-COMANDO'
    expect(await provider.complete({ task: 't', system: 'SISTEMA FIXO', prompt: SEGREDO, schema })).toEqual({ ok: true })
    const call = seen[0]!
    expect(call.stdin).toBe(SEGREDO)
    expect(call.args.join(' ')).not.toContain(SEGREDO)
    expect(call.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']))
    // `--tools ""` (nenhuma ferramenta) e as configurações do projeto ignoradas
    expect(call.args[call.args.indexOf('--tools') + 1]).toBe('')
    expect(call.args[call.args.indexOf('--setting-sources') + 1]).toBe('')
    expect(call.args[call.args.indexOf('--system-prompt') + 1]).toBe('SISTEMA FIXO')
    expect(call.cwd).toBe('C:/tmp/vazia')
    expect(call.timeoutMs).toBeGreaterThan(0)
    expect(claudeArgs('s', 'sonnet')).not.toContain('--dangerously-skip-permissions')
  })

  it('a segunda pergunta (correção) também vai pelo stdin', async () => {
    const seen: { args: string[]; stdin: string }[] = []
    const answers = [envelope('lixo'), envelope('{"ok":true}')]
    const provider = createClaudeCliProvider({ exe: 'x', cwd: 'y', run: okRun(() => answers.shift()!, seen) })
    expect(await provider.complete({ task: 't', system: 's', prompt: 'P', schema })).toEqual({ ok: true })
    expect(seen).toHaveLength(2)
    expect(seen[1]!.stdin).toContain('Sua resposta anterior')
    expect(seen[1]!.args.join(' ')).not.toContain('Sua resposta anterior')
  })

  it('erro do programa vira mensagem em português que diz "IA", sem nome de fornecedor', async () => {
    const fails = (reason: ProcessError['reason'], stderr = ''): typeof runProcess => async () => {
      throw new ProcessError('x', reason, reason === 'exit' ? 1 : null, '', stderr)
    }
    const msg = async (run: typeof runProcess): Promise<string> => {
      try {
        await createClaudeCliProvider({ exe: 'x', cwd: 'y', run }).complete({ task: 't', system: 's', prompt: 'p', schema })
        return ''
      } catch (err) {
        return (err as Error).message
      }
    }
    expect(await msg(fails('timeout'))).toMatch(/demorou demais/)
    expect(await msg(fails('spawn'))).toMatch(/Não consegui abrir o Claude Code/)
    expect(await msg(fails('exit', 'Not logged in'))).toMatch(/Not logged in/)
    for (const reason of ['timeout', 'spawn', 'exit'] as const) expect(await msg(fails(reason))).not.toMatch(/openai|gpt|gemini/i)
    const isError = okRun(() => envelope('limite de uso atingido', { is_error: true }), [])
    expect(await msg(isError)).toMatch(/limite de uso atingido/)
    expect(await msg(okRun(() => 'não é json', []))).toMatch(/formato que não reconheci/)
  })
})

describe('AnthropicApiProvider', () => {
  const ok = (text: string): Response => new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 })

  it('só HTTPS no endereço fixo, chave no cabeçalho, nada da chave no corpo', async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = []
    const provider = createAnthropicApiProvider({
      getKey: () => 'chave-de-teste-falsa-123',
      fetchImpl: (async (url: URL | string, init?: RequestInit) => {
        seen.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) })
        return ok('{"ok":true}')
      }) as typeof fetch
    })
    expect(await provider.complete({ task: 't', system: 'S', prompt: 'P', schema })).toEqual({ ok: true })
    expect(seen[0]!.url).toBe(API_URL)
    expect(seen[0]!.url.startsWith('https://')).toBe(true)
    expect(seen[0]!.headers['x-api-key']).toBe('chave-de-teste-falsa-123')
    expect(seen[0]!.body).not.toContain('chave-secreta')
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ system: 'S', messages: [{ role: 'user', content: 'P' }] })
  })

  it('sem chave, chave recusada e limite de uso viram mensagens claras', async () => {
    const fetchStatus = (status: number): typeof fetch => (async () => new Response('{}', { status })) as typeof fetch
    const run = async (opts: Parameters<typeof createAnthropicApiProvider>[0]): Promise<string> => {
      try {
        await createAnthropicApiProvider(opts).complete({ task: 't', system: 's', prompt: 'p', schema })
        return ''
      } catch (err) {
        return (err as Error).message
      }
    }
    expect(await run({ getKey: () => null })).toMatch(/Falta a chave de API da Anthropic/)
    expect(await run({ getKey: () => 'k', fetchImpl: fetchStatus(401) })).toMatch(/A Anthropic recusou a chave de API/)
    expect(await run({ getKey: () => 'k', fetchImpl: fetchStatus(429) })).toMatch(/limite de uso/)
    expect(await run({ getKey: () => 'k', fetchImpl: fetchStatus(500) })).toMatch(/erro 500/)
    expect(await run({ getKey: () => 'k', url: 'http://api.exemplo.com/x', fetchImpl: fetchStatus(200) })).toMatch(/só é chamada por HTTPS/)
    expect(await run({ getKey: () => 'k', fetchImpl: (async () => { throw new Error('ECONNRESET') }) as typeof fetch })).toMatch(/Não consegui falar com a IA: ECONNRESET/)
  })

  it('tempo limite derruba a pergunta', async () => {
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('abortado')))
      })) as typeof fetch
    await expect(createAnthropicApiProvider({ getKey: () => 'k', fetchImpl: hang }).complete({ task: 't', system: 's', prompt: 'p', schema, timeoutMs: 30 })).rejects.toThrow(/demorou demais/)
  })
})

describe('MockProvider (respostas gravadas)', () => {
  it('responde pelo trecho do prompt; pedido sem gravação falha com erro visível', async () => {
    const mock = createMockProvider({ recorded: [{ match: 'login', response: { retakes: [{ from: 1, to: 3 }] } }] })
    const r = await mock.complete({ task: 'retakes', system: 's', prompt: 'o botão de login', schema: retakesSchema })
    expect(r.retakes).toHaveLength(1)
    await expect(mock.complete({ task: 'retakes', system: 's', prompt: 'outra coisa', schema: retakesSchema })).rejects.toThrow(/não há resposta gravada/)
  })

  it('parseRecorded valida o arquivo', () => {
    expect(parseRecorded('[{"match":"a","response":{"x":1}}]')).toEqual([{ match: 'a', response: { x: 1 } }])
    expect(() => parseRecorded('{}')).toThrow(/lista/)
    expect(() => parseRecorded('[{"response":1}]')).toThrow(/match/)
  })
})

describe('recomeços: o que vai para a IA e o que volta', () => {
  const words = (n: number, kind: Word['kind'] = 'word'): Word[] => Array.from({ length: n }, (_, i) => ({ i, text: `p${i}`, start: i * 500, end: i * 500 + 400, prob: 1, kind }))

  it('só TEXTO: cada palavra com o número dela, sem tempo, sem caminho', () => {
    const w = words(4)
    w[1] = { ...w[1]!, text: 'login,' }
    w[2] = { ...w[2]!, kind: 'gap-speech', text: '…' }
    const [prompt] = buildRetakePrompts(w)
    expect(prompt).toBe('Transcrição:\n[0]p0 [1]login, [3]p3')
    expect(prompt).not.toMatch(/\d{4,}/) // nenhum tempo em ms
    expect(RETAKES_SYSTEM).toContain('{"retakes":')
  })

  it('transcrição longa vai em janelas com emenda repetida', () => {
    const w = words(RETAKES_WINDOW + 600)
    const prompts = buildRetakePrompts(w)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain(`[${RETAKES_WINDOW - RETAKES_OVERLAP}]`)
    expect(prompts[0]).toContain(`[${RETAKES_WINDOW - 1}]`)
    expect(prompts[1]).toContain(`[${RETAKES_WINDOW + 599}]`)
    expect(buildRetakePrompts([])).toEqual([])
  })

  it('detectRetakes valida os índices que a IA devolve (descarta e conta o que não existe)', async () => {
    const w = words(30)
    const provider = createMockProvider({
      recorded: [
        {
          match: 'Transcrição',
          response: {
            retakes: [
              { from: 3, to: 6, reason: 'recomeçou a frase' },
              { from: 28, to: 99 },
              { from: 9, to: 4 }
            ]
          }
        }
      ]
    })
    const r = await detectRetakes({ provider, words: w })
    expect(r.retakes).toEqual([{ from: 3, to: 6, reason: 'recomeçou a frase' }])
    expect(r.dropped).toBe(2)
  })

  it('JSON quebrado na primeira resposta da IA: nova tentativa; depois erro', async () => {
    const w = words(10)
    const answers = ['quase {"retakes": [', '{"retakes":[{"from":1,"to":2,"reason":"x"}]}']
    const provider = providerFromAsk('mock', async () => answers.shift()!)
    expect((await detectRetakes({ provider, words: w })).retakes).toHaveLength(1)
    await expect(detectRetakes({ provider: providerFromAsk('mock', async () => 'lixo'), words: w })).rejects.toThrow(/mesmo depois de pedir de novo/)
  })
})

describe('dicionário', () => {
  it('limpa: só texto, sem controle, sem repetido (sem ligar para a caixa), sem passar do limite', () => {
    expect(normalizeDictionary(['  Sintomax ', 'sintomax', 'Agendaí', '', 7, null, 'A\u0000B', 'x'.repeat(200)])).toEqual(['Sintomax', 'Agendaí', 'A B', 'x'.repeat(DICTIONARY_MAX_LENGTH)])
    expect(normalizeDictionary('não é lista')).toEqual([])
    expect(normalizeDictionary(Array.from({ length: 500 }, (_, i) => `termo${i}`))).toHaveLength(DICTIONARY_MAX_TERMS)
  })
  it('texto do campo: uma linha ou vírgula por termo', () => {
    expect(parseDictionaryText('Sintomax\nAgendaí, Tomada;  Outro Termo \n\n')).toEqual(['Sintomax', 'Agendaí', 'Tomada', 'Outro Termo'])
  })
})

describe('níveis do áudio', () => {
  it('RMS em dBFS por quadro de 10 ms; silêncio digital = -120', () => {
    const sr = 8000
    const per = (sr * LEVEL_FRAME_MS) / 1000 // 160 amostras
    const pcm = new Int16Array(per * 3)
    pcm.fill(16384, per, per * 2) // quadro do meio a meia escala: -6 dBFS
    expect(computeLevels(pcm, sr)).toEqual([SILENT_DB, -6, SILENT_DB])
    expect(computeLevels(new Int16Array(0), sr)).toEqual([])
    expect(computeLevels(new Int16Array(10), 0)).toEqual([])
  })
  it('alinha uma faixa ao eixo da voz', () => {
    expect(alignLevels([1, 2, 3], 2)).toEqual([SILENT_DB, SILENT_DB, 1, 2, 3])
    expect(alignLevels([1, 2, 3], -1)).toEqual([2, 3])
    expect(alignLevels([1, 2, 3], 0)).toEqual([1, 2, 3])
  })
})
