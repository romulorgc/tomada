/**
 * A RETOMADA do recorte em pedaços (R1): lê o andamento guardado no projeto, confere que cada pedaço "pronto" está mesmo no disco e inteiro,
 * e descarta o que não vale (pedaço de outra câmera, depois de um buraco, ou meio gravado). Sem Electron.
 *
 * Os pedaços e o andamento moram na pasta do projeto, por isso todo caminho aqui chega JÁ RESOLVIDO por `resolveProjectFile` (quem chama).
 * A pasta dos pedaços é PLANA (só arquivos): apagar é arquivo por arquivo, sem `rm` recursivo (que falha calado em caminho com acento).
 */
import { mkdir, readdir, readFile, rm, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { contiguousChunks, matteChunkName, matteStateName, MATTE_PROGRESS_VERSION, parseMatteProgress, progressMatchesCamera, type MatteChunk, type MatteProgress } from '@shared/matte-parts'
import { writeFileAtomic } from '../fs-utils'

export type ResumeState = {
  /** O andamento lido (com os pedaços já conferidos), ou `null` se não havia nada que valesse. */
  progress: MatteProgress | null
  /** Os pedaços inteiros no disco, do 0 em diante e sem buracos. */
  chunks: MatteChunk[]
  /** Por que o que existia foi descartado, no todo ou em parte (para o log), ou `null` se nada foi perdido. */
  discarded: string | null
  /** O que existia foi TODO descartado (a rodada começa do zero); `false` com `discarded` preenchido = só os pedaços depois do primeiro ruim. */
  restart: boolean
}

export type ResumeInput = {
  partsDir: string
  progressFile: string
  cameraPath: string
  cameraMtimeMs: number
  chunkSeconds: number
  /** "Recortar de novo": ignora o que existe e começa do zero. */
  force?: boolean
}

/** Apaga todos os arquivos da pasta (ela é plana) e a própria pasta. Não falha se ela não existe. */
export async function removePartsDir(partsDir: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(partsDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  for (const name of names) await rm(join(partsDir, name), { force: true, maxRetries: 8, retryDelay: 250, recursive: false })
  await rmdir(partsDir).catch(() => undefined)
}

export async function removeProgress(progressFile: string): Promise<void> {
  await rm(progressFile, { force: true, maxRetries: 8, retryDelay: 250 })
}

export async function writeProgress(progressFile: string, progress: MatteProgress): Promise<void> {
  await writeFileAtomic(progressFile, `${JSON.stringify(progress, null, 2)}\n`)
}

export async function readProgress(progressFile: string): Promise<MatteProgress | null> {
  try {
    return parseMatteProgress(await readFile(progressFile, 'utf8'))
  } catch {
    return null
  }
}

/** Os pedaços de `chunks` (em ordem) que existem inteiros no disco; para no primeiro que falta ou não bate com o tamanho guardado. */
async function verifiedChunks(partsDir: string, chunks: readonly MatteChunk[]): Promise<MatteChunk[]> {
  const ok: MatteChunk[] = []
  for (const chunk of contiguousChunks(chunks)) {
    const info = await stat(join(partsDir, matteChunkName(chunk.index))).catch(() => null)
    if (!info?.isFile() || info.size === 0 || (chunk.bytes > 0 && info.size !== chunk.bytes)) break
    ok.push(chunk)
  }
  return ok
}

/**
 * Deixa na pasta só os pedaços de `keep` e o ponto de retomada do SEGUINTE (o estado do RVM para continuar daí): tira o que sobrou de uma rodada que
 * morreu (`.tmp`), o que veio depois de um buraco, a lista da junção e pontos de retomada que não servem mais.
 */
async function keepOnly(partsDir: string, keep: readonly MatteChunk[]): Promise<void> {
  const wanted = new Set([...keep.map((c) => matteChunkName(c.index)), matteStateName(keep.length)])
  const names = await readdir(partsDir).catch(() => [] as string[])
  for (const name of names) if (!wanted.has(name)) await rm(join(partsDir, name), { force: true, maxRetries: 8, retryDelay: 250 })
}

/**
 * O estado de partida de uma rodada do recorte. Devolve os pedaços aproveitáveis e deixa a pasta limpa; `discarded` diz (para o log) por
 * que um andamento existente não foi aproveitado.
 */
export async function loadResume(o: ResumeInput): Promise<ResumeState> {
  const discard = async (why: string | null): Promise<ResumeState> => {
    await removePartsDir(o.partsDir)
    await removeProgress(o.progressFile)
    await mkdir(o.partsDir, { recursive: true })
    return { progress: null, chunks: [], discarded: why, restart: true }
  }
  const progress = await readProgress(o.progressFile)
  if (o.force) return discard((progress?.chunks.length ?? 0) > 0 ? 'o recorte foi pedido de novo do zero' : null)
  if (!progress) {
    // sem andamento legível: pedaços soltos não têm dono, não servem
    const hadParts = (await readdir(o.partsDir).catch(() => [] as string[])).length > 0
    return discard(hadParts ? 'o andamento do recorte sumiu ou não abriu' : null)
  }
  if (!progressMatchesCamera(progress, o.cameraPath, o.cameraMtimeMs, o.chunkSeconds) || progress.version !== MATTE_PROGRESS_VERSION) {
    return discard('a câmera do projeto mudou desde o último recorte')
  }
  await mkdir(o.partsDir, { recursive: true })
  const chunks = await verifiedChunks(o.partsDir, progress.chunks)
  await keepOnly(o.partsDir, chunks)
  const lost = progress.chunks.length - chunks.length
  return { progress: { ...progress, chunks }, chunks, discarded: lost > 0 ? `${lost} pedaço(s) do recorte não estavam inteiros no disco` : null, restart: false }
}
