import { useEffect, useState } from 'react'
import { DEFAULT_RECORD_PREFS } from '@shared/recording'
import type { CameraStyleChoice } from '@shared/types'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'

const STYLES: CameraStyleChoice[] = ['side-by-side', 'presenter']

/** O padrão do estilo da câmera: é a MESMA preferência da tela Gravar (a última escolha vira o padrão). */
export function SettingsCameraStyle() {
  const notify = useApp((s) => s.notify)
  const [style, setStyle] = useState<CameraStyleChoice>(DEFAULT_RECORD_PREFS.cameraStyle)
  useEffect(() => {
    void window.tomada.record.getPrefs().then((prefs) => setStyle(prefs.cameraStyle)).catch((err: unknown) => notify({ kind: 'error', text: t.settings.cameraStyle.title, detail: String(err) }))
  }, [notify])
  const choose = async (next: CameraStyleChoice): Promise<void> => {
    try {
      const prefs = await window.tomada.record.setPrefs({ cameraStyle: next })
      setStyle(prefs.cameraStyle)
    } catch (err) {
      notify({ kind: 'error', text: t.settings.cameraStyle.title, detail: String(err) })
    }
  }
  return (
    <div className="grid gap-3" data-testid="settings-camera-style-choice">
      <div className="seg" role="group" aria-label={t.settings.cameraStyle.title}>
        {STYLES.map((value) => (
          <button key={value} type="button" aria-pressed={style === value} onClick={() => void choose(value)} data-testid={`settings-camera-style-${value}`}>
            {t.record.cameraStyle[value]}
          </button>
        ))}
      </div>
      <p className="text-[0.8125rem] text-faint">{t.record.cameraStyle.help[style]}</p>
    </div>
  )
}
