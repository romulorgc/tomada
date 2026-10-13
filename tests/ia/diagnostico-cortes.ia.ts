/**
 * DIAGNÓSTICO dos cortes verticais com a IA de verdade numa pasta de projeto que já tem `transcript.json` (por exemplo a da prova real):
 * mostra o que a IA devolveu e o que a conferência descartou, com os motivos. Só roda com `TOMADA_PASTA_PROJETO=<pasta>`:
 *
 *   TOMADA_PASTA_PROJETO=C:\tmp\...\projetos\<gravação> npx vitest run -c vitest.ia.config.ts tests/ia/diagnostico-cortes.ia.ts
 *
 * Consome a assinatura de quem roda (uma chamada). Imprime só números e títulos; nunca altera a pasta.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createClaudeCliProvider, locateClaude } from '../../src/main/llm/claude-cli'
import { suggestClips } from '../../src/main/llm/clips'
import { readActivity } from '../../src/main/activity'
import { clipOutputMs, clipCountRange } from '../../src/shared/clips'
import { parseProject, projectDurationMs } from '../../src/shared/project'
import { keptRanges, rangesLength } from '../../src/shared/timeline'
import type { Transcript } from '../../src/shared/types'

const pasta = process.env.TOMADA_PASTA_PROJETO

it.skipIf(!pasta)('o que a IA devolve para os cortes desta pasta, e o que a conferência descarta', async () => {
  const project = parseProject(readFileSync(join(pasta!, 'project.json'), 'utf8'))
  const transcript = JSON.parse(readFileSync(join(pasta!, 'transcript.json'), 'utf8')) as Transcript
  const activity = await readActivity(pasta!)
  const duration = projectDurationMs(project)
  const outputMs = rangesLength(keptRanges(duration, project.cuts))
  const exe = locateClaude()
  expect(exe, 'o Claude Code não está instalado neste computador').not.toBeNull()
  const cwd = join(tmpdir(), 'tomada-ia-diagnostico')
  mkdirSync(cwd, { recursive: true })
  const provider = createClaudeCliProvider({ exe: exe!, cwd })
  const t0 = Date.now()
  const r = await suggestClips({ provider, words: transcript.words, durationMs: duration, cuts: project.cuts, clicks: activity.clicks, keys: activity.keys })
  console.log(`Vídeo: ${(duration / 1000).toFixed(1)} s gravados, ${(outputMs / 1000).toFixed(1)} s depois da limpeza (pedido: ${JSON.stringify(clipCountRange(outputMs))}); IA em ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  console.log(`Aceitos (${r.clips.length}):\n${r.clips.map((c) => `  "${c.title}" · ${(clipOutputMs(c.ranges, project.cuts, duration) / 1000).toFixed(1)} s · nota ${c.score} (gancho ${c.notes.hook}, fluxo ${c.notes.flow}, valor ${c.notes.value}) · ${c.reason}`).join('\n')}`)
  console.log(`Descartados na conferência (${r.dropped.length}):\n${r.dropped.map((d) => `  "${d.title}": ${d.why}`).join('\n')}`)
})
