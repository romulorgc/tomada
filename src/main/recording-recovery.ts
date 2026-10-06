import { open, readFile, readdir, stat } from 'node:fs/promises'
import type { InterruptedRecording } from '@shared/recovery'
import { elapsedMs, normalizeIntervals } from '@shared/recording'
import type { Ffmpeg } from './ffmpeg'
import { readManifest, RAW_CAMERA, RAW_MIC, RAW_MIC_PCM, RAW_SCREEN, type RecordingManifest } from './manifest'
import { checkpointPcm, validatePcmHeader } from './pcm-file'
import { resolveProjectFile } from './project-files'
import { assertProjectId } from './projects'
import type { Logger } from './logger'
import { MANIFEST_PATH } from './manifest'

/** Só nomes fixos e caminhos conferidos; nunca segue um nome vindo do manifesto rejeitado. */
async function rawInfo(dir: string): Promise<{ bytes: number; active: boolean }> {
  let bytes = 0, active = false
  for (const rel of [RAW_SCREEN, RAW_CAMERA, RAW_MIC, RAW_MIC_PCM]) {
    const file = await resolveProjectFile(dir, rel)
    const info = await stat(file).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return null; throw err })
    if (!info?.isFile()) continue
    bytes += info.size
    if (info.size > 0 && Date.now() - info.mtimeMs < 5000) active = true
  }
  return { bytes, active }
}

export async function assertRawInactive(dir: string): Promise<void> {
  if ((await rawInfo(dir)).active) throw new Error('Essa gravação pode estar ativa em outra instância. Espere alguns segundos sem escrita antes de recuperar ou descartar.')
}

/** Descarte confirmado de bruto ilegível: confere apenas caminhos fixos, sem interpretar o JSON. */
export async function unreadableRecoveryDir(root: string, id: string): Promise<string> {
  assertProjectId(id)
  const dir = await resolveProjectFile(root, id)
  if (!(await stat(await resolveProjectFile(dir, MANIFEST_PATH))).isFile()) throw new Error('Não encontrei o manifesto dessa gravação.')
  if ((await rawInfo(dir)).bytes === 0) throw new Error('Não encontrei um bruto para descartar nessa pasta.')
  await assertRawInactive(dir)
  return dir
}

const EVENTS_MISSING = 'Os eventos não foram salvos ou estão ilegíveis. A recuperação pode ficar sem efeitos de cursor, cliques e teclas e sem zooms por atividade.'
async function eventsWarning(dir: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(await resolveProjectFile(dir, 'raw/events.json'), 'utf8'))
    if (!raw || !['cursor', 'clicks', 'keys', 'windowRects'].every(key => Array.isArray(raw[key]))) return EVENTS_MISSING
    return undefined
  } catch { return EVENTS_MISSING }
}

export async function loadRecovery(root: string, id: string): Promise<{ dir: string; manifest: RecordingManifest; bytes: number }> {
  assertProjectId(id)
  const dir = await resolveProjectFile(root, id)
  const manifest = await readManifest(dir)
  if (manifest.screen && manifest.screen.file !== RAW_SCREEN) throw new Error('Caminho de tela inválido no manifesto de gravação.')
  if (manifest.camera && ![RAW_CAMERA, RAW_MIC, RAW_MIC_PCM].includes(manifest.camera.file)) throw new Error('Caminho de câmera inválido no manifesto de gravação.')
  let bytes = 0
  for (const rel of new Set([manifest.screen?.file, manifest.camera?.file, ...(manifest.micPcm ? [RAW_MIC_PCM] : [])])) {
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

export async function listRecoveries(root: string, logger: Logger): Promise<InterruptedRecording[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return []; throw err })
  const result: InterruptedRecording[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    let dir: string
    try {
      assertProjectId(entry.name)
      dir = await resolveProjectFile(root, entry.name)
      const file = await resolveProjectFile(dir, MANIFEST_PATH)
      const info = await stat(file).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return null; throw err })
      if (!info?.isFile()) continue
    } catch (err) { logger.warn(`Não consegui conferir a pasta da gravação ${entry.name}.`, err); continue }
    try {
      const { manifest, bytes } = await loadRecovery(root, entry.name)
      if (!isInterrupted(manifest) || bytes === 0) continue
      if ((await rawInfo(dir)).active) continue
      const warning = manifest.saved ? undefined : await eventsWarning(dir)
      result.push({ id: entry.name, sessionId: manifest.sessionId, title: manifest.title, createdAt: manifest.createdAt, recordedMs: manifest.recordedMs, bytes, ...(warning ? { warning } : {}) })
    } catch (err) {
      logger.warn(`Não consegui ler o manifesto da gravação ${entry.name}.`, err)
      try {
        const raw = await rawInfo(dir)
        if (raw.bytes === 0 || raw.active) continue
        result.push({ id: entry.name, sessionId: `ilegível:${entry.name}`, title: entry.name, createdAt: (await stat(dir)).mtime.toISOString(), recordedMs: null, bytes: raw.bytes,
          error: `Existe um bruto que não consegui ler: ${err instanceof Error ? err.message : String(err)}. Os arquivos foram preservados em raw/.` })
      } catch (rawErr) { logger.warn(`Não consegui conferir o bruto da gravação ${entry.name}.`, rawErr) }
    }
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Carimbo final do bruto, inclusive WebM aberto sem Duration no cabeçalho. Só demux; sem decodificar/GPU. */
async function rawDuration(ff: Ffmpeg, path: string): Promise<number> {
  const probe = await ff.probe(path)
  if (probe.durationMs > 0) return probe.durationMs
  let durationMs = 0
  // 5 MiB/s mais um minuto para arranque: até disco lento tem orçamento pelo volume que precisa ler.
  const timeoutMs = 60_000 + Math.ceil((await stat(path)).size / (5 * 1024 ** 2)) * 1000
  try {
    await ff.run(['-i', path, '-map', '0', '-c', 'copy', '-f', 'null', '-'], { timeoutMs, onProgress: (p) => { durationMs = Math.max(durationMs, p.timeMs) } })
  } catch (err) {
    if (err instanceof Error && /tempo limite/i.test(err.message)) throw new Error(`Não consegui medir a duração do bruto em ${Math.ceil(timeoutMs / 1000)} s. O disco demorou mais que o previsto; tente recuperar de novo. Os pedaços continuam em raw/.`)
    throw err
  }
  return durationMs
}

/** Não usa o relógio da reabertura: só a mídia, último pedaço e pausa persistidos. */
export async function finalizeInterrupted(dir: string, manifest: RecordingManifest, ff: Ffmpeg): Promise<void> {
  if (!manifest.clock) throw new Error('A gravação não tem o relógio de início. Os pedaços foram preservados em raw/.')
  let mediaMs = 0
  for (const rel of new Set([manifest.screen?.file, manifest.camera?.file, ...(manifest.micPcm ? [RAW_MIC_PCM] : [])])) {
    if (!rel) continue
    const path = await resolveProjectFile(dir, rel)
    const info = await stat(path).catch(() => null)
    if (!info || info.size === 0) continue
    if (rel === RAW_MIC_PCM) {
      if (info.nlink > 1) throw new Error('O bruto PCM tem um link físico para outro arquivo; a recuperação foi recusada.')
      const handle = await open(path, 'r+')
      try {
        await validatePcmHeader(handle)
        // Queda no meio da escrita: restaura o tamanho real, até a última amostra completa.
        const complete = 44 + Math.floor((info.size - 44) / 4) * 4
        await handle.truncate(complete)
        await checkpointPcm(handle, complete)
      } finally { await handle.close() }
    }
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
