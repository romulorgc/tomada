import { describe, expect, it } from 'vitest'
import { DEFAULT_DICTIONARY } from '@shared/dictionary'
import { DEFAULT_RECORDING_SHORTCUTS, matchesAccelerator, validateRecordingShortcuts } from '@shared/shortcuts-config'
import { applyOwnerEditingDefaults, exportDefaultsSchema } from '@shared/settings-defaults'
import { createProject } from '@shared/project'

describe('padrões pessoais da M5', () => {
  it('traz o vocabulário inicial, na ordem definida', () => {
    expect(DEFAULT_DICTIONARY).toEqual(['Tomada', 'YouTube', 'Shorts', 'GitHub', 'Windows'])
  })
  it('aplica legenda e zoom próprios a projetos novos, sem mudar o original', () => {
    const project = createProject({ id: 'p', title: 'Teste' })
    const next = applyOwnerEditingDefaults(project, { ownerCaptionsHorizontal: { ...project.captions, enabled: true, wordsPerLine: 4 }, ownerCaptionsVertical: { ...project.captions, enabled: false, wordsPerLine: 2 }, ownerZoomPreset: 'off', ownerVerticalZoomPreset: 'subtle' })
    expect(next.captions).toMatchObject({ enabled: true, wordsPerLine: 4 })
    expect(next.vertical).toMatchObject({ captions: { enabled: false, wordsPerLine: 2 }, zoomPreset: 'subtle' })
    expect(next.zoomPreset).toBe('off')
    expect(project.vertical).toBeUndefined()
    expect(project.captions.enabled).toBe(false)
  })
  it('exportação tem defaults separados e recusa resolução ou fps inválido', () => {
    expect(exportDefaultsSchema.parse({})).toEqual({ horizontal: { resolution: '1080p', fps: 30 }, vertical: { fps: 30 } })
    expect(exportDefaultsSchema.safeParse({ vertical: { fps: 120 } }).success).toBe(false)
    expect(exportDefaultsSchema.safeParse({ horizontal: { resolution: '8K' } }).success).toBe(false)
  })
})

describe('atalhos editáveis', () => {
  it('normaliza equivalentes e preserva o padrão de gravação', () => {
    expect(validateRecordingShortcuts({ recordStop: 'shift+control+r', pause: 'alt+ctrl+p' })).toEqual({ recordStop: 'Ctrl+Shift+R', pause: 'Ctrl+Alt+P' })
    expect(validateRecordingShortcuts(DEFAULT_RECORDING_SHORTCUTS)).toEqual(DEFAULT_RECORDING_SHORTCUTS)
  })
  it('recusa conflito entre ações, tecla errei, teleprompter e tecla sem modificador', () => {
    for (const prefs of [{ recordStop: 'Ctrl+Shift+R', pause: 'Control+Shift+R' }, { recordStop: 'Ctrl+Alt+Z', pause: 'Ctrl+Shift+P' }, { recordStop: 'Ctrl+Alt+Space', pause: 'Ctrl+Shift+P' }, { recordStop: 'R', pause: 'Ctrl+Shift+P' }]) expect(() => validateRecordingShortcuts(prefs)).toThrow()
    expect(() => validateRecordingShortcuts({ recordStop: 'Ctrl+Alt+X', pause: 'Ctrl+Shift+P' }, 'Ctrl+Alt+X')).toThrow(/Errei/)
  })
  it('o atalho local exige os mesmos modificadores e reconhece letras sem caixa', () => {
    const event = { key: 'r', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }
    expect(matchesAccelerator(event, 'Ctrl+Shift+R')).toBe(true)
    expect(matchesAccelerator({ ...event, altKey: true }, 'Ctrl+Shift+R')).toBe(false)
  })
})
