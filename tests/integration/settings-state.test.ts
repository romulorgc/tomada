import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHandlers } from '../../src/main/handlers'
import { createLogger, createMemoryLogger } from '../../src/main/logger'
import { ENV_PROJECTS_DIR, defaultProjectsDir } from '../../src/main/paths'
import { createOutputDirs } from '../../src/main/path-guard'
import { createProjectStore } from '../../src/main/projects'
import { loadSettings, saveSettings } from '../../src/main/settings'
import { createAppState } from '../../src/main/state'
import { locateFfmpeg } from '../../src/main/ffmpeg'
import { copyTree, FIX, useTmpDir } from '../helpers/env'
import { createIdleExportService, createIdleRecordingService } from '../helpers/recording'

const tmp = useTmpDir()

describe('settings.json', () => {
  it('arquivo ausente = padrões, sem erro', async () => {
    const log = createMemoryLogger()
    expect(await loadSettings(join(tmp(), 'settings.json'), log)).toEqual({})
    expect(log.entries).toEqual([])
  })

  it('ida e volta preserva campos desconhecidos (de versões futuras)', async () => {
    const file = join(tmp(), 'settings.json')
    await saveSettings(file, { projectsDir: 'D:\\Videos', ffmpegPath: 'C:\\ff', gravar: { fps: 60 } } as never)
    const back = await loadSettings(file, createMemoryLogger())
    expect(back).toMatchObject({ projectsDir: 'D:\\Videos', ffmpegPath: 'C:\\ff' })
    expect((back as Record<string, unknown>).gravar).toEqual({ fps: 60 })
  })

  it('arquivo quebrado: usa padrões, avisa no log e guarda o arquivo ruim', async () => {
    const dir = tmp()
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{ quebrado')
    const log = createMemoryLogger()
    expect(await loadSettings(file, log)).toEqual({})
    expect(log.entries.some((e) => e.level === 'warn')).toBe(true)
    expect(readdirSync(dir)).toContain('settings.json.invalido')
    expect(existsSync(file)).toBe(false)
  })

  it('campo com tipo errado também conta como inválido', async () => {
    const file = join(tmp(), 'settings.json')
    writeFileSync(file, JSON.stringify({ projectsDir: 42 }))
    const log = createMemoryLogger()
    expect(await loadSettings(file, log)).toEqual({})
    expect(log.entries.some((e) => e.level === 'warn')).toBe(true)
  })
})

describe('AppState', () => {
  const make = async (env: NodeJS.ProcessEnv = {}) => {
    const dir = tmp()
    const file = join(dir, 'settings.json')
    const log = createMemoryLogger()
    return { dir, file, log, state: await createAppState({ file, env, logger: log }) }
  }

  it('padrão: Videos\\Tomada do usuário', async () => {
    const { state } = await make()
    expect(state.view().effective).toEqual({ projectsDir: defaultProjectsDir(), projectsDirSource: 'default' })
  })

  it('escolher a pasta dos projetos: cria, grava no disco e passa a valer', async () => {
    const { state, file, dir } = await make()
    const novo = join(dir, 'meus projetos', 'v2')
    const view = await state.update({ projectsDir: novo })
    expect(view.effective).toEqual({ projectsDir: novo, projectsDirSource: 'settings' })
    expect(state.projectsRoot()).toBe(novo)
    expect(existsSync(novo)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).projectsDir).toBe(novo)
  })

  it('pasta relativa é recusada com mensagem clara e NADA é gravado', async () => {
    const { state, file } = await make()
    await expect(state.update({ projectsDir: 'pasta\\relativa' })).rejects.toThrow(/caminho completo/)
    expect(existsSync(file)).toBe(false)
    expect(state.settings()).toEqual({})
  })

  it('pasta impossível de criar é recusada (aqui: dentro de um arquivo)', async () => {
    const { state, dir } = await make()
    const arquivo = join(dir, 'arquivo.txt')
    writeFileSync(arquivo, 'x')
    await expect(state.update({ projectsDir: join(arquivo, 'filha') })).rejects.toThrow(/Não consegui usar a pasta/)
    expect(state.settings()).toEqual({})
  })

  it('ffmpeg em lugar errado é recusado; em lugar certo, aceito', async () => {
    const { state } = await make({ ...process.env })
    await expect(state.update({ ffmpegPath: join(tmp(), 'nao-tem-ffmpeg') })).rejects.toThrow(/Não encontrei o ffmpeg/)
    const real = locateFfmpeg()!
    const view = await state.update({ ffmpegPath: join(real.ffmpeg, '..') })
    expect(view.settings.ffmpegPath).toBe(join(real.ffmpeg, '..'))
    expect(state.ffmpegLocateOptions().custom).toBe(join(real.ffmpeg, '..'))
    // string vazia limpa e volta ao PATH
    const cleared = await state.update({ ffmpegPath: '' })
    expect(cleared.settings.ffmpegPath).toBeUndefined()
    expect(state.ffmpegLocateOptions().custom).toBeUndefined()
  })

  it('TOMADA_PROJECTS_DIR (testes) vence o ajuste, e o painel sabe disso', async () => {
    const { state, dir } = await make({ [ENV_PROJECTS_DIR]: 'E:\\tmp\\teste' })
    const view = await state.update({ projectsDir: join(dir, 'x') })
    expect(view.effective).toEqual({ projectsDir: 'E:\\tmp\\teste', projectsDirSource: 'env' })
  })

  it('o que foi gravado volta na próxima abertura do app', async () => {
    const { state, file, dir } = await make()
    await state.update({ projectsDir: join(dir, 'p') })
    const again = await createAppState({ file, env: {}, logger: createMemoryLogger() })
    expect(again.projectsRoot()).toBe(join(dir, 'p'))
  })

  it('patch com tipo errado é recusado', async () => {
    const { state } = await make()
    await expect(state.update({ projectsDir: 5 } as never)).rejects.toThrow()
  })

  it('preferências da tela Gravar: padrões, gravadas no disco, lembradas na próxima abertura e sem apagar os outros ajustes', async () => {
    const { state, file, dir } = await make()
    expect(state.recordPrefs()).toMatchObject({ mode: 'screen-camera', fps: 30, systemAudio: false, hideCursor: true, setupDone: false, sourceId: null })
    await state.update({ projectsDir: join(dir, 'p') })
    const saved = await state.updateRecordPrefs({ mode: 'screen', fps: 60, cameraId: 'cam-7', micId: 'mic-3', systemAudio: true, setupDone: true })
    expect(saved).toMatchObject({ mode: 'screen', fps: 60, cameraId: 'cam-7', micId: 'mic-3', systemAudio: true, setupDone: true })
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { projectsDir?: string; record?: Record<string, unknown> }
    expect(onDisk.projectsDir).toBe(join(dir, 'p')) // não derrubou o ajuste vizinho
    expect(onDisk.record).toMatchObject({ mode: 'screen', fps: 60, cameraId: 'cam-7' })

    const again = await createAppState({ file, env: {}, logger: createMemoryLogger() })
    expect(again.recordPrefs()).toEqual(saved)
    expect(again.projectsRoot()).toBe(join(dir, 'p'))
    // Trocar a pasta dos projetos depois também não derruba as preferências.
    await again.update({ projectsDir: join(dir, 'q') })
    expect(again.recordPrefs()).toEqual(saved)
    expect((JSON.parse(readFileSync(file, 'utf8')) as { record?: unknown }).record).toBeDefined()
    // Atualização parcial mescla com o que já estava.
    const merged = await again.updateRecordPrefs({ fps: 30 })
    expect(merged).toMatchObject({ mode: 'screen', fps: 30, cameraId: 'cam-7' })
  })

  it('mudanças quase juntas não se apagam: a tela Gravar manda um pedido por controle, sem esperar o anterior', async () => {
    const { state, file, dir } = await make()
    const novaPasta = join(dir, 'concorrente')
    // Tudo disparado no mesmo tique, como a interface faz ao abrir (escolhe câmera, microfone, tela…).
    const results = await Promise.all([
      state.updateRecordPrefs({ mode: 'screen' }),
      state.updateRecordPrefs({ fps: 60 }),
      state.update({ projectsDir: novaPasta }),
      state.updateRecordPrefs({ cameraId: 'cam-1' }),
      state.updateRecordPrefs({ micId: 'mic-1' }),
      state.updateRecordPrefs({ systemAudio: true }),
      state.updateRecordPrefs({ sourceId: 'screen:1:0', sourceName: 'Tela 1' })
    ])
    expect(results).toHaveLength(7)
    const expected = { mode: 'screen', fps: 60, cameraId: 'cam-1', micId: 'mic-1', systemAudio: true, sourceId: 'screen:1:0', sourceName: 'Tela 1' }
    expect(state.recordPrefs()).toMatchObject(expected)
    expect(state.settings().projectsDir).toBe(novaPasta)
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { projectsDir?: string; record?: Record<string, unknown> }
    expect(onDisk.projectsDir).toBe(novaPasta)
    expect(onDisk.record).toMatchObject(expected)
    const again = await createAppState({ file, env: {}, logger: createMemoryLogger() })
    expect(again.recordPrefs()).toMatchObject(expected)
  })

  it('um pedido recusado não trava a fila: o seguinte ainda é gravado', async () => {
    const { state } = await make()
    const [bad, good] = await Promise.allSettled([state.update({ projectsDir: 'relativa' }), state.updateRecordPrefs({ fps: 60 })])
    expect(bad.status).toBe('rejected')
    expect(good.status).toBe('fulfilled')
    expect(state.recordPrefs().fps).toBe(60)
  })

  it('preferência estragada no disco (tipo errado, valor fora da lista) volta ao padrão campo a campo, sem derrubar o app', async () => {
    const dir = tmp()
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ record: { mode: 'holograma', fps: 144, systemAudio: 'sim', cameraId: 'cam-ok', sourceId: 42, futuro: true } }))
    const state = await createAppState({ file, env: {}, logger: createMemoryLogger() })
    expect(state.recordPrefs()).toMatchObject({ mode: 'screen-camera', fps: 30, systemAudio: false, cameraId: 'cam-ok', sourceId: null })
    writeFileSync(file, JSON.stringify({ record: 'lixo' }))
    const lixo = await createAppState({ file, env: {}, logger: createMemoryLogger() })
    expect(lixo.recordPrefs().mode).toBe('screen-camera')
  })
})

/** O que o editor (M2b) pede ao main: mídias derivadas, diálogos, abrir/mostrar arquivo e área de transferência. */
function editorDeps(over: { image?: string | null } = {}) {
  const calls: string[] = []
  return {
    calls,
    derived: { peaks: async () => null, previewAudio: async () => null, thumbs: async () => null, idle: async () => undefined, shutdown: () => undefined },
    pickExportDir: async () => null,
    outputDirs: createOutputDirs(),
    pickImage: async () => over.image ?? null,
    openPath: async (path: string) => void calls.push(`open ${path}`),
    revealPath: async (path: string) => void calls.push(`reveal ${path}`),
    copyText: (text: string) => void calls.push(`copy ${text}`)
  }
}

describe('handlers de IPC (contrato completo, sem Electron)', () => {
  async function build(over: { image?: string | null } = {}) {
    const dir = tmp()
    const root = join(dir, 'projetos')
    copyTree(FIX.exemplo, join(root, 'exemplo'))
    const log = createMemoryLogger()
    const state = await createAppState({ file: join(dir, 'settings.json'), env: { ...process.env, [ENV_PROJECTS_DIR]: root }, logger: log })
    const store = createProjectStore({ root: () => state.projectsRoot(), logger: log, trash: async () => {}, openFolder: async () => {} })
    const extras = editorDeps(over)
    const calls = extras.calls
    const handlers = createHandlers({
      info: { name: 'Tomada', version: '0.0.0', platform: 'win32', electron: '40.9.3', userDataDir: dir, logsDir: dir },
      state,
      store,
      logger: log,
      pickFolder: async () => null,
      pickFfmpeg: async () => null,
      recording: createIdleRecordingService(),
      exporter: createIdleExportService(),
      ...extras,
      finishCountdown: () => undefined,
      clock: () => 0
    })
    return { handlers, state, root, calls }
  }

  it('lista, detalha e renomeia por IPC', async () => {
    const { handlers } = await build()
    const list = await handlers['projects:list']()
    expect(list.map((p) => p.id)).toEqual(['exemplo'])
    expect((await handlers['projects:get']('exemplo')).media.screen?.url).toContain('tomada-media://project/exemplo/media/screen.mp4')
    expect((await handlers['projects:rename']('exemplo', 'Outro nome')).title).toBe('Outro nome')
  })

  it('projects:save valida o documento, grava por inteiro e devolve o que gravou; documento inválido não toca o arquivo', async () => {
    const { handlers, root } = await build()
    const file = join(root, 'exemplo', 'project.json')
    const project = (await handlers['projects:get']('exemplo')).project
    const saved = await handlers['projects:save']('exemplo', { ...project, title: 'Salvo pelo editor' })
    expect(saved.title).toBe('Salvo pelo editor')
    expect(JSON.parse(readFileSync(file, 'utf8')).title).toBe('Salvo pelo editor')
    const before = readFileSync(file, 'utf8')
    await expect(handlers['projects:save']('exemplo', { ...project, style: 'isto não é um estilo' } as never)).rejects.toThrow()
    await expect(handlers['projects:save']('exemplo', { ...project, cuts: [{ id: 'x', start: 'a' }] } as never)).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readdirSync(join(root, 'exemplo')).filter((n) => n.endsWith('.tmp'))).toEqual([])
    await expect(handlers['projects:save']('../fora', project)).rejects.toThrow(/inválido/)
  })

  it('projects:pick-background copia a imagem escolhida para media/ e devolve o caminho; cancelar devolve null; arquivo que não é imagem falha', async () => {
    const dir = tmp()
    const png = join(dir, 'fundo.png')
    writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'))
    const ok = await (async () => {
      const { handlers, root } = await build({ image: png })
      const rel = await handlers['projects:pick-background']('exemplo')
      return { rel, root }
    })()
    expect(ok.rel).toMatch(/^media\/fundo-[0-9a-f]{8}\.png$/)
    expect(existsSync(join(ok.root, 'exemplo', ok.rel!))).toBe(true)

    const cancelled = await build({ image: null })
    expect(await cancelled.handlers['projects:pick-background']('exemplo')).toBeNull()

    const txt = join(dir, 'nota.txt')
    writeFileSync(txt, 'oi')
    const bad = await build({ image: txt })
    await expect(bad.handlers['projects:pick-background']('exemplo')).rejects.toThrow(/PNG, JPG ou WebP/)
  })

  it('files:open, files:reveal e clipboard:write só aceitam o que é seguro', async () => {
    const { handlers, calls, root } = await build()
    const abs = join(root, 'exemplo', 'media', 'screen.mp4') // mídia dentro da pasta dos projetos
    await handlers['files:open'](abs)
    await handlers['files:reveal'](abs)
    await handlers['clipboard:write'](abs)
    expect(calls).toEqual([`open ${abs}`, `reveal ${abs}`, `copy ${abs}`])
    // o registro de IPC embrulha tudo em async: aqui também, para o erro chegar como rejeição
    const asyncCall = async <T,>(fn: () => T): Promise<Awaited<T>> => await fn()
    await expect(asyncCall(() => handlers['files:open']('relativo/video.mp4'))).rejects.toThrow(/caminho completo/)
    await expect(asyncCall(() => handlers['files:reveal']('..\\video.mp4'))).rejects.toThrow(/caminho completo/)
    await expect(handlers['clipboard:write']('x'.repeat(10_001))).rejects.toThrow(/Texto inválido/)
    await expect(handlers['clipboard:write'](42 as never)).rejects.toThrow(/Texto inválido/)
    expect(calls).toHaveLength(3)
  })

  it('export:pick-dir e derived:* passam pelo contrato', async () => {
    const { handlers } = await build()
    expect(await handlers['export:pick-dir']('C:\qualquer')).toBeNull()
    expect(await handlers['derived:peaks']('exemplo')).toBeNull()
    expect(await handlers['derived:preview-audio']('exemplo')).toBeNull()
    expect(await handlers['derived:thumbs']('exemplo')).toBeNull()
  })

  it('ffmpeg:status acha o ffmpeg e traz a versão', async () => {
    const { handlers } = await build()
    const status = await handlers['ffmpeg:status']()
    expect(status.found).toBe(true)
    expect(status.error).toBeNull()
    expect(status.version).toMatch(/^\S+$/)
    expect(status.ffprobeVersion).toMatch(/^\S+$/)
    expect(status.source).toBe('path')
  })

  it('ffmpeg:test roda de verdade e libx264 passa', async () => {
    const { handlers } = await build()
    const result = await handlers['ffmpeg:test']()
    expect(result.ok).toBe(true)
    expect(result.error).toBeNull()
    expect(result.encoders.libx264).toBe(true)
    expect(result.steps.length).toBeGreaterThanOrEqual(4)
    expect(result.steps.find((s) => s.label.includes('libx264'))?.ok).toBe(true)
  })

  it('ffmpeg:status com ajuste errado diz o que fazer, em vez de cair em silêncio no PATH', async () => {
    const dir = tmp()
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ ffmpegPath: join(dir, 'sumiu') }))
    const log = createMemoryLogger()
    const state = await createAppState({ file, env: {}, logger: log })
    const store = createProjectStore({ root: () => state.projectsRoot(), logger: log, trash: async () => {}, openFolder: async () => {} })
    const handlers = createHandlers({
      info: { name: 'T', version: '0', platform: 'win32', electron: '0', userDataDir: dir, logsDir: dir },
      state,
      store,
      logger: log,
      pickFolder: async () => null,
      pickFfmpeg: async () => null,
      recording: createIdleRecordingService(),
      exporter: createIdleExportService(),
      ...editorDeps(),
      finishCountdown: () => undefined,
      clock: () => 0
    })
    const status = await handlers['ffmpeg:status']()
    expect(status.found).toBe(false)
    expect(status.error).toMatch(/Não encontrei o ffmpeg e o ffprobe em/)
    const test = await handlers['ffmpeg:test']()
    expect(test.ok).toBe(false)
  })
})

describe('createLogger', () => {
  it('escreve linhas datadas em tomada-AAAA-MM-DD.log, com o detalhe do erro', () => {
    const dir = join(tmp(), 'logs')
    const log = createLogger(dir)
    log.info('olá', { a: 1 })
    log.error('quebrou', new Error('motivo X'))
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^tomada-\d{4}-\d{2}-\d{2}\.log$/)
    const text = readFileSync(join(dir, files[0]!), 'utf8')
    expect(text).toMatch(/\[info\] olá \| \{"a":1\}/)
    expect(text).toMatch(/\[error\] quebrou \| Error: motivo X/)
  })

  it('nunca lança, nem com a pasta de log impossível', () => {
    const dir = tmp()
    const arquivo = join(dir, 'arquivo')
    writeFileSync(arquivo, 'x')
    const log = createLogger(join(arquivo, 'logs'), { echo: true })
    expect(() => log.error('sem lugar para escrever')).not.toThrow()
  })
})
