import { describe, expect, it } from 'vitest'
import {
  CURRENT_PROJECT_VERSION,
  ProjectFormatError,
  createProject,
  defaultStyle,
  migrate,
  parseProject,
  projectDurationMs,
  serializeProject
} from '@shared/project'
import { MEDIA_SCHEME, mediaUrl } from '@shared/media-url'
import type { Src } from '@shared/types'

const src = (path: string, durationMs: number): Src => ({ path, w: 1920, h: 1080, fps: 30, durationMs })

describe('createProject', () => {
  it('cria com padrões bons e só o título obrigatório', () => {
    const p = createProject({ title: 'Minha aula' })
    expect(p.version).toBe(CURRENT_PROJECT_VERSION)
    expect(p.title).toBe('Minha aula')
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(new Date(p.createdAt).getTime()).not.toBeNaN()
    expect(p.cuts).toEqual([])
    expect(p.zooms).toEqual([])
    expect(p.layouts).toEqual([])
    expect(p.clips).toEqual([])
    expect(p.sync).toEqual({ screenOffsetMs: 0, cameraOffsetMs: 0 })
    expect(p.style).toEqual(defaultStyle())
    expect(p.captions.enabled).toBe(false)
  })

  it('aceita id, data e fontes explícitos', () => {
    const p = createProject({
      title: 'x',
      id: 'abc',
      createdAt: new Date('2026-10-04T12:00:00Z'),
      sources: { screen: src('media/screen.mp4', 5000) },
      sync: { cameraOffsetMs: 40 }
    })
    expect(p.id).toBe('abc')
    expect(p.createdAt).toBe('2026-10-04T12:00:00.000Z')
    expect(p.sources.screen?.path).toBe('media/screen.mp4')
    expect(p.sync).toEqual({ screenOffsetMs: 0, cameraOffsetMs: 40 })
  })

  it('o projeto criado passa na própria validação (ida e volta)', () => {
    const p = createProject({ title: 'roundtrip', sources: { screen: src('media/screen.mp4', 1000) } })
    expect(migrate(JSON.parse(serializeProject(p)))).toEqual(p)
    expect(parseProject(serializeProject(p))).toEqual(p)
  })

  it('ids diferentes a cada chamada', () => {
    expect(createProject({ title: 'a' }).id).not.toBe(createProject({ title: 'a' }).id)
  })
})

describe('migrate', () => {
  const base = () => JSON.parse(serializeProject(createProject({ title: 'base', id: 'p1' }))) as Record<string, unknown>

  it('versão futura: aceita, preserva campos desconhecidos e não rebaixa a versão', () => {
    const raw = {
      ...base(),
      version: 3,
      novoCampoNaRaiz: { a: 1 },
      style: { ...defaultStyle(), efeitoNovo: 'brilho' },
      cuts: [{ id: 'c1', start: 0, end: 10, reason: 'manual', enabled: true, nota: 'futuro' }]
    }
    const p = migrate(raw) as unknown as Record<string, unknown> & { cuts: Record<string, unknown>[] }
    expect(p.version).toBe(3)
    expect(p.novoCampoNaRaiz).toEqual({ a: 1 })
    expect((p.style as Record<string, unknown>).efeitoNovo).toBe('brilho')
    expect(p.cuts[0]?.nota).toBe('futuro')
  })

  it('campos novos opcionais: documento antigo sem eles ganha os padrões', () => {
    const raw = base()
    delete raw.captions
    delete raw.clips
    delete raw.zooms
    delete raw.style
    delete raw.sync
    delete raw.capture
    const p = migrate(raw)
    expect(p.captions.highlightColor).toBe('#FFD93D')
    expect(p.clips).toEqual([])
    expect(p.zooms).toEqual([])
    expect(p.style).toEqual(defaultStyle())
    expect(p.sync).toEqual({ screenOffsetMs: 0, cameraOffsetMs: 0 })
    expect(p.capture.kind).toBe('screen')
  })

  it('estilo parcial é completado campo a campo', () => {
    const raw = { ...base(), style: { radius: 30, camera: { size: 0.4 } } }
    const p = migrate(raw)
    expect(p.style.radius).toBe(30)
    expect(p.style.camera.size).toBe(0.4)
    expect(p.style.camera.shape).toBe(defaultStyle().camera.shape)
    expect(p.style.cursor).toEqual(defaultStyle().cursor)
  })

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'oi'],
    ['sem version', { id: 'x', title: 't', createdAt: 'now' }],
    ['version texto', { ...{ id: 'x', title: 't', createdAt: 'now' }, version: '2' }],
    ['version 1', { id: 'x', title: 't', createdAt: 'now', version: 1 }],
    ['version 0', { id: 'x', title: 't', createdAt: 'now', version: 0 }]
  ])('rejeita %s com ProjectFormatError', (_nome, raw) => {
    expect(() => migrate(raw)).toThrow(ProjectFormatError)
  })

  it('rejeita campo com tipo errado dizendo onde', () => {
    const raw = { ...base(), cuts: [{ id: 'c', start: 'zero', end: 10, reason: 'manual', enabled: true }] }
    expect(() => migrate(raw)).toThrow(/cuts\.0\.start/)
  })

  it('rejeita razão de corte desconhecida', () => {
    const raw = { ...base(), cuts: [{ id: 'c', start: 0, end: 10, reason: 'inventada', enabled: true }] }
    expect(() => migrate(raw)).toThrow(ProjectFormatError)
  })

  it('exige id e título', () => {
    const semId = base()
    delete semId.id
    expect(() => migrate(semId)).toThrow(ProjectFormatError)
    const semTitulo = base()
    delete semTitulo.title
    expect(() => migrate(semTitulo)).toThrow(ProjectFormatError)
  })
})

describe('parseProject', () => {
  it('JSON quebrado vira ProjectFormatError legível', () => {
    expect(() => parseProject('{ nope')).toThrow(ProjectFormatError)
    expect(() => parseProject('')).toThrow(/JSON válido/)
  })
})

describe('serializeProject', () => {
  it('indenta e termina com quebra de linha', () => {
    const text = serializeProject(createProject({ title: 't', id: 'i' }))
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "version": 2')
  })
})

describe('projectDurationMs', () => {
  it('é a maior duração entre as fontes', () => {
    expect(
      projectDurationMs({
        sources: { screen: src('a', 9000), camera: src('b', 12_500), voice: src('c', 12_000) }
      })
    ).toBe(12_500)
  })
  it('sem fontes é zero', () => {
    expect(projectDurationMs({ sources: {} })).toBe(0)
  })
})

describe('mediaUrl', () => {
  it('codifica pasta com espaço e acento, sem codificar as barras', () => {
    const url = mediaUrl('2026-10-04 1200 Gravação nº 1', 'media/screen.mp4')
    expect(url).toBe(`${MEDIA_SCHEME}://project/2026-10-04%201200%20Grava%C3%A7%C3%A3o%20n%C2%BA%201/media/screen.mp4`)
  })
  it('aceita barra invertida no caminho e acrescenta versão', () => {
    expect(mediaUrl('p', 'media\\thumb.jpg', 123.9)).toBe(`${MEDIA_SCHEME}://project/p/media/thumb.jpg?v=123`)
  })
})
