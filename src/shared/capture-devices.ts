import { CAMERA_PROFILES, cameraVideoConstraints, type CameraProfile } from './camera-quality'

/**
 * Mesmas restrições para gravação e calibração: o modo da câmera e os filtros mudam a latência. Sem `profile`,
 * o degrau seguro (1080p pedindo o modo de 60 qps, que em pouca luz entrega ~30 em vez dos 15 do modo de 30:
 * ver `@shared/camera-quality`). A gravação passa o degrau que a sondagem da abertura escolheu.
 */
export function deviceCaptureConstraints(cameraId: string | null, micId: string | null, prefs: { echoCancellation: boolean; noiseSuppression: boolean }, profile: CameraProfile = CAMERA_PROFILES.fhd) {
  return {
    video: cameraId ? { deviceId: { exact: cameraId }, ...cameraVideoConstraints(profile) } : false,
    audio: micId ? { deviceId: { exact: micId }, sampleRate: { ideal: 48000 }, channelCount: { ideal: 1 }, autoGainControl: false, echoCancellation: prefs.echoCancellation, noiseSuppression: prefs.noiseSuppression } : false
  }
}
export const isPhysicalDeviceId = (value: string | null | undefined): boolean => typeof value === 'string' && value.length > 0 && value.length <= 500 && !['default', 'communications'].includes(value)
export function physicalDeviceId(settings: { deviceId?: string; groupId?: string }, devices: readonly { kind: string; deviceId: string; groupId: string }[], kind: 'audioinput' | 'videoinput'): string | null {
  if (isPhysicalDeviceId(settings.deviceId)) return settings.deviceId!
  if (!settings.groupId) return null
  const matches = devices.filter((d) => d.kind === kind && d.groupId === settings.groupId && isPhysicalDeviceId(d.deviceId))
  return matches.length === 1 ? matches[0]!.deviceId : null
}
