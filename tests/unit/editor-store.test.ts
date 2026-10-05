import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOSAVE_MS, COALESCE_MS, HISTORY_LIMIT, createEditorStore, selectionExists, type EditorStore } from '@shared/editor-store'
import { createProject } from '@shared/project'
import type { Project } from '@shared/types'

const base = (): Project => createProject({ id: 'p1', title: 'Teste', createdAt: '2026-10-05T12:00:00.000Z' })

type Harness = { store: EditorStore; saved: Project[]; errors: string[]; fail: { value: Error | null } }

function harness(over: { debounceMs?: number; historyLimit?: number } = {}): Harness {
  const saved: Project[] = []
  const errors: string[] = []
  const fail = { value: null as Error | null }
  const store = createEditorStore({
    project: base(),
    save: async (p) => {
      if (fail.value) throw fail.value
      saved.push(p)
    },
    onSaveError: (m) => errors.push(m),
    ...over
  })
  return { store, saved, errors, fail }
}

const setTitle = (title: string) => (p: Project): Project => ({ ...p, title })
const addCut = (id: string, start: number) => (p: Project): Project => ({ ...p, cuts: [...p.cuts, { id, start, end: start + 100, reason: 'manual', enabled: true }] })

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('desfazer e refazer', () => {
  it('desfaz e refaz mudanças, na ordem', () => {
    const { store } = harness()
    const s = store.getState()
    s.change(setTitle('A'))
    s.change(setTitle('B'))
    s.change(setTitle('C'))
    expect(store.getState().project.title).toBe('C')
    expect(store.getState().undoCount).toBe(3)
    store.getState().undo()
    expect(store.getState().project.title).toBe('B')
    store.getState().undo()
    store.getState().undo()
    expect(store.getState().project.title).toBe('Teste')
    expect(store.getState().undo()).toBe(false) // nada mais para desfazer
    expect(store.getState().redoCount).toBe(3)
    store.getState().redo()
    store.getState().redo()
    expect(store.getState().project.title).toBe('B')
    expect(store.getState().redo()).toBe(true)
    expect(store.getState().redo()).toBe(false)
    expect(store.getState().project.title).toBe('C')
  })

  it('uma mudança nova depois de desfazer apaga o "refazer"', () => {
    const { store } = harness()
    store.getState().change(setTitle('A'))
    store.getState().change(setTitle('B'))
    store.getState().undo()
    expect(store.getState().redoCount).toBe(1)
    store.getState().change(setTitle('X'))
    expect(store.getState().redoCount).toBe(0)
    expect(store.getState().redo()).toBe(false)
    expect(store.getState().project.title).toBe('X')
  })

  it('mudança que devolve o mesmo objeto não vira passo', () => {
    const { store } = harness()
    expect(store.getState().change((p) => p)).toBe(false)
    expect(store.getState().undoCount).toBe(0)
  })

  it('guarda no máximo 100 passos: o mais antigo se perde, não o mais novo', () => {
    const { store } = harness()
    expect(HISTORY_LIMIT).toBe(100)
    for (let i = 1; i <= 130; i++) store.getState().change(setTitle(`T${i}`))
    expect(store.getState().undoCount).toBe(100)
    for (let i = 0; i < 100; i++) store.getState().undo()
    expect(store.getState().undo()).toBe(false)
    expect(store.getState().project.title).toBe('T30') // 130 − 100: o estado de 100 passos atrás
  })

  it('"history: false" muda e salva mas não entra no histórico', () => {
    const { store } = harness()
    store.getState().change(setTitle('silencioso'), { history: false })
    expect(store.getState().project.title).toBe('silencioso')
    expect(store.getState().undoCount).toBe(0)
  })
})

describe('agrupamento', () => {
  it('um arraste (begin…end) é UM passo, mesmo com dezenas de mudanças', () => {
    const { store } = harness()
    const s = store.getState()
    s.begin()
    for (let i = 1; i <= 40; i++) store.getState().change(addCut(`c${i}`, i * 200))
    expect(store.getState().undoCount).toBe(0) // ainda dentro do gesto
    store.getState().end()
    expect(store.getState().undoCount).toBe(1)
    expect(store.getState().project.cuts).toHaveLength(40)
    store.getState().undo()
    expect(store.getState().project.cuts).toHaveLength(0)
    store.getState().redo()
    expect(store.getState().project.cuts).toHaveLength(40)
  })

  it('um gesto sem mudança nenhuma não cria passo', () => {
    const { store } = harness()
    store.getState().begin()
    store.getState().end()
    expect(store.getState().undoCount).toBe(0)
  })

  it('desfazer no meio de um gesto é ignorado', () => {
    const { store } = harness()
    store.getState().change(setTitle('A'))
    store.getState().begin()
    store.getState().change(setTitle('B'))
    expect(store.getState().undo()).toBe(false)
    store.getState().end()
    expect(store.getState().project.title).toBe('B')
  })

  it('"coalesce": mudanças seguidas da mesma chave dentro da janela são um passo só', () => {
    const { store } = harness()
    store.getState().change(setTitle('A'), { coalesce: 'titulo' })
    vi.advanceTimersByTime(COALESCE_MS - 100)
    store.getState().change(setTitle('AB'), { coalesce: 'titulo' })
    vi.advanceTimersByTime(COALESCE_MS - 100)
    store.getState().change(setTitle('ABC'), { coalesce: 'titulo' })
    expect(store.getState().undoCount).toBe(1)
    store.getState().undo()
    expect(store.getState().project.title).toBe('Teste')
  })

  it('"coalesce": outra chave, ou pausa maior que a janela, abre um passo novo', () => {
    const { store } = harness()
    store.getState().change(setTitle('A'), { coalesce: 'x' })
    store.getState().change(setTitle('B'), { coalesce: 'y' })
    expect(store.getState().undoCount).toBe(2)
    vi.advanceTimersByTime(COALESCE_MS + 50)
    store.getState().change(setTitle('C'), { coalesce: 'y' })
    expect(store.getState().undoCount).toBe(3)
  })
})

describe('salvamento automático', () => {
  it(`espera ${AUTOSAVE_MS} ms depois da última mudança e grava UMA vez, com o documento mais novo`, async () => {
    const { store, saved } = harness()
    expect(store.getState().saveStatus).toBe('saved')
    store.getState().change(setTitle('A'))
    expect(store.getState().saveStatus).toBe('saving')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1)
    expect(saved).toHaveLength(0)
    store.getState().change(setTitle('B')) // reinicia a espera
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1)
    expect(saved).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.title).toBe('B')
    expect(store.getState().saveStatus).toBe('saved')
  })

  it('o estado vira "saved" só depois que a gravação termina', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const store = createEditorStore({ project: base(), save: () => gate })
    store.getState().change(setTitle('A'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(store.getState().saveStatus).toBe('saving')
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState().saveStatus).toBe('saved')
  })

  it('mudança que chega durante a gravação gera outra gravação, e o estado só fecha no fim', async () => {
    const calls: string[] = []
    let release: () => void = () => undefined
    const store = createEditorStore({
      project: base(),
      save: async (p) => {
        calls.push(p.title)
        if (calls.length === 1) await new Promise<void>((r) => (release = r))
      }
    })
    store.getState().change(setTitle('A'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(calls).toEqual(['A'])
    store.getState().change(setTitle('B')) // durante a primeira gravação
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState().saveStatus).toBe('saving') // B ainda não foi
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(calls).toEqual(['A', 'B'])
    expect(store.getState().saveStatus).toBe('saved')
  })

  it('flush() grava na hora (fechar o projeto não perde a última mudança)', async () => {
    const { store, saved } = harness()
    store.getState().change(setTitle('A'))
    await store.getState().flush()
    expect(saved.map((p) => p.title)).toEqual(['A'])
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 3)
    expect(saved).toHaveLength(1) // o temporizador antigo não regrava
    await store.getState().flush() // nada novo: não grava
    expect(saved).toHaveLength(1)
  })

  it('desfazer e refazer também salvam', async () => {
    const { store, saved } = harness()
    store.getState().change(setTitle('A'))
    await store.getState().flush()
    store.getState().undo()
    await store.getState().flush()
    store.getState().redo()
    await store.getState().flush()
    expect(saved.map((p) => p.title)).toEqual(['A', 'Teste', 'A'])
  })

  it('um arraste salva o resultado, não cada passo intermediário em separado', async () => {
    const { store, saved } = harness()
    store.getState().begin()
    for (let i = 1; i <= 30; i++) {
      store.getState().change(setTitle(`T${i}`))
      await vi.advanceTimersByTimeAsync(16)
    }
    store.getState().end()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.title).toBe('T30')
  })

  it('ERRO de gravação nunca é silencioso: fica no estado, vai para o aviso e a próxima mudança tenta de novo', async () => {
    const { store, saved, errors, fail } = harness()
    fail.value = new Error('Disco cheio')
    store.getState().change(setTitle('A'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(store.getState().saveStatus).toBe('error')
    expect(store.getState().saveError).toBe('Disco cheio')
    expect(errors).toEqual(['Disco cheio'])
    expect(saved).toHaveLength(0)

    fail.value = null
    store.getState().change(setTitle('B'))
    expect(store.getState().saveStatus).toBe('saving')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(saved.map((p) => p.title)).toEqual(['B'])
    expect(store.getState().saveStatus).toBe('saved')
    expect(store.getState().saveError).toBeNull()
  })

  it('depois de um erro, flush() tenta de novo sem precisar de mudança nova', async () => {
    const { store, saved, fail } = harness()
    fail.value = new Error('sem permissão')
    store.getState().change(setTitle('A'))
    await store.getState().flush()
    expect(store.getState().saveStatus).toBe('error')
    fail.value = null
    await store.getState().flush()
    expect(saved.map((p) => p.title)).toEqual(['A'])
    expect(store.getState().saveStatus).toBe('saved')
  })

  it('dispose() cancela o temporizador pendente', async () => {
    const { store, saved } = harness()
    store.getState().change(setTitle('A'))
    store.getState().dispose()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)
    expect(saved).toHaveLength(0)
  })
})

describe('seleção', () => {
  it('seleção e intervalo não entram no histórico nem disparam salvamento', async () => {
    const { store, saved } = harness()
    store.getState().setSelection({ kind: 'zoom', id: 'z1' })
    store.getState().setRange({ start: 1000, end: 2000 })
    expect(store.getState().undoCount).toBe(0)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)
    expect(saved).toHaveLength(0)
  })

  it('desfazer que faz o item selecionado sumir limpa a seleção', () => {
    const { store } = harness()
    store.getState().change((p) => ({ ...p, zooms: [{ id: 'z1', start: 0, end: 1000, scale: 1.5, focus: 'auto', origin: 'manual' }] }))
    store.getState().setSelection({ kind: 'zoom', id: 'z1' })
    store.getState().undo()
    expect(store.getState().selection).toBeNull()
    store.getState().redo()
    expect(store.getState().project.zooms).toHaveLength(1)
  })

  it('selectionExists confere zoom, layout e corte', () => {
    const p = { ...base(), cuts: [{ id: 'c1', start: 0, end: 100, reason: 'manual' as const, enabled: true }] }
    expect(selectionExists(p, null)).toBe(true)
    expect(selectionExists(p, { kind: 'cut', id: 'c1' })).toBe(true)
    expect(selectionExists(p, { kind: 'cut', id: 'nada' })).toBe(false)
    expect(selectionExists(p, { kind: 'layout', id: 'l1' })).toBe(false)
  })
})
