/**
 * Caminhos que vêm do documento (`project.json`) ou da interface: a regra é UMA só, em código puro (sem DOM, sem
 * Node), para o processo principal, a ponte e as janelas usarem a mesma.
 *
 * Todo caminho do documento é RELATIVO à pasta do projeto. Aqui fica a parte que dá para decidir só olhando o
 * texto (sem absoluto, sem `..`, sem unidade, sem `\\servidor`, sem esquema como `http:` ou `file:`, sem fluxo
 * alternativo do NTFS, sem nome reservado do Windows). A parte que depende do disco (atalho, junção, link
 * simbólico) é de `resolveProjectFile`, no processo principal.
 */
import type { Project } from './types'

/** Frase que o usuário vê quando o documento aponta para fora da pasta do projeto. */
export const OUTSIDE_PROJECT_MESSAGE = 'Este projeto aponta para um arquivo fora da pasta dele'

export class UnsafePathError extends Error {
  override readonly name = 'UnsafePathError'
}

/** Nomes de dispositivo do Windows: `CON.mp4` ou `con.qualquer.coisa` também são o dispositivo. */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i

/** O nome (parte antes do primeiro ponto, sem espaços no fim) é um dispositivo reservado do Windows? */
export function isReservedWindowsName(name: string): boolean {
  const stem = name.split('.')[0]!.replace(/[ ]+$/g, '')
  return RESERVED.test(stem)
}

/** Motivo (curto) de o caminho relativo não servir, ou `null` se ele é aceitável. */
export function unsafeRelativePathReason(rel: unknown): string | null {
  if (typeof rel !== 'string') return 'o caminho não é um texto'
  if (rel.length === 0) return 'o caminho está vazio'
  if (rel.length > 1000) return 'o caminho é longo demais'
  if (/[\u0000-\u001f\u007f]/.test(rel)) return 'o caminho tem caracteres de controle'
  if (/^[\\/]/.test(rel)) return 'o caminho é absoluto ou de rede'
  // unidade (C:), esquema (http:, file:, data:, concat:), fluxo alternativo do NTFS (arquivo:fluxo)
  if (rel.includes(':')) return 'o caminho tem unidade, esquema ou fluxo alternativo (":")'
  if (/[<>"|?*]/.test(rel)) return 'o caminho tem caracteres que o Windows não aceita'
  const segments = rel.split(/[\\/]+/)
  for (const seg of segments) {
    if (seg === '') return 'o caminho termina numa barra'
    if (seg === '.') continue
    if (seg === '..') return 'o caminho sobe de pasta ("..")'
    // o Windows descarta pontos e espaços do fim do nome: ".. " e "..." viram ".."
    if (/[. ]$/.test(seg)) return 'um nome do caminho termina em ponto ou espaço'
    if (isReservedWindowsName(seg)) return 'o caminho usa um nome reservado do Windows'
  }
  if (segments.every((s) => s === '.')) return 'o caminho não aponta para um arquivo'
  return null
}

export function isSafeRelativePath(rel: unknown): rel is string {
  return unsafeRelativePathReason(rel) === null
}

/** Devolve o caminho se ele serve; senão lança `UnsafePathError` com a frase que o usuário vê. */
export function assertSafeRelativePath(rel: unknown, field?: string): string {
  const reason = unsafeRelativePathReason(rel)
  if (reason === null) return rel as string
  const shown = typeof rel === 'string' ? JSON.stringify(rel.length > 120 ? `${rel.slice(0, 120)}…` : rel) : String(rel)
  throw new UnsafePathError(`${OUTSIDE_PROJECT_MESSAGE}: ${field ? `${field} ` : ''}${shown} (${reason}).`)
}

/** Todo caminho relativo que o documento guarda (mídias e imagem de fundo), com o nome do campo para a mensagem. */
export function documentFilePaths(project: Pick<Project, 'sources' | 'style'>): { field: string; path: string }[] {
  const out: { field: string; path: string }[] = []
  for (const key of ['screen', 'camera', 'voice', 'system'] as const) {
    const src = project.sources[key]
    if (src) out.push({ field: `sources.${key}.path`, path: src.path })
  }
  const bg = project.style.background
  if (bg.type === 'image') out.push({ field: 'style.background.path', path: bg.path })
  return out
}

/** Confere (só pelo texto) todos os caminhos do documento; lança `UnsafePathError` no primeiro ruim. */
export function assertDocumentPathsSafe(project: Pick<Project, 'sources' | 'style'>): void {
  for (const { field, path } of documentFilePaths(project)) assertSafeRelativePath(path, field)
}
