/**
 * Cortes verticais com a IA de verdade (`npm run test:ia`): o programa de linha de comando recebe SÓ o texto da demonstração
 * sintética "Agendaí" (frases numeradas, com a atividade de tela de cada uma) e devolve cortes. O modelo varia de uma chamada
 * para outra, então a prova é de QUALIDADE e de forma, não de texto exato: pelo menos 2 cortes, de 25 a 65 s, começando e
 * terminando em frase inteira, sem se sobrepor, com gancho curto, cada um de UM assunto (ou dois vizinhos) e nenhum
 * começando no cumprimento ou terminando na despedida. O relatório mostra só números e títulos dos cortes do fixture.
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createClaudeCliProvider, locateClaude } from '../../src/main/llm/claude-cli'
import { suggestClips } from '../../src/main/llm/clips'
import { HOOK_MAX_WORDS, clipOutputMs, clipOverlapMs, hookWords } from '../../src/shared/clips'
import { buildSentences } from '../../src/shared/sentences'
import { buildDemo, type DemoTopic } from '../helpers/demo-script'

const demo = buildDemo()
const sentences = buildSentences(demo.words, { clicks: demo.clicks, keys: demo.keys })
/** Folga (ms) entre o começo/fim do corte e a frase: a validação cola o corte na frase com folga curta nas pontas. */
const EDGE_MS = 500

it('a IA sugere cortes de 30 a 60 s que começam em frase inteira, abrem com gancho, fecham a ideia e são de um assunto', async () => {
  const exe = locateClaude()
  expect(exe, 'o programa da IA não está instalado neste computador (precisa do `claude` no PATH ou em ~/.local/bin)').not.toBeNull()
  const cwd = join(tmpdir(), 'tomada-ia-teste')
  mkdirSync(cwd, { recursive: true })
  const provider = createClaudeCliProvider({ exe: exe!, cwd })

  const t0 = Date.now()
  const r = await suggestClips({ provider, words: demo.words, durationMs: demo.durationMs, cuts: [], clicks: demo.clicks, keys: demo.keys })
  const secs = ((Date.now() - t0) / 1000).toFixed(0)

  const lines = r.clips.map((c, k) => {
    const ms = clipOutputMs(c.ranges, [], demo.durationMs)
    return `${k + 1}. "${c.title}" · ${(ms / 1000).toFixed(1)} s · gancho ${c.notes.hook} · fluxo ${c.notes.flow} · valor ${c.notes.value} · nota ${c.score}`
  })
  console.log(`IA de verdade: ${r.clips.length} cortes em ${secs} s (${r.dropped.length} descartados na conferência)\n  ${lines.join('\n  ')}`)

  expect(r.clips.length, 'a IA devolveu cortes demais ou de menos').toBeGreaterThanOrEqual(2)
  expect(r.clips.length).toBeLessThanOrEqual(3)

  const topicsOf = (start: number, end: number): DemoTopic[] =>
    demo.sentences.filter((s) => s.startMs >= start - EDGE_MS && s.endMs <= end + EDGE_MS).map((s) => s.topic)

  for (const [k, c] of r.clips.entries()) {
    const label = `corte ${k + 1} («${c.title}»)`
    const first = c.ranges[0]!
    const last = c.ranges[c.ranges.length - 1]!

    // duração: de 25 a 65 s (a validação aceita essa faixa; o pedido é de 30 a 60)
    const ms = clipOutputMs(c.ranges, [], demo.durationMs)
    expect(ms, `${label}: curto demais`).toBeGreaterThanOrEqual(25_000)
    expect(ms, `${label}: longo demais`).toBeLessThanOrEqual(65_000)

    // começa no começo de uma frase e termina no fim de uma frase
    expect(sentences.some((s) => Math.abs(s.startMs - first.start) <= EDGE_MS), `${label}: não começa no início de uma frase`).toBe(true)
    expect(sentences.some((s) => Math.abs(s.endMs - last.end) <= EDGE_MS), `${label}: não termina no fim de uma frase`).toBe(true)

    // gancho: afirma o resultado em poucas palavras
    expect(c.hook.trim().length, `${label}: sem gancho`).toBeGreaterThan(0)
    expect(hookWords(c.hook), `${label}: gancho com mais de ${HOOK_MAX_WORDS} palavras`).toBeLessThanOrEqual(HOOK_MAX_WORDS)

    // um assunto só (ou dois vizinhos, com um dominante)
    const topics = topicsOf(first.start, last.end)
    expect(topics.length, `${label}: nenhuma frase do roteiro dentro do corte`).toBeGreaterThan(0)
    const counts = new Map<DemoTopic, number>()
    for (const t of topics) counts.set(t, (counts.get(t) ?? 0) + 1)
    const top = Math.max(...counts.values())
    expect(counts.size, `${label}: mistura ${counts.size} assuntos (${[...counts.keys()].join(', ')})`).toBeLessThanOrEqual(2)
    expect(top / topics.length, `${label}: nenhum assunto domina (${[...counts.entries()].map(([t, n]) => `${t} ${n}`).join(', ')})`).toBeGreaterThanOrEqual(0.6)

    // não abre no cumprimento nem fecha na despedida
    const firstTopic = demo.sentences.find((s) => Math.abs(s.startMs - first.start) <= EDGE_MS)?.topic
    const lastTopic = [...demo.sentences].reverse().find((s) => Math.abs(s.endMs - last.end) <= EDGE_MS)?.topic
    expect(firstTopic, `${label}: começa na abertura (cumprimento)`).not.toBe('intro')
    expect(lastTopic, `${label}: termina na despedida`).not.toBe('fim')
  }

  // sem sobreposição entre os cortes
  for (let a = 0; a < r.clips.length; a++) {
    for (let b = a + 1; b < r.clips.length; b++) {
      expect(clipOverlapMs(r.clips[a]!.ranges, r.clips[b]!.ranges), `os cortes ${a + 1} e ${b + 1} se sobrepõem`).toBe(0)
    }
  }
}, 6 * 60_000)
