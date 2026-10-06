/** Regiões comuns aos formatos, sempre em coordenadas e tempo da tela de origem. */
import type { BlurRegion, Point, Project, Rect } from './types'
import { nextSegId } from './segments'

export const MIN_BLUR_MS = 100
export const PROTECTION_CHANGED_MESSAGE = 'A proteção de dados mudou. Exporte novamente este vídeo antes de postar.'
export const protectionFingerprint = (p: Pick<Project, 'blurRegions'>): string => JSON.stringify(p.blurRegions ?? [])
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function normalizeBlurRect(rect: Rect): Rect | null {
  if (!Object.values(rect).every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) return null
  const w = Math.min(1, rect.w)
  const h = Math.min(rect.h > 1 ? 1 - clamp(rect.y, 0, .999) : 1, rect.h)
  const x = clamp(rect.x, 0, 1 - w)
  const y = clamp(rect.y, 0, 1 - h)
  return { x, y, w, h }
}

export function activeBlurRegions(p: Pick<Project, 'blurRegions'>, t: number): BlurRegion[] {
  return (p.blurRegions ?? []).filter(r => r.start <= t && t < r.end)
}

export function createBlurRegion(p: Project, rect: Rect, start: number, end: number, duration: number): Project | null {
  const r = normalizeBlurRect(rect)
  if (!r || ![start, end, duration].every(Number.isFinite) || !p.sources.screen) return null
  const a = clamp(Math.min(start, end), 0, duration)
  const b = clamp(Math.max(start, end), 0, duration)
  if (b - a < MIN_BLUR_MS) return null
  const regions = p.blurRegions ?? []
  return { ...p, blurRegions: [...regions, { id: nextSegId(regions, 'blur'), start: a, end: b, rect: r, mode: 'blur' }] }
}

export function updateBlurRegion(p: Project, id: string, patch: Partial<Pick<BlurRegion, 'mode' | 'rect'>>): Project {
  if (patch.mode !== undefined && !['blur', 'pixelate', 'solid'].includes(patch.mode)) return p
  const rect = patch.rect === undefined ? undefined : normalizeBlurRect(patch.rect)
  if (rect === null || !p.blurRegions?.some(r => r.id === id)) return p
  return { ...p, blurRegions: p.blurRegions.map(r => r.id === id ? { ...r, ...patch, ...(rect ? { rect } : {}) } : r) }
}
export const setBlurRect = (p: Project, id: string, rect: Rect): Project => updateBlurRegion(p, id, { rect })
export const deleteBlurRegion = (p: Project, id: string): Project => ({ ...p, blurRegions: (p.blurRegions ?? []).filter(r => r.id !== id) })

export function moveBlurRegion(p: Project, id: string, delta: number, duration: number): Project {
  const r = p.blurRegions?.find(r => r.id === id)
  if (!r || !Number.isFinite(delta)) return p
  const d = clamp(delta, -r.start, duration - r.end)
  return { ...p, blurRegions: p.blurRegions!.map(v => v.id === id ? { ...v, start: r.start + d, end: r.end + d } : v) }
}
export function resizeBlurRegion(p: Project, id: string, edge: 'start' | 'end', to: number, duration: number): Project {
  const r = p.blurRegions?.find(r => r.id === id)
  if (!r || !Number.isFinite(to)) return p
  const at = edge === 'start' ? clamp(to, 0, r.end - MIN_BLUR_MS) : clamp(to, r.start + MIN_BLUR_MS, duration)
  return { ...p, blurRegions: p.blurRegions!.map(v => v.id === id ? { ...v, [edge]: at } : v) }
}

/** `bar`: a moldura de navegador (C1) ocupa o topo do cartão; a tela gravada só é desenhada ABAIXO dela. */
type ScreenTransform = { src: Rect; dest: Rect; bar?: { h: number } }
/** A parte do cartão onde a tela gravada aparece (o cartão menos a barra da moldura, se houver). */
function pageOf(s: ScreenTransform): Rect {
  const barH = s.bar?.h ?? 0
  return barH > 0 && barH < s.dest.h ? { x: s.dest.x, y: s.dest.y + barH, w: s.dest.w, h: s.dest.h - barH } : s.dest
}
export function sourcePoint(p: Point, s: ScreenTransform): Point {
  const page = pageOf(s)
  return { x: clamp(s.src.x + (p.x - page.x) / page.w * s.src.w, 0, 1), y: clamp(s.src.y + (p.y - page.y) / page.h * s.src.h, 0, 1) }
}
export function displayRect(r: Rect, s: ScreenTransform): Rect {
  const page = pageOf(s)
  return { x: page.x + (r.x - s.src.x) / s.src.w * page.w, y: page.y + (r.y - s.src.y) / s.src.h * page.h, w: r.w / s.src.w * page.w, h: r.h / s.src.h * page.h }
}
