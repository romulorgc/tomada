/**
 * Aba CÂMERA: mostrar/esconder, o ENQUADRAMENTO DO ROSTO (o recorte acompanha o rosto; aproximação e deslocamento à mão; também dá
 * para arrastar dentro da câmera na prévia), a câmera AO LADO da tela (lado, formato, largura e espaço), o APRESENTADOR RECORTADO
 * (o recorte do fundo, o canto, a altura da pessoa, contorno e sombra), forma, tamanho, posição
 * (grade 3×3; também dá para arrastar a bolha na prévia), borda, espelhar e "encolher durante o zoom".
 */
import { MANUAL_ZOOM, MANUAL_OFFSET_MAX, resolveFraming } from '@shared/face'
import { PRESENTER, SIDE_GAP, SIDE_WIDTH, CAMERA_CORNERS, resolvePresenter, resolveSideBySide } from '@shared/styles'
import type { CameraFraming, CameraStyle, Corner, PresenterStyle, SideBySideStyle } from '@shared/types'
import { cameraJobKey, isCameraJobActive, useCamera } from '../../camera-store'
import { CameraPrepare } from '../../components/CameraPrepare'
import { CameraIcon, ShapeCircleIcon, ShapeRoundedIcon, ShapeSquareIcon } from '../../components/Icons'
import { t } from '../../i18n/pt-BR'
import { ColorField, Section, Segmented, Slider, Toggle } from '../controls'
import { useDoc, useEditor } from '../context'

const T = t.editor.camera
const F = T.framing
const S = T.side
const P = T.presenter

/** O estado da análise do rosto: preparar o motor, procurando, achado, não achado, ou o erro com o "tentar de novo". */
function FaceStatus() {
  const { detail, face } = useEditor()
  const view = useCamera((s) => s.view)
  const job = useCamera((s) => s.jobs[cameraJobKey(detail.id, 'face')])
  const analyze = useCamera((s) => s.analyze)
  const cancel = useCamera((s) => s.cancel)
  const pct = Math.round((job?.fraction ?? 0) * 100)

  if (isCameraJobActive(job)) {
    return (
      <div className="cam-status" data-testid="face-status" data-state={job!.state}>
        <p className="ctl-note" aria-live="polite">
          {job!.state === 'queued' ? F.status.queued : F.status.running(pct)}
        </p>
        <div className="meter" role="progressbar" aria-label={F.status.running(pct)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => void cancel(detail.id, 'face')} data-testid="face-cancel">
          {F.status.cancel}
        </button>
      </div>
    )
  }
  if (job?.state === 'error' || face.status === 'error') {
    const message = job?.state === 'error' ? job.error : face.error
    return (
      <div className="cam-status" role="alert" data-testid="face-status" data-state="error">
        <p className="ctl-note">
          {job?.state === 'error' ? F.status.failed : F.status.unreadable}
          {message ? `: ${message}` : ''}
        </p>
        <button type="button" className="btn" onClick={() => void analyze(detail.id, 'face')} data-testid="face-retry">
          {F.status.retry}
        </button>
      </div>
    )
  }
  if (view && view.face.state !== 'ready' && face.status !== 'ready') return <CameraPrepare explain={F.needsPrepare} />
  if (face.status === 'loading') return <p className="ctl-note" data-testid="face-status" data-state="loading">{F.status.running(100)}</p>
  if (face.status === 'ready' && face.data) {
    const looks = face.data.sampleMs > 0 ? Math.max(1, Math.round(face.data.durationMs / face.data.sampleMs)) : face.data.boxes.length
    const coverage = Math.min(1, face.data.boxes.length / looks)
    return (
      <p className="ctl-note" data-testid="face-status" data-state={face.data.boxes.length > 0 ? 'found' : 'none'}>
        {face.data.boxes.length > 0 ? F.status.found(Math.round(coverage * 100)) : F.status.none}
      </p>
    )
  }
  return (
    <div className="cam-status" data-testid="face-status" data-state="missing">
      <p className="ctl-note">{F.status.missing}</p>
      <button type="button" className="btn" onClick={() => void analyze(detail.id, 'face')} data-testid="face-start">
        {F.status.retry}
      </button>
    </div>
  )
}

/** O estado do recorte do fundo: preparar o motor, recortando (com o andamento), pronto, ainda não feito, ou o erro com o "tentar de novo". */
function MatteStatus() {
  const { detail, matte } = useEditor()
  const view = useCamera((s) => s.view)
  const job = useCamera((s) => s.jobs[cameraJobKey(detail.id, 'matte')])
  const analyze = useCamera((s) => s.analyze)
  const cancel = useCamera((s) => s.cancel)
  const pct = Math.round((job?.fraction ?? 0) * 100)

  if (isCameraJobActive(job)) {
    return (
      <div className="cam-status" data-testid="matte-status" data-state={job!.state}>
        <p className="ctl-note" aria-live="polite">
          {job!.state === 'queued' ? P.status.queued : P.status.running(pct)}
        </p>
        <div className="meter" role="progressbar" aria-label={P.status.running(pct)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => void cancel(detail.id, 'matte')} data-testid="matte-cancel">
          {P.status.cancel}
        </button>
      </div>
    )
  }
  if (job?.state === 'error') {
    return (
      <div className="cam-status" role="alert" data-testid="matte-status" data-state="error">
        <p className="ctl-note">
          {P.status.failed}
          {job.error ? `: ${job.error}` : ''}
        </p>
        <button type="button" className="btn" onClick={() => void analyze(detail.id, 'matte')} data-testid="matte-retry">
          {P.status.retry}
        </button>
      </div>
    )
  }
  if (matte.url) {
    const cpu = view && view.matte.state === 'ready' && view.matte.detail
    return (
      <div className="cam-status" data-testid="matte-status" data-state="ready">
        <p className="ctl-note">{P.status.ready}</p>
        {cpu ? <p className="ctl-note">{view.matte.detail}</p> : null}
        <button type="button" className="btn btn-ghost" onClick={() => void analyze(detail.id, 'matte')} data-testid="matte-redo">
          {P.status.redo}
        </button>
      </div>
    )
  }
  if (view && view.matte.state !== 'ready') {
    // o preparo do rosto e o do recorte são UM só (mesmo ambiente, mesmos pacotes): enquanto o do rosto ainda aparece no alto da aba, não há segunda caixa
    if (view.face.state !== 'ready') {
      return (
        <p className="ctl-note" data-testid="matte-needs-prepare">
          {P.needsPrepareAbove}
        </p>
      )
    }
    return <CameraPrepare feature="matte" explain={P.needsPrepare} />
  }
  return (
    <div className="cam-status" data-testid="matte-status" data-state="missing">
      <p className="ctl-note">{P.status.missing}</p>
      <button type="button" className="btn" onClick={() => void analyze(detail.id, 'matte')} data-testid="matte-start">
        {P.status.start}
      </button>
    </div>
  )
}

export function CameraPanel() {
  const { store, hasCamera } = useEditor()
  const cam = useDoc((s) => s.project.style.camera)
  const layout = useDoc((s) => s.project.style.defaultLayout)
  const sideBySide = useDoc((s) => s.project.style.sideBySide)
  const presenterStyle = useDoc((s) => s.project.style.presenter)
  const vertical = useDoc((s) => s.format === 'vertical')

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
  const editFraming = (patch: Partial<CameraFraming>, coalesce?: string): void => {
    store.getState().change((p) => ({ ...p, style: { ...p.style, camera: { ...p.style.camera, framing: { ...p.style.camera.framing, ...patch } } } }), coalesce ? { coalesce } : undefined)
  }
  const resetFraming = (): void => {
    store.getState().change((p) => {
      const { framing: _gone, ...rest } = p.style.camera
      void _gone
      return { ...p, style: { ...p.style, camera: rest } }
    })
  }
  const editSide = (patch: Partial<SideBySideStyle>, coalesce?: string): void => {
    store.getState().change((p) => ({ ...p, style: { ...p.style, sideBySide: { ...p.style.sideBySide, ...patch } } }), coalesce ? { coalesce } : undefined)
  }
  const editPresenter = (patch: Partial<PresenterStyle>, coalesce?: string): void => {
    store.getState().change((p) => ({ ...p, style: { ...p.style, presenter: { ...p.style.presenter, ...patch } } }), coalesce ? { coalesce } : undefined)
  }
  const off = cam.hidden
  const framing = resolveFraming(cam.framing)
  const hasManual = cam.framing !== undefined && (cam.framing.zoom !== undefined || cam.framing.dx !== undefined || cam.framing.dy !== undefined || cam.framing.auto === false)
  const side = resolveSideBySide(sideBySide)
  const sideActive = layout === 'side-by-side'
  const presenter = resolvePresenter(presenterStyle)
  const presenterActive = layout === 'presenter'

  return (
    <div className="panel" data-testid="camera-panel">
      <Section title={T.title}>
        <Toggle label={T.show} checked={!cam.hidden} testId="camera-show" onChange={(v) => edit({ hidden: !v })} />
      </Section>

      <div className="panel-group" data-disabled={off} aria-disabled={off}>
        <Section title={F.title} testId="camera-framing">
          <FaceStatus />
          <Toggle label={F.auto} hint={F.autoHint} checked={framing.auto} testId="framing-auto" disabled={off} onChange={(v) => editFraming({ auto: v })} />
          <Slider
            label={F.zoom}
            value={framing.zoom}
            min={MANUAL_ZOOM.min}
            max={MANUAL_ZOOM.max}
            step={0.05}
            testId="framing-zoom"
            disabled={off}
            format={F.zoomValue}
            onChange={(v) => editFraming({ zoom: v }, 'framing-zoom')}
          />
          <Slider
            label={F.horizontal}
            value={framing.dx}
            min={-MANUAL_OFFSET_MAX}
            max={MANUAL_OFFSET_MAX}
            step={0.005}
            testId="framing-dx"
            disabled={off}
            format={F.offset}
            onChange={(v) => editFraming({ dx: v }, 'framing-dx')}
          />
          <Slider
            label={F.vertical}
            value={framing.dy}
            min={-MANUAL_OFFSET_MAX}
            max={MANUAL_OFFSET_MAX}
            step={0.005}
            testId="framing-dy"
            disabled={off}
            format={F.offset}
            onChange={(v) => editFraming({ dy: v }, 'framing-dy')}
          />
          <p className="ctl-note">{F.dragHint}</p>
          <button type="button" className="btn btn-wide" disabled={off || !hasManual} onClick={resetFraming} data-testid="framing-reset">
            {F.reset}
          </button>
        </Section>

        {!vertical ? (
          <Section title={S.title} testId="camera-side">
            <p className="ctl-note">{S.help}</p>
            {!sideActive ? <p className="ctl-note" data-testid="side-inactive">{S.notActive}</p> : null}
            <Segmented<'left' | 'right'>
              label={S.side}
              value={side.side}
              onChange={(v) => editSide({ side: v })}
              options={[
                { value: 'left', label: S.sides.left, disabled: off, testId: 'side-left' },
                { value: 'right', label: S.sides.right, disabled: off, testId: 'side-right' }
              ]}
            />
            <Segmented<'portrait' | 'square'>
              label={S.ratio}
              value={side.ratio}
              onChange={(v) => editSide({ ratio: v })}
              options={[
                { value: 'portrait', label: S.ratios.portrait, disabled: off, testId: 'side-portrait' },
                { value: 'square', label: S.ratios.square, disabled: off, testId: 'side-square' }
              ]}
            />
            <Slider label={S.width} value={side.width} min={SIDE_WIDTH.min} max={SIDE_WIDTH.max} step={0.005} testId="side-width" disabled={off} format={S.percent} onChange={(v) => editSide({ width: v }, 'side-width')} />
            <Slider label={S.gap} value={side.gap} min={SIDE_GAP.min} max={SIDE_GAP.max} step={0.002} testId="side-gap" disabled={off} format={S.percent} onChange={(v) => editSide({ gap: v }, 'side-gap')} />
          </Section>
        ) : null}

        <Section title={P.title} testId="camera-presenter">
          <p className="ctl-note">{P.help}</p>
          {!presenterActive ? (
            <p className="ctl-note" data-testid="presenter-inactive">
              {P.notActive}
            </p>
          ) : null}
          <MatteStatus />
          {!vertical ? (
            <Segmented<'left' | 'right'>
              label={P.side}
              value={presenter.side}
              onChange={(v) => editPresenter({ side: v })}
              options={[
                { value: 'left', label: P.sides.left, disabled: off, testId: 'presenter-left' },
                { value: 'right', label: P.sides.right, disabled: off, testId: 'presenter-right' }
              ]}
            />
          ) : null}
          {vertical ? (
            <Slider
              label={P.height}
              value={presenter.heightV}
              min={PRESENTER.heightV.min}
              max={PRESENTER.heightV.max}
              step={0.005}
              testId="presenter-height"
              disabled={off}
              format={P.percent}
              onChange={(v) => editPresenter({ heightV: v }, 'presenter-height')}
            />
          ) : (
            <Slider
              label={P.height}
              value={presenter.height}
              min={PRESENTER.height.min}
              max={PRESENTER.height.max}
              step={0.005}
              testId="presenter-height"
              disabled={off}
              format={P.percent}
              onChange={(v) => editPresenter({ height: v }, 'presenter-height')}
            />
          )}
          <Toggle label={P.outline} hint={P.outlineHint} checked={presenter.outline} testId="presenter-outline" disabled={off} onChange={(v) => editPresenter({ outline: v })} />
          <Slider
            label={P.outlineWidth}
            value={presenter.outlineWidth}
            min={PRESENTER.outline.min}
            max={PRESENTER.outline.max}
            step={1}
            testId="presenter-outline-width"
            disabled={off || !presenter.outline}
            format={(v) => `${Math.round(v)} px`}
            onChange={(v) => editPresenter({ outlineWidth: v }, 'presenter-outline-width')}
          />
          <Toggle label={P.shadow} checked={presenter.shadow} testId="presenter-shadow" disabled={off} onChange={(v) => editPresenter({ shadow: v })} />
          <p className="ctl-note">{P.mirrorHint}</p>
        </Section>

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
          {!vertical ? <p className="ctl-note">{T.borderNote}</p> : null}
        </Section>

        <Section title={T.behavior}>
          <Toggle label={T.mirror} checked={cam.mirror} testId="camera-mirror" disabled={off} onChange={(v) => edit({ mirror: v })} />
          <Toggle label={T.shrink} checked={cam.shrinkOnZoom} testId="camera-shrink" disabled={off} onChange={(v) => edit({ shrinkOnZoom: v })} />
        </Section>
      </div>
    </div>
  )
}
