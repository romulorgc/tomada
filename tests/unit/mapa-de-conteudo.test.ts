/**
 * Mapa de conteúdo da tela (enquadramento do 9:16): da imagem à grade de bordas, ao perfil de cada eixo na área-base (recortada) e ao
 * bloco principal de conteúdo; o arquivo (`events/content-map.jsonl`) e a leitura dele. A página é sintética (`pagina-webmail.ts`).
 */
import { describe, expect, it } from 'vitest'
import {
  CONTENT_GRID,
  axisProfile,
  blockCover,
  contentCellsFromGray,
  contentMapToJsonLines,
  contentSampleFromLine,
  createContentTrack,
  dedupeContentMap,
  mainBlock,
  sameContent,
  type ContentSample
} from '@shared/content-map'
import { eventsFromText } from '@shared/events'
import { COLUMN, FRAME, PAGE, pageGray, pageSample } from '../helpers/pagina-webmail'

const cols = CONTENT_GRID.cols

describe('da imagem à grade de bordas', () => {
  it('área lisa fica em 0 e texto fica alto; a grade tem uma célula por posição', () => {
    const gray = pageGray()
    const cells = contentCellsFromGray(gray, FRAME.w, FRAME.h)
    expect(cells).toHaveLength(CONTENT_GRID.cols * CONTENT_GRID.rows)
    const at = (x: number, y: number): number => cells[Math.floor(y * CONTENT_GRID.rows) * cols + Math.floor(x * cols)]!
    expect(at(0.9, 0.5)).toBe(0) // margem em branco, à direita
    expect(at(0.57, 0.5)).toBeGreaterThan(150) // meio da coluna de texto
    expect(at(0.3, 0.5)).toBe(0) // entre a barra lateral e a coluna
  })

  it('quadro que não é um quadro é erro, não grade de zeros', () => {
    expect(() => contentCellsFromGray(new Uint8Array(10), 640, 360)).toThrow(/inválido/)
  })

  it('a mesma imagem não vira outra amostra: a tela parada por muito tempo ocupa uma linha', () => {
    const a = pageSample(0)
    const same = { ...pageSample(1000) }
    const moved = { column: { x0: 0.5, x1: 0.8, y0: 0.12, y1: 0.9 } }
    const other = pageSample(2000, moved)
    expect(sameContent(a.cells, same.cells)).toBe(true)
    expect(sameContent(a.cells, other.cells)).toBe(false)
    expect(dedupeContentMap([a, same, other, pageSample(3000, moved), pageSample(4000, moved)]).map((s) => s.t)).toEqual([0, 2000])
  })
})

describe('perfil de um eixo na área-base', () => {
  it('a faixa de abas e a barra de tarefas contam na tela inteira e saem do perfil com o recorte da página', () => {
    const sample = pageSample(0)
    const full = axisProfile(sample, { x: 0, y: 0, w: 1, h: 1 }, 'x')
    const page = axisProfile(sample, { x: 0, y: 0.07, w: 1, h: 0.86 }, 'x')
    const stripAt = (p: number[]): number => p[Math.floor(0.9 * p.length)]! // à direita, onde só as faixas de cima e de baixo têm borda
    expect(stripAt(full)).toBeGreaterThan(0.05)
    expect(stripAt(page)).toBe(0)
  })

  it('o recorte muda o espaço: o perfil começa no x do recorte e a coluna aparece onde está na página', () => {
    const sample = pageSample(0)
    const crop = { x: 0.3, y: 0, w: 0.6, h: 1 }
    const profile = axisProfile(sample, crop, 'x')
    const block = mainBlock(profile)!
    // a coluna (0.406-0.734) na tela vira ((0.406−0.3)/0.6 = 0.177) a ((0.734−0.3)/0.6 = 0.723) na página recortada
    expect(block.start).toBeCloseTo((COLUMN.start - crop.x) / crop.w, 1)
    expect(block.end).toBeCloseTo((COLUMN.end - crop.x) / crop.w, 1)
  })

  it('o eixo vertical também: a coluna de texto ocupa a faixa de cima a baixo dela', () => {
    const profile = axisProfile(pageSample(0), { x: 0.4, y: 0, w: 0.34, h: 1 }, 'y')
    const block = mainBlock(profile)!
    expect(block.start).toBeLessThan(0.2)
    expect(block.end).toBeGreaterThan(0.85)
  })
})

describe('bloco principal de conteúdo', () => {
  const full = { x: 0, y: 0, w: 1, h: 1 }
  const page = { x: 0, y: 0.05, w: 1, h: 0.9 }

  it('acha a coluna central e ignora a barra de ícones colada na borda e os rótulos da barra lateral', () => {
    for (const rect of [full, page]) {
      const block = mainBlock(axisProfile(pageSample(0), rect, 'x'))!
      expect(block.start).toBeGreaterThan(COLUMN.start - 0.05)
      expect(block.start).toBeLessThan(COLUMN.start + 0.03)
      expect(block.end).toBeGreaterThan(COLUMN.end - 0.03)
      expect(block.end).toBeLessThan(COLUMN.end + 0.05)
    }
  })

  it('a lista de e-mails, de ponta a ponta, é um bloco largo', () => {
    const block = mainBlock(axisProfile(pageSample(0, { column: null }), page, 'x'))!
    expect(block.end - block.start).toBeGreaterThan(0.6)
  })

  it('página lisa não tem bloco: não há o que enquadrar', () => {
    const blank = { t: 0, cols, rows: CONTENT_GRID.rows, cells: new Uint8Array(cols * CONTENT_GRID.rows) }
    expect(mainBlock(axisProfile(blank, full, 'x'))).toBeNull()
  })

  it('quanto do bloco cabe numa janela: tudo, metade, nada', () => {
    const profile = axisProfile(pageSample(0), page, 'x')
    const block = mainBlock(profile)!
    expect(blockCover(profile, block, block.start - 0.1, block.end + 0.1)).toBeCloseTo(1, 6)
    const half = blockCover(profile, block, block.start, (block.start + block.end) / 2)
    expect(half).toBeGreaterThan(0.35)
    expect(half).toBeLessThan(0.65)
    expect(blockCover(profile, block, 0, block.start - 0.05)).toBe(0)
  })
})

describe('o arquivo do mapa', () => {
  it('uma linha por imagem e a mesma grade na volta', () => {
    const map = dedupeContentMap([pageSample(0), pageSample(1000), pageSample(5000, { column: null })])
    const text = contentMapToJsonLines(map)
    expect(text.trim().split('\n')).toHaveLength(2)
    const back = eventsFromText({ contentMap: text }).contentMap!
    expect(back.map((s) => s.t)).toEqual([0, 5000])
    expect(Array.from(back[1]!.cells)).toEqual(Array.from(map[1]!.cells))
  })

  it('linha estragada ou com a grade de outro tamanho é descartada (a última, cortada pela metade, também)', () => {
    const good = contentMapToJsonLines([pageSample(0)])
    const bad = JSON.stringify({ t: 1000, c: 64, r: 36, g: 'AAAA' })
    const truncated = good.slice(0, 40)
    const map = eventsFromText({ contentMap: `${good}${bad}\n${truncated}` }).contentMap!
    expect(map.map((s) => s.t)).toEqual([0])
    expect(contentSampleFromLine({ t: 5, c: 4, r: 4, g: 'AAAA' })).toBeNull()
    expect(contentSampleFromLine(null)).toBeNull()
  })

  it('sem o arquivo, o mapa é vazio', () => {
    expect(eventsFromText({}).contentMap).toEqual([])
  })
})

describe('o mapa ao longo do tempo', () => {
  const map: ContentSample[] = [pageSample(0, { column: null }), pageSample(5000)]
  const crop = { at: () => ({ x: 0, y: 0.05, w: 1, h: 0.9 }) }

  it('vale a amostra mais recente: a lista até 5 s e a coluna depois', () => {
    const track = createContentTrack(map, crop)!
    expect(track.times).toEqual([0, 5000])
    const wide = mainBlock(track.profileAt(2000, 'x'))!
    const column = mainBlock(track.profileAt(7000, 'x'))!
    expect(wide.end - wide.start).toBeGreaterThan(0.6)
    expect(column.end - column.start).toBeLessThan(0.45)
  })

  it('sem mapa não há trilha', () => {
    expect(createContentTrack([], crop)).toBeNull()
    expect(createContentTrack(undefined, null)).toBeNull()
  })

  it('o recorte é o do instante: a página recortada à direita muda o lugar do bloco', () => {
    const moving = { at: (t: number) => (t < 3000 ? { x: 0, y: 0, w: 1, h: 1 } : { x: 0.3, y: 0, w: 0.7, h: 1 }) }
    const track = createContentTrack([pageSample(0)], moving)!
    const before = mainBlock(track.profileAt(1000, 'x'))!
    const after = mainBlock(track.profileAt(4000, 'x'))!
    expect(after.start).toBeLessThan(before.start)
  })
})

describe('a página sintética', () => {
  it('tem a faixa de abas e a barra de tarefas de verdade (senão o teste do recorte não provaria nada)', () => {
    const gray = pageGray()
    const bare = pageGray({ bare: true })
    const diff = gray.reduce((n, v, i) => n + (v !== bare[i] ? 1 : 0), 0)
    expect(diff).toBeGreaterThan(FRAME.w * FRAME.h * 0.01)
    expect(PAGE.column.x1 - PAGE.column.x0).toBeCloseTo(630 / 1920, 2)
  })
})
