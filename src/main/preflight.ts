import { mkdir, statfs } from 'node:fs/promises'
import type { PreflightResult } from '@shared/preflight'

/** A pasta vem do estado validado do main; o renderer nunca fornece um caminho. */
export async function checkPreflight(projectsRoot: string, minFreeBytes = 1_000_000_000): Promise<PreflightResult> {
  let freeBytes: number | null = null
  try {
    await mkdir(projectsRoot, { recursive: true })
    const fs = await statfs(projectsRoot)
    freeBytes = Number(fs.bavail) * Number(fs.bsize)
  } catch {
    // Não impedir a gravação por falta de suporte à medição; mostrar "não consegui medir".
  }
  // TODO M4c: receber o detector existente; não criar outro detector de rosto nesta etapa.
  return { freeBytes, disk: freeBytes === null ? 'unknown' : freeBytes < minFreeBytes ? 'low' : 'ok', dnd: 'reminder', face: 'pending-m4c' }
}
