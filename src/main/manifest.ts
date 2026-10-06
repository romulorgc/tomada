/**
 * `raw/recording.json`: o que foi gravado e como, para processar (e reprocessar) depois.
 * É gravado ao preparar, atualizado ao começar e ao parar; sobrevive a falhas do
 * processamento (o bruto fica na pasta e o "tentar de novo" lê isto).
 * Código puro de formato; a escrita atômica usa `fs-utils`. Sem Electron.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProcessStepId, StopReason } from '@shared/ipc'
import type { FrameRate, Interval, RecordMode } from '@shared/recording'
import type { CaptureInfo, Project, Rect, Size } from '@shared/types'
import type { VideoScript } from '@shared/script'
import type { RetakeMark } from '@shared/retake-marker'
import { writeFileAtomic } from './fs-utils'

export const MANIFEST_PATH = 'raw/recording.json'
export const RAW_SCREEN = 'raw/screen.webm'
export const RAW_CAMERA = 'raw/camera.webm'
export const RAW_MIC = 'raw/mic.webm'

export type ManifestScreen = {
  file: typeof RAW_SCREEN
  kind: 'screen' | 'window'
  sourceId: string
  sourceName: string
  /** Fator de escala do monitor. */
  scale: number
  mime: string | null
  hasSystemAudio: boolean
  /** O cursor do sistema NÃO aparece no vídeo (informado pela trilha de captura). */
  cursorHidden: boolean
  /** Quadro real no início e no fim da gravação. */
  frame: Size | null
  frameEnd: Size | null
  /** Retângulo físico do monitor (tela inteira) ou da moldura da janela no início. */
  screenRect: Rect | null
}

export type ManifestCamera = {
  file: typeof RAW_CAMERA | typeof RAW_MIC
  mime: string | null
  hasVideo: boolean
  hasAudio: boolean
  size: Size | null
}

export type ManifestClock = {
  /** Instante do primeiro `start` (relógio do renderer). */
  t0: number
  screenStartAt: number | null
  cameraStartAt: number | null
  /** main − renderer. */
  offsetMs: number
  rttMs: number
}

/** O que o passo "salvar" decidiu (guardado para o "tentar de novo" não refazer). */
export type ManifestSaved = {
  capture: CaptureInfo
  sync: { screenOffsetMs: number; cameraOffsetMs: number }
  stats: { cursor: number; clicks: number; keys: number }
}

export type RecordingManifest = {
  version: 1
  sessionId: string
  folder: string
  title: string
  createdAt: string
  mode: RecordMode
  cameraId?: string | null
  micId?: string | null
  fps: FrameRate
  screen: ManifestScreen | null
  camera: ManifestCamera | null
  clock: ManifestClock | null
  pauses: Interval[]
  endedAt: number | null
  stopReason: StopReason | null
  /** Duração gravada (ms, sem pausas), quando já se sabe. */
  recordedMs: number | null
  notes: string[]
  saved: ManifestSaved | null
  processedAt: string | null
  /**
   * O piloto automático ainda precisa começar para esta gravação. Gravado junto com `processedAt` (no mesmo arquivo atômico) e
   * apagado pelo piloto quando o estado dele já está no project.json: fechar o app no intervalo não perde a intenção.
   */
  autopilotPending?: boolean
  script?: VideoScript
  retakeMarks?: RetakeMark[]
  processing?: { done: ProcessStepId[]; sources: Project['sources'] }
}

export async function writeManifest(dir: string, manifest: RecordingManifest): Promise<void> {
  await writeFileAtomic(join(dir, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`)
}

export async function readManifest(dir: string): Promise<RecordingManifest> {
  const text = await readFile(join(dir, MANIFEST_PATH), 'utf8')
  const parsed = JSON.parse(text) as RecordingManifest
  if (parsed.version !== 1) throw new Error(`Versão do manifesto de gravação não suportada: ${String(parsed.version)}`)
  return parsed
}
