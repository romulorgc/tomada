/**
 * Contrato dos motores da análise da câmera (M4c). Quem usa (o serviço, os testes) só conhece esta interface.
 */
import type { CameraEngineId, CameraFeatureState } from '@shared/camera-analysis'
import type { FaceTrack } from '@shared/face'
import type { PrepareTracker, StepSpec } from '../transcription/prepare-tracker'

export type CameraCheck = {
  face: CameraFeatureState
  matte: CameraFeatureState
  /** A placa usada ("NVIDIA GeForce RTX 3050 Laptop GPU") ou null se for o processador. */
  device: string | null
}

export type DetectFacesOptions = {
  /** Arquivo da câmera, caminho ABSOLUTO já resolvido por `resolveProjectFile`. */
  video: string
  /** Duração conhecida (ms): dá o tempo limite proporcional. */
  durationMs: number
  signal?: AbortSignal
  /** 0..1 */
  onProgress?: (fraction: number) => void
}

export interface CameraEngine {
  readonly id: CameraEngineId
  /** Os passos da preparação de primeira vez (com peso), para o rastreador. */
  readonly prepareSteps: readonly StepSpec[]
  /** Está tudo no lugar? Rápido: só olha arquivos e a marca de "preparado". */
  check(): Promise<CameraCheck>
  /** Prepara de primeira vez (ou retoma/repara). Lança com o motivo; o rastreador já foi avisado. */
  prepare(tracker: PrepareTracker, signal: AbortSignal): Promise<void>
  /** Acha o rosto ao longo da gravação (uma olhada a cada `sampleMs`). */
  detectFaces(opts: DetectFacesOptions): Promise<FaceTrack>
}
