/**
 * A PRÉVIA: o canvas onde o motor desenha (mesma cena da exportação), mais o que dá para fazer em cima dele:
 *  - arrastar a bolha da câmera (gruda numa das 9 posições da grade);
 *  - com um zoom selecionado, clicar na prévia fixa o foco daquele zoom naquele ponto;
 *  - estado de erro desenhado (vídeo que não abre).
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { setZoomFocus } from '@shared/edits'
import type { Scene } from '@shared/scene'
import type { Corner } from '@shared/types'
import { AlertIcon, FolderIcon, TargetIcon } from '../components/Icons'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'
import { useDoc, useEditor, usePlayback } from './context'

type DragMode = { mode: 'camera' }

/** A posição da grade 3×3 mais próxima de um ponto (fração 0..1 da área da tela). */
function nearestCorner(fx: number, fy: number): Corner {
  const col = fx < 1 / 3 ? 'left' : fx < 2 / 3 ? 'center' : 'right'
  const row = fy < 1 / 3 ? 'top' : fy < 2 / 3 ? 'middle' : 'bottom'
  return `${row}-${col}` as Corner
}

const inside = (p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }, pad = 0): boolean =>
  p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad

export function PreviewStage({ canvasRef, hostRef, frameRef }: { canvasRef: RefObject<HTMLCanvasElement | null>; hostRef: RefObject<HTMLDivElement | null>; frameRef: RefObject<HTMLDivElement | null> }) {
  const { store, engineRef, detail } = useEditor()
  const revealProject = useApp((s) => s.revealProject)
  const selection = useDoc((s) => s.selection)
  const zooms = useDoc((s) => s.project.zooms)
  const error = usePlayback((s) => s.error)
  const [cursor, setCursor] = useState<'default' | 'grab' | 'grabbing' | 'crosshair'>('default')
  const drag = useRef<DragMode | null>(null)

  const selected = selection?.kind === 'zoom' ? zooms.find((z) => z.id === selection.id) : undefined
  const focus = selected && selected.focus !== 'auto' ? selected.focus : null
  // o marcador do foco acompanha a imagem; sem foco fixo esta assinatura é constante e não re-renderiza
  usePlayback((s) => (focus ? s.sourceMs : 0))

  const toCanvas = (e: ReactPointerEvent): { x: number; y: number } | null => {
    const frame = frameRef.current
    const canvas = canvasRef.current
    if (!frame || !canvas) return null
    const rect = frame.getBoundingClientRect()
    return { x: ((e.clientX - rect.left) * canvas.width) / rect.width, y: ((e.clientY - rect.top) * canvas.height) / rect.height }
  }

  const cameraHit = (scene: Scene | null, p: { x: number; y: number }): boolean =>
    Boolean(scene && scene.screen && scene.camera && scene.debug.layout === 'bubble' && scene.debug.previous === scene.debug.layout && inside(p, scene.camera.dest, 4))

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const scene = engineRef.current?.scene ?? null
    const p = toCanvas(e)
    if (!scene || !p) return
    if (cameraHit(scene, p)) {
      e.currentTarget.setPointerCapture(e.pointerId)
      store.getState().begin()
      drag.current = { mode: 'camera' }
      setCursor('grabbing')
      return
    }
    if (selected && scene.screen && inside(p, scene.screen.dest)) {
      const { dest, src } = scene.screen
      const x = src.x + ((p.x - dest.x) / dest.w) * src.w
      const y = src.y + ((p.y - dest.y) / dest.h) * src.h
      store.getState().change((doc) => setZoomFocus(doc, selected.id, { x, y }))
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const scene = engineRef.current?.scene ?? null
    const p = toCanvas(e)
    if (!scene || !p) return
    if (drag.current?.mode === 'camera' && scene.screen) {
      const { dest } = scene.screen
      const corner = nearestCorner((p.x - dest.x) / dest.w, (p.y - dest.y) / dest.h)
      store.getState().change((doc) => (doc.style.camera.corner === corner ? doc : { ...doc, style: { ...doc.style, camera: { ...doc.style.camera, corner } } }))
      return
    }
    setCursor(cameraHit(scene, p) ? 'grab' : selected && scene.screen && inside(p, scene.screen.dest) ? 'crosshair' : 'default')
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    store.getState().end()
    setCursor('default')
  }

  // marcador do foco manual do zoom selecionado (posição na imagem de agora)
  let marker: { left: number; top: number } | null = null
  const scene = engineRef.current?.scene ?? null
  const canvas = canvasRef.current
  if (focus && scene?.screen && canvas) {
    const { dest, src } = scene.screen
    const x = dest.x + ((focus.x - src.x) / src.w) * dest.w
    const y = dest.y + ((focus.y - src.y) / src.h) * dest.h
    if (inside({ x, y }, dest)) marker = { left: (x / canvas.width) * 100, top: (y / canvas.height) * 100 }
  }

  return (
    <div className="ed-view" data-testid="preview-view">
      <div
        ref={frameRef}
        className="preview-frame"
        data-testid="preview-frame"
        data-cursor={cursor}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas ref={canvasRef} width={1280} height={720} aria-label={t.editor.preview} data-testid="preview-canvas" data-ready="false" />
        {/* As fontes de imagem e de som da prévia: ficam na página (precisam decodificar) mas não aparecem. */}
        <div ref={hostRef} className="preview-sources" aria-hidden="true" />
        {marker ? (
          <span className="focus-marker" data-testid="focus-marker" style={{ left: `${marker.left}%`, top: `${marker.top}%` }}>
            <TargetIcon size={22} />
          </span>
        ) : null}
        {selected ? (
          <p className="preview-hint" data-testid="focus-hint">
            <TargetIcon size={14} /> {t.editor.zoom.focusHint}
          </p>
        ) : null}
        {error ? (
          <div className="preview-error" role="alert" data-testid="preview-error">
            <AlertIcon size={28} />
            <h3>{t.editor.previewError}</h3>
            <p>{error}</p>
            <p className="muted">{t.editor.previewErrorHint}</p>
            <button type="button" className="btn" onClick={() => void revealProject(detail.id)}>
              <FolderIcon size={16} />
              {t.project.revealFolder}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
