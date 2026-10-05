/**
 * Plano da exportação 16:9: resoluções, taxas de bits, a sequência de
 * quadros de saída e os tempos de origem que cada um mostra, nome do arquivo.
 * Código puro: sem DOM, sem Node.
 */
import { z } from 'zod'
import type { FormatSpec } from './scene'
import { outputToSource } from './timeline'
import type { Range } from './types'

export type ExportResolution = '1080p' | '1440p' | '2160p'
export type ExportFps = 30 | 60

export type ExportOptions = {
  resolution: ExportResolution
  fps: ExportFps
  /** Nome do arquivo SEM extensão. Ausente ou vazio = o padrão "<título> - YouTube 1080p". */
  fileName?: string
  /** Pasta de destino (caminho absoluto). Ausente = `exports/` dentro da pasta do projeto. */
  dir?: string
}

/** Validação do pedido de exportação que atravessa a IPC. */
export const exportRequestSchema = z.object({
  projectId: z.string().min(1).max(300),
  resolution: z.enum(['1080p', '1440p', '2160p']),
  fps: z.union([z.literal(30), z.literal(60)]),
  fileName: z.string().max(200).optional(),
  dir: z.string().min(1).max(1000).optional()
})

export const EXPORT_SIZES: Record<ExportResolution, { w: number; h: number }> = {
  '1080p': { w: 1920, h: 1080 },
  '1440p': { w: 2560, h: 1440 },
  '2160p': { w: 3840, h: 2160 }
}

export const EXPORT_RESOLUTION_LABEL: Record<ExportResolution, string> = { '1080p': '1080p', '1440p': '1440p', '2160p': '4K' }

/** Taxa de bits do YouTube: 1080p 8 Mbps (12 a 60 qps), 1440p 16 (24), 4K 40 (60). */
const BITRATE_MBPS: Record<ExportResolution, Record<ExportFps, number>> = {
  '1080p': { 30: 8, 60: 12 },
  '1440p': { 30: 16, 60: 24 },
  '2160p': { 30: 40, 60: 60 }
}

export function exportBitrate(resolution: ExportResolution, fps: ExportFps): number {
  return BITRATE_MBPS[resolution][fps] * 1_000_000
}

export function exportFormat(opts: ExportOptions): FormatSpec {
  const { w, h } = EXPORT_SIZES[opts.resolution]
  return { kind: 'horizontal', w, h }
}

/**
 * Nível do H.264 High para o tamanho e a taxa de quadros (macroblocos por quadro e por segundo,
 * tabela A-1 da norma). Devolve o código hexadecimal do nível (0x28 = 4.0).
 */
export function avcLevelIdc(w: number, h: number, fps: number): number {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16)
  const rate = mbs * fps
  const levels: { idc: number; frame: number; rate: number }[] = [
    { idc: 0x28, frame: 8192, rate: 245_760 },
    { idc: 0x29, frame: 8192, rate: 245_760 },
    { idc: 0x2a, frame: 8704, rate: 522_240 },
    { idc: 0x32, frame: 22_080, rate: 589_824 },
    { idc: 0x33, frame: 36_864, rate: 983_040 },
    { idc: 0x34, frame: 36_864, rate: 2_073_600 }
  ]
  return (levels.find((l) => mbs <= l.frame && rate <= l.rate) ?? levels[levels.length - 1]!).idc
}

/** `avc1.64XXYY`: perfil High (0x64), sem restrições, nível `YY`. */
export function avcCodecString(w: number, h: number, fps: number): string {
  return `avc1.6400${avcLevelIdc(w, h, fps).toString(16).padStart(2, '0')}`
}

/** Quantos quadros tem a saída: a duração (ms) vezes a taxa, arredondada (±1 quadro da duração). */
export function outputFrameCount(outputMs: number, fps: number): number {
  if (!(outputMs > 0) || !(fps > 0)) return 0
  return Math.max(1, Math.round((outputMs / 1000) * fps))
}

/** Instante de SAÍDA (ms) do quadro `i`. */
export function outputFrameTime(i: number, fps: number): number {
  return (i * 1000) / fps
}

/**
 * Instante de ORIGEM (ms) que o quadro de saída `i` mostra: sequência crescente, com saltos nos
 * cortes. O deslocamento de meio milissegundo evita que um instante que cai EXATAMENTE na borda de
 * um trecho (número de ponto flutuante) pegue o quadro vizinho.
 */
export function sourceTimeOfFrame(i: number, fps: number, kept: readonly Range[]): number {
  return outputToSource(outputFrameTime(i, fps) + 0.5, kept)
}

/** Segundos de arquivo do quadro de origem: `t` (relógio da gravação) menos o deslocamento da fonte. */
export function fileTimeSeconds(sourceMs: number, offsetMs: number): number {
  return Math.max(0, (sourceMs - offsetMs) / 1000)
}

// ---------------------------------------------------------------------------
// Nome do arquivo

/** Título → nome de arquivo válido no Windows (sem caracteres proibidos, sem ponto/espaço no fim). */
export function sanitizeFileName(title: string, fallback = 'Gravação'): string {
  const clean = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  const base = clean.length > 0 ? clean : fallback
  // nomes reservados do Windows
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
  const safe = reserved.test(base) ? `${base}_` : base
  return safe.slice(0, 120).replace(/[. ]+$/g, '')
}

/** O nome padrão sem extensão: `<título> - YouTube 1080p` (60 qps vira `1080p60`). */
export function defaultExportStem(title: string, opts: Pick<ExportOptions, 'resolution' | 'fps'>): string {
  const label = EXPORT_RESOLUTION_LABEL[opts.resolution]
  return `${sanitizeFileName(title)} - YouTube ${label}${opts.fps === 60 ? '60' : ''}`
}

/** `<nome escolhido>.mp4`, ou o padrão `<título> - YouTube 1080p.mp4` quando o nome não foi escolhido. */
export function exportFileName(title: string, opts: ExportOptions): string {
  const custom = opts.fileName?.trim().replace(/\.mp4$/i, '').trim()
  return `${custom ? sanitizeFileName(custom) : defaultExportStem(title, opts)}.mp4`
}

/** Progresso → tempo restante (ms) a partir de quadros por segundo medidos. */
export function etaMs(done: number, total: number, framesPerSecond: number): number | null {
  if (!(framesPerSecond > 0) || done <= 0 || done > total) return null
  return Math.round(((total - done) / framesPerSecond) * 1000)
}
