/**
 * As peças de `safe-output`: pasta temporária exclusiva (dentro do projeto e fora dele), arquivo de saída que ainda não existe,
 * recusa de atalho, junção e link físico, troca do arquivo antigo pelo novo e limpeza com erro no log. Sem Electron.
 */
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '../../src/main/logger'
import { assertNotLinked, commitToProject, createProjectTmpDir, createTmpDirIn, removeTmpDir } from '../../src/main/safe-output'
import { useTmpDir } from '../helpers/env'

const tmp = useTmpDir()
const INTACT = 'NAO MEXER'
const intact = (file: string): boolean => readFileSync(file).equals(Buffer.from(INTACT))

function outsideFile(name: string): string {
  const file = join(tmp(), name)
  writeFileSync(file, INTACT)
  return file
}

describe('safe-output', () => {
  const projectDir = (): string => {
    const dir = join(tmp(), 'projeto')
    mkdirSync(join(dir, 'media'), { recursive: true })
    return dir
  }

  it('createProjectTmpDir: pasta nova e vazia a cada pedido, dentro do projeto, com nome que ninguém adivinha', async () => {
    const dir = projectDir()
    const a = await createProjectTmpDir(dir, 'media', '.tmp-x-')
    const b = await createProjectTmpDir(dir, 'media', '.tmp-x-')
    expect(a.dir).not.toBe(b.dir)
    expect(readdirSync(a.dir)).toEqual([])
    expect(a.dir.replace(/\\/g, '/').toLowerCase()).toContain('/media/.tmp-x-')
    expect(a.dir).not.toContain(String(process.pid))
  })

  it('createProjectTmpDir: media/ que aponta para fora é recusada (nada é criado lá)', async () => {
    const dir = join(tmp(), 'projeto-2')
    mkdirSync(dir)
    const outside = join(tmp(), 'fora')
    mkdirSync(outside)
    symlinkSync(outside, join(dir, 'media'), 'junction')
    await expect(createProjectTmpDir(dir, 'media', '.tmp-x-')).rejects.toThrow(/fora da pasta/)
    expect(readdirSync(outside)).toEqual([])
  })

  it('file(): só nome simples e que ainda não existe', async () => {
    const t = await createProjectTmpDir(projectDir(), 'media', '.tmp-x-')
    const ok = await t.file('saida.bin')
    expect(ok.startsWith(t.dir)).toBe(true)
    writeFileSync(ok, 'x')
    await expect(t.file('saida.bin')).rejects.toThrow(/já existe/)
    await expect(t.file('../fuga.bin')).rejects.toThrow()
    await expect(t.file('sub/arquivo.bin')).rejects.toThrow()
  })

  it('assertNotLinked: arquivo comum e pasta passam; link físico e junção são recusados; o que não existe devolve false', async () => {
    const dir = projectDir()
    const plain = join(dir, 'media', 'comum.bin')
    writeFileSync(plain, 'x')
    expect(await assertNotLinked(plain, 'o arquivo')).toBe(true)
    expect(await assertNotLinked(join(dir, 'media'), 'a pasta')).toBe(true)
    expect(await assertNotLinked(join(dir, 'media', 'nao-existe'), 'o arquivo')).toBe(false)
    const outside = outsideFile('fora-link.bin')
    linkSync(outside, join(dir, 'media', 'link.bin'))
    await expect(assertNotLinked(join(dir, 'media', 'link.bin'), 'o arquivo')).rejects.toThrow(/link físico/)
    symlinkSync(join(dir, 'media'), join(dir, 'junta'), 'junction')
    await expect(assertNotLinked(join(dir, 'junta'), 'a pasta')).rejects.toThrow(/atalho ou junção/)
  })

  it('commitToProject: troca o arquivo antigo (comum) pelo novo e recusa destino que é link', async () => {
    const dir = projectDir()
    const t = await createProjectTmpDir(dir, 'media', '.tmp-x-')
    const made = await t.file('novo.bin')
    writeFileSync(made, 'novo')
    writeFileSync(join(dir, 'media', 'final.bin'), 'antigo')
    await commitToProject(dir, made, 'media/final.bin')
    expect(readFileSync(join(dir, 'media', 'final.bin'), 'utf8')).toBe('novo')
    const outside = outsideFile('fora-destino.bin')
    linkSync(outside, join(dir, 'media', 'preso.bin'))
    const made2 = await t.file('novo2.bin')
    writeFileSync(made2, 'novo2')
    await expect(commitToProject(dir, made2, 'media/preso.bin')).rejects.toThrow(/link físico/)
    expect(intact(outside)).toBe(true)
    await expect(commitToProject(dir, made2, '../fuga.bin')).rejects.toThrow()
  })

  it('createTmpDirIn: pasta nova e vazia fora do projeto (exportação, pasta de trabalho)', async () => {
    const parent = join(tmp(), 'destino')
    const a = await createTmpDirIn(parent, '.tmp-')
    const b = await createTmpDirIn(parent, '.tmp-')
    expect(a.dir).not.toBe(b.dir)
    expect(readdirSync(a.dir)).toEqual([])
    expect(readdirSync(parent).length).toBe(2)
  })

  it('removeTmpDir: falha ao apagar vira aviso no log (nunca silêncio, nunca derruba quem chamou)', async () => {
    const t = await createTmpDirIn(join(tmp(), 'destino-2'), '.tmp-')
    const busy = join(t.dir, 'aberto.bin')
    writeFileSync(busy, 'x')
    const handle = await open(busy, 'r') // no Windows, um arquivo aberto não deixa a pasta ser apagada
    const logger = createMemoryLogger()
    try {
      await removeTmpDir(t.dir, logger)
      const warned = logger.entries.some((e) => e.level === 'warn' && e.message.includes(t.dir))
      // fora do Windows o arquivo aberto não impede a remoção: aí o que vale é a pasta ter sumido sem aviso
      expect(warned || !existsSync(t.dir)).toBe(true)
    } finally {
      await handle.close()
    }
    await removeTmpDir(t.dir, logger)
    expect(existsSync(t.dir)).toBe(false)
  })
})
