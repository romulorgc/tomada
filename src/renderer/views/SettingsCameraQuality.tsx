import { useEffect, useState } from 'react'
import { CAMERA_QUALITIES, DEFAULT_CAMERA_QUALITY, type CameraQuality } from '@shared/camera-quality'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'

/** Qualidade da câmera: a MESMA preferência que a gravação lê (`cameraQuality`). Máxima é o padrão. */
export function SettingsCameraQuality() {
  const notify = useApp((s) => s.notify)
  const [quality, setQuality] = useState<CameraQuality>(DEFAULT_CAMERA_QUALITY)
  useEffect(() => {
    void window.tomada.record.getPrefs().then((prefs) => setQuality(prefs.cameraQuality)).catch((err: unknown) => notify({ kind: 'error', text: t.settings.cameraQuality.title, detail: String(err) }))
  }, [notify])
  const choose = async (next: CameraQuality): Promise<void> => {
    try {
      const prefs = await window.tomada.record.setPrefs({ cameraQuality: next })
      setQuality(prefs.cameraQuality)
    } catch (err) {
      notify({ kind: 'error', text: t.settings.cameraQuality.title, detail: String(err) })
    }
  }
  return (
    <div className="grid gap-3" data-testid="settings-camera-quality-choice">
      <div className="seg" role="group" aria-label={t.settings.cameraQuality.title}>
        {CAMERA_QUALITIES.map((value) => (
          <button key={value} type="button" aria-pressed={quality === value} onClick={() => void choose(value)} data-testid={`settings-camera-quality-${value}`}>
            {t.settings.cameraQuality[value]}
          </button>
        ))}
      </div>
      <p className="text-[0.8125rem] text-faint">{t.settings.cameraQuality.help2[quality]}</p>
    </div>
  )
}
