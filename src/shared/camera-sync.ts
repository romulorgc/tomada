import type { Project } from './types'
import { isPhysicalDeviceId } from './capture-devices'

export type CameraSyncSegment = { startMs: number; durationMs: number; offsetMs: number; confidence: number }
export type CameraCalibration = { cameraId: string; micId: string; offsetMs: number; confidence: number; calibratedAt: string }

/** Positivo = imagem atrasada: buscar um quadro mais adiante; a voz conserva cameraOffsetMs. */
export function cameraVideoOffsetMs(project: Pick<Project, 'sync'>): number {
  return project.sync.cameraOffsetMs - (project.sync.cameraAvManualOffsetMs ?? project.sync.cameraAvOffsetMs ?? 0)
}

export function withManualCameraOffset(project: Project, value: number | null): Project {
  const sync = { ...project.sync }
  if (value === null) delete sync.cameraAvManualOffsetMs
  else sync.cameraAvManualOffsetMs = Math.max(-300, Math.min(300, Math.round(value / 10) * 10))
  return { ...project, sync }
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** SyncNet usa confiança em unidades de distância (não probabilidade). Exige dois trechos concordantes. */
export function selectCameraAvOffset(segments: readonly CameraSyncSegment[]): { offsetMs: number; confidence: number; accepted: number } | null {
  const credible = segments.filter((s) => Number.isFinite(s.offsetMs) && Math.abs(s.offsetMs) <= 600 && Number.isFinite(s.confidence) && s.confidence >= 3 && s.durationMs >= 1000)
  if (credible.length < 2) return null
  const center = median(credible.map((s) => s.offsetMs))
  const accepted = credible.filter((s) => Math.abs(s.offsetMs - center) <= 40)
  if (accepted.length < 2) return null
  return { offsetMs: median(accepted.map((s) => s.offsetMs)), confidence: median(accepted.map((s) => s.confidence)), accepted: accepted.length }
}

export function calibrationForPair(calibrations: readonly CameraCalibration[], cameraId: string | null | undefined, micId: string | null | undefined): CameraCalibration | undefined {
  if (!isPhysicalDeviceId(cameraId) || !isPhysicalDeviceId(micId)) return undefined
  return calibrations.find((c) => c.cameraId === cameraId && c.micId === micId)
}
