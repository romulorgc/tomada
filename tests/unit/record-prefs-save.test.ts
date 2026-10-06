import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_RECORD_PREFS, type RecordPrefs } from '@shared/recording'
import { createRecordPrefsStore } from '../../src/renderer/recording/prefs-store'

const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail }); return { promise, resolve, reject } }

describe('preferências de Gravar confirmadas pelo main', () => {
  it('bloqueia o início enquanto salva e devolve a escolha válida depois de uma rejeição', async () => {
    const waiting = deferred<RecordPrefs>()
    const store = createRecordPrefsStore({ save: () => waiting.promise })
    store.getState().load(DEFAULT_RECORD_PREFS)
    const save = store.getState().update({ retakeShortcut: 'Ctrl+Alt+X' })
    expect(store.getState().prefs?.retakeShortcut).toBe('Ctrl+Alt+X')
    expect(store.getState().canStart()).toBe(false)
    waiting.reject(new Error('O atalho Ctrl+Alt+X já está reservado para Errei.'))
    await save
    expect(store.getState().prefs?.retakeShortcut).toBe('Ctrl+Alt+Z')
    expect(store.getState().error).toContain('Errei')
    expect(store.getState().canStart()).toBe(false)
    store.getState().useConfirmed()
    expect(store.getState().canStart()).toBe(true)
  })
  it('uma resposta do main normalizada é a escolha usada, e confirmação não contorna um save pendente', async () => {
    const waiting = deferred<RecordPrefs>()
    const store = createRecordPrefsStore({ save: () => waiting.promise })
    store.getState().load(DEFAULT_RECORD_PREFS)
    const save = store.getState().update({ sourceId: 'fonte-que-sumiu' })
    store.getState().useConfirmed()
    expect(store.getState().canStart()).toBe(false)
    waiting.resolve({ ...DEFAULT_RECORD_PREFS, sourceId: null })
    await save
    expect(store.getState().prefs?.sourceId).toBeNull()
    expect(store.getState().canStart()).toBe(true)
  })
  it('a mensagem exibida mantém o motivo em português sem o cabeçalho técnico do IPC', async () => {
    const store = createRecordPrefsStore({ save: async () => { throw new Error("Error invoking remote method 'record:prefs-set': Error: O atalho já está reservado para Errei.") } })
    store.getState().load(DEFAULT_RECORD_PREFS)
    await store.getState().update({ retakeShortcut: 'Ctrl+Alt+X' })
    expect(store.getState().error).toBe('O atalho já está reservado para Errei.')
  })
  it('saves rápidos são serializados: rejeitar um campo não apaga o outro nem permite início intermediário', async () => {
    const first = deferred<RecordPrefs>()
    const second = deferred<RecordPrefs>()
    const save = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const store = createRecordPrefsStore({ save })
    store.getState().load(DEFAULT_RECORD_PREFS)
    const a = store.getState().update({ retakeShortcut: 'Ctrl+Alt+X' })
    const b = store.getState().update({ fps: 60 })
    await Promise.resolve()
    expect(save).toHaveBeenCalledTimes(1)
    first.reject(new Error('Conflito de atalho'))
    await a
    expect(store.getState().prefs).toMatchObject({ retakeShortcut: 'Ctrl+Alt+Z', fps: 60 })
    expect(store.getState().canStart()).toBe(false)
    second.resolve({ ...DEFAULT_RECORD_PREFS, fps: 60 })
    await b
    expect(store.getState().prefs).toMatchObject({ retakeShortcut: 'Ctrl+Alt+Z', fps: 60 })
    expect(store.getState().canStart()).toBe(false)
    store.getState().useConfirmed()
    expect(store.getState().canStart()).toBe(true)
  })
})
