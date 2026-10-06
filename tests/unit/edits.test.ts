import { describe, expect, it } from 'vitest'
import {
  LAYOUT_MIN_MS,
  MANUAL_ZOOM_MIN_MS,
  MANUAL_ZOOM_SCALE,
  ZOOM_SCALE_MAX,
  ZOOM_SCALE_MIN,
  createLayoutSeg,
  createZoom,
  deleteLayoutSeg,
  deleteZoom,
  moveLayoutSeg,
  moveZoom,
  regenerateZooms,
  resizeLayoutSeg,
  resizeZoom,
  setLayoutOfSeg,
  setZoomFocus,
  setZoomScale,
  splitLayoutAt,
  zoomCounts
} from '@shared/edits'
import { createProject } from '@shared/project'
import { overlappingPairs } from '@shared/segments'
import type { Project, Zoom } from '@shared/types'

const D = 30_000
const zoom = (id: string, start: number, end: number, origin: Zoom['origin'] = 'auto'): Zoom => ({ id, start, end, scale: 1.7, focus: 'auto', origin })

function doc(zooms: Zoom[] = [], layouts: Project['layouts'] = []): Project {
  return { ...createProject({ id: 'p', title: 'T', createdAt: '2026-10-05T00:00:00.000Z' }), zooms, layouts }
}

describe('zooms: criar', () => {
  it('arrastar cria um zoom MANUAL com a escala padrão, ordenado, sem mexer no documento original', () => {
    const p = doc([zoom('zoom-auto-1', 8000, 10_000)])
    const out = createZoom(p, 3000, 5000, D)!
    expect(out.id).toBe('zoom-1')
    expect(out.project.zooms.map((z) => z.id)).toEqual(['zoom-1', 'zoom-auto-1'])
    expect(out.project.zooms[0]).toMatchObject({ start: 3000, end: 5000, scale: MANUAL_ZOOM_SCALE, focus: 'auto', origin: 'manual' })
    expect(p.zooms).toHaveLength(1)
  })
  it('recusa gesto curto ou que começa em cima de outro zoom', () => {
    const p = doc([zoom('a', 4000, 6000)])
    expect(createZoom(p, 5000, 7000, D)).toBeNull() // começa em cima do zoom a
    expect(createZoom(p, 1000, 1000 + MANUAL_ZOOM_MIN_MS - 1, D)).toBeNull()
  })
  it('o arraste que passa por cima do vizinho é recortado nele', () => {
    const p = doc([zoom('a', 4000, 6000)])
    const out = createZoom(p, 1000, 9000, D)!
    expect(out.project.zooms.find((z) => z.id === out.id)).toMatchObject({ start: 1000, end: 4000 })
  })
})

describe('zooms: editar à mão vira manual', () => {
  const base = doc([zoom('a', 2000, 4000, 'auto'), zoom('b', 8000, 10_000, 'auto')])
  it('mover', () => {
    const out = moveZoom(base, 'a', 1000, D)
    expect(out.zooms[0]).toMatchObject({ start: 3000, end: 5000, origin: 'manual' })
    expect(out.zooms[1]!.origin).toBe('auto') // o outro não é tocado
    expect(overlappingPairs(out.zooms)).toEqual([])
  })
  it('mover contra o vizinho para; deslocamento zero devolve o mesmo documento', () => {
    expect(moveZoom(base, 'a', 99_000, D).zooms[0]).toMatchObject({ start: 6000, end: 8000 })
    expect(moveZoom(base, 'a', 0, D)).toBe(base)
  })
  it('redimensionar respeita o mínimo e o vizinho', () => {
    expect(resizeZoom(base, 'a', 'end', 99_000, D).zooms[0]).toMatchObject({ end: 8000, origin: 'manual' })
    expect(resizeZoom(base, 'a', 'end', 0, D).zooms[0]).toMatchObject({ end: 2000 + MANUAL_ZOOM_MIN_MS })
    expect(resizeZoom(base, 'a', 'start', 2000, D)).toBe(base)
  })
  it('escala: limitada e arredondada; foco manual; voltar ao automático', () => {
    expect(setZoomScale(base, 'a', 99).zooms[0]!.scale).toBe(ZOOM_SCALE_MAX)
    expect(setZoomScale(base, 'a', 0.2).zooms[0]!.scale).toBe(ZOOM_SCALE_MIN)
    expect(setZoomScale(base, 'a', 2.3456).zooms[0]).toMatchObject({ scale: 2.35, origin: 'manual' })
    const f = setZoomFocus(base, 'a', { x: 1.4, y: -0.2 })
    expect(f.zooms[0]).toMatchObject({ focus: { x: 1, y: 0 }, origin: 'manual' })
    expect(setZoomFocus(f, 'a', 'auto').zooms[0]!.focus).toBe('auto')
    expect(setZoomScale(base, 'nada', 2)).toBe(base)
  })
  it('apagar', () => {
    expect(deleteZoom(base, 'a').zooms.map((z) => z.id)).toEqual(['b'])
    expect(deleteZoom(base, 'nada')).toBe(base)
  })
})

describe('zooms: gerar de novo', () => {
  it('troca os automáticos e mantém os manuais, e o preset fica registrado', () => {
    const p = doc([zoom('zoom-auto-1', 1000, 2500), zoom('zoom-1', 5000, 7000, 'manual')])
    const fresh = [zoom('zoom-auto-1', 900, 2400), zoom('zoom-auto-2', 9000, 10_500)]
    const out = regenerateZooms(p, 'intense', fresh)
    expect(out.zoomPreset).toBe('intense')
    expect(out.zooms.map((z) => z.id)).toEqual(['zoom-auto-1', 'zoom-1', 'zoom-auto-2'])
    expect(out.zooms.find((z) => z.id === 'zoom-1')!.origin).toBe('manual')
  })
  it('automático que cairia em cima de um manual é descartado', () => {
    const p = doc([zoom('zoom-1', 1000, 3000, 'manual')])
    const out = regenerateZooms(p, 'moderate', [zoom('zoom-auto-1', 2000, 3500), zoom('zoom-auto-2', 6000, 7500)])
    expect(out.zooms.map((z) => z.id)).toEqual(['zoom-1', 'zoom-auto-2'])
    expect(overlappingPairs(out.zooms)).toEqual([])
  })
  it('"off" tira os automáticos', () => {
    const p = doc([zoom('zoom-auto-1', 1000, 2500), zoom('zoom-1', 5000, 7000, 'manual')])
    const out = regenerateZooms(p, 'off', [])
    expect(out.zooms.map((z) => z.id)).toEqual(['zoom-1'])
    expect(out.zoomPreset).toBe('off')
  })
  it('zoomCounts', () => {
    expect(zoomCounts(doc([zoom('a', 0, 1000), zoom('b', 2000, 3000, 'manual'), zoom('c', 4000, 5000)]))).toEqual({ auto: 2, manual: 1 })
  })
})

describe('layout: trechos', () => {
  it('criar arrastando, com o layout pedido', () => {
    const out = createLayoutSeg(doc(), 2000, 6000, D, 'screen')!
    expect(out.project.layouts).toEqual([{ id: 'layout-1', start: 2000, end: 6000, layout: 'screen', origin:'manual' }])
    expect(createLayoutSeg(out.project, 3000, 5000, D, 'camera')).toBeNull() // em cima de outro trecho
    expect(createLayoutSeg(doc(), 100, 100 + LAYOUT_MIN_MS - 1, D, 'screen')).toBeNull()
  })
  it('mover, redimensionar, trocar o layout e apagar', () => {
    const p = doc([], [
      { id: 'layout-1', start: 2000, end: 4000, layout: 'screen' },
      { id: 'layout-2', start: 6000, end: 9000, layout: 'camera' }
    ])
    expect(moveLayoutSeg(p, 'layout-1', 99_000, D).layouts[0]).toMatchObject({ start: 4000, end: 6000 })
    expect(resizeLayoutSeg(p, 'layout-1', 'end', 99_000, D).layouts[0]).toMatchObject({ end: 6000 })
    expect(setLayoutOfSeg(p, 'layout-1', 'side-by-side').layouts[0]!.layout).toBe('side-by-side')
    expect(setLayoutOfSeg(p, 'layout-1', 'screen')).toBe(p)
    expect(deleteLayoutSeg(p, 'layout-2').layouts.map((l) => l.id)).toEqual(['layout-1'])
  })
})

describe('layout: dividir (tecla S)', () => {
  it('dentro de um trecho: parte em dois, o primeiro com o id original', () => {
    const p = doc([], [{ id: 'layout-1', start: 2000, end: 8000, layout: 'screen' }])
    const out = splitLayoutAt(p, 5000, D)!
    expect(out.project.layouts).toEqual([
      { id: 'layout-1', start: 2000, end: 5000, layout: 'screen' },
      { id: 'layout-2', start: 5000, end: 8000, layout: 'screen' }
    ])
    expect(out.id).toBe('layout-2')
  })
  it('no layout padrão: cria dois trechos com o layout padrão até os vizinhos', () => {
    const p = doc([], [{ id: 'layout-1', start: 10_000, end: 12_000, layout: 'camera' }])
    const out = splitLayoutAt(p, 4000, D)!
    const novos = out.project.layouts.filter((l) => l.id !== 'layout-1')
    expect(novos).toEqual([
      { id: 'layout-2', start: 0, end: 4000, layout: p.style.defaultLayout },
      { id: 'layout-3', start: 4000, end: 10_000, layout: p.style.defaultLayout }
    ])
    expect(overlappingPairs(out.project.layouts)).toEqual([])
    expect(out.id).toBe('layout-3')
  })
  it('perto demais das bordas não divide', () => {
    const p = doc([], [{ id: 'layout-1', start: 2000, end: 8000, layout: 'screen' }])
    expect(splitLayoutAt(p, 2100, D)).toBeNull()
    expect(splitLayoutAt(doc(), 100, D)).toBeNull()
  })
})

it('excluir um zoom automático registra a decisão e regenerar não o faz voltar',() => {
  const automatic = zoom('zoom-auto-1',1000,2000)
  const edited = deleteZoom(doc([automatic]),automatic.id)
  expect(edited.zooms).toEqual([])
  expect(regenerateZooms(edited,'moderate',[automatic]).zooms).toEqual([])
})
