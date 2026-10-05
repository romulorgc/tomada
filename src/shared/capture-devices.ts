/** Mesmas restrições para gravação e calibração: o modo da câmera e os filtros mudam a latência. */
export function deviceCaptureConstraints(cameraId: string | null, micId: string | null, prefs: { echoCancellation: boolean; noiseSuppression: boolean }) {
  return {
    video: cameraId ? { deviceId: { exact: cameraId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } } : false,
    audio: micId ? { deviceId: { exact: micId }, autoGainControl: false, echoCancellation: prefs.echoCancellation, noiseSuppression: prefs.noiseSuppression } : false
  }
}
export const isPhysicalDeviceId = (value: string | null | undefined): boolean => typeof value === 'string' && value.length > 0 && value.length <= 500 && !['default', 'communications'].includes(value)
export function physicalDeviceId(settings: { deviceId?: string; groupId?: string }, devices: readonly { kind: string; deviceId: string; groupId: string }[], kind: 'audioinput' | 'videoinput'): string | null {
  if (isPhysicalDeviceId(settings.deviceId)) return settings.deviceId!
  if (!settings.groupId) return null
  const matches = devices.filter((d) => d.kind === kind && d.groupId === settings.groupId && isPhysicalDeviceId(d.deviceId))
  return matches.length === 1 ? matches[0]!.deviceId : null
}
