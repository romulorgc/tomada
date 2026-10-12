/**
 * Recomeços com a IA de verdade (`npm run test:ia`): o programa de linha de comando recebe SÓ o texto (palavras
 * numeradas) de uma fala sintética com um recomeço óbvio ("o botão de login, não, o botão de cadastro fica aqui") e
 * devolve índices válidos que apontam o trecho errado. O modelo varia de uma chamada para outra, então a prova é de
 * formato e de lugar (o recomeço cobre o "login"), não de texto exato.
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createClaudeCliProvider, locateClaude } from '../../src/main/llm/claude-cli'
import { detectRetakes } from '../../src/main/llm/retakes'
import { buildTranscript } from '../../src/shared/transcript'
import type { Word } from '../../src/shared/types'

const TEXT = 'Então, aqui na tela fica o botão de login, não, o botão de cadastro fica aqui. Depois é só preencher o formulário e clicar em enviar.'

function words(): Word[] {
  const tokens = TEXT.split(' ')
  return buildTranscript({
    engine: 'teste',
    model: 'ia',
    language: 'pt',
    durationMs: tokens.length * 400 + 1000,
    words: tokens.map((text, k) => ({ text, start: 500 + k * 400, end: 500 + k * 400 + 300 })),
    segments: [],
    vad: [],
    offsetMs: 0,
    createdAt: ''
  }).words
}

it('a IA aponta o recomeço do botão de login, com índices que existem', async () => {
  const exe = locateClaude()
  expect(exe, 'o Claude Code não está instalado neste computador (precisa do `claude` no PATH ou em ~/.local/bin)').not.toBeNull()
  const cwd = join(tmpdir(), 'tomada-ia-teste')
  mkdirSync(cwd, { recursive: true })
  const provider = createClaudeCliProvider({ exe: exe!, cwd })
  const all = words()
  const login = all.find((w) => w.text.startsWith('login'))!.i
  const result = await detectRetakes({ provider, words: all })
  expect(result.dropped).toBe(0)
  expect(result.retakes.length).toBeGreaterThanOrEqual(1)
  for (const r of result.retakes) {
    expect(r.from).toBeGreaterThanOrEqual(0)
    expect(r.to).toBeGreaterThanOrEqual(r.from)
    expect(r.to).toBeLessThan(all.length)
  }
  // o trecho errado ("o botão de login, não,") está coberto por algum recomeço
  expect(result.retakes.some((r) => r.from <= login && r.to >= login), JSON.stringify(result.retakes)).toBe(true)
})
