/** Ferramenta da prévia. As alças são DOM; só os pixels protegidos entram no vídeo. */
import { useRef, useState, type PointerEvent, type RefObject } from 'react'
import { createBlurRegion, displayRect, setBlurRect, sourcePoint } from '@shared/blur'
import type { Point, Project, Rect } from '@shared/types'
import type { SceneScreen } from '@shared/scene'
import { t } from '../i18n/pt-BR'
import { useDoc, useEditor, usePlayback } from './context'

type Gesture = { mode: 'draw' | 'move' | 'nw' | 'ne' | 'sw' | 'se'; a: Point; transform: SceneScreen; base: Project; id?: string; rect?: Rect }
export function BlurOverlay({ canvasRef, frameRef }: { canvasRef: RefObject<HTMLCanvasElement | null>; frameRef: RefObject<HTMLDivElement | null> }) {
  const { store, engineRef, durationMs, playback } = useEditor()
  const drawing = useDoc(s => s.blurDrawing)
  const selection = useDoc(s => s.selection)
  const regions = useDoc(s => s.project.blurRegions)
  const active = drawing || selection?.kind === 'blur'
  const sourceMs = usePlayback(s => active ? s.sourceMs : 0)
  const [ghost, setGhost] = useState<Rect | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const selected = selection?.kind === 'blur' ? regions?.find(r => r.id === selection.id && r.start <= sourceMs && sourceMs < r.end) : undefined
  const point = (e: PointerEvent, s: SceneScreen): Point | null => {
    const bounds = frameRef.current?.getBoundingClientRect()
    const canvas = canvasRef.current
    if (!bounds || !canvas) return null
    return sourcePoint({ x: (e.clientX - bounds.left) * canvas.width / bounds.width, y: (e.clientY - bounds.top) * canvas.height / bounds.height }, s)
  }
  const begin = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const transform = engineRef.current?.scene?.screen
    if (!transform) return
    const a = point(e, transform)
    if (!a) return
    const edge = (e.target as HTMLElement).dataset.edge
    const mode = drawing ? 'draw' : edge && ['nw', 'ne', 'sw', 'se'].includes(edge) ? edge as Gesture['mode'] : 'move'
    if (mode !== 'draw' && !selected) return
    e.stopPropagation()
    e.preventDefault()
    engineRef.current?.pause()
    e.currentTarget.setPointerCapture(e.pointerId)
    store.getState().begin()
    gesture.current = { mode, a, transform: { ...transform, src: { ...transform.src }, dest: { ...transform.dest } }, base: store.getState().project, ...(selected ? { id: selected.id, rect: selected.rect } : {}) }
  }
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    const g = gesture.current
    if (!g) return
    e.stopPropagation()
    const b = point(e, g.transform)
    if (!b) return
    if (g.mode === 'draw') {
      setGhost({ x: Math.min(g.a.x, b.x), y: Math.min(g.a.y, b.y), w: Math.abs(b.x - g.a.x), h: Math.abs(b.y - g.a.y) })
    } else if (g.rect && g.id) {
      let r: Rect
      if (g.mode === 'move') r = { ...g.rect, x: g.rect.x + b.x - g.a.x, y: g.rect.y + b.y - g.a.y }
      else {
        const left = g.mode.endsWith('w') ? b.x : g.rect.x
        const right = g.mode.endsWith('e') ? b.x : g.rect.x + g.rect.w
        const top = g.mode.startsWith('n') ? b.y : g.rect.y
        const bottom = g.mode.startsWith('s') ? b.y : g.rect.y + g.rect.h
        r = { x: Math.min(left, right), y: Math.min(top, bottom), w: Math.max(.005, Math.abs(right - left)), h: Math.max(.005, Math.abs(bottom - top)) }
      }
      store.getState().change(() => setBlurRect(g.base, g.id!, r))
    }
  }
  const finish = (e: PointerEvent<HTMLDivElement>): void => {
    const g = gesture.current
    if (!g) return
    e.stopPropagation()
    if (g.mode === 'draw' && ghost && e.type !== 'pointercancel') {
      const st = store.getState()
      const range = st.range ?? { start: playback.getState().sourceMs, end: Math.min(durationMs, playback.getState().sourceMs + 2000) }
      const next = createBlurRegion(st.project, ghost, range.start, range.end, durationMs)
      if (next) {
        st.change(() => next)
        st.setSelection({ kind: 'blur', id: next.blurRegions!.at(-1)!.id })
        st.setBlurDrawing(false)
      }
    }
    gesture.current = null
    setGhost(null)
    store.getState().end()
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const transform = engineRef.current?.scene?.screen
  const canvas = canvasRef.current
  const rect = ghost ?? selected?.rect
  const box = rect && transform && canvas ? displayRect(rect, transform) : null
  return <div className="blur-overlay" data-drawing={drawing} data-testid="blur-overlay" onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}>
    {drawing ? <p className="preview-hint">{t.editor.blur.drawing}</p> : null}
    {box && canvas ? <div className="blur-selection" data-testid="blur-selection" aria-label={t.editor.blur.selected} style={{ left: `${box.x / canvas.width * 100}%`, top: `${box.y / canvas.height * 100}%`, width: `${box.w / canvas.width * 100}%`, height: `${box.h / canvas.height * 100}%` }}>
      {(['nw', 'ne', 'sw', 'se'] as const).map(edge => <i key={edge} data-edge={edge} data-testid={`blur-handle-${edge}`} />)}
    </div> : null}
  </div>
}
