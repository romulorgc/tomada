/**
 * ÚNICO jeito de transformar um caminho do documento (`project.json`) num arquivo do disco.
 *
 * O documento pode vir de terceiros (alguém manda a pasta de um projeto), então o processo principal não confia em
 * nenhum caminho dele: todo caminho é RELATIVO, resolve para DENTRO da pasta do projeto e é conferido com
 * `realpath` (junção, atalho e link simbólico que apontam para fora não passam). Quem precisa de um arquivo do
 * projeto (exportação, mídias derivadas, detalhes do projeto) passa por `resolveProjectFile`; achar um
 * `join(dir, project.sources.X.path)` solto é defeito.
 *
 * Sem Electron.
 */
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { OUTSIDE_PROJECT_MESSAGE, UnsafePathError, assertSafeRelativePath, documentFilePaths } from '@shared/safe-path'
import type { Project } from '@shared/types'

/** `target` está ESTRITAMENTE dentro de `root`? Os dois já devem estar resolvidos (de preferência com `realpath`). */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  if (rel === '' || isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

const isMissing = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const outside = (rel: string, field?: string): UnsafePathError => {
  const shown = JSON.stringify(rel.length > 120 ? `${rel.slice(0, 120)}…` : rel)
  return new UnsafePathError(`${OUTSIDE_PROJECT_MESSAGE}: ${field ? `${field} ` : ''}${shown} (aponta para fora da pasta, por atalho ou junção).`)
}

/**
 * Caminho absoluto de um arquivo do projeto, ou lança `UnsafePathError` ("Este projeto aponta para um arquivo fora
 * da pasta dele"). O arquivo pode não existir (quem chama decide o que fazer com isso): neste caso confere o
 * trecho que existe e devolve o caminho resolvido a partir dele.
 */
export async function resolveProjectFile(dir: string, rel: string, field?: string): Promise<string> {
  assertSafeRelativePath(rel, field)
  const base = await realpath(dir)
  const lexical = resolve(base, rel)
  if (!isInside(base, lexical)) throw outside(rel, field)

  // O trecho mais fundo que existe, seguido até o fim (atalhos e junções inclusive).
  let probe = lexical
  let real: string | null = null
  while (real === null) {
    try {
      real = await realpath(probe)
    } catch (err) {
      if (!isMissing(err)) throw err
      // `realpath` falhou porque o alvo não existe. Atalho quebrado que aponta para fora também cai aqui: barra.
      const info = await lstat(probe).catch(() => null)
      if (info) throw outside(rel, field)
      const parent = dirname(probe)
      if (parent === probe || !isInside(base, probe)) {
        real = base
        probe = base
      } else probe = parent
    }
  }
  const full = probe === lexical ? real : join(real, relative(probe, lexical))
  if (!isInside(base, full)) throw outside(rel, field)
  return full
}

/** Confere TODOS os caminhos do documento (mídias e imagem de fundo); lança no primeiro que escapa da pasta. */
export async function assertDocumentPaths(dir: string, project: Pick<Project, 'sources' | 'style' | 'review'>): Promise<void> {
  for (const { field, path } of documentFilePaths(project)) await resolveProjectFile(dir, path, field)
}
