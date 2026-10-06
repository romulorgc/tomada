import { expect, it } from 'vitest'
import { deviceCaptureConstraints, physicalDeviceId } from '@shared/capture-devices'
import { calibrationForPair } from '@shared/camera-sync'

it('calibração e gravação pedem exatamente o mesmo modo de captura', () => {
  expect(deviceCaptureConstraints('cam', 'mic', { echoCancellation: true, noiseSuppression: true })).toEqual({ video: { deviceId: { exact: 'cam' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } }, audio: { deviceId: { exact: 'mic' }, sampleRate: { ideal: 48000 }, channelCount: { ideal: 1 }, autoGainControl: false, echoCancellation: true, noiseSuppression: true } })
})
it('resolve o padrão pelo grupo físico e nunca reaproveita calibração ao mudar o microfone padrão', () => {
  const devices = [{ kind: 'audioinput', deviceId: 'mic-A', groupId: 'A' }, { kind: 'audioinput', deviceId: 'mic-B', groupId: 'B' }]
  expect(physicalDeviceId({ deviceId: 'default', groupId: 'A' }, devices, 'audioinput')).toBe('mic-A')
  expect(physicalDeviceId({ deviceId: 'default', groupId: 'B' }, devices, 'audioinput')).toBe('mic-B')
  const calibration = { cameraId: 'cam', micId: 'mic-A', offsetMs: 80, confidence: 4, calibratedAt: 'hoje' }
  expect(calibrationForPair([calibration], 'cam', physicalDeviceId({ deviceId: 'default', groupId: 'B' }, devices, 'audioinput'))).toBeUndefined()
  expect(calibrationForPair([{ ...calibration, micId: 'default' }], 'cam', 'default')).toBeUndefined()
  expect(physicalDeviceId({ deviceId: 'default' }, devices, 'audioinput')).toBeNull()
})
