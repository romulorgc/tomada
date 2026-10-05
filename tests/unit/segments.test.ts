import { describe, expect, it } from 'vitest'
import { MIN_SEG_MS, freeSpaceAround, moveSeg, newSegRange, nextSegId, overlappingPairs, resizeSeg, segAt, sortedSegs, splitSeg, type Seg } from '@shared/segments'

const B = { min: 0, max: 20_000 }
const seg = (id: string, start: number, end: number): Seg => ({ id, start, end })
const A = seg('a', 2000, 4000)
const Bz = seg('b', 6000, 9000)

describe('moveSeg', () => {
  it('move por um deslocamento livre', () => {
    expect(moveSeg([A, Bz], 'a', 500, B)).toEqual([seg('a', 2500, 4500), Bz])
  })
  it('para no vizinho da direita (nunca sobrepõe) mesmo com um deslocamento enorme', () => {
    const out = moveSeg([A, Bz], 'a', 9000, B)
    expect(out[0]).toEqual(seg('a', 4000, 6000)) // encostou em b (6000)
    expect(overlappingPairs(out)).toEqual([])
  })
  it('para no vizinho da esquerda e no começo do eixo', () => {
    expect(moveSeg([A, Bz], 'b', -9000, B)[1]).toEqual(seg('b', 4000, 7000))
    expect(moveSeg([A], 'a', -9000, B)[0]).toEqual(seg('a', 0, 2000))
  })
  it('para no fim do eixo', () => {
    expect(moveSeg([Bz], 'b', 99_000, B)[0]).toEqual(seg('b', 17_000, 20_000))
  })
  it('sem espaço para andar não mexe, e não altera o que recebeu', () => {
    const tight = [seg('x', 0, 1000), seg('y', 1000, 2500), seg('z', 2500, 4000)]
    const copy = JSON.parse(JSON.stringify(tight))
    expect(moveSeg(tight, 'y', 300, B)).toEqual(tight)
    expect(tight).toEqual(copy)
  })
  it('id inexistente ou deslocamento inválido devolve igual', () => {
    expect(moveSeg([A], 'nada', 100, B)).toEqual([A])
    expect(moveSeg([A], 'a', Number.NaN, B)).toEqual([A])
  })
})

describe('resizeSeg', () => {
  it('arrasta a borda de início e a de fim', () => {
    expect(resizeSeg([A, Bz], 'a', 'start', 1500, B)[0]).toEqual(seg('a', 1500, 4000))
    expect(resizeSeg([A, Bz], 'a', 'end', 5000, B)[0]).toEqual(seg('a', 2000, 5000))
  })
  it('a borda de fim para no vizinho; a de início para no vizinho da esquerda', () => {
    expect(resizeSeg([A, Bz], 'a', 'end', 8000, B)[0]).toEqual(seg('a', 2000, 6000))
    expect(resizeSeg([A, Bz], 'b', 'start', 1000, B)[1]).toEqual(seg('b', 4000, 9000))
  })
  it('respeita o comprimento mínimo: nunca inverte nem some', () => {
    expect(resizeSeg([A], 'a', 'end', 100, B)[0]).toEqual(seg('a', 2000, 2000 + MIN_SEG_MS))
    expect(resizeSeg([A], 'a', 'start', 9000, B)[0]).toEqual(seg('a', 4000 - MIN_SEG_MS, 4000))
    expect(resizeSeg([A], 'a', 'end', 100, { ...B, minLen: 600 })[0]).toEqual(seg('a', 2000, 2600))
  })
  it('respeita os limites do eixo', () => {
    expect(resizeSeg([A], 'a', 'start', -500, B)[0]).toEqual(seg('a', 0, 4000))
    expect(resizeSeg([A], 'a', 'end', 99_000, B)[0]).toEqual(seg('a', 2000, 20_000))
  })
})

describe('newSegRange (criar arrastando)', () => {
  it('cria no espaço livre, em qualquer sentido do arraste', () => {
    expect(newSegRange([A, Bz], 4500, 5500, B)).toEqual({ start: 4500, end: 5500 })
    expect(newSegRange([A, Bz], 5500, 4500, B)).toEqual({ start: 4500, end: 5500 })
  })
  it('recorta no vizinho se o arraste passa por cima', () => {
    expect(newSegRange([A, Bz], 4500, 12_000, B)).toEqual({ start: 4500, end: 6000 })
    expect(newSegRange([A, Bz], 5500, 1000, B)).toEqual({ start: 4000, end: 5500 })
  })
  it('começar em cima de outro segmento não cria; arraste curto demais não cria', () => {
    expect(newSegRange([A, Bz], 3000, 5000, B)).toBeNull()
    expect(newSegRange([A, Bz], 4500, 4500 + MIN_SEG_MS - 1, B)).toBeNull()
  })
})

describe('splitSeg e ids', () => {
  it('divide em dois, o primeiro com o id original', () => {
    expect(splitSeg([A, Bz], 'a', 3000, 'a2')).toEqual([seg('a', 2000, 3000), seg('a2', 3000, 4000), Bz])
  })
  it('não divide perto demais das bordas', () => {
    expect(splitSeg([A], 'a', 2100, 'a2')).toBeNull()
    expect(splitSeg([A], 'a', 3950, 'a2')).toBeNull()
    expect(splitSeg([A], 'nada', 3000, 'a2')).toBeNull()
  })
  it('nextSegId acha o maior número livre do prefixo', () => {
    expect(nextSegId([], 'layout')).toBe('layout-1')
    expect(nextSegId([{ id: 'layout-1' }, { id: 'layout-7' }, { id: 'zoom-9' }], 'layout')).toBe('layout-8')
    expect(nextSegId([{ id: 'zoom-auto-3' }], 'zoom')).toBe('zoom-1') // ids dos automáticos não contam
  })
  it('segAt e sortedSegs', () => {
    expect(segAt([A, Bz], 2000)?.id).toBe('a')
    expect(segAt([A, Bz], 4000)).toBeUndefined() // o fim não pertence
    expect(sortedSegs([Bz, A]).map((s) => s.id)).toEqual(['a', 'b'])
    expect(freeSpaceAround([A, Bz], A, B)).toEqual({ from: 0, to: 6000 })
  })
  it('mesmo com dados antigos sobrepostos o movimento não piora a sobreposição', () => {
    const messy = [seg('p', 1000, 5000), seg('q', 4000, 8000)]
    const out = moveSeg(messy, 'q', 500, B)
    expect(out.find((s) => s.id === 'q')!.start).toBeGreaterThanOrEqual(5000)
  })
})
