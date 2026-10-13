/**
 * O RECORTE EM PEDAÇOS, RETOMÁVEL (R1). Código puro: sem DOM, sem Node.
 *
 * O recorte de uma gravação inteira leva ~1,5× a duração dela (2,3 min para 88 s de 4K). Em vez de um arquivo só, que morre sem `moov`
 * quando o app fecha no meio, ele é gravado em PEDAÇOS de `MATTE_CHUNK_SECONDS` (um mp4 por pedaço, em `MATTE_PARTS_DIR`) e o andamento
 * fica em `MATTE_PROGRESS_FILE`. Fechar o app, cair a luz ou matar o processo perde no máximo o pedaço em curso: a rodada seguinte
 * continua do último pedaço inteiro e, no fim, os pedaços são juntados em `MATTE_FILE` (`matte.ts`).
 *
 * O ESTADO ÚNICO que a interface consulta é `MatteStatus`, devolvido por `matteStatusOf` (e, no renderer, por `useMatteStatus`).
 */

/** A pasta dos pedaços (`p0000.mp4`, `p0001.mp4`…) enquanto o recorte não termina. */
export const MATTE_PARTS_DIR = 'media/camera-matte.parts'
/** O andamento do recorte, no projeto: quais pedaços estão prontos e como a última rodada terminou. */
export const MATTE_PROGRESS_FILE = 'media/camera-matte.progress.json'
export const MATTE_PROGRESS_VERSION = 1
/** Duração de cada pedaço (s). Perder o pedaço em curso custa até ~15 s de trabalho; juntar nove pedaços custa menos de 1 s. */
export const MATTE_CHUNK_SECONDS = 10
/** Sem ponto de retomada: antes do primeiro instante que falta, o RVM vê este tanto de vídeo (s) só para "esquentar" a memória dele (a máscara não é gravada). */
export const MATTE_WARMUP_SECONDS = 1

export const matteChunkName = (index: number): string => `p${String(index).padStart(4, '0')}.mp4`
/**
 * O PONTO DE RETOMADA do pedaço `index` (`s0003.npz`, 4,4 MB): o estado do RVM no início dele. Com ele a retomada continua IDÊNTICA à rodada contínua;
 * sem ele (sumiu, outra versão) ela cai no aquecimento de `MATTE_WARMUP_SECONDS`. Só o do pedaço em curso e o do seguinte ficam em disco.
 */
export const matteStateName = (index: number): string => `s${String(index).padStart(4, '0')}.npz`

export type MatteChunk = { index: number; frames: number; bytes: number }

/**
 * Como a última rodada terminou: `running` (em andamento, ou o app morreu no meio), `interrupted` (o app fechou), `cancelled` (a pessoa
 * cancelou) ou `failed`.
 */
export type MatteProgressStatus = 'running' | 'interrupted' | 'cancelled' | 'failed'

export type MatteProgress = {
  version: number
  /** A câmera de onde saem os pedaços (se ela mudar, os pedaços não valem mais). */
  source: string
  sourceMtimeMs: number
  chunkSeconds: number
  /** Os pedaços prontos, do 0 em diante e SEM buracos. */
  chunks: MatteChunk[]
  status: MatteProgressStatus
  /** 0..1, o último andamento conhecido (para dizer "retomando de 63%"). */
  fraction: number
  /** Quantas rodadas já começaram (a primeira é 1). */
  attempts: number
  startedAt: string
  updatedAt: string
  /** Por que parou, quando `failed`, `interrupted` ou `cancelled`. */
  error?: string
}

/** O maior pedaço de lista que começa no 0 e não tem buraco (o que a retomada pode aproveitar). */
export function contiguousChunks<T extends { index: number }>(chunks: readonly T[]): T[] {
  const byIndex = new Map<number, T>(chunks.map((c) => [c.index, c]))
  const out: T[] = []
  for (let i = 0; byIndex.has(i); i++) out.push(byIndex.get(i)!)
  return out
}

/** Lê o andamento; `null` se o arquivo não presta (então o recorte recomeça do zero, com aviso no log). */
export function parseMatteProgress(text: string): MatteProgress | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const o = raw as Partial<MatteProgress> | null
  if (!o || typeof o !== 'object' || o.version !== MATTE_PROGRESS_VERSION) return null
  if (typeof o.source !== 'string' || typeof o.sourceMtimeMs !== 'number' || !Array.isArray(o.chunks)) return null
  const chunks: MatteChunk[] = []
  for (const c of o.chunks as unknown[]) {
    const k = c as Partial<MatteChunk> | null
    if (!k || typeof k.index !== 'number' || !Number.isInteger(k.index) || k.index < 0 || typeof k.frames !== 'number' || !(k.frames > 0)) continue
    chunks.push({ index: k.index, frames: k.frames, bytes: typeof k.bytes === 'number' ? k.bytes : 0 })
  }
  const status: MatteProgressStatus = o.status === 'interrupted' || o.status === 'cancelled' || o.status === 'failed' ? o.status : 'running'
  const stamp = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    version: MATTE_PROGRESS_VERSION,
    source: o.source,
    sourceMtimeMs: o.sourceMtimeMs,
    chunkSeconds: typeof o.chunkSeconds === 'number' && o.chunkSeconds > 0 ? o.chunkSeconds : MATTE_CHUNK_SECONDS,
    chunks: contiguousChunks(chunks),
    status,
    fraction: typeof o.fraction === 'number' && o.fraction >= 0 && o.fraction <= 1 ? o.fraction : 0,
    attempts: typeof o.attempts === 'number' && o.attempts >= 0 ? Math.floor(o.attempts) : 1,
    startedAt: stamp(o.startedAt),
    updatedAt: stamp(o.updatedAt),
    ...(typeof o.error === 'string' ? { error: o.error } : {})
  }
}

/** Os pedaços guardados valem para esta câmera e este tamanho de pedaço? */
export function progressMatchesCamera(progress: MatteProgress, cameraPath: string, cameraMtimeMs: number, chunkSeconds = MATTE_CHUNK_SECONDS): boolean {
  return progress.version === MATTE_PROGRESS_VERSION && progress.source === cameraPath && progress.sourceMtimeMs === cameraMtimeMs && progress.chunkSeconds === chunkSeconds
}

/** Quanto do recorte os pedaços prontos cobrem (0..0,99): o "retomando de 63%" mostrado antes de o motor dizer o andamento de verdade. */
export function chunksFraction(doneChunks: number, chunkSeconds: number, durationMs: number): number {
  if (!(durationMs > 0) || doneChunks <= 0) return 0
  return Math.min(0.99, (doneChunks * chunkSeconds * 1000) / durationMs)
}

/**
 * O ESTADO ÚNICO do recorte do fundo de um projeto: o que a interface (chip do editor, prévia, exportação) consulta numa leitura só.
 *  - `ready`: o `camera-matte.mp4` existe e vale para a câmera (`url` preenchida);
 *  - `running`: recortando agora (`fraction`/`percent`); `resumed` = continuando de pedaços que já estavam prontos;
 *  - `queued`: espera a vez (outro recorte na fila, ou o recorte deu lugar à exportação/transcrição/prévia: `waiting = 'gpu'`);
 *  - `failed`: terminou com erro (`error` traz o motivo; "Tentar de novo" refaz a partir do último pedaço pronto);
 *  - `none`: nada em andamento e sem recorte (nunca pedido, cancelado, ou o motor ainda não está preparado).
 */
export type MatteStatus = {
  state: 'none' | 'queued' | 'running' | 'ready' | 'failed'
  /** 0..1 */
  fraction: number
  /** 0..100, inteiro */
  percent: number
  /** Continuando de onde parou (a rodada anterior foi interrompida). */
  resumed: boolean
  /** Por que está parado na fila: dando lugar a uma exportação, à transcrição ou à prévia (`gpu`); ou só esperando a vez (`queue`). */
  waiting: 'gpu' | 'queue' | null
  error: string | null
  url: string | null
}

/** O que a interface sabe do trabalho: o último `camera:job` do projeto, do tipo `matte`. */
export type MatteJobLike = {
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  fraction: number
  error?: string | undefined
  url?: string | undefined
  resumed?: boolean | undefined
  waiting?: 'gpu' | undefined
}

export function matteStatusOf(input: { url: string | null; job?: MatteJobLike | undefined }): MatteStatus {
  const { url, job } = input
  const resumed = Boolean(job?.resumed)
  const pct = (f: number): number => Math.max(0, Math.min(100, Math.round(f * 100)))
  if (job && (job.state === 'queued' || job.state === 'running')) {
    const fraction = Math.max(0, Math.min(1, job.fraction))
    const waiting = job.waiting === 'gpu' ? 'gpu' : job.state === 'queued' ? 'queue' : null
    return { state: job.state, fraction, percent: pct(fraction), resumed, waiting, error: null, url: null }
  }
  if (job?.state === 'error') return { state: 'failed', fraction: 0, percent: 0, resumed, waiting: null, error: job.error ?? 'O recorte do fundo falhou.', url: null }
  if (url) return { state: 'ready', fraction: 1, percent: 100, resumed, waiting: null, error: null, url }
  if (job?.state === 'done' && job.url) return { state: 'ready', fraction: 1, percent: 100, resumed, waiting: null, error: null, url: job.url }
  return { state: 'none', fraction: 0, percent: 0, resumed, waiting: null, error: null, url: null }
}
