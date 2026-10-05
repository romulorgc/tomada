import { describe, expect, it } from 'vitest'
import { MIN_CUT_MS, addManualCut, enabledCutsAt, newlyCutMs, reenableCut, restoreAt, restoreCut } from '@shared/cuts'
import { keptRanges } from '@shared/timeline'
import type { Cut } from '@shared/types'

const cut = (id: string, start: number, end: number, reason: Cut['reason'] = 'manual', enabled = true): Cut => ({ id, start, end, reason, enabled })
const D = 20_000

describe('addManualCut', () => {
  it('cria um corte manual ligado, com o intervalo ordenado e limitado à duração', () => {
    expect(addManualCut([], 4000, 2000, D)).toEqual([cut('cut-1', 2000, 4000)])
    expect(addManualCut([], -500, 1000, D)).toEqual([cut('cut-1', 0, 1000)])
    expect(addManualCut([], 19_000, 99_000, D)).toEqual([cut('cut-1', 19_000, 20_000)])
  })
  it('ignora cortes minúsculos (um clique sem querer)', () => {
    expect(addManualCut([], 1000, 1000 + MIN_CUT_MS - 1, D)).toEqual([])
  })
  it('funde com cortes manuais que se tocam ou se sobrepõem', () => {
    const base = [cut('cut-1', 2000, 4000), cut('cut-2', 8000, 9000)]
    expect(addManualCut(base, 3000, 8500, D)).toEqual([cut('cut-1', 2000, 9000)])
    expect(addManualCut(base, 4000, 5000, D)).toEqual([cut('cut-1', 2000, 5000), cut('cut-2', 8000, 9000)])
  })
  it('não funde com corte automático nem com manual desligado', () => {
    const base = [cut('s1', 2000, 4000, 'silence'), cut('m1', 5000, 6000, 'manual', false)]
    const out = addManualCut(base, 3000, 5500, D)
    expect(out.map((c) => c.id).sort()).toEqual(['cut-1', 'm1', 's1'])
    expect(keptRanges(D, out)).toEqual([
      { start: 0, end: 2000 },
      { start: 5500, end: 20_000 }
    ])
  })
  it('não altera o que recebeu', () => {
    const base = [cut('cut-1', 2000, 4000)]
    const copy = JSON.parse(JSON.stringify(base))
    addManualCut(base, 3000, 5000, D)
    expect(base).toEqual(copy)
  })
})

describe('restaurar', () => {
  const all = [cut('m', 1000, 3000), cut('s', 2500, 4000, 'silence'), cut('off', 7000, 8000, 'filler', false)]
  it('corte manual restaurado some; automático só é desligado', () => {
    expect(restoreAt(all, 1500).map((c) => c.id)).toEqual(['s', 'off'])
    const r = restoreAt(all, 3500)
    expect(r.find((c) => c.id === 's')).toMatchObject({ enabled: false })
    expect(r.find((c) => c.id === 'm')).toMatchObject({ enabled: true })
  })
  it('em cima de dois cortes restaura os dois', () => {
    const r = restoreAt(all, 2700)
    expect(r.find((c) => c.id === 'm')).toBeUndefined()
    expect(r.find((c) => c.id === 's')?.enabled).toBe(false)
    expect(enabledCutsAt(all, 2700).map((c) => c.id)).toEqual(['m', 's'])
  })
  it('fora de qualquer corte, ou num corte já desligado, não muda nada', () => {
    expect(restoreAt(all, 5000)).toEqual(all)
    expect(restoreAt(all, 7500)).toEqual(all)
  })
  it('restoreCut e reenableCut', () => {
    expect(restoreCut(all, 'm').map((c) => c.id)).toEqual(['s', 'off'])
    expect(restoreCut(all, 's').find((c) => c.id === 's')?.enabled).toBe(false)
    expect(reenableCut(all, 'off').find((c) => c.id === 'off')?.enabled).toBe(true)
  })
  it('o fim do corte já é vídeo mantido', () => {
    expect(enabledCutsAt([cut('m', 1000, 3000)], 3000)).toEqual([])
  })
})

describe('newlyCutMs', () => {
  it('conta só o que ainda não está cortado', () => {
    const cuts = [cut('m', 1000, 3000), cut('s', 2500, 4000, 'silence')]
    expect(newlyCutMs(cuts, 0, 10_000)).toBe(10_000 - 3000)
    expect(newlyCutMs(cuts, 1500, 2000)).toBe(0)
    expect(newlyCutMs(cuts, 3500, 6000)).toBe(2000)
    expect(newlyCutMs([], 100, 600)).toBe(500)
  })
})
