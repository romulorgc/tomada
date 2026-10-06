import { useEffect, useState } from 'react'
import { micCheck, type MicCheck } from '@shared/preflight'

/** Janela móvel de dois segundos, sem enviar amostras de voz pela IPC. */
export function useMicCheck(stream: MediaStream | null): MicCheck | null {
  const [check, setCheck] = useState<MicCheck | null>(null)
  useEffect(() => {
    const tracks = stream?.getAudioTracks() ?? []
    if (!tracks.length) { setCheck(null); return }
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    ctx.createMediaStreamSource(new MediaStream(tracks)).connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    const history: { t: number; meanSquare: number; peak: number }[] = []
    const since = performance.now()
    const timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0, peak = 0
      for (const sample of samples) { sum += sample * sample; peak = Math.max(peak, Math.abs(sample)) }
      const now = performance.now()
      history.push({ t: now, meanSquare: sum / samples.length, peak })
      while (history[0] && history[0].t < now - 2000) history.shift()
      const rms = Math.sqrt(history.reduce((a, b) => a + b.meanSquare, 0) / history.length)
      setCheck(micCheck({ rms, peak: Math.max(...history.map((h) => h.peak)), sampledMs: Math.min(2000, now - since) }))
    }, 100)
    return () => { window.clearInterval(timer); void ctx.close().catch(() => undefined); setCheck(null) }
  }, [stream])
  return check
}
