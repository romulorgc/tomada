/**
 * Os canais de IA da M4b com os serviços de verdade e a IA de TESTE (respostas gravadas): sugerir cortes (pela IA e pela
 * heurística sem IA), "editar pedindo" e os textos de publicação. Prova o que VAI para a IA (só texto, sem caminho), o
 * que volta (validado contra a transcrição), as mensagens de "IA indisponível" (sem nome de fornecedor) e o que a
 * interface recebe quando a resposta é inútil.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planAiEdit } from '../../src/shared/ai-edit'
import { createProject, serializeProject } from '../../src/shared/project'
import type { Clip, Project } from '../../src/shared/types'
import { createHandlers, type HandlerDeps } from '../../src/main/handlers'
import { createLlmManager } from '../../src/main/llm/manager'
import { createMockProvider } from '../../src/main/llm/mock'
import { suggestClips } from '../../src/main/llm/clips'
import { proposeEdit } from '../../src/main/llm/edit'
import { generatePublish } from '../../src/main/llm/publish'
import { createMemoryLogger } from '../../src/main/logger'
import { ENV_PROJECTS_DIR } from '../../src/main/paths'
import { createOutputDirs } from '../../src/main/path-guard'
import { createProjectStore } from '../../src/main/projects'
import { createAppState } from '../../src/main/state'
import { createMockTranscriber } from '../../src/main/transcription/mock'
import { createTranscriptionService } from '../../src/main/transcription/service'
import { useTmpDir } from '../helpers/env'
import { buildDemo, sentenceRange } from '../helpers/demo-script'
import { fakeVault } from '../helpers/handler-extras'
import { createIdleExportService, createIdleRecordingService } from '../helpers/recording'

const tmp = useTmpDir()
const demo = buildDemo()
const durationMs = demo.durationMs

const item = (a: number, b: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'Agende em três cliques',
  hook: 'Agende em três cliques, sem planilha',
  ranges: [sentenceRange(demo, a, b)],
  score: 82,
  notes: { hook: 85, flow: 80, value: 80 },
  reason: 'Mostra o agendamento do começo ao fim.',
  ...extra
})

function writeDemoProject(dir: string): Project {
  mkdirSync(join(dir, 'events'), { recursive: true })
  const p = createProject({
    id: 'demo-1',
    title: 'Demonstração do Agendaí',
    sources: {
      screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs },
      camera: { path: 'media/camera.mp4', w: 640, h: 360, fps: 30, durationMs },
      voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs }
    }
  })
  writeFileSync(join(dir, 'project.json'), serializeProject(p))
  writeFileSync(
    join(dir, 'transcript.json'),
    JSON.stringify({ engine: 'teste', model: 'mock', language: 'pt', durationMs, words: demo.words, segments: [], vad: [], createdAt: '2026-10-05T10:00:00.000Z' })
  )
  writeFileSync(join(dir, 'events', 'clicks.jsonl'), demo.clicks.map((t) => JSON.stringify({ t, x: 0.5, y: 0.5, button: 'left' })).join('\n') + '\n')
  writeFileSync(join(dir, 'events', 'keys.jsonl'), demo.keys.map((t) => JSON.stringify({ t })).join('\n') + '\n')
  return p
}

async function build(opts: { responses?: unknown[]; llm?: 'mock' | 'off'; project?: (p: Project) => Project } = {}) {
  const base = tmp()
  const root = join(base, 'projetos')
  const dir = join(root, 'demo')
  mkdirSync(dir, { recursive: true })
  let project = writeDemoProject(dir)
  if (opts.project) {
    project = opts.project(project)
    writeFileSync(join(dir, 'project.json'), serializeProject(project))
  }
  const logger = createMemoryLogger()
  const env: NodeJS.ProcessEnv = { ...process.env, [ENV_PROJECTS_DIR]: root, TOMADA_LLM: opts.llm ?? 'mock' }
  if (opts.responses) {
    const file = join(base, 'respostas.json')
    writeFileSync(file, JSON.stringify(opts.responses))
    env.TOMADA_LLM_RESPONSES = file
  }
  const state = await createAppState({ file: join(base, 'settings.json'), env, logger })
  const store = createProjectStore({ root: () => state.projectsRoot(), logger, trash: async () => undefined, openFolder: async () => undefined })
  const transcription = createTranscriptionService({ logger, engine: createMockTranscriber({ ready: true }), read: (id) => store.read(id), vocabulary: () => [], emit: () => undefined })
  const llm = createLlmManager({ env, getPrefs: () => state.llmPrefs(), savePrefs: (patch) => state.updateLlmPrefs(patch), vault: fakeVault, scratchDir: '', logger })
  const deps: HandlerDeps = {
    info: { name: 'Tomada', version: '0.0.0', platform: 'win32', electron: '40', userDataDir: base, logsDir: base },
    state,
    store,
    logger,
    pickFolder: async () => null,
    pickFfmpeg: async () => null,
    recording: createIdleRecordingService(),
    exporter: createIdleExportService(),
    derived: { peaks: async () => null, previewAudio: async () => null, thumbs: async () => null, levels: async () => null, idle: async () => undefined, shutdown: () => undefined },
    transcription,
    llm,
    outputDirs: createOutputDirs(),
    pickExportDir: async () => null,
    pickImage: async () => null,
    openPath: async () => undefined,
    revealPath: async () => undefined,
    copyText: () => undefined,
    finishCountdown: () => undefined,
    clock: () => 0
  }
  return { handlers: createHandlers(deps), dir, project, logger }
}

describe('IA: cortes verticais (canal ai:clips)', () => {
  it('com a IA, devolve os cortes conferidos contra a transcrição e diz o que descartou e por quê', async () => {
    const { handlers } = await build({
      responses: [
        {
          task: 'clips',
          match: 'Frases:',
          response: {
            clips: [
              item(10, 16, { title: 'Agende em três cliques', score: 90 }),
              item(17, 22, { title: 'Lembrete automático no WhatsApp', hook: 'Os lembretes saem sozinhos', score: 78 }),
              item(4, 5, { title: 'Curto demais' }),
              item(10, 16, { title: 'Repetido', score: 40 }),
              { title: 'Sem trechos' }
            ]
          }
        }
      ]
    })
    const r = await handlers['ai:clips']('demo', 'auto')
    expect(r.source).toBe('ai')
    expect(r.notice).toBeNull()
    expect(r.clips.map((c) => [c.title, c.score, c.source])).toEqual([['Agende em três cliques', 90, 'ai'], ['Lembrete automático no WhatsApp', 78, 'ai']])
    expect(r.clips[0]!.ranges[0]!.start).toBeLessThanOrEqual(demo.sentences[10]!.startMs)
    expect(r.dropped.map((d) => d.title).sort()).toEqual(['Corte 5', 'Curto demais', 'Repetido'])
    expect(r.dropped.find((d) => d.title === 'Curto demais')!.why).toMatch(/precisa ficar entre 25 e 65 s/)
    expect(r.dropped.find((d) => d.title === 'Repetido')!.why).toBe('repete o corte «Agende em três cliques»')
  })

  it('só vai TEXTO para a IA: frases com número de palavra, tempo e atividade; nada de caminho, tela ou áudio', async () => {
    const seen: { task: string; system: string; prompt: string }[] = []
    const provider = createMockProvider({ recorded: [{ task: 'clips', match: '', response: { clips: [] } }], onAsk: (r) => seen.push(r) })
    const r = await suggestClips({ provider, words: demo.words, durationMs, cuts: [], clicks: demo.clicks, keys: demo.keys })
    expect(r).toEqual({ clips: [], dropped: [] })
    expect(seen).toHaveLength(1)
    const text = `${seen[0]!.system}\n${seen[0]!.prompt}`
    expect(seen[0]!.task).toBe('clips')
    expect(seen[0]!.prompt).toContain('Agora vamos agendar um horário.')
    expect(seen[0]!.prompt).toMatch(/\[\d+-\d+\] \d+:\d\d–\d+:\d\d · \d+,\d s · .* · /)
    expect(text).not.toMatch(/[A-Za-z]:\\|tomada-media|\.mp4|\.wav|\.jsonl|media\//)
    expect(text).not.toMatch(/claude|anthropic|openai|gpt/i)
  })

  it('sem IA (TOMADA_LLM=off): usa a heurística e explica o motivo e como ligar a IA, sem nome de fornecedor', async () => {
    const { handlers } = await build({ llm: 'off' })
    const r = await handlers['ai:clips']('demo', 'auto')
    expect(r.source).toBe('heuristic')
    expect(r.clips.length).toBeGreaterThanOrEqual(2)
    for (const c of r.clips) {
      expect(c.source).toBe('heuristic')
      expect(c.hook.split(' ').length).toBeLessThanOrEqual(8)
    }
    expect(r.notice).toMatch(/^Sem IA: usei a heurística/)
    expect(r.notice).toMatch(/Ajustes → IA/)
    expect(r.notice).not.toMatch(/claude|anthropic|openai|gpt/i)
  })

  it('a pessoa pode pedir a heurística mesmo com IA, e aí não há aviso de IA indisponível', async () => {
    const { handlers } = await build()
    const r = await handlers['ai:clips']('demo', 'heuristic')
    expect(r.source).toBe('heuristic')
    expect(r.notice).toBeNull()
    expect(r.clips.length).toBeGreaterThanOrEqual(2)
  })

  it('não repete o que o projeto já tem: um corte existente tira o igual da lista nova', async () => {
    const first = await (await build({ llm: 'off' })).handlers['ai:clips']('demo', 'auto')
    const existing: Clip = { id: 'clip-1', title: first.clips[0]!.title, hook: '', ranges: first.clips[0]!.ranges, score: 50, reason: '', format: 'vertical', layoutV: 'auto' }
    const { handlers } = await build({ llm: 'off', project: (p) => ({ ...p, clips: [existing] }) })
    const again = await handlers['ai:clips']('demo', 'auto')
    expect(again.clips.every((c) => c.ranges[0]!.start !== existing.ranges[0]!.start)).toBe(true)
  })

  it('id de projeto com caminho é recusado; sem transcrição diz o que fazer; modo inventado é recusado', async () => {
    const { handlers, dir } = await build({ llm: 'off' })
    for (const bad of ['..', '../demo', 'C:\\Windows', '']) await expect(handlers['ai:clips'](bad, 'auto'), bad).rejects.toThrow()
    await expect(handlers['ai:clips']('demo', 'tudo' as never)).rejects.toThrow(/Modo de sugestão inválido/)
    const { rmSync } = await import('node:fs')
    rmSync(join(dir, 'transcript.json'))
    await expect(handlers['ai:clips']('demo', 'auto')).rejects.toThrow(/Transcreva primeiro/)
  })

  it('resposta que não é JSON, duas vezes: erro visível, nada de corte inventado', async () => {
    const { handlers } = await build({ responses: [{ task: 'clips', match: '', response: 'isto não é JSON' }] })
    await expect(handlers['ai:clips']('demo', 'auto')).rejects.toThrow(/resposta que não consegui usar/)
  })
})

describe('IA: editar pedindo (canal ai:edit)', () => {
  it('devolve as operações CRUAS e a frase da IA; quem as valida e aplica é planAiEdit', async () => {
    const [from, to] = sentenceRange(demo, 4, 5)
    const ops = [{ op: 'cut', from, to }, { op: 'cut', from: 5, to: 99_999 }]
    const { handlers, project } = await build({ responses: [{ task: 'edit', match: 'Tira a parte do cadastro', response: { ops, reply: 'Cortei o cadastro.' } }] })
    const r = await handlers['ai:edit']('demo', 'Tira a parte do cadastro', 'horizontal')
    expect(r).toEqual({ ops, reply: 'Cortei o cadastro.' })
    const plan = planAiEdit({ project, words: demo.words, durationMs, format: 'horizontal', ops: r.ops, reply: r.reply })
    expect(plan.applied).toHaveLength(1)
    expect(plan.refused).toHaveLength(1)
  })

  it('o pedido leva o texto da pessoa e o formato; pedido vazio, longo demais ou formato inventado são recusados antes da IA', async () => {
    const seen: string[] = []
    const provider = createMockProvider({ recorded: [{ task: 'edit', match: '', response: { ops: [], reply: 'ok' } }], onAsk: (r) => seen.push(r.prompt) })
    const { project } = await build()
    await proposeEdit({ provider, instruction: 'Faz 3 cortes para TikTok', words: demo.words, project, format: 'vertical', durationMs, clicks: demo.clicks, keys: demo.keys })
    expect(seen[0]).toContain('Pedido da pessoa: "Faz 3 cortes para TikTok"')
    expect(seen[0]).toContain('formato aberto: 9:16 (vertical)')
    const { handlers } = await build()
    await expect(handlers['ai:edit']('demo', '   ', 'horizontal')).rejects.toThrow(/Escreva o que você quer mudar/)
    await expect(handlers['ai:edit']('demo', 'x'.repeat(2001), 'horizontal')).rejects.toThrow(/longo demais/)
    await expect(handlers['ai:edit']('demo', 'oi', 'quadrado' as never)).rejects.toThrow(/Formato inválido/)
    await expect(handlers['ai:edit']('..', 'oi', 'horizontal')).rejects.toThrow()
  })

  it('sem IA o pedido falha dizendo por quê e como ligar (sem nome de fornecedor); sem resposta de operações, a lista vem vazia', async () => {
    const off = await build({ llm: 'off' })
    const err = await off.handlers['ai:edit']('demo', 'tira o preço', 'horizontal').catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/A IA está desligada neste teste\. Para ligar a IA, instale o programa da IA neste computador ou cole uma chave em Ajustes → IA\./)
    expect((err as Error).message).not.toMatch(/claude|anthropic|openai|gpt/i)
    const quiet = await build()
    expect(await quiet.handlers['ai:edit']('demo', 'qualquer coisa', 'horizontal')).toEqual({ ops: [], reply: 'A IA de teste não propõe mudanças.' })
  })
})

describe('IA: publicação (canal ai:publish)', () => {
  const okResponse = {
    titles: ['Agendaí: agenda para barbearias em 3 minutos', 'Como agendar clientes sem planilha', 'Sistema de agenda para barbearia'],
    description: 'Veja o Agendaí em ação.\n00:00 Introdução',
    tags: ['agenda', 'barbearia', '#Sistema'],
    chapters: [
      { from: sentenceRange(demo, 3, 3)[0], title: 'Cadastro de clientes' },
      { from: sentenceRange(demo, 10, 10)[0], title: 'Agendar um horário' },
      { from: sentenceRange(demo, 17, 17)[0], title: 'Lembrete automático' },
      { from: sentenceRange(demo, 23, 23)[0], title: 'Relatório' }
    ],
    clips: [{ id: 'clip-1', caption: 'Agende sem planilha.', tiktok: ['agenda', 'barbearia'], reels: ['agenda'], shorts: ['agendamento'] }]
  }
  const withClip = (p: Project): Project => ({ ...p, clips: [{ id: 'clip-1', title: 'Agende em três cliques', hook: 'Agende sem planilha', ranges: [{ start: demo.sentences[10]!.startMs - 100, end: demo.sentences[16]!.endMs + 300 }], score: 80, reason: '', format: 'vertical', layoutV: 'auto' }] })

  it('devolve títulos, descrição sem horário, tags, capítulos válidos e o texto do corte', async () => {
    const { handlers } = await build({ responses: [{ task: 'publish', match: 'clip-1', response: okResponse }], project: withClip })
    const r = await handlers['ai:publish']('demo')
    expect(r.titles).toHaveLength(3)
    expect(r.description).toBe('Veja o Agendaí em ação.')
    expect(r.tags).toEqual(['agenda', 'barbearia', 'sistema'])
    expect(r.chapters.map((c) => c.title)).toEqual(['Introdução', 'Cadastro de clientes', 'Agendar um horário', 'Lembrete automático', 'Relatório'])
    expect(r.chapters[0]!.start).toBe(0)
    expect(r.clips['clip-1']).toEqual({ caption: 'Agende sem planilha.', tiktok: ['#agenda', '#barbearia'], reels: ['#agenda'], shorts: ['#agendamento', '#Shorts'] })
  })

  it('o pedido leva só texto: o resumo, os cortes e as frases com o tempo do vídeo final', async () => {
    const seen: string[] = []
    const provider = createMockProvider({ recorded: [{ task: 'publish', match: '', response: okResponse }], onAsk: (r) => seen.push(`${r.system}\n${r.prompt}`) })
    const { project } = await build({ project: withClip })
    await generatePublish({ provider, project: withClip(project), words: demo.words, durationMs, clips: withClip(project).clips })
    expect(seen[0]).toContain('- clip-1: "Agende em três cliques"')
    expect(seen[0]).toMatch(/\[\d+-\d+\] 00:\d\d–00:\d\d · Oi pessoal, tudo bem\?/)
    expect(seen[0]).not.toMatch(/[A-Za-z]:\\|tomada-media|\.mp4|\.wav|media\//)
    expect(seen[0]).not.toMatch(/claude|anthropic|openai|gpt/i)
  })

  it('resposta sem nenhum título é recusada com o motivo (a interface deixa tentar de novo)', async () => {
    const { handlers } = await build({ responses: [{ task: 'publish', match: '', response: { titles: [], description: 'x' } }] })
    await expect(handlers['ai:publish']('demo')).rejects.toThrow(/A IA não devolveu nenhum título\. Tente de novo\./)
  })

  it('com a IA de teste sem respostas gravadas devolve um texto mínimo e capítulos só com a introdução', async () => {
    const { handlers } = await build()
    const r = await handlers['ai:publish']('demo')
    expect(r.titles).toEqual(['Título de teste'])
    expect(r.chapters).toEqual([{ start: 0, title: 'Introdução' }])
  })
})
