/**
 * `raw/recording.json`: o que foi gravado e como, para processar (e reprocessar) depois.
 * É gravado ao preparar, atualizado ao começar e ao parar; sobrevive a falhas do
 * processamento (o bruto fica na pasta e o "tentar de novo" lê isto).
 * Código puro de formato; a escrita atômica usa `fs-utils`. Sem Electron.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ProcessStepId, StopReason } from '@shared/ipc'
import { cameraCaptureInfoSchema, type CameraCaptureInfo } from '@shared/camera-quality'
import type { FrameRate, Interval, RecordMode } from '@shared/recording'
import type { CameraStyleChoice, CaptureInfo, Project, Rect, Size } from '@shared/types'
import type { VideoScript } from '@shared/script'
import type { RetakeMark } from '@shared/retake-marker'
import { writeFileAtomic } from './fs-utils'
import { resolveProjectFile } from './project-files'

export const MANIFEST_PATH = 'raw/recording.json'
export const RAW_SCREEN = 'raw/screen.webm'
export const RAW_CAMERA = 'raw/camera.webm'
export const RAW_MIC = 'raw/mic.webm'
export const RAW_MIC_PCM = 'raw/mic.wav'

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
  /** A janela gravada é um navegador (C1), segundo o rastreador. */
  browser?: { exe: string; engine: 'chromium' | 'gecko' }
}

export type ManifestCamera = {
  file: typeof RAW_CAMERA | typeof RAW_MIC | typeof RAW_MIC_PCM
  mime: string | null
  hasVideo: boolean
  hasAudio: boolean
  size: Size | null
  /** O que a abertura da câmera decidiu (degrau, qps medidos): o aviso de poucos qps do processamento fala disto. */
  capture?: CameraCaptureInfo
  /** Quadros por segundo REALMENTE gravados no bruto (medidos no passo "camera" do processamento). */
  measured?: { fps: number; width: number; height: number }
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
  /** A voz PCM substitui a trilha Opus; começa no cameraStartAt (referência antiga da voz). */
  micPcm?: boolean
  /** Positivo = silêncio na cabeça do PCM; negativo = trim. Preserva a referência de tempo da voz anterior. */
  pcmAlignment?: { offsetMs: number; correlation: number }
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
  /** O estilo da câmera escolhido na tela Gravar (só com tela + câmera). Ausente = quadro ao lado. */
  cameraStyle?: CameraStyleChoice
  /** Checkpoints durante a gravação: no relógio do renderer, nunca o da reabertura. */
  lastChunkAt?: number | null
  openPauseAt?: number | null
  /** A decisão de recuperar já foi tomada; ainda pode haver uma falha para repetir. */
  recoveryPending?: boolean
  script?: VideoScript
  retakeMarks?: RetakeMark[]
  processing?: { done: ProcessStepId[]; sources: Project['sources'] }
}

const manifestWrites = new Map<string, Promise<void>>()

export async function writeManifest(dir: string, manifest: RecordingManifest): Promise<void> {
  // Captura o checkpoint já: o objeto continua sendo atualizado pela gravação.
  const data = `${JSON.stringify(manifest, null, 2)}\n`
  const path = resolve(dir, MANIFEST_PATH)
  const key = process.platform === 'win32' ? path.toLowerCase() : path
  // Chunk, pausa, retomada e processamento compartilham a ordem dos renames.
  const task = (manifestWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    await writeFileAtomic(await resolveProjectFile(dir, MANIFEST_PATH), data)
  })
  manifestWrites.set(key, task)
  const clear = (): void => { if (manifestWrites.get(key) === task) manifestWrites.delete(key) }
  void task.then(clear, clear)
  await task // a falha desta escrita continua visível para quem a pediu
}

export async function readManifest(dir: string): Promise<RecordingManifest> {
  const text = await readFile(await resolveProjectFile(dir, MANIFEST_PATH), 'utf8')
  const parsed = JSON.parse(text) as RecordingManifest
  if (parsed.version !== 1) throw new Error(`Versão do manifesto de gravação não suportada: ${String(parsed.version)}`)
  if (typeof parsed.sessionId !== 'string' || typeof parsed.folder !== 'string' || typeof parsed.title !== 'string' || typeof parsed.createdAt !== 'string' || !Array.isArray(parsed.pauses) || !Array.isArray(parsed.notes) || parsed.notes.some((n) => typeof n !== 'string')) throw new Error('Manifesto de gravação inválido.')
  const finite = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n)
  if (parsed.clock && (!finite(parsed.clock.t0) || !finite(parsed.clock.offsetMs) || !finite(parsed.clock.rttMs))) throw new Error('Relógio inválido no manifesto de gravação.')
  for (const p of parsed.pauses) if (!finite(p?.start) || !finite(p?.end) || p.end < p.start) throw new Error('Pausa inválida no manifesto de gravação.')
  for (const value of [parsed.endedAt, parsed.recordedMs, parsed.lastChunkAt, parsed.openPauseAt]) if (value !== null && value !== undefined && !finite(value)) throw new Error('Tempo inválido no manifesto de gravação.')
  if (parsed.autopilotPending !== undefined && typeof parsed.autopilotPending !== 'boolean') throw new Error('Intenção do piloto inválida no manifesto de gravação.')
  // O que a abertura da câmera decidiu é só informação para o aviso: se não bate com o formato, some (o aviso fala do que sabe).
  if (parsed.camera && parsed.camera.capture !== undefined && !cameraCaptureInfoSchema.safeParse(parsed.camera.capture).success) delete parsed.camera.capture
  if (parsed.cameraStyle !== undefined && parsed.cameraStyle !== 'side-by-side' && parsed.cameraStyle !== 'presenter') throw new Error('Estilo da câmera inválido no manifesto de gravação.')
  if (parsed.micPcm !== undefined && typeof parsed.micPcm !== 'boolean') throw new Error('Formato do microfone inválido no manifesto de gravação.')
  if (parsed.pcmAlignment && (!finite(parsed.pcmAlignment.offsetMs) || Math.abs(parsed.pcmAlignment.offsetMs) > 250 || !finite(parsed.pcmAlignment.correlation) || parsed.pcmAlignment.correlation < 0 || parsed.pcmAlignment.correlation > 1.000001)) throw new Error('Alinhamento do PCM inválido no manifesto de gravação.')
  return parsed
}
