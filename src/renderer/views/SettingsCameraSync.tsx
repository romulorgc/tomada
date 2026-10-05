import { useEffect, useRef, useState } from 'react'
import { cameraBitrate, pickRecorderMime } from '@shared/recording'
import { deviceCaptureConstraints, physicalDeviceId } from '@shared/capture-devices'
import type { CameraCalibration } from '@shared/camera-sync'
import { t } from '../i18n/pt-BR'
import { useDeviceLists } from '../recording/devices'

const T = t.settings.cameraSync
const MAX_BYTES = 32 * 1024 * 1024

export function CameraSyncSettings() {
  const { lists, error: deviceError } = useDeviceLists()
  const [cameraId, setCameraId] = useState('')
  const [micId, setMicId] = useState('')
  const [phase, setPhase] = useState<'idle' | 'recording' | 'analyzing'>('idle')
  const [remaining, setRemaining] = useState(5)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CameraCalibration | null>(null)
  const preview = useRef<HTMLVideoElement>(null)
  const live = useRef<MediaStream | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; live.current?.getTracks().forEach((track) => track.stop()) }
  }, [])
  useEffect(() => {
    if (!cameraId && lists?.cameras[0]) setCameraId(lists.cameras[0].deviceId)
    if (!micId && lists?.mics[0]) setMicId(lists.mics[0].deviceId)
  }, [lists, cameraId, micId])

  const calibrate = async (): Promise<void> => {
    setError(null)
    setResult(null)
    setRemaining(5)
    setPhase('recording')
    let timer: number | undefined
    try {
      const prefs = await window.tomada.record.getPrefs()
      const stream = await navigator.mediaDevices.getUserMedia(deviceCaptureConstraints(cameraId, micId, prefs))
      live.current = stream
      if (!alive.current) return
      const devices = await navigator.mediaDevices.enumerateDevices()
      const physicalCameraId = physicalDeviceId(stream.getVideoTracks()[0]!.getSettings(), devices, 'videoinput')
      const physicalMicId = physicalDeviceId(stream.getAudioTracks()[0]!.getSettings(), devices, 'audioinput')
      if (!physicalCameraId || !physicalMicId) throw new Error(T.unresolvedDevice)
      if (preview.current) { preview.current.srcObject = stream; await preview.current.play() }
      const mime = pickRecorderMime((candidate) => MediaRecorder.isTypeSupported(candidate), { video: true, audio: true })
      const videoSettings = stream.getVideoTracks()[0]!.getSettings()
      const recorder = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        videoBitsPerSecond: cameraBitrate({ w: videoSettings.width ?? 1280, h: videoSettings.height ?? 720 }, 30),
        audioBitsPerSecond: 128_000
      })
      const chunks: Blob[] = []
      let bytes = 0
      const data = await new Promise<ArrayBuffer>((resolve, reject) => {
        let ticks = 0
        recorder.ondataavailable = (event) => {
          bytes += event.data.size
          if (bytes > MAX_BYTES) { reject(new Error(T.tooLarge)); if (recorder.state !== 'inactive') recorder.stop(); return }
          chunks.push(event.data)
        }
        recorder.onerror = () => reject(new Error(T.captureFailed))
        recorder.onstop = () => { void new Blob(chunks).arrayBuffer().then(resolve, reject) }
        recorder.start(250)
        timer = window.setInterval(() => {
          ticks++
          if (alive.current) setRemaining(Math.max(0, 5 - ticks))
          if (ticks >= 5 || !alive.current) { window.clearInterval(timer); if (recorder.state !== 'inactive') recorder.stop() }
        }, 1000)
      })
      stream.getTracks().forEach((track) => track.stop())
      if (!alive.current) return
      setPhase('analyzing')
      const measured = await window.tomada.cameraSync.calibrate({ cameraId: physicalCameraId, micId: physicalMicId, data })
      if (alive.current) setResult(measured)
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
      window.tomada.log({ level: 'error', message: T.failed, detail: err instanceof Error ? err.message : String(err) })
    } finally {
      if (timer !== undefined) window.clearInterval(timer)
      live.current?.getTracks().forEach((track) => track.stop())
      live.current = null
      if (alive.current) setPhase('idle')
    }
  }
  return (
    <div className="grid gap-4" data-testid="settings-camera-sync-body">
      <p>{T.instructions}</p>
      <label className="grid min-w-0 gap-2">{T.camera}<select className="w-full min-w-0 rounded-control border border-line-strong bg-raised px-3 py-2 text-ink" data-testid="calibration-camera" value={cameraId} disabled={phase !== 'idle'} onChange={(event) => setCameraId(event.target.value)}>{lists?.cameras.map((device, i) => <option key={device.deviceId} value={device.deviceId}>{device.label || T.cameraName(i + 1)}</option>)}</select></label>
      <label className="grid min-w-0 gap-2">{T.mic}<select className="w-full min-w-0 rounded-control border border-line-strong bg-raised px-3 py-2 text-ink" data-testid="calibration-mic" value={micId} disabled={phase !== 'idle'} onChange={(event) => setMicId(event.target.value)}>{lists?.mics.map((device, i) => <option key={device.deviceId} value={device.deviceId}>{device.label || T.micName(i + 1)}</option>)}</select></label>
      <video ref={preview} muted playsInline className="w-full max-w-sm rounded-lg" hidden={phase !== 'recording'} />
      <button type="button" className="btn btn-secondary" data-testid="calibrate-sync" disabled={!cameraId || !micId || phase !== 'idle'} onClick={() => void calibrate()}>{phase === 'recording' ? T.recording(remaining) : phase === 'analyzing' ? T.analyzing : error ? T.retry : T.start}</button>
      {(error || deviceError) && <p role="alert" data-testid="calibration-error">{error || deviceError}</p>}
      {result && <p role="status" data-testid="calibration-success">{T.saved(result.offsetMs)}</p>}
    </div>
  )
}
