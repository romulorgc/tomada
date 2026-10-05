/**
 * Segurança (revisão de 05/10), parte que depende do DISCO: `resolveProjectFile` (junção, atalho quebrado, nome
 * curto 8.3), quem pode abrir/mostrar o quê (`checkOpenable`, `checkRevealable`) e as pastas de exportação
 * aprovadas (`OutputDirs`).
 */
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProject } from '@shared/project'
import { OUTSIDE_PROJECT_MESSAGE } from '@shared/safe-path'
import { OPENABLE_EXTENSIONS, checkOpenable, checkRevealable, createOutputDirs, type GuardContext } from '../../src/main/path-guard'
import { assertDocumentPaths, isInside, resolveProjectFile } from '../../src/main/project-files'
import { FIX, useTmpDir } from '../helpers/env'

const tmp = useTmpDir()

/** Raiz com um projeto e uma pasta de FORA (com um segredo). O `tmp()` do Windows vem em nome curto (8.3): propositalmente. */
function world() {
  const base = tmp()
  const root = join(base, 'projetos')
  const dir = join(root, 'proj')
  const outside = join(base, 'fora')
  mkdirSync(join(dir, 'media'), { recursive: true })
  mkdirSync(outside)
  copyFileSync(join(FIX.exemplo, 'media', 'screen.mp4'), join(dir, 'media', 'screen.mp4'))
  writeFileSync(join(dir, 'media', 'voice.wav'), 'x')
  writeFileSync(join(dir, 'nota.txt'), 'oi')
  writeFileSync(join(outside, 'segredo.mp4'), 'segredo')
  writeFileSync(join(outside, 'segredo.txt'), 'segredo')
  return { base, root, dir, outside }
}

describe('isInside', () => {
  it('estritamente dentro: nem a própria pasta, nem irmã com o mesmo prefixo, nem outra unidade', () => {
    expect(isInside('C:\\a\\b', 'C:\\a\\b\\c\\d.mp4')).toBe(true)
    expect(isInside('C:\\a\\b', 'C:\\a\\b')).toBe(false)
    expect(isInside('C:\\a\\b', 'C:\\a\\bc\\d.mp4')).toBe(false)
    expect(isInside('C:\\a\\b', 'C:\\a\\x.mp4')).toBe(false)
    expect(isInside('C:\\a\\b', 'D:\\a\\b\\c.mp4')).toBe(false)
    expect(isInside('C:\\a\\b', 'C:\\a\\b\\..\\x.mp4')).toBe(false)
    expect(isInside('C:\\a\\b', 'C:\\a\\b\\..x\\y.mp4')).toBe(true) // "..x" é um nome comum
    expect(isInside('C:\\A\\B', 'c:\\a\\b\\c.mp4')).toBe(true) // o Windows não distingue maiúsculas
  })
})

describe('resolveProjectFile', () => {
  it('devolve o caminho absoluto (real) de um arquivo do projeto, com contrabarra ou barra normal', async () => {
    const { dir } = world()
    const real = await realpath(dir)
    expect(await resolveProjectFile(dir, 'media/screen.mp4')).toBe(join(real, 'media', 'screen.mp4'))
    expect(await resolveProjectFile(dir, 'media\\voice.wav')).toBe(join(real, 'media', 'voice.wav'))
    expect(await resolveProjectFile(dir, './nota.txt')).toBe(join(real, 'nota.txt'))
  })

  it('arquivo que não existe ainda vale (quem chama decide), desde que fique dentro; subpasta que não existe também', async () => {
    const { dir } = world()
    const real = await realpath(dir)
    expect(await resolveProjectFile(dir, 'media/nao-existe.wav')).toBe(join(real, 'media', 'nao-existe.wav'))
    expect(await resolveProjectFile(dir, 'media/thumbs/thumb-0001.jpg')).toBe(join(real, 'media', 'thumbs', 'thumb-0001.jpg'))
  })

  it('recusa o que sai da pasta: .., absoluto, unidade, UNC, esquema, nome reservado', async () => {
    const { dir, outside } = world()
    const rels = [
      '..\\fora\\segredo.mp4',
      'media/../../fora/segredo.mp4',
      join(outside, 'segredo.mp4'),
      'C:\\Windows\\win.ini',
      '\\\\servidor\\pasta\\x.mp4',
      'http://127.0.0.1/x.png',
      'file:///C:/Windows/win.ini',
      'media/screen.mp4:fluxo',
      'media/.. /x',
      'nul'
    ]
    for (const rel of rels) await expect(resolveProjectFile(dir, rel), rel).rejects.toThrow(OUTSIDE_PROJECT_MESSAGE)
  })

  it('junção que aponta para fora da pasta: recusa o arquivo de dentro dela (conferido com realpath)', async () => {
    const { dir, outside } = world()
    symlinkSync(outside, join(dir, 'media', 'atalho'), 'junction')
    await expect(resolveProjectFile(dir, 'media/atalho/segredo.mp4', 'sources.screen.path')).rejects.toThrow(/sources\.screen\.path/)
    await expect(resolveProjectFile(dir, 'media/atalho/segredo.mp4')).rejects.toThrow(OUTSIDE_PROJECT_MESSAGE)
    // arquivo que NEM existe do outro lado também: o atalho em si já é a fuga
    await expect(resolveProjectFile(dir, 'media/atalho/novo.wav')).rejects.toThrow(OUTSIDE_PROJECT_MESSAGE)
  })

  it('junção que aponta para dentro da própria pasta é aceita', async () => {
    const { dir } = world()
    symlinkSync(join(dir, 'media'), join(dir, 'espelho'), 'junction')
    const real = await realpath(dir)
    expect(await resolveProjectFile(dir, 'espelho/screen.mp4')).toBe(join(real, 'media', 'screen.mp4'))
  })

  it('atalho QUEBRADO (alvo que não existe) não passa por "arquivo ausente"', async () => {
    const { dir, base } = world()
    symlinkSync(join(base, 'alvo-que-nao-existe'), join(dir, 'media', 'quebrado'), 'junction')
    await expect(resolveProjectFile(dir, 'media/quebrado/x.mp4')).rejects.toThrow(OUTSIDE_PROJECT_MESSAGE)
    await expect(resolveProjectFile(dir, 'media/quebrado')).rejects.toThrow(OUTSIDE_PROJECT_MESSAGE)
  })

  it('assertDocumentPaths confere TODOS os caminhos do documento (mídias e imagem de fundo)', async () => {
    const { dir, outside } = world()
    symlinkSync(outside, join(dir, 'media', 'atalho'), 'junction')
    const doc = () =>
      createProject({
        title: 't',
        sources: { screen: { path: 'media/screen.mp4', w: 1, h: 1, fps: 30, durationMs: 1000 }, voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs: 1000 } }
      })
    await expect(assertDocumentPaths(dir, doc())).resolves.toBeUndefined()
    const a = doc()
    a.sources.voice!.path = 'media/atalho/segredo.mp4'
    await expect(assertDocumentPaths(dir, a)).rejects.toThrow(/sources\.voice\.path/)
    const b = doc()
    b.style.background = { type: 'image', path: '..\\fora\\segredo.mp4' }
    await expect(assertDocumentPaths(dir, b)).rejects.toThrow(/style\.background\.path/)
    const c = doc()
    c.sources.system = { path: join(outside, 'segredo.mp4'), w: 0, h: 0, fps: 0, durationMs: 1000 }
    await expect(assertDocumentPaths(dir, c)).rejects.toThrow(/sources\.system\.path/)
  })
})

describe('files:open (checkOpenable)', () => {
  const ctxOf = (root: string, outputs: string[] = []): GuardContext => ({ root, isExportOutput: (real) => outputs.includes(real.toLowerCase()) })

  it('abre arquivo de mídia que está dentro da raiz dos projetos', async () => {
    const { root, dir } = world()
    for (const rel of ['media/screen.mp4', 'nota.txt']) {
      const file = join(dir, rel)
      expect(await checkOpenable(file, ctxOf(root))).toBe(file)
    }
  })

  it('a lista de extensões é a combinada', () => {
    expect([...OPENABLE_EXTENSIONS]).toEqual(['.mp4', '.mov', '.webm', '.m4a', '.wav', '.srt', '.vtt', '.txt', '.png', '.jpg'])
  })

  it('NÃO abre executável, script nem atalho (nem dentro da raiz)', async () => {
    const { root, dir } = world()
    for (const name of ['programa.exe', 'script.bat', 'script.cmd', 'atalho.lnk', 'macro.ps1', 'x.vbs', 'x.js', 'x.msi', 'x.dll', 'x.scr', 'x.com', 'x.url', 'semextensao', 'x.mp4.exe']) {
      const file = join(dir, name)
      writeFileSync(file, 'x')
      await expect(checkOpenable(file, ctxOf(root)), name).rejects.toThrow(/Só abro arquivos de mídia/)
    }
  })

  it('NÃO abre arquivo de mídia de fora da raiz que nenhuma exportação desta sessão gerou', async () => {
    const { root, outside } = world()
    await expect(checkOpenable(join(outside, 'segredo.mp4'), ctxOf(root))).rejects.toThrow(/não está na pasta dos projetos/)
    await expect(checkOpenable(join(outside, 'segredo.txt'), ctxOf(root))).rejects.toThrow(/não está na pasta dos projetos/)
  })

  it('o ".." não engana: o caminho é conferido depois de resolvido', async () => {
    const { root, dir } = world()
    await expect(checkOpenable(join(dir, '..', '..', 'fora', 'segredo.mp4'), ctxOf(root))).rejects.toThrow(/não está na pasta dos projetos/)
    await expect(checkOpenable(`${dir}\\media\\..\\..\\..\\fora\\segredo.mp4`, ctxOf(root))).rejects.toThrow(/não está na pasta dos projetos/)
  })

  it('a junção não engana: arquivo "dentro" da raiz que na verdade mora fora é recusado', async () => {
    const { root, dir, outside } = world()
    symlinkSync(outside, join(dir, 'atalho'), 'junction')
    await expect(checkOpenable(join(dir, 'atalho', 'segredo.mp4'), ctxOf(root))).rejects.toThrow(/não está na pasta dos projetos/)
  })

  it('a saída de uma exportação concluída nesta sessão abre, mesmo fora da raiz; a extensão continua valendo', async () => {
    const { root, outside } = world()
    const out = join(outside, 'Aula final.mp4')
    writeFileSync(out, 'video')
    const realOut = (await realpath(out)).toLowerCase()
    expect(await checkOpenable(out, ctxOf(root, [realOut]))).toBe(out)
    const exe = join(outside, 'Aula final.exe')
    writeFileSync(exe, 'x')
    await expect(checkOpenable(exe, ctxOf(root, [(await realpath(exe)).toLowerCase()]))).rejects.toThrow(/Só abro arquivos de mídia/)
  })

  it('caminho relativo, vazio, com NUL, pasta ou que não existe: erro, nunca abre', async () => {
    const { root, dir } = world()
    await expect(checkOpenable('media\\screen.mp4', ctxOf(root))).rejects.toThrow(/caminho completo/)
    await expect(checkOpenable('..\\video.mp4', ctxOf(root))).rejects.toThrow(/caminho completo/)
    await expect(checkOpenable('', ctxOf(root))).rejects.toThrow(/caminho completo/)
    await expect(checkOpenable(undefined, ctxOf(root))).rejects.toThrow(/caminho completo/)
    await expect(checkOpenable(`${dir}\\media\\screen.mp4\0.exe`, ctxOf(root))).rejects.toThrow(/caminho completo/)
    await expect(checkOpenable(join(dir, 'media'), ctxOf(root))).rejects.toThrow()
    await expect(checkOpenable(join(dir, 'media', 'nao-existe.mp4'), ctxOf(root))).rejects.toThrow(/Não encontrei/)
  })
})

describe('files:reveal (checkRevealable)', () => {
  it('mostra arquivo e pasta dentro da raiz (e a própria raiz); nunca fora', async () => {
    const { root, dir, outside } = world()
    const ctx: GuardContext = { root, isExportOutput: () => false }
    for (const p of [dir, join(dir, 'media'), join(dir, 'media', 'screen.mp4'), root]) expect(await checkRevealable(p, ctx), p).toBe(p)
    for (const p of [outside, join(outside, 'segredo.mp4'), 'C:\\Windows', 'C:\\Windows\\System32\\cmd.exe', join(dir, '..', '..', 'fora')]) {
      await expect(checkRevealable(p, ctx), p).rejects.toThrow(/não vou mostrá-lo/)
    }
    await expect(checkRevealable('\\\\servidor\\pasta', ctx)).rejects.toThrow()
    await expect(checkRevealable('relativo', ctx)).rejects.toThrow(/caminho completo/)
  })

  it('mostra a pasta de exportação aprovada e a saída concluída; a junção não engana', async () => {
    const { root, dir, outside, base } = world()
    const out = join(outside, 'final.mp4')
    writeFileSync(out, 'v')
    const realOut = (await realpath(out)).toLowerCase()
    const realOutside = (await realpath(outside)).toLowerCase()
    const ctx: GuardContext = { root, isExportOutput: (r) => r.toLowerCase() === realOut, isApprovedDir: (r) => r.toLowerCase() === realOutside }
    expect(await checkRevealable(out, ctx)).toBe(out)
    expect(await checkRevealable(outside, ctx)).toBe(outside)
    const outra = join(base, 'outra')
    mkdirSync(outra)
    await expect(checkRevealable(outra, ctx)).rejects.toThrow(/não vou mostrá-lo/)
    symlinkSync(outra, join(dir, 'atalho'), 'junction')
    await expect(checkRevealable(join(dir, 'atalho'), ctx)).rejects.toThrow(/não vou mostrá-lo/)
  })
})

describe('OutputDirs (pastas de exportação aprovadas)', () => {
  it('só vale a pasta aprovada, exatamente ela (maiúsculas à parte); subpasta, vizinha e relativa não', async () => {
    const { base } = world()
    const dirs = createOutputDirs()
    const picked = join(base, 'Saída')
    mkdirSync(picked)
    mkdirSync(join(picked, 'sub'))
    expect(await dirs.resolve(picked)).toBeNull() // ainda não aprovada
    await dirs.approve(picked)
    expect(await dirs.resolve(picked)).toBe(picked)
    expect(await dirs.resolve(picked.toUpperCase())).not.toBeNull()
    expect(await dirs.resolve(`${picked}\\`)).not.toBeNull()
    expect(await dirs.resolve(join(picked, 'sub'))).toBeNull()
    expect(await dirs.resolve(join(picked, '..'))).toBeNull()
    expect(await dirs.resolve(join(base, 'outra'))).toBeNull()
    expect(await dirs.resolve('Saída')).toBeNull()
    expect(await dirs.resolve(undefined as never)).toBeNull()
    expect(dirs.has((await realpath(picked)).toLowerCase())).toBe(true)
    expect(dirs.has((await realpath(join(picked, 'sub'))).toLowerCase())).toBe(false)
  })

  it('o mesmo diretório por nome curto (8.3) e por nome longo é a mesma pasta aprovada', async () => {
    const { base } = world() // `tmp()` já vem em nome curto no Windows
    const dirs = createOutputDirs()
    const long = await realpath(join(base))
    await dirs.approve(base)
    expect(await dirs.resolve(long)).not.toBeNull()
  })

  it('recusa aprovar caminho que não é absoluto', async () => {
    await expect(createOutputDirs().approve('relativo\\pasta')).rejects.toThrow(/caminho completo/)
  })

  it('pasta que ainda não existe pode ser aprovada (o diálogo cria) e vale pelo mesmo caminho', async () => {
    const { base } = world()
    const dirs = createOutputDirs()
    const futura = join(base, 'ainda-nao-existe')
    await dirs.approve(futura)
    expect(await dirs.resolve(futura)).toBe(futura)
  })
})
