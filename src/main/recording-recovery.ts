import { readdir, stat } from 'node:fs/promises'
import type { InterruptedRecording } from '@shared/recovery'
import { elapsedMs, normalizeIntervals } from '@shared/recording'
import type { Ffmpeg } from './ffmpeg'
import { readManifest, RAW_CAMERA, RAW_MIC, RAW_SCREEN, type RecordingManifest } from './manifest'
import { resolveProjectFile } from './project-files'
import { assertProjectId } from './projects'

export async function loadRecovery(root: string, id: string): Promise<{ dir: string; manifest: RecordingManifest; bytes: number }> {
  assertProjectId(id)
  const dir = await resolveProjectFile(root, id)
  const manifest = await readManifest(dir)
  if (manifest.screen && manifest.screen.file !== RAW_SCREEN) throw new Error('Caminho de tela inválido no manifesto de gravação.')
  if (manifest.camera && ![RAW_CAMERA, RAW_MIC].includes(manifest.camera.file)) throw new Error('Caminho de câmera inválido no manifesto de gravação.')
  let bytes = 0
  for (const rel of [manifest.screen?.file, manifest.camera?.file]) {
    if (!rel) continue
    const path = await resolveProjectFile(dir, rel)
    const info = await stat(path).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return null; throw err })
    if (info && !info.isFile()) throw new Error('A gravação aponta para uma pasta no lugar de um arquivo de mídia.')
    bytes += info?.size ?? 0
  }
  manifest.folder = id
  return { dir, manifest, bytes }
}

export const isInterrupted = (manifest: RecordingManifest): boolean => !manifest.processedAt && (manifest.endedAt === null || manifest.recoveryPending === true)

export async function listRecoveries(root: string): Promise<InterruptedRecording[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return []; throw err })
  const result: InterruptedRecording[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    try {
      const { manifest, bytes } = await loadRecovery(root, entry.name)
      if (!isInterrupted(manifest) || bytes === 0) continue
      result.push({ id: entry.name, sessionId: manifest.sessionId, title: manifest.title, createdAt: manifest.createdAt, recordedMs: manifest.recordedMs, bytes })
    } catch {
      // Uma pasta de terceiros sem manifesto válido não se torna gravação recuperável.
      // A recuperação automática registra o motivo; nenhuma junção é seguida pela lista.
    }
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Carimbo final do bruto, inclusive WebM aberto sem Duration no cabeçalho. Só demux; sem decodificar/GPU. */
async function rawDuration(ff: Ffmpeg, path: string): Promise<number> {
  const probe = await ff.probe(path)
  if (probe.durationMs > 0) return probe.durationMs
  let durationMs = 0
  await ff.run(['-i', path, '-map', '0', '-c', 'copy', '-f', 'null', '-'], { timeoutMs: 60_000, onProgress: (p) => { durationMs = Math.max(durationMs, p.timeMs) } })
  return durationMs
}

/** Não usa o relógio da reabertura: só a mídia, último pedaço e pausa persistidos. */
export async function finalizeInterrupted(dir: string, manifest: RecordingManifest, ff: Ffmpeg): Promise<void> {
  if (!manifest.clock) throw new Error('A gravação não tem o relógio de início. Os pedaços foram preservados em raw/.')
  let mediaMs = 0
  for (const rel of [manifest.screen?.file, manifest.camera?.file]) {
    if (!rel) continue
    const path = await resolveProjectFile(dir, rel)
    const info = await stat(path).catch(() => null)
    if (!info || info.size === 0) continue
    mediaMs = Math.max(mediaMs, await rawDuration(ff, path))
  }
  if (mediaMs <= 0) throw new Error('Não consegui encontrar duração nos pedaços gravados. O bruto foi preservado em raw/.')
  const pauses = normalizeIntervals(manifest.pauses)
  const t0 = manifest.clock.t0
  const last = manifest.lastChunkAt ?? t0
  const checkpointMs = elapsedMs(Math.max(t0, last), t0, pauses, manifest.openPauseAt ?? null)
  manifest.recordedMs = Math.max(mediaMs, checkpointMs)
  const closedMs = pauses.reduce((sum, p) => sum + p.end - p.start, 0)
  manifest.endedAt = Math.max(t0 + manifest.recordedMs + closedMs, manifest.openPauseAt ?? t0)
  manifest.pauses = normalizeIntervals([...pauses, ...(manifest.openPauseAt !== null && manifest.openPauseAt !== undefined ? [{ start: manifest.openPauseAt, end: manifest.endedAt }] : [])])
  manifest.openPauseAt = null
  manifest.stopReason = 'error'
  manifest.recoveryPending = true
  manifest.notes.push('Gravação recuperada dos pedaços no disco. O último segundo pode estar incompleto; confira o fim do vídeo.')
}
