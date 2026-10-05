/**
 * Aba CÂMERA: mostrar/esconder, forma, tamanho, posição (grade 3×3; também dá para arrastar na prévia), borda,
 * espelhar e "encolher durante o zoom".
 */
import { CAMERA_CORNERS } from '@shared/styles'
import { withManualCameraOffset } from '@shared/camera-sync'
import type { CameraStyle, Corner } from '@shared/types'
import { CameraIcon, ShapeCircleIcon, ShapeRoundedIcon, ShapeSquareIcon } from '../../components/Icons'
import { t } from '../../i18n/pt-BR'
import { ColorField, Section, Segmented, Slider, Toggle } from '../controls'
import { useDoc, useEditor } from '../context'

const T = t.editor.camera

export function CameraPanel() {
  const { store, hasCamera } = useEditor()
  const cam = useDoc((s) => s.project.style.camera)
  const layout = useDoc((s) => s.project.style.defaultLayout)
  const vertical = useDoc((s) => s.format === 'vertical')
  const sync = useDoc((s) => s.project.sync)

  if (!hasCamera) {
    return (
      <div className="panel" data-testid="camera-panel">
        <div className="empty-state" data-testid="camera-empty">
          <CameraIcon size={28} />
          <p>{T.none}</p>
        </div>
      </div>
    )
  }

  const edit = (patch: Partial<CameraStyle>, coalesce?: string): void => {
    store.getState().change((p) => ({ ...p, style: { ...p.style, camera: { ...p.style.camera, ...patch } } }), coalesce ? { coalesce } : undefined)
  }
  const off = cam.hidden

  return (
    <div className="panel" data-testid="camera-panel">
      <Section title={T.title}>
        <Toggle label={T.show} checked={!cam.hidden} testId="camera-show" onChange={(v) => edit({ hidden: !v })} />
      </Section>

      <Section title={T.sync.title}>
        <Slider label={T.sync.title} value={sync.cameraAvManualOffsetMs ?? sync.cameraAvOffsetMs ?? 0} min={-300} max={300} step={10} testId="camera-sync" format={(v) => `${v > 0 ? '+' : ''}${v} ms`} onChange={(v) => store.getState().change((p) => withManualCameraOffset(p, v), { coalesce: 'camera-sync' })} />
        <p className="pos-help">{T.sync.help}</p>
        <p className="pos-help" data-testid="camera-sync-status">{sync.cameraAvManualOffsetMs !== undefined ? T.sync.manual : T.sync.automatic(sync.cameraAvOffsetMs ?? 0)}</p>
        {sync.cameraAvDetection?.reason && <p className="pos-help">{sync.cameraAvDetection.reason}</p>}
        <button type="button" data-testid="camera-sync-auto" disabled={sync.cameraAvManualOffsetMs === undefined} onClick={() => store.getState().change((p) => withManualCameraOffset(p, null))}>{T.sync.reset}</button>
      </Section>

      <div className="panel-group" data-disabled={off} aria-disabled={off}>
        <Section title={T.shape}>
          <Segmented<CameraStyle['shape']>
            label={T.shape}
            variant="icon"
            value={cam.shape}
            onChange={(shape) => edit({ shape })}
            options={[
              { value: 'circle', label: T.shapes.circle, icon: <ShapeCircleIcon size={16} />, disabled: off, testId: 'camera-shape-circle' },
              { value: 'rounded', label: T.shapes.rounded, icon: <ShapeRoundedIcon size={16} />, disabled: off, testId: 'camera-shape-rounded' },
              { value: 'square', label: T.shapes.square, icon: <ShapeSquareIcon size={16} />, disabled: off, testId: 'camera-shape-square' }
            ]}
          />
          <Slider label={T.size} value={cam.size} min={0.12} max={0.5} step={0.005} testId="camera-size" disabled={off} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => edit({ size: v }, 'camera-size')} />
        </Section>

        <Section title={T.position}>
          <div className="pos-row">
            <div className="corner-grid" role="group" aria-label={T.position} data-testid="camera-corners">
              {CAMERA_CORNERS.map((c: Corner) => (
                <button
                  key={c}
                  type="button"
                  aria-label={T.positions[c]}
                  title={T.positions[c]}
                  aria-pressed={cam.corner === c}
                  disabled={off}
                  data-testid={`corner-${c}`}
                  onClick={() => edit({ corner: c })}
                />
              ))}
            </div>
            <p className="pos-help">{vertical ? T.positionVertical : layout === 'bubble' ? T.positionHelp : T.positionOnlyBubble}</p>
          </div>
        </Section>

        <Section title={T.border}>
          <Slider label={T.borderWidth} value={cam.borderWidth} min={0} max={12} step={1} testId="camera-border" disabled={off} format={(v) => `${Math.round(v)} px`} onChange={(v) => edit({ borderWidth: v }, 'camera-border')} />
          <ColorField label={T.borderColor} value={cam.borderColor} testId="camera-border-color" onChange={(c) => edit({ borderColor: c }, 'camera-border-color')} />
        </Section>

        <Section title={T.behavior}>
          <Toggle label={T.mirror} checked={cam.mirror} testId="camera-mirror" disabled={off} onChange={(v) => edit({ mirror: v })} />
          <Toggle label={T.shrink} checked={cam.shrinkOnZoom} testId="camera-shrink" disabled={off} onChange={(v) => edit({ shrinkOnZoom: v })} />
        </Section>
      </div>
    </div>
  )
}
