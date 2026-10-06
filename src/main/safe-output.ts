/**
 * Onde os processos externos (ffmpeg, whisper.cpp) escrevem: NUNCA num nome que alguém possa ter plantado antes.
 *
 * O projeto pode vir de terceiros (alguém manda a pasta). Uma saída de ffmpeg num caminho previsível
 * (`media/.tmp-peaks-<PID>/voz.pcm`, `media/screen.mp4.parcial`) é um convite: quem planta ali um link físico, um atalho ou uma junção
 * faz o ffmpeg gravar por cima de um arquivo de FORA da pasta (o ffmpeg abre o nome, trunca e escreve; link físico não passa por
 * `resolveProjectFile`, que só olha para onde o caminho resolve). A regra, aqui, é uma só:
 *
 *  1. toda saída nasce numa pasta temporária EXCLUSIVA: nome sorteado pelo sistema (`mkdtemp`), criada agora, vazia; nada plantado
 *     antes dela pode existir lá dentro;
 *  2. a pasta, e cada arquivo de saída dentro dela, passam por `resolveProjectFile` (dentro do projeto, sem atalho nem junção) e o
 *     arquivo não pode existir ainda;
 *  3. o resultado só ganha o nome definitivo no fim, e um destino que já é atalho, junção ou link físico é RECUSADO com o motivo
 *     (nunca escrito por cima, nunca trocado em silêncio);
 *  4. a pasta temporária sai no `finally`; se não saiu, o aviso vai para o log.
 *
 * Sem Electron: roda igual nos testes.
 */
import { lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { writeFileAtomic } from './fs-utils'
import type { Logger } from './logger'
import { isInside, resolveProjectFile } from './project-files'

export class UnsafeOutputError extends Error {
  override readonly name = 'UnsafeOutputError'
}

/** Pasta temporária exclusiva e o jeito de pedir um arquivo de saída dentro dela. */
export interface ExclusiveDir {
  /** Caminho (real) da pasta. */
  readonly dir: string
  /** Caminho de um arquivo de saída: nome simples (sem barra), conferido, que AINDA NÃO existe. */
  file(name: string): Promise<string>
}

const isMissing = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const lstatOrNull = (path: string) => lstat(path).catch((err: unknown) => (isMissing(err) ? null : Promise.reject(err)))

function assertSimpleName(name: string): void {
  if (name.length === 0 || name === '.' || name === '..' || /[\\/:]/.test(name) || /[\u0000-\u001f]/.test(name)) {
    throw new UnsafeOutputError(`Nome de arquivo de saída inválido: ${JSON.stringify(name)}.`)
  }
}

/**
 * `path` já existe como atalho, junção ou link físico (arquivo com mais de um nome)? Aí lança com o motivo. Devolve se o caminho
 * existe (arquivo comum ou pasta) ou não.
 */
export async function assertNotLinked(path: string, what: string): Promise<boolean> {
  const info = await lstatOrNull(path)
  if (!info) return false
  if (info.isSymbolicLink()) {
    throw new UnsafeOutputError(`${what} (${basename(path)}) é um atalho ou junção: o Tomada não escreve por cima de atalhos. Apague o atalho e tente de novo.`)
  }
  if (info.isFile() && info.nlink > 1) {
    throw new UnsafeOutputError(`${what} (${basename(path)}) é um link físico (o mesmo arquivo tem outro nome no disco): o Tomada não escreve por cima dele. Apague o link e tente de novo.`)
  }
  return true
}

async function checkFreshDir(dir: string, parentReal: string): Promise<void> {
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new UnsafeOutputError('A pasta temporária não é uma pasta comum.')
  if (!isInside(parentReal, await realpath(dir))) throw new UnsafeOutputError('A pasta temporária ficou fora da pasta pedida.')
}

/**
 * Pasta temporária exclusiva DENTRO do projeto: `<parentRel>/<prefix><sorteio>`. `parentRel` (ex.: `media`) é criada se faltar e
 * conferida com `resolveProjectFile` (junção para fora lança `UnsafePathError`: "Este projeto aponta para um arquivo fora da pasta
 * dele").
 */
export async function createProjectTmpDir(projectDir: string, parentRel: string, prefix: string): Promise<ExclusiveDir> {
  const parent = await resolveProjectFile(projectDir, parentRel)
  await mkdir(parent, { recursive: true })
  // de novo, agora que existe: o que está no caminho é conferido com realpath
  const parentReal = await resolveProjectFile(projectDir, parentRel)
  const dir = await mkdtemp(join(parentReal, prefix))
  try {
    const rel = `${parentRel}/${basename(dir)}`
    const resolved = await resolveProjectFile(projectDir, rel)
    if (resolved.toLowerCase() !== dir.toLowerCase()) throw new UnsafeOutputError('A pasta temporária não resolve para onde foi criada.')
    await checkFreshDir(dir, parentReal)
    return {
      dir,
      async file(name) {
        assertSimpleName(name)
        const out = await resolveProjectFile(projectDir, `${rel}/${name}`)
        if (await lstatOrNull(out)) throw new UnsafeOutputError(`O arquivo temporário ${name} já existe na pasta nova: não escrevo por cima.`)
        return out
      }
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

/** Pasta temporária exclusiva FORA do projeto (pasta de exportação, pasta de trabalho do app): `<parent>/<prefix><sorteio>`. */
export async function createTmpDirIn(parent: string, prefix: string): Promise<ExclusiveDir> {
  await mkdir(parent, { recursive: true })
  const parentReal = await realpath(parent)
  const dir = await mkdtemp(join(parentReal, prefix))
  try {
    await checkFreshDir(dir, parentReal)
    return {
      dir,
      async file(name) {
        assertSimpleName(name)
        const out = join(dir, name)
        if (await lstatOrNull(out)) throw new UnsafeOutputError(`O arquivo temporário ${name} já existe na pasta nova: não escrevo por cima.`)
        return out
      }
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

/** Apaga a pasta temporária. Falhar não derruba quem chamou (o resultado já está pronto), mas NUNCA fica mudo: vai para o log. */
export async function removeTmpDir(dir: string, logger: Pick<Logger, 'warn'>): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (err) {
    logger.warn(`Não consegui apagar a pasta temporária ${dir}; pode apagar à mão.`, err)
  }
}

/**
 * Confere o ÚLTIMO trecho do caminho como ele está escrito (não o que ele resolve): `resolveProjectFile` segue o atalho e devolve
 * o destino dele, então um atalho ou junção que aponta para DENTRO do projeto só se vê pelo caminho de antes de resolver.
 */
async function assertDestinationNotLinked(projectDir: string, rel: string, what: string): Promise<void> {
  const base = await realpath(projectDir)
  await assertNotLinked(join(base, ...rel.split(/[\\/]+/)), what)
}

/**
 * Dá o nome definitivo `rel` (dentro do projeto) ao arquivo ou pasta pronto `from`: o destino passa por `resolveProjectFile`, o que já
 * existe como atalho, junção ou link físico é recusado, o antigo (comum) sai e o novo entra por `rename`. Devolve o caminho final.
 */
export async function commitToProject(projectDir: string, from: string, rel: string, opts: { directory?: boolean } = {}): Promise<string> {
  const target = await resolveProjectFile(projectDir, rel)
  await assertDestinationNotLinked(projectDir, rel, opts.directory ? 'A pasta de destino' : 'O arquivo de destino')
  await rm(target, { recursive: opts.directory === true, force: true, maxRetries: 3, retryDelay: 100 })
  await mkdir(join(target, '..'), { recursive: true })
  await rename(from, target)
  return target
}

/** Escreve um arquivo do projeto de forma atômica (temporário ao lado + rename), recusando destino que já é atalho ou link. */
export async function writeProjectFile(projectDir: string, rel: string, data: string | Uint8Array): Promise<string> {
  const target = await resolveProjectFile(projectDir, rel)
  await assertDestinationNotLinked(projectDir, rel, 'O arquivo de destino')
  await writeFileAtomic(target, data)
  return target
}
