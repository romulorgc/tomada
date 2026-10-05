/**
 * Dispositivos de câmera e microfone para a tela Gravar: lista, prévia ao vivo e medidor
 * de nível. A gravação de verdade abre os próprios streams (`CaptureEngine.open`); a
 * prévia é solta antes disso.
 */
import { useEffect, useRef, useState } from 'react'
import { levelToMeter, peakFromBytes, smoothMeter } from '@shared/recording'
import { explainMediaError } from './media-errors'

export type DeviceLists = { cameras: MediaDeviceInfo[]; mics: MediaDeviceInfo[] }

const stopAll = (s: MediaStream | null): void => s?.getTracks().forEach((t) => t.stop())

/** `enumerateDevices` só traz os nomes depois que alguma captura foi permitida. */
async function unlockLabels(): Promise<void> {
  for (const constraints of [{ audio: true, video: true }, { audio: true }, { video: true }] as MediaStreamConstraints[]) {
    try {
      stopAll(await navigator.mediaDevices.getUserMedia(constraints))
      return
    } catch {
      // tenta o próximo (talvez só falte a câmera ou só o microfone)
    }
  }
}

async function listDevices(): Promise<DeviceLists> {
  let all = await navigator.mediaDevices.enumerateDevices()
  const needsLabels = all.some((d) => (d.kind === 'videoinput' || d.kind === 'audioinput') && d.label === '')
  if (needsLabels) {
    await unlockLabels()
    all = await navigator.mediaDevices.enumerateDevices()
  }
  return {
    cameras: all.filter((d) => d.kind === 'videoinput'),
    mics: all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications')
  }
}

/** Lista de câmeras e microfones, atualizada quando algo é plugado ou desplugado. */
export function useDeviceLists(): { lists: DeviceLists | null; error: string | null } {
  const [lists, setLists] = useState<DeviceLists | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      listDevices()
        .then((l) => {
          if (!alive) return
          setLists(l)
          setError(null)
        })
        .catch((err: unknown) => {
          if (!alive) return
          window.tomada.log({ level: 'error', message: 'Falha ao listar câmeras e microfones', detail: err instanceof Error ? err.message : String(err) })
          setError(explainMediaError(err, 'camera'))
          setLists({ cameras: [], mics: [] })
        })
    }
    refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => {
      alive = false
      navigator.mediaDevices.removeEventListener('devicechange', refresh)
    }
  }, [])

  return { lists, error }
}

export type PreviewParams = {
  cameraId: string | null
  micId: string | null
  noiseSuppression: boolean
  echoCancellation: boolean
  enabled: boolean
}

/** Stream de prévia (câmera pequena + microfone). Fecha ao trocar de dispositivo e ao sair. */
export function useDevicePreview(p: PreviewParams): { stream: MediaStream | null; error: string | null; loading: boolean } {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!p.enabled || (!p.cameraId && !p.micId)) {
      setStream(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    let current: MediaStream | null = null
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: p.cameraId ? { deviceId: { exact: p.cameraId }, width: { ideal: 640 }, height: { ideal: 360 } } : false,
          audio: p.micId
            ? { deviceId: { exact: p.micId }, autoGainControl: false, echoCancellation: p.echoCancellation, noiseSuppression: p.noiseSuppression }
            : false
        })
        if (cancelled) {
          stopAll(s)
          return
        }
        current = s
        setStream(s)
      } catch (err) {
        if (cancelled) return
        setStream(null)
        setError(explainMediaError(err, p.cameraId ? 'camera' : 'microphone'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      stopAll(current)
      setStream(null)
    }
  }, [p.cameraId, p.micId, p.noiseSuppression, p.echoCancellation, p.enabled])

  return { stream, error, loading }
}

/** Nível do microfone (0..1, escala do medidor) de um stream; atualiza ~20 vezes por segundo. */
export function useMicLevel(stream: MediaStream | null): number {
  const [level, setLevel] = useState(0)
  const last = useRef(0)

  useEffect(() => {
    const tracks = stream?.getAudioTracks() ?? []
    if (!stream || tracks.length === 0) {
      setLevel(0)
      return
    }
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    ctx.createMediaStreamSource(new MediaStream(tracks)).connect(analyser)
    const bytes = new Uint8Array(analyser.fftSize)
    let value = 0
    last.current = performance.now()
    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(bytes)
      const now = performance.now()
      value = smoothMeter(value, levelToMeter(peakFromBytes(bytes)), now - last.current)
      last.current = now
      setLevel(value)
    }, 50)
    return () => {
      window.clearInterval(timer)
      void ctx.close().catch(() => undefined)
      setLevel(0)
    }
  }, [stream])

  return level
}
