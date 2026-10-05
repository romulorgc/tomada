import { describe, expect, it } from 'vitest'
import { migrate, serializeProject, createProject } from '@shared/project'
import {
  BACKGROUND_PRESETS,
  NIGHT_PRESET,
  backgroundFromPreset,
  backgroundKey,
  gradientEndpoints,
  presetIdOf,
  styleUnit
} from '@shared/styles'
import type { Background } from '@shared/types'

describe('fundos', () => {
  it('são os 18 do legado, com ids únicos e cores hexadecimais válidas', () => {
    expect(BACKGROUND_PRESETS).toHaveLength(18)
    expect(new Set(BACKGROUND_PRESETS.map((b) => b.id)).size).toBe(18)
    for (const b of BACKGROUND_PRESETS) {
      expect(b.from).toMatch(/^#[0-9a-f]{6}$/)
      expect(b.to).toMatch(/^#[0-9a-f]{6}$/)
      expect(b.name.length).toBeGreaterThan(2)
    }
    // conferidos contra legado/lib/layout.mjs
    const sunset = BACKGROUND_PRESETS.find((b) => b.id === 'sunset')!
    expect([sunset.from, sunset.to]).toEqual(['#f97316', '#fbbf24'])
    const navy = BACKGROUND_PRESETS.find((b) => b.id === 'navy')!
    expect([navy.from, navy.to]).toEqual(['#1e3a5f', '#0ea5e9'])
  })

  it('preset vira gradiente a 135°; as cores iguais viram sólido; o reverso reconhece o preset', () => {
    expect(backgroundFromPreset('sunset')).toEqual({ type: 'gradient', from: '#f97316', to: '#fbbf24', angle: 135 })
    expect(backgroundFromPreset('preto')).toEqual({ type: 'solid', color: '#000000' })
    expect(backgroundFromPreset('nao-existe')).toEqual(backgroundFromPreset(NIGHT_PRESET.id))
    expect(presetIdOf(backgroundFromPreset('violeta'))).toBe('violeta')
    expect(presetIdOf(backgroundFromPreset('branco'))).toBe('branco')
    expect(presetIdOf({ type: 'gradient', from: '#123456', to: '#654321', angle: 10 })).toBeNull()
    expect(presetIdOf({ type: 'image', path: 'x.jpg' })).toBeNull()
  })

  it('o fundo padrão do projeto é o preset "Noite"', () => {
    expect(createProject({ title: 'x' }).style.background).toEqual(backgroundFromPreset(NIGHT_PRESET.id))
  })

  it('chave estável para o cache', () => {
    const a: Background = { type: 'gradient', from: '#000000', to: '#ffffff', angle: 90 }
    expect(backgroundKey(a)).toBe(backgroundKey({ ...a }))
    expect(backgroundKey(a)).not.toBe(backgroundKey({ ...a, angle: 91 }))
    expect(backgroundKey({ type: 'solid', color: '#fff' })).not.toBe(backgroundKey({ type: 'image', path: '#fff' }))
  })

  it('gradiente no padrão do CSS: 90° da esquerda para a direita; 180° de cima para baixo; 135° passa pelos cantos', () => {
    expect(gradientEndpoints(90, 200, 100)).toMatchObject({ x0: 0, x1: 200 })
    const down = gradientEndpoints(180, 200, 100)
    expect(down.y0).toBeCloseTo(0, 9)
    expect(down.y1).toBeCloseTo(100, 9)
    const diag = gradientEndpoints(135, 100, 100)
    expect(diag.x0).toBeCloseTo(0, 6)
    expect(diag.y0).toBeCloseTo(0, 6)
    expect(diag.x1).toBeCloseTo(100, 6)
    expect(diag.y1).toBeCloseTo(100, 6)
  })

  it('o projeto aceita a imagem como fundo, as 9 posições da câmera e o halo (e completa o que falta)', () => {
    const p = createProject({ title: 'x' })
    p.style.background = { type: 'image', path: 'media/fundo.jpg' }
    p.style.camera.corner = 'top-center'
    p.style.cursor.halo = true
    p.zoomPreset = 'off'
    const back = migrate(JSON.parse(serializeProject(p)))
    expect(back.style.background).toEqual({ type: 'image', path: 'media/fundo.jpg' })
    expect(back.style.camera.corner).toBe('top-center')
    expect(back.style.cursor.halo).toBe(true)
    expect(back.zoomPreset).toBe('off')
    // documento antigo (sem halo e sem zoomPreset) recebe os padrões
    const old = JSON.parse(serializeProject(createProject({ title: 'y' })))
    delete old.style.cursor.halo
    const migrated = migrate(old)
    expect(migrated.style.cursor.halo).toBe(false)
    expect(migrated.zoomPreset).toBeUndefined()
  })

  it('unidade de estilo: lado menor sobre 1080', () => {
    expect(styleUnit({ w: 1920, h: 1080 })).toBe(1)
    expect(styleUnit({ w: 3840, h: 2160 })).toBe(2)
    expect(styleUnit({ w: 1080, h: 1920 })).toBe(1)
    expect(styleUnit({ w: 640, h: 360 })).toBeCloseTo(1 / 3, 9)
  })
})
