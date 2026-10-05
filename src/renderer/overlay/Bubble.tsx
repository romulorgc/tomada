/**
 * Bolha da câmera sobre a tela durante a gravação (não aparece no vídeo: a janela é
 * excluída da captura). Arrastável. Abre a mesma câmera da gravação (o Chromium
 * compartilha o dispositivo entre as duas janelas).
 */
import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n/pt-BR'

export function Bubble() {
  const ref = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    let stream: MediaStream | null = null
    void (async () => {
      try {
        const config = await window.tomada.bubble.config()
        if (!config || !alive) return
        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: config.cameraId }, width: { ideal: 640 }, height: { ideal: 640 } },
          audio: false
        })
        if (!alive) {
          stream.getTracks().forEach((tr) => tr.stop())
          return
        }
        const video = ref.current
        if (video) {
          video.style.transform = config.mirror ? 'scaleX(-1)' : 'none'
          video.srcObject = stream
          await video.play().catch(() => undefined)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        window.tomada.log({ level: 'warn', message: 'A bolha da câmera não abriu a câmera', detail: message })
        if (alive) setError(message)
      }
    })()
    return () => {
      alive = false
      stream?.getTracks().forEach((tr) => tr.stop())
    }
  }, [])

  return (
    <div className="bubble" role="img" aria-label={t.bubble.label} data-testid="bubble">
      <video ref={ref} muted playsInline />
      {error ? <p className="absolute inset-0 grid place-items-center p-4 text-center text-[0.8125rem] text-muted">{t.bubble.error}</p> : null}
    </div>
  )
}
