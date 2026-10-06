/**
 * A PRÉVIA: o canvas onde o motor desenha (mesma cena da exportação), mais o que dá para fazer em cima dele:
 *  - arrastar a bolha da câmera (gruda numa das 9 posições da grade);
 *  - com um zoom selecionado, clicar na prévia fixa o foco daquele zoom naquele ponto;
 *  - estado de erro desenhado (vídeo que não abre);
 *  - no vertical, o guia das ZONAS SEGURAS (área segura e a interface do TikTok, Reels e Shorts): só aqui, nunca no vídeo.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { useStore } from 'zustand'
import { setScreenCrop } from '@shared/crop-edit'
import { setZoomFocus } from '@shared/edits'
import type { Scene } from '@shared/scene'
import type { Corner } from '@shared/types'
import { PLATFORM_ZONES, SAFE_BOX, VERTICAL_H, VERTICAL_W, safeBoxFor } from '@shared/vertical'
import { AlertIcon, FolderIcon, TargetIcon } from '../components/Icons'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'
import { CropEditor } from './CropEditor'
import { useDoc, useEditor, usePlayback } from './context'

type DragMode = { mode: 'camera' }

/** A posição da grade 3×3 mais próxima de um ponto (fração 0..1 da área da tela). */
function nearestCorner(fx: number, fy: number): Corner {
  const col = fx < 1 / 3 ? 'left' : fx < 2 / 3 ? 'center' : 'right'
  const row = fy < 1 / 3 ? 'top' : fy < 2 / 3 ? 'middle' : 'bottom'
  return `${row}-${col}` as Corner
}

/** Layouts em que a câmera é uma bolha que se arrasta (no 16:9 e no vertical). */
const BUBBLE_LAYOUTS = new Set(['bubble', 'screen-focus', 'screen-wide'])

const inside = (p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }, pad = 0): boolean =>
  p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad

/** As zonas da interface das plataformas e a caixa segura única, em porcentagem do quadro 1080×1920. Só na prévia. */
function SafeGuide() {
  const L = t.editor.top.safeGuideLabels
  const pct = (v: number, of: number): string => `${((v / of) * 100).toFixed(3)}%`
  return (
    <div className="safe-guide" data-testid="safe-guide-overlay" aria-hidden="true">
      {PLATFORM_ZONES.map((z, k) => (
        <div key={z.id} className="sg-platform" data-platform={z.id}>
          <i className="sg-band" style={{ left: 0, top: 0, width: '100%', height: pct(z.top, VERTICAL_H) }} />
          <i className="sg-band" style={{ left: 0, bottom: 0, width: '100%', height: pct(z.bottom, VERTICAL_H) }} />
          {z.left > 0 ? <i className="sg-band" style={{ left: 0, top: 0, height: '100%', width: pct(z.left, VERTICAL_W) }} /> : null}
          <i className="sg-band" style={{ right: 0, top: 0, height: '100%', width: pct(z.right, VERTICAL_W) }} />
          <b className="sg-label" style={{ bottom: pct(8 + k * 56, VERTICAL_H), right: pct(z.right + 10, VERTICAL_W) }}>
            {L[z.id]}
          </b>
        </div>
      ))}
      <div
        className="sg-box"
        style={{ left: pct(SAFE_BOX.x, VERTICAL_W), top: pct(SAFE_BOX.y, VERTICAL_H), width: pct(SAFE_BOX.w, VERTICAL_W), height: pct(SAFE_BOX.h, VERTICAL_H) }}
      >
        <b>{L.box}</b>
      </div>
    </div>
  )
}

export function PreviewStage({ canvasRef, hostRef, frameRef }: { canvasRef: RefObject<HTMLCanvasElement | null>; hostRef: RefObject<HTMLDivElement | null>; frameRef: RefObject<HTMLDivElement | null> }) {
  const { store, engineRef, detail, clips, rawData, durationMs } = useEditor()
  const screenCrop = useDoc((s) => s.doc.screenCrop)
  const cropEditing = useDoc((s) => s.cropUi.editing)
  const revealProject = useApp((s) => s.revealProject)
  // a prévia de um corte: o quadro mostra o corte, não o vídeo inteiro
  const previewId = useStore(clips, (s) => s.previewId)
  const previewTitle = useDoc((s) => (previewId ? s.doc.clips.find((c) => c.id === previewId)?.title : undefined))
  const selection = useDoc((s) => s.selection)
  const format = useDoc((s) => s.format)
  const safeGuide = useDoc((s) => s.safeGuide)
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
    Boolean(scene && scene.screen && scene.camera && BUBBLE_LAYOUTS.has(scene.debug.layout) && scene.debug.previous === scene.debug.layout && inside(p, scene.camera.dest, 4))

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
    if (selected && !previewId && scene.screen && inside(p, scene.screen.dest)) {
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
      // no 16:9 a grade 3×3 é a da tela; no vertical é a da área segura (a câmera nunca sai dela)
      const dest = scene.format.kind === 'vertical' ? safeBoxFor(scene.format) : scene.screen.dest
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
    <div className="ed-view" data-testid="preview-view" data-clip-preview={previewTitle !== undefined ? 'true' : undefined}>
      {cropEditing && screenCrop?.mode === 'manual' && screenCrop.manual ? (
        <CropEditor
          rect={screenCrop.manual}
          onCommit={(manual) => store.getState().changeDoc((doc) => setScreenCrop(doc, { ...(doc.screenCrop ?? { mode: 'manual' }), mode: 'manual', manual }, rawData, durationMs))}
        />
      ) : null}
      {previewTitle !== undefined ? (
        <div className="preview-clip-banner" role="status" data-testid="preview-clip-banner">
          <span>{t.editor.clips.preview.banner(previewTitle)}</span>
          <button type="button" className="btn btn-ghost" onClick={() => clips.getState().preview(null)} data-testid="preview-clip-exit">
            {t.editor.clips.preview.exit}
          </button>
        </div>
      ) : null}
      <div
        ref={frameRef}
        className="preview-frame"
        data-testid="preview-frame"
        data-cursor={cursor}
        data-format={format}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas ref={canvasRef} width={1280} height={720} aria-label={t.editor.preview} data-testid="preview-canvas" data-ready="false" />
        {/* As fontes de imagem e de som da prévia: ficam na página (precisam decodificar) mas não aparecem. */}
        <div ref={hostRef} className="preview-sources" aria-hidden="true" />
        {format === 'vertical' && safeGuide ? <SafeGuide /> : null}
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
