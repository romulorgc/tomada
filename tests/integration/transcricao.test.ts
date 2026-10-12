/**
 * O serviço de transcrição (preparação retomável, fila de uma por vez, transcript.json dentro do projeto), o gerente
 * da IA (qual usar, a chave cifrada que nunca volta) e os canais de IPC da M3 com os serviços de verdade.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { IpcEvents } from '@shared/ipc'
import { DEFAULT_DICTIONARY } from '@shared/dictionary'
import { parseProject } from '@shared/project'
import { parseTranscript } from '@shared/transcript'
import type { PrepareSnapshot, TranscriptionJob } from '@shared/transcription'
import type { Project, Transcript } from '@shared/types'
import { createHandlers, type HandlerDeps } from '../../src/main/handlers'
import { createLlmManager } from '../../src/main/llm/manager'
import { createMemoryLogger } from '../../src/main/logger'
import { ENV_PROJECTS_DIR } from '../../src/main/paths'
import { createOutputDirs } from '../../src/main/path-guard'
import { createProjectStore } from '../../src/main/projects'
import { createAppState } from '../../src/main/state'
import { createMockTranscriber, MOCK_SENTENCE } from '../../src/main/transcription/mock'
import { createTranscriptionService, type TranscriptionService } from '../../src/main/transcription/service'
import type { Transcriber } from '../../src/main/transcription/types'
import { copyTree, FIX, useTmpDir } from '../helpers/env'
import { fakeVault, transcriptionDeps } from '../helpers/handler-extras'
import { createIdleExportService, createIdleRecordingService } from '../helpers/recording'

const tmp = useTmpDir()

// ---------------------------------------------------------------------------
// Serviço de transcrição

type Events = { prepare: PrepareSnapshot[]; jobs: TranscriptionJob[] }

function buildService(over: { engine?: Transcriber; ready?: boolean; failStep?: string; delayMs?: number; mutate?: (p: Project) => void } = {}) {
  const base = tmp()
  const dir = join(base, 'p1')
  copyTree(FIX.exemplo, dir)
  const dir2 = join(base, 'p2')
  copyTree(FIX.exemplo, dir2)
  const events: Events = { prepare: [], jobs: [] }
  const vocabulary: string[] = ['Kubernetes']
  const log = createMemoryLogger()
  const read = async (id: string): Promise<{ project: Project; dir: string }> => {
    const d = id === 'p1' ? dir : id === 'p2' ? dir2 : null
    if (!d) throw new Error(`Projeto não encontrado: ${id}`)
    const project = parseProject(readFileSync(join(d, 'project.json'), 'utf8'))
    over.mutate?.(project)
    return { project, dir: d }
  }
  const service: TranscriptionService = createTranscriptionService({
    logger: log,
    engine: over.engine ?? createMockTranscriber({ ready: over.ready ?? true, ...(over.failStep ? { failStep: over.failStep } : {}), stepMs: 20, ...(over.delayMs ? { delayMs: over.delayMs } : {}) }),
    read,
    vocabulary: () => vocabulary,
    emit: <K extends 'transcription:prepare' | 'transcription:job'>(channel: K, payload: IpcEvents[K]) => {
      if (channel === 'transcription:prepare') events.prepare.push(payload as PrepareSnapshot)
      else events.jobs.push(payload as TranscriptionJob)
    }
  })
  return { service, events, dir, dir2, base, log, vocabulary }
}

describe('serviço de transcrição: preparação', () => {
  it('motor sem preparar: o estado diz o que falta e transcrever é recusado com o motivo', async () => {
    const { service } = buildService({ ready: false })
    const view = await service.view()
    expect(view).toMatchObject({ engine: 'mock', state: 'missing', prepare: null, jobs: [] })
    expect(view.detail).toMatch(/preparada/)
    await expect(service.start('p1')).rejects.toThrow(/preparada/)
  })

  it('prepara com progresso real (passos, fração crescente), termina "pronta" e aí transcreve', async () => {
    const { service, events } = buildService({ ready: false })
    await service.prepare()
    await service.idle()
    const fractions = events.prepare.map((s) => s.fraction)
    expect(fractions.length).toBeGreaterThan(4)
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions) // nunca anda para trás
    expect(events.prepare.at(-1)).toMatchObject({ status: 'done', fraction: 1 })
    expect(events.prepare.some((s) => s.steps.some((st) => st.status === 'running'))).toBe(true)
    expect(await service.view()).toMatchObject({ state: 'ready' })
    await service.start('p1')
    await service.idle()
    expect(events.jobs.at(-1)).toMatchObject({ projectId: 'p1', state: 'done' })
  })

  it('falha num passo: erro visível com o passo; "tentar de novo" (outra preparação) conclui', async () => {
    const { service, events } = buildService({ ready: false, failStep: 'model' })
    await service.prepare()
    await service.idle()
    const failed = events.prepare.at(-1)!
    expect(failed.status).toBe('error')
    expect(failed.error).toMatchObject({ step: 'model' })
    expect(failed.error!.message).toMatch(/Falha simulada/)
    const view = await service.view()
    expect(view.state).toBe('error')
    expect(view.detail).toMatch(/Falha simulada/)
    // tentar de novo: a falha simulada acontece uma vez só
    await service.prepare()
    await service.idle()
    expect(events.prepare.at(-1)!.status).toBe('done')
    expect((await service.view()).state).toBe('ready')
  })

  it('cancelar a preparação: estado "cancelled", sem fingir que ficou pronto', async () => {
    const { service, events } = buildService({ ready: false })
    await service.prepare()
    service.cancelPrepare()
    await service.idle()
    expect(events.prepare.at(-1)!.status).toBe('cancelled')
    expect((await service.view()).state).toBe('missing')
  })

  it('pedir a preparação duas vezes seguidas não abre duas', async () => {
    const { service, events } = buildService({ ready: false })
    await Promise.all([service.prepare(), service.prepare()])
    await service.idle()
    const starts = events.prepare.filter((s) => s.fraction === 0 && s.steps.every((st) => st.status === 'pending'))
    expect(starts).toHaveLength(1)
  })
})

describe('serviço de transcrição: fila e arquivo', () => {
  it('grava transcript.json DENTRO do projeto, com palavras em ms, e lê de volta', async () => {
    const { service, dir } = buildService()
    expect(await service.getTranscript('p1')).not.toBeNull() // o exemplo já tem uma (de teste)
    await service.start('p1')
    await service.idle()
    const file = join(dir, 'transcript.json')
    const t = parseTranscript(readFileSync(file, 'utf8'))
    expect(t.engine).toBe('teste')
    expect(t.words.map((w) => w.text).join(' ')).toBe(MOCK_SENTENCE)
    expect(t.words.every((w, i) => w.i === i && Number.isInteger(w.start) && w.end > w.start)).toBe(true)
    expect(await service.getTranscript('p1')).toEqual(t)
  })

  it('projeto sem transcript.json: getTranscript devolve null (não é erro)', async () => {
    const { service, dir } = buildService()
    const { rmSync } = await import('node:fs')
    rmSync(join(dir, 'transcript.json'))
    expect(await service.getTranscript('p1')).toBeNull()
  })

  it('transcript.json quebrado: erro visível com o motivo (não devolve vazio)', async () => {
    const { service, dir } = buildService()
    writeFileSync(join(dir, 'transcript.json'), '{ isto não é json')
    await expect(service.getTranscript('p1')).rejects.toThrow()
    writeFileSync(join(dir, 'transcript.json'), JSON.stringify({ words: 'nada' }))
    await expect(service.getTranscript('p1')).rejects.toThrow(/inválido/)
  })

  it('projeto que não existe: erro, sem criar nada', async () => {
    const { service, base } = buildService()
    await expect(service.start('nao-existe')).rejects.toThrow(/não encontrado/i)
    await expect(service.getTranscript('nao-existe')).rejects.toThrow()
    expect(existsSync(join(base, 'nao-existe'))).toBe(false)
  })

  it('o motor recebe o dicionário, o deslocamento da voz e a duração; o áudio é o do projeto', async () => {
    const seen: { wav: string; vocabulary?: readonly string[]; offsetMs?: number; audioMs?: number; language?: string }[] = []
    const engine: Transcriber = {
      id: 'mock',
      check: async () => ({ state: 'ready', detail: null, device: null }),
      prepare: async () => undefined,
      transcribe: async (wav, o) => {
        seen.push({ wav, ...(o?.vocabulary ? { vocabulary: o.vocabulary } : {}), ...(o?.offsetMs !== undefined ? { offsetMs: o.offsetMs } : {}), ...(o?.audioMs !== undefined ? { audioMs: o.audioMs } : {}), ...(o?.language ? { language: o.language } : {}) })
        return { engine: 'x', model: 'x', language: 'pt', durationMs: 1000, words: [{ i: 0, text: 'oi', start: 0, end: 500, prob: 1, kind: 'word' }], segments: [], vad: [], createdAt: '' }
      }
    }
    const { service, dir } = buildService({ engine, mutate: (p) => void (p.sync.cameraOffsetMs = 123) })
    await service.start('p1')
    await service.idle()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ vocabulary: ['Kubernetes'], offsetMs: 123, language: 'pt' })
    expect(seen[0]!.wav.endsWith(join('media', 'voice.wav'))).toBe(true)
    expect(seen[0]!.wav.toLowerCase().startsWith(realpathSync.native(dir).toLowerCase())).toBe(true) // o caminho do motor é o real (sem atalhos)
    expect(seen[0]!.audioMs).toBeGreaterThan(20_000)
  })

  it('uma transcrição por vez: a segunda espera na fila e roda depois', async () => {
    const { service, events } = buildService({ delayMs: 300 })
    await service.start('p1')
    await service.start('p2')
    const view = await service.view()
    expect(view.jobs.find((j) => j.projectId === 'p1')!.state).toMatch(/queued|running/)
    expect(view.jobs.find((j) => j.projectId === 'p2')!.state).toBe('queued')
    await service.idle()
    const order = events.jobs.filter((j) => j.state === 'running' || j.state === 'done').map((j) => `${j.projectId}:${j.state}`)
    const firstDone = order.indexOf('p1:done')
    const secondRunning = order.indexOf('p2:running')
    expect(firstDone).toBeGreaterThan(-1)
    expect(secondRunning).toBeGreaterThan(firstDone) // p2 só começa depois que p1 acabou
    expect(events.jobs.at(-1)).toMatchObject({ projectId: 'p2', state: 'done' })
  })

  it('pedir de novo o que já está na fila não duplica', async () => {
    const { service, events } = buildService({ delayMs: 200 })
    await service.start('p1')
    await service.start('p1')
    await service.idle()
    expect(events.jobs.filter((j) => j.state === 'queued' && j.projectId === 'p1')).toHaveLength(1)
  })

  it('cancelar um da fila: nunca roda; cancelar o que roda: "cancelled" e nenhum arquivo novo', async () => {
    const { service, events, dir, dir2 } = buildService({ delayMs: 600 })
    const { rmSync } = await import('node:fs')
    rmSync(join(dir, 'transcript.json'))
    rmSync(join(dir2, 'transcript.json'))
    await service.start('p1')
    await service.start('p2')
    service.cancel('p2')
    await new Promise((r) => setTimeout(r, 100))
    service.cancel('p1')
    await service.idle()
    expect(events.jobs.filter((j) => j.projectId === 'p2').map((j) => j.state)).toEqual(['queued', 'cancelled'])
    expect(events.jobs.at(-1)).toMatchObject({ projectId: 'p1', state: 'cancelled' })
    expect(existsSync(join(dir, 'transcript.json'))).toBe(false)
    expect(existsSync(join(dir2, 'transcript.json'))).toBe(false)
  })

  it('voz que aponta para fora da pasta do projeto: o trabalho falha com o motivo e nada é escrito', async () => {
    const { service, events, dir, base } = buildService({ mutate: (p) => void (p.sources.voice!.path = '../fora/voz.wav') })
    const { rmSync } = await import('node:fs')
    rmSync(join(dir, 'transcript.json'))
    mkdirSync(join(base, 'fora'))
    writeFileSync(join(base, 'fora', 'voz.wav'), 'x')
    await service.start('p1')
    await service.idle()
    const last = events.jobs.at(-1)!
    expect(last.state).toBe('error')
    expect(last.error).toMatch(/fora da pasta/)
    expect(existsSync(join(dir, 'transcript.json'))).toBe(false)
  })

  it('voz que passa por uma junção para fora da pasta também é barrada', async () => {
    const { service, events, dir, base } = buildService()
    const { rmSync } = await import('node:fs')
    rmSync(join(dir, 'transcript.json'))
    const fora = join(base, 'fora')
    mkdirSync(fora)
    writeFileSync(join(fora, 'voice.wav'), 'x')
    rmSync(join(dir, 'media'), { recursive: true, force: true })
    symlinkSync(fora, join(dir, 'media'), 'junction')
    await service.start('p1')
    await service.idle()
    expect(events.jobs.at(-1)).toMatchObject({ state: 'error' })
    expect(events.jobs.at(-1)!.error).toMatch(/fora da pasta/)
  })

  it('motor que falha: erro visível no trabalho e no log; a fila segue para o próximo', async () => {
    let calls = 0
    const engine: Transcriber = {
      id: 'mock',
      check: async () => ({ state: 'ready', detail: null, device: null }),
      prepare: async () => undefined,
      transcribe: async () => {
        calls++
        if (calls === 1) throw new Error('CUDA sem memória')
        return { engine: 'x', model: 'x', language: 'pt', durationMs: 1000, words: [], segments: [], vad: [], createdAt: '' }
      }
    }
    const { service, events, log } = buildService({ engine })
    await service.start('p1')
    await service.start('p2')
    await service.idle()
    expect(events.jobs.find((j) => j.projectId === 'p1' && j.state === 'error')!.error).toBe('CUDA sem memória')
    expect(events.jobs.at(-1)).toMatchObject({ projectId: 'p2', state: 'done' })
    expect(log.entries.some((e) => e.level === 'error')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Gerente da IA

function buildManager(over: { env?: NodeJS.ProcessEnv; cli?: string | null; prefs?: { provider?: 'auto' | 'cli' | 'api'; model?: string; apiKeyEnc?: string }; vaultOn?: boolean } = {}) {
  const prefs = { ...over.prefs }
  const saved: unknown[] = []
  const manager = createLlmManager({
    env: over.env ?? {},
    getPrefs: () => ({ ...prefs }),
    savePrefs: async (patch) => {
      saved.push(patch)
      if (patch.apiKeyEnc !== undefined) {
        if (patch.apiKeyEnc === '') delete prefs.apiKeyEnc
        else prefs.apiKeyEnc = patch.apiKeyEnc
      }
    },
    vault: over.vaultOn === false ? { ...fakeVault, available: () => false } : fakeVault,
    scratchDir: join(tmp(), 'trabalho'),
    logger: createMemoryLogger(),
    findClaude: () => (over.cli === undefined ? 'C:\\claude.exe' : over.cli)
  })
  return { manager, prefs, saved }
}

describe('gerente da IA', () => {
  it('automático: usa o programa deste computador quando existe; sem ele, a chave; sem nenhum, diz o que fazer', () => {
    expect(buildManager({ cli: 'C:\\claude.exe' }).manager.status()).toMatchObject({ provider: 'cli', available: true, cliFound: true })
    expect(buildManager({ cli: null, prefs: { apiKeyEnc: 'cifrado:x' } }).manager.status()).toMatchObject({ provider: 'api', available: true, hasKey: true })
    const none = buildManager({ cli: null }).manager.status()
    expect(none).toMatchObject({ provider: null, available: false })
    expect(none.detail).toMatch(/instale o programa ou cole uma chave/)
  })

  it('preferência fixa: só o programa, ou só a chave, sem trocar escondido', () => {
    expect(buildManager({ cli: null, prefs: { provider: 'cli', apiKeyEnc: 'cifrado:x' } }).manager.status()).toMatchObject({ provider: null, available: false })
    expect(buildManager({ cli: 'C:\\claude.exe', prefs: { provider: 'api' } }).manager.status()).toMatchObject({ provider: null, available: false })
    expect(buildManager({ cli: 'C:\\claude.exe', prefs: { provider: 'api', apiKeyEnc: 'cifrado:x' } }).manager.status()).toMatchObject({ provider: 'api', available: true })
  })

  it('a interface nunca vê o nome do fornecedor: a mensagem diz "IA"', () => {
    const texts = [
      buildManager({ cli: null }).manager.status().detail,
      buildManager({ cli: null, prefs: { provider: 'cli' } }).manager.status().detail,
      buildManager({ cli: null, prefs: { provider: 'api' } }).manager.status().detail
    ].join(' ')
    expect(texts).not.toMatch(/claude|anthropic|openai|gpt|gemini/i)
  })

  it('guardar a chave: cifrada pelo cofre, nunca devolvida; apagar remove', async () => {
    const { manager, saved, prefs } = buildManager({ cli: null })
    const key = 'chave-de-teste-falsa-abcdef'
    const status = await manager.setKey(`  ${key}  `)
    expect(JSON.stringify(status)).not.toContain(key)
    expect(status).toMatchObject({ hasKey: true, provider: 'api', available: true })
    expect(JSON.stringify(saved)).not.toContain(key)
    expect(prefs.apiKeyEnc).toBe(`cifrado:${[...key].reverse().join('')}`)
    const cleared = await manager.clearKey()
    expect(cleared).toMatchObject({ hasKey: false, available: false })
    expect(prefs.apiKeyEnc).toBeUndefined()
  })

  it('chave que não parece chave, ou cofre indisponível: recusa com o motivo e não guarda nada', async () => {
    const { manager, saved } = buildManager({ cli: null })
    for (const bad of ['curta', 'tem espaço dentro da chave 123456', 'com\nquebra-de-linha-1234567890', '', 'a'.repeat(401)]) {
      await expect(manager.setKey(bad), JSON.stringify(bad.slice(0, 12))).rejects.toThrow(/não parece válida/)
    }
    await expect(manager.setKey(123 as never)).rejects.toThrow(/não parece válida/)
    const off = buildManager({ cli: null, vaultOn: false })
    await expect(off.manager.setKey('chave-de-teste-falsa')).rejects.toThrow(/com segurança/)
    expect(saved).toEqual([])
    expect(off.saved).toEqual([])
  })

  it('TOMADA_LLM=mock usa as respostas gravadas; =off desliga mesmo com o programa instalado', async () => {
    const mock = buildManager({ env: { TOMADA_LLM: 'mock' } }).manager
    expect(mock.status()).toMatchObject({ provider: 'mock', available: true })
    // sem resposta gravada para o teste de "ok", a IA de teste devolve a lista vazia dos recomeços: não é o formato pedido, e isso aparece
    expect(await mock.test()).toEqual({ ok: false, message: expect.stringMatching(/resposta que não consegui usar/) })
    const off = buildManager({ env: { TOMADA_LLM: 'off' }, cli: 'C:\\claude.exe' }).manager
    expect(off.status()).toMatchObject({ provider: null, available: false })
    expect(off.provider()).toBeNull()
    expect(await off.test()).toMatchObject({ ok: false })
  })
})

// ---------------------------------------------------------------------------
// IPC da M3, com os serviços de verdade

async function buildIpc() {
  const base = tmp()
  const root = join(base, 'projetos')
  const dir = join(root, 'exemplo')
  copyTree(FIX.exemplo, dir)
  const logger = createMemoryLogger()
  const file = join(base, 'settings.json')
  const state = await createAppState({ file, env: { ...process.env, [ENV_PROJECTS_DIR]: root }, logger })
  const store = createProjectStore({ root: () => state.projectsRoot(), logger, trash: async () => undefined, openFolder: async () => undefined })
  const outputDirs = createOutputDirs()
  const deps: HandlerDeps = {
    info: { name: 'Tomada', version: '0.0.0', platform: 'win32', electron: '40', userDataDir: base, logsDir: base },
    state,
    store,
    logger,
    pickFolder: async () => null,
    pickFfmpeg: async () => null,
    recording: createIdleRecordingService(),
    exporter: createIdleExportService(),
    derived: { peaks: async () => null, previewAudio: async () => null, thumbs: async () => null, levels: async () => null, cropSuggest: async () => null, idle: async () => undefined, shutdown: () => undefined },
    ...transcriptionDeps({ state, store, logger }),
    outputDirs,
    pickExportDir: async () => null,
    pickImage: async () => null,
    openPath: async () => undefined,
    revealPath: async () => undefined,
    copyText: () => undefined,
    finishCountdown: () => undefined,
    clock: () => 0
  }
  return { handlers: createHandlers(deps), file, root, dir, state }
}

describe('IPC da transcrição e da IA', () => {
  it('a chave da IA nunca volta pela ponte e fica cifrada em disco', async () => {
    const { handlers, file } = await buildIpc()
    const key = 'chave-de-teste-falsa-abcdef'
    const after = await handlers['llm:set-key'](key)
    expect(after).toMatchObject({ hasKey: true })
    const surfaces = [
      after,
      await handlers['llm:status'](),
      await handlers['settings:get'](),
      await handlers['settings:update']({}),
      await handlers['transcription:get-prefs'](),
      await handlers['dictionary:get']()
    ]
    for (const s of surfaces) {
      expect(JSON.stringify(s)).not.toContain(key)
      expect(JSON.stringify(s)).not.toContain('apiKeyEnc')
      expect(JSON.stringify(s)).not.toContain('cifrado:')
    }
    const onDisk = readFileSync(file, 'utf8')
    expect(onDisk).not.toContain(key)
    expect(onDisk).toContain('apiKeyEnc') // guardada, mas só cifrada
    expect(await handlers['llm:clear-key']()).toMatchObject({ hasKey: false })
    expect(readFileSync(file, 'utf8')).not.toContain('apiKeyEnc')
  })

  it('o renderer não consegue gravar a chave nem o dicionário pelo canal de ajustes gerais', async () => {
    const { handlers, file } = await buildIpc()
    await handlers['settings:update']({ llm: { apiKeyEnc: 'cifrado:invasor' }, dictionary: ['x'], transcription: { engine: 'whisper-cpp' } } as never)
    const onDisk = readFileSync(file, 'utf8')
    expect(onDisk).not.toContain('invasor')
    expect(await handlers['dictionary:get']()).toEqual(DEFAULT_DICTIONARY)
  })

  it('dicionário: limpa, sem repetido, e persiste na gravação do arquivo', async () => {
    const { handlers, file } = await buildIpc()
    const saved = await handlers['dictionary:set'](['  Kubernetes ', 'kubernetes', 'Tomada', '', 'a\u0000b', 'x'.repeat(200)])
    expect(saved).toEqual(['Kubernetes', 'Tomada', 'a b', 'x'.repeat(80)])
    expect(await handlers['dictionary:get']()).toEqual(saved)
    expect((JSON.parse(readFileSync(file, 'utf8')) as { dictionary: string[] }).dictionary).toEqual(saved)
    expect(await handlers['dictionary:set']('não é lista' as never)).toEqual([])
  })

  it('preferências da transcrição: só os dois booleanos entram; o resto é ignorado', async () => {
    const { handlers, state } = await buildIpc()
    expect(await handlers['transcription:get-prefs']()).toEqual({ auto: true, autoClean: true })
    expect(await handlers['transcription:set-prefs']({ auto: false, autoClean: 'sim', engine: 'x', extra: 1 } as never)).toEqual({ auto: false, autoClean: true })
    expect(state.transcriptionPrefs()).toEqual({ auto: false, autoClean: true })
    expect(await handlers['transcription:set-prefs'](undefined as never)).toEqual({ auto: false, autoClean: true })
  })

  it('só o id do projeto atravessa a ponte: id com caminho é recusado antes de tocar em disco', async () => {
    const { handlers, root } = await buildIpc()
    for (const bad of ['..', '../exemplo', 'exemplo/..', 'C:\\Windows', '', 'a\\b']) {
      await expect(handlers['transcript:get'](bad), bad).rejects.toThrow()
      await expect(handlers['transcription:start'](bad), bad).rejects.toThrow()
      await expect(handlers['transcription:cancel'](bad), bad).rejects.toThrow()
      await expect(handlers['ai:retakes'](bad), bad).rejects.toThrow()
    }
    expect(existsSync(join(root, '..', 'transcript.json'))).toBe(false)
  })

  it('transcript:get devolve a transcrição do exemplo e ai:retakes valida o que a IA devolve', async () => {
    const { handlers } = await buildIpc()
    const t = (await handlers['transcript:get']('exemplo')) as Transcript
    expect(t.words).toHaveLength(36)
    const r = await handlers['ai:retakes']('exemplo')
    expect(r).toEqual({ retakes: [], dropped: 0 }) // IA de teste sem resposta gravada: lista vazia
  })

  it('ai:retakes sem transcrição diz o que fazer; com IA desligada diz o motivo (sem nome de fornecedor)', async () => {
    const a = await buildIpc()
    const { rmSync } = await import('node:fs')
    rmSync(join(a.dir, 'transcript.json'))
    await expect(a.handlers['ai:retakes']('exemplo')).rejects.toThrow(/Transcreva primeiro/)
  })

  it('llm:set-prefs valida a escolha', async () => {
    const { handlers } = await buildIpc()
    await expect(handlers['llm:set-prefs']({ provider: 'outro' } as never)).rejects.toThrow(/inválida/)
    await expect(handlers['llm:set-prefs']({ model: 5 } as never)).rejects.toThrow(/inválido/)
    expect(await handlers['llm:set-prefs']({ provider: 'api' })).toMatchObject({ preference: 'api' })
  })

  it('a transcrição de teste prepara e transcreve pelos canais de IPC', async () => {
    const base = tmp()
    const root = join(base, 'projetos')
    copyTree(FIX.exemplo, join(root, 'exemplo'))
    const logger = createMemoryLogger()
    const state = await createAppState({ file: join(base, 's.json'), env: { ...process.env, [ENV_PROJECTS_DIR]: root }, logger })
    const store = createProjectStore({ root: () => state.projectsRoot(), logger, trash: async () => undefined, openFolder: async () => undefined })
    const extras = transcriptionDeps({ state, store, logger, ready: false })
    expect((await extras.transcription.view()).state).toBe('missing')
    await extras.transcription.prepare()
    await extras.transcription.idle()
    expect((await extras.transcription.view()).state).toBe('ready')
  })
})
