import { dirname } from 'node:path'
import { statfs } from 'node:fs/promises'
import { diskEstimate, type DiskEstimate } from '@shared/disk'
import { formatBytes } from '@shared/format'

/** A pasta já foi aprovada pelo main. Medir o ancestral permite avisar antes de criar a saída. */
export async function checkDiskSpace(dir: string, estimatedBytes: number, durationMs: number, reason: string): Promise<DiskEstimate> {
  let probe = dir
  let freeBytes: number | null = null
  for (;;) {
    try {
      const info = await statfs(probe)
      freeBytes = Number(info.bavail) * Number(info.bsize)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') break
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  return diskEstimate(freeBytes, estimatedBytes, durationMs, reason)
}

export function diskWarning(estimate: DiskEstimate): string {
  const needed = formatBytes(estimate.estimatedBytes)
  return estimate.freeBytes === null
    ? `Não consegui medir o disco. Espaço estimado: ${needed}. ${estimate.reason}`
    : `Pouco espaço no disco: ${formatBytes(estimate.freeBytes)} livres; estimativa de ${needed}. ${estimate.reason}`
}
