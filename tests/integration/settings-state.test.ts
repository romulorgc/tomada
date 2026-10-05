import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHandlers } from '../../src/main/handlers'
import { createLogger, createMemoryLogger } from '../../src/main/logger'
import { ENV_PROJECTS_DIR, defaultProjectsDir } from '../../src/main/paths'
import { createProjectStore } from '../../src/main/projects'
import { loadSettings, saveSettings } from '../../src/main/settings'
import { createAppState } from '../../src/main/state'
import { locateFfmpeg } from '../../src/main/ffmpeg'
import { copyTree, FIX, useTmpDir } from '../helpers/env'

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
})

describe('handlers de IPC (contrato completo, sem Electron)', () => {
  async function build() {
    const dir = tmp()
    const root = join(dir, 'projetos')
    copyTree(FIX.exemplo, join(root, 'exemplo'))
    const log = createMemoryLogger()
    const state = await createAppState({ file: join(dir, 'settings.json'), env: { ...process.env, [ENV_PROJECTS_DIR]: root }, logger: log })
    const store = createProjectStore({ root: () => state.projectsRoot(), logger: log, trash: async () => {}, openFolder: async () => {} })
    const handlers = createHandlers({
      info: { name: 'Tomada', version: '0.0.0', platform: 'win32', electron: '40.9.3', userDataDir: dir, logsDir: dir },
      state,
      store,
      logger: log,
      pickFolder: async () => null,
      pickFfmpeg: async () => null
    })
    return { handlers, state }
  }

  it('lista, detalha e renomeia por IPC', async () => {
    const { handlers } = await build()
    const list = await handlers['projects:list']()
    expect(list.map((p) => p.id)).toEqual(['exemplo'])
    expect((await handlers['projects:get']('exemplo')).media.screen?.url).toContain('tomada-media://project/exemplo/media/screen.mp4')
    expect((await handlers['projects:rename']('exemplo', 'Outro nome')).title).toBe('Outro nome')
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
      pickFfmpeg: async () => null
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
