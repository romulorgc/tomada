import { describe, expect, it } from 'vitest'
import { cameraVideoOffsetMs, selectCameraAvOffset, withManualCameraOffset } from '@shared/camera-sync'
import { createProject, parseProject, serializeProject } from '@shared/project'
import { fileTimeSeconds } from '@shared/export'
import { createEditorStore } from '@shared/editor-store'

describe('sincronia exclusiva da imagem da câmera', () => {
  it('adianta a imagem atrasada sem mover o início da voz ou da tela', () => {
    const p = createProject({ title: 'Teste', sync: { cameraOffsetMs: 20, screenOffsetMs: 4, cameraAvOffsetMs: 80 } })
    expect(cameraVideoOffsetMs(p)).toBe(-60)
    expect(fileTimeSeconds(1000, cameraVideoOffsetMs(p))).toBe(1.06)
    expect(p.sync.cameraOffsetMs).toBe(20)
    expect(p.sync.screenOffsetMs).toBe(4)
  })
  it('preserva projetos antigos e o ajuste manual zero prevalece', () => {
    const old = createProject({ title: 'Antigo', sync: { cameraOffsetMs: 30 } })
    expect(cameraVideoOffsetMs(parseProject(serializeProject(old)))).toBe(30)
    const auto = { ...old, sync: { ...old.sync, cameraAvOffsetMs: 80 } }
    const manual = withManualCameraOffset(auto, 0)
    expect(cameraVideoOffsetMs(manual)).toBe(30)
    expect(withManualCameraOffset(manual, null).sync.cameraAvManualOffsetMs).toBeUndefined()
    expect(cameraVideoOffsetMs(withManualCameraOffset(manual, null))).toBe(-50)
  })
  it('o ajuste manual e a volta ao automático são desfazíveis', () => {
    const p = createProject({ title: 'Teste', sync: { cameraAvOffsetMs: 80 } })
    const store = createEditorStore({ project: p, save: async () => {}, onSaveError: () => {} })
    store.getState().change((doc) => withManualCameraOffset(doc, -100))
    store.getState().change((doc) => withManualCameraOffset(doc, null))
    expect(cameraVideoOffsetMs(store.getState().project)).toBe(-80)
    store.getState().undo()
    expect(cameraVideoOffsetMs(store.getState().project)).toBe(100)
    store.getState().undo()
    expect(cameraVideoOffsetMs(store.getState().project)).toBe(-80)
    store.getState().dispose()
  })
  it('descarta confiança baixa e discrepantes antes de usar a mediana', () => {
    const segments = [80, 100, 90, 500].map((offsetMs) => ({ startMs: 0, durationMs: 3000, offsetMs, confidence: 6 }))
    expect(selectCameraAvOffset([...segments, { startMs: 0, durationMs: 3000, offsetMs: -200, confidence: 0.5 }])).toEqual({ offsetMs: 90, confidence: 6, accepted: 3 })
    expect(selectCameraAvOffset([{ startMs: 0, durationMs: 3000, offsetMs: 80, confidence: 6 }])).toBeNull()
    expect(selectCameraAvOffset([])).toBeNull()
  })
})
