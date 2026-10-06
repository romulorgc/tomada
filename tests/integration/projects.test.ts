import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrate } from '@shared/project'
import { writeFileAtomic } from '../../src/main/fs-utils'
import { createMemoryLogger } from '../../src/main/logger'
import {
  createProjectStore,
  InvalidProjectIdError,
  ProjectNotFoundError,
  type ProjectStore
} from '../../src/main/projects'
import { copyTree, FIX, useTmpDir } from '../helpers/env'

const tmp = useTmpDir()

const EXAMPLE_ID = '2026-10-04 1500 Projeto de exemplo'

/** Raiz com o projeto de exemplo + lixo que a biblioteca precisa tolerar. */
function seed(): { root: string; trashDir: string; store: ProjectStore; log: ReturnType<typeof createMemoryLogger>; opened: string[] } {
  const base = tmp()
  const root = join(base, 'projetos')
  const trashDir = join(base, 'lixeira')
  mkdirSync(root)
  mkdirSync(trashDir)
  copyTree(FIX.exemplo, join(root, EXAMPLE_ID))
  const log = createMemoryLogger()
  const opened: string[] = []
  const store = createProjectStore({
    root: () => root,
    logger: log,
    // lixeira falsa: mover para outra pasta tem o mesmo efeito observável (some da raiz)
    trash: async (p) => renameSync(p, join(trashDir, `${Date.now()}-${p.split(/[\\/]/).pop()}`)),
    openFolder: async (p) => {
      opened.push(p)
    }
  })
  return { root, trashDir, store, log, opened }
}

describe('ProjectStore.list', () => {
  it('informa transcrição e cortes prontos, e atualiza o selo se a transcrição sumir', async () => {
    const { root, store } = seed()
    const file = join(root, EXAMPLE_ID, 'project.json')
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    doc.clips = [{ id: 'corte', title: 'Demonstração', hook: 'Agende em poucos cliques', ranges: [{ start: 0, end: 18000 }], score: 80, reason: 'Teste', format: 'vertical', layoutV: 'screen-focus' }]
    writeFileSync(file, JSON.stringify(doc))
    expect((await store.list())[0]).toMatchObject({ hasTranscript: true, clipCount: 1 })
    const fs = await import('node:fs/promises')
    await fs.rm(join(root, EXAMPLE_ID, 'transcript.json'))
    expect((await store.list())[0]).toMatchObject({ hasTranscript: false, clipCount: 1 })
  })
  it('lista o projeto de exemplo com título, duração, data e miniatura', async () => {
    const { store } = seed()
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: EXAMPLE_ID,
      title: 'Projeto de exemplo',
      createdAt: '2026-10-04T15:00:00.000Z',
      thumbPath: 'media/thumb.jpg',
      hasScreen: true,
      hasCamera: true
    })
    expect(list[0]?.durationMs).toBeGreaterThan(20_000)
    expect(list[0]?.thumbVersion).toBeGreaterThan(0)
  })

  it('o aviso do piloto automático (que não pôde retomar) aparece no cartão da Biblioteca; sem aviso, o campo nem existe', async () => {
    const { root, store } = seed()
    expect((await store.list())[0]).not.toHaveProperty('autopilotNotice')
    const file = join(root, EXAMPLE_ID, 'project.json')
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    doc.autopilot = { projectId: EXAMPLE_ID, status: 'done', startedAt: 1, elapsedMs: 0, notice: 'O piloto automático não pôde retomar: teste.', steps: [{ id: 'transcribe', status: 'error', detail: 'teste' }] }
    writeFileSync(file, JSON.stringify(doc))
    expect((await store.list())[0]?.autopilotNotice).toBe('O piloto automático não pôde retomar: teste.')
  })

  it('ignora pasta inválida sem quebrar e REGISTRA no log (uma vez só)', async () => {
    const { root, store, log } = seed()
    mkdirSync(join(root, 'quebrada'))
    writeFileSync(join(root, 'quebrada', 'project.json'), '{ isto não é json')
    mkdirSync(join(root, 'sem-arquivo'))
    mkdirSync(join(root, 'versao-velha'))
    writeFileSync(join(root, 'versao-velha', 'project.json'), JSON.stringify({ version: 1, id: 'x', title: 't', createdAt: 'agora' }))
    mkdirSync(join(root, 'campo-errado'))
    writeFileSync(
      join(root, 'campo-errado', 'project.json'),
      JSON.stringify({ version: 2, id: 'x', title: 't', createdAt: 'agora', cuts: [{ id: 1 }] })
    )
    mkdirSync(join(root, '.oculta'))
    writeFileSync(join(root, 'arquivo-solto.txt'), 'oi')

    const first = await store.list()
    expect(first.map((p) => p.id)).toEqual([EXAMPLE_ID])
    const warnings = log.entries.filter((e) => e.level === 'warn')
    expect(warnings).toHaveLength(4) // quebrada, sem-arquivo, versao-velha, campo-errado (oculta e arquivo solto são ignoradas)
    const text = warnings.map((w) => w.message).join('\n')
    expect(text).toContain('quebrada')
    expect(text).toContain('sem-arquivo')
    expect(text).toContain('versao-velha')
    expect(text).toContain('campo-errado')

    await store.list() // de novo: nada de log repetido
    expect(log.entries.filter((e) => e.level === 'warn')).toHaveLength(4)
  })

  it('cria a raiz se ainda não existe e devolve lista vazia', async () => {
    const root = join(tmp(), 'ainda', 'nao', 'existe')
    const store = createProjectStore({ root: () => root, logger: createMemoryLogger(), trash: async () => {}, openFolder: async () => {} })
    expect(await store.list()).toEqual([])
    expect(existsSync(root)).toBe(true)
  })

  it('ordena do mais novo para o mais antigo', async () => {
    const { root, store } = seed()
    const copy = (name: string, createdAt: string): void => {
      copyTree(join(root, EXAMPLE_ID), join(root, name))
      const file = join(root, name, 'project.json')
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), createdAt, title: name }))
    }
    copy('mais-novo', '2026-11-01T10:00:00.000Z')
    copy('do-meio', '2026-10-20T10:00:00.000Z')
    expect((await store.list()).map((p) => p.id)).toEqual(['mais-novo', 'do-meio', EXAMPLE_ID])
  })

  it('projeto sem miniatura: thumbPath null', async () => {
    const { root, store } = seed()
    const fs = await import('node:fs')
    fs.rmSync(join(root, EXAMPLE_ID, 'media', 'thumb.jpg'))
    expect((await store.list())[0]).toMatchObject({ thumbPath: null, thumbVersion: 0 })
  })
})

describe('ProjectStore.read / detail', () => {
  it('lê e valida o documento', async () => {
    const { store } = seed()
    const { project, dir } = await store.read(EXAMPLE_ID)
    expect(project.title).toBe('Projeto de exemplo')
    expect(project.sources.screen?.path).toBe('media/screen.mp4')
    expect(dir.endsWith(EXAMPLE_ID)).toBe(true)
  })

  it('detail traz URLs tomada-media:// e tamanhos reais dos arquivos', async () => {
    const { store } = seed()
    const d = await store.detail(EXAMPLE_ID)
    expect(d.media.screen?.url).toMatch(/^tomada-media:\/\/project\/2026-10-04%201500%20Projeto%20de%20exemplo\/media\/screen\.mp4\?v=\d+$/)
    expect(d.media.screen?.bytes).toBe(readFileSync(join(d.dir, 'media', 'screen.mp4')).length)
    expect(d.media.camera?.url).toContain('/media/camera.mp4')
  })

  it('arquivo de mídia que sumiu vira null (e aviso no log), sem derrubar o projeto', async () => {
    const { root, store, log } = seed()
    const fs = await import('node:fs')
    fs.rmSync(join(root, EXAMPLE_ID, 'media', 'camera.mp4'))
    const d = await store.detail(EXAMPLE_ID)
    expect(d.media.camera).toBeNull()
    expect(d.media.screen).not.toBeNull()
    expect(log.entries.some((e) => e.level === 'warn' && e.message.includes('camera.mp4'))).toBe(true)
  })

  it('id que não existe: ProjectNotFoundError', async () => {
    const { store } = seed()
    await expect(store.read('nao-existe')).rejects.toBeInstanceOf(ProjectNotFoundError)
    await expect(store.detail('nao-existe')).rejects.toBeInstanceOf(ProjectNotFoundError)
  })

  it('id que tenta escapar da raiz: InvalidProjectIdError em TODAS as operações', async () => {
    const { store } = seed()
    for (const bad of ['..', '../fora', 'a/b', 'a\\b', 'C:\\Windows', '', '.']) {
      await expect(store.read(bad), bad).rejects.toBeInstanceOf(InvalidProjectIdError)
      await expect(store.rename(bad, 'x'), bad).rejects.toBeInstanceOf(InvalidProjectIdError)
      await expect(store.trash(bad), bad).rejects.toBeInstanceOf(InvalidProjectIdError)
      await expect(store.reveal(bad), bad).rejects.toBeInstanceOf(InvalidProjectIdError)
      expect(() => store.dirOf(bad), bad).toThrow(InvalidProjectIdError)
    }
  })
})

describe('ProjectStore.rename', () => {
  it('grava o título no project.json (persiste) e devolve o resumo', async () => {
    const { root, store } = seed()
    const summary = await store.rename(EXAMPLE_ID, '  Aula de Psicanálise nº 2  ')
    expect(summary.title).toBe('Aula de Psicanálise nº 2')
    const onDisk = JSON.parse(readFileSync(join(root, EXAMPLE_ID, 'project.json'), 'utf8'))
    expect(onDisk.title).toBe('Aula de Psicanálise nº 2')
    expect((await store.list())[0]?.title).toBe('Aula de Psicanálise nº 2')
    // a pasta mantém o nome (o id não muda)
    expect(existsSync(join(root, EXAMPLE_ID))).toBe(true)
  })

  it('preserva campos de versões futuras e o resto do documento', async () => {
    const { root, store } = seed()
    const file = join(root, EXAMPLE_ID, 'project.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...raw, version: 3, campoDoFuturo: { x: 1 } }))
    await store.rename(EXAMPLE_ID, 'Novo')
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(after.version).toBe(3)
    expect(after.campoDoFuturo).toEqual({ x: 1 })
    expect(after.sources).toEqual(raw.sources)
    expect(migrate(after).title).toBe('Novo')
  })

  it('título vazio ou só espaços: erro, arquivo intacto', async () => {
    const { root, store } = seed()
    const before = readFileSync(join(root, EXAMPLE_ID, 'project.json'), 'utf8')
    await expect(store.rename(EXAMPLE_ID, '   ')).rejects.toThrow(/vazio/)
    await expect(store.rename(EXAMPLE_ID, 123 as unknown as string)).rejects.toThrow(/vazio/)
    expect(readFileSync(join(root, EXAMPLE_ID, 'project.json'), 'utf8')).toBe(before)
  })

  it('título gigante: erro', async () => {
    const { store } = seed()
    await expect(store.rename(EXAMPLE_ID, 'x'.repeat(201))).rejects.toThrow(/caracteres/)
  })

  it('não deixa arquivo temporário para trás', async () => {
    const { root, store } = seed()
    await store.rename(EXAMPLE_ID, 'Sem sobras')
    expect(readdirSync(join(root, EXAMPLE_ID)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('renomeações simultâneas terminam com um documento válido (escrita atômica)', async () => {
    const { root, store } = seed()
    const titles = Array.from({ length: 8 }, (_, i) => `Título ${i}`)
    await Promise.all(titles.map((t) => store.rename(EXAMPLE_ID, t)))
    const text = readFileSync(join(root, EXAMPLE_ID, 'project.json'), 'utf8')
    expect(titles).toContain(migrate(JSON.parse(text)).title)
    expect(readdirSync(join(root, EXAMPLE_ID)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})

describe('ProjectStore.trash / reveal', () => {
  it('manda a pasta inteira para a lixeira e some da lista', async () => {
    const { root, trashDir, store } = seed()
    await store.trash(EXAMPLE_ID)
    expect(existsSync(join(root, EXAMPLE_ID))).toBe(false)
    expect(readdirSync(trashDir)).toHaveLength(1)
    expect(await store.list()).toEqual([])
  })

  it('"deu certo" só se a pasta saiu mesmo: lixeira que não remove vira ERRO', async () => {
    const { root } = seed()
    const store = createProjectStore({ root: () => root, logger: createMemoryLogger(), trash: async () => {}, openFolder: async () => {} })
    await expect(store.trash(EXAMPLE_ID)).rejects.toThrow(/continua em/)
  })

  it('erro da lixeira sobe com a mensagem', async () => {
    const { root } = seed()
    const store = createProjectStore({
      root: () => root,
      logger: createMemoryLogger(),
      trash: async () => {
        throw new Error('arquivo em uso por outro programa')
      },
      openFolder: async () => {}
    })
    await expect(store.trash(EXAMPLE_ID)).rejects.toThrow(/em uso/)
    expect(existsSync(join(root, EXAMPLE_ID))).toBe(true)
  })

  it('apagar o que não existe: ProjectNotFoundError', async () => {
    const { store } = seed()
    await expect(store.trash('fantasma')).rejects.toBeInstanceOf(ProjectNotFoundError)
  })

  it('reveal abre a pasta certa', async () => {
    const { store, opened, root } = seed()
    await store.reveal(EXAMPLE_ID)
    expect(opened).toEqual([join(root, EXAMPLE_ID)])
  })
})

describe('ProjectStore.importBackground', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

  it('copia a imagem para media/ com nome que não se repete para a mesma imagem e não se confunde com outra', async () => {
    const { root, store } = seed()
    const dir = tmp()
    const a = join(dir, 'a.png')
    const b = join(dir, 'b.PNG')
    writeFileSync(a, png)
    writeFileSync(b, Buffer.concat([png, Buffer.from('mais bytes')]))
    const first = await store.importBackground(EXAMPLE_ID, a)
    const again = await store.importBackground(EXAMPLE_ID, a)
    const other = await store.importBackground(EXAMPLE_ID, b)
    expect(first).toMatch(/^media\/fundo-[0-9a-f]{8}\.png$/)
    expect(again).toBe(first) // a mesma imagem não se duplica
    expect(other).not.toBe(first)
    expect(other.endsWith('.png')).toBe(true) // extensão em minúsculas
    expect(readFileSync(join(root, EXAMPLE_ID, first))).toEqual(png)
  })

  it('recusa o que não é imagem, o que não existe, o que passa de 40 MB e projeto que não existe', async () => {
    const { store } = seed()
    const dir = tmp()
    const txt = join(dir, 'nota.txt')
    writeFileSync(txt, 'oi')
    await expect(store.importBackground(EXAMPLE_ID, txt)).rejects.toThrow(/PNG, JPG ou WebP/)
    await expect(store.importBackground(EXAMPLE_ID, join(dir, 'sumiu.png'))).rejects.toThrow(/Não encontrei a imagem/)
    const big = join(dir, 'grande.jpg')
    writeFileSync(big, Buffer.alloc(41 * 1024 * 1024))
    await expect(store.importBackground(EXAMPLE_ID, big)).rejects.toThrow(/40 MB/)
    const ok = join(dir, 'ok.webp')
    writeFileSync(ok, png)
    await expect(store.importBackground('fantasma', ok)).rejects.toBeInstanceOf(ProjectNotFoundError)
    await expect(store.importBackground('../fora', ok)).rejects.toBeInstanceOf(InvalidProjectIdError)
  })
})

describe('writeFileAtomic', () => {
  it('cria pastas que faltam e grava o conteúdo', async () => {
    const file = join(tmp(), 'a', 'b', 'c.json')
    await writeFileAtomic(file, '{"ok":true}')
    expect(readFileSync(file, 'utf8')).toBe('{"ok":true}')
  })

  it('falha no rename: o arquivo antigo fica intacto e o temporário é removido', async () => {
    const dir = tmp()
    const target = join(dir, 'alvo')
    mkdirSync(target) // rename de arquivo por cima de PASTA falha
    await expect(writeFileAtomic(target, 'novo')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['alvo'])
  })
})
