/**
 * URLs do protocolo `tomada-media://project/<pasta-do-projeto>/<caminho>`.
 * Código puro: sem DOM, sem Node.
 */
import { assertSafeRelativePath } from './safe-path'

export const MEDIA_SCHEME = 'tomada-media'
export const MEDIA_HOST = 'project'

/**
 * URL de um arquivo dentro da pasta de um projeto. `version` fura o cache (ex.: mtime).
 * O caminho é RELATIVO e validado: `..`, unidade, `\\servidor`, esquema (`http:`, `file:`, `data:`) e nome reservado
 * lançam `UnsafePathError`. (Sem isto o `URL` do navegador colapsaria um `..` e a requisição cairia em outra pasta.)
 */
export function mediaUrl(projectId: string, relPath: string, version?: number): string {
  assertSafeRelativePath(relPath)
  const segments = [projectId, ...relPath.split(/[\\/]+/).filter((s) => s !== '' && s !== '.')].map(encodeURIComponent)
  const query = version === undefined ? '' : `?v=${Math.trunc(version)}`
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${segments.join('/')}${query}`
}

/** É uma URL do nosso protocolo (a única que a interface pode ler de um arquivo do projeto)? */
export function isMediaUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith(`${MEDIA_SCHEME}://${MEDIA_HOST}/`)
}

/** Devolve a URL se for do protocolo de mídia; senão lança (nada de `http:`, `https:`, `file:`, `data:` ou `blob:`). */
export function assertMediaUrl(url: unknown): string {
  if (isMediaUrl(url)) return url
  throw new Error('A interface só lê arquivos do próprio projeto (tomada-media://).')
}
