/**
 * URLs do protocolo `tomada-media://project/<pasta-do-projeto>/<caminho>`.
 * Código puro: sem DOM, sem Node.
 */

export const MEDIA_SCHEME = 'tomada-media'
export const MEDIA_HOST = 'project'

/** URL de um arquivo dentro da pasta de um projeto. `version` fura o cache (ex.: mtime). */
export function mediaUrl(projectId: string, relPath: string, version?: number): string {
  const segments = [projectId, ...relPath.split(/[\\/]+/).filter(Boolean)].map(encodeURIComponent)
  const query = version === undefined ? '' : `?v=${Math.trunc(version)}`
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${segments.join('/')}${query}`
}
