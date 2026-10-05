/**
 * Estado do EDITOR: o documento aberto (`Project`) com desfazer/refazer e salvamento automático.
 *
 *  - Desfazer/refazer: 100 passos, cada passo é uma fotografia imutável do documento (compartilha
 *    estrutura com a seguinte, então é barato). Um ARRASTE vira UM passo só (`begin()`…`end()`), e
 *    mudanças contínuas do mesmo controle (um controle deslizante, as setas do teclado) se juntam num
 *    passo só pela chave `coalesce`.
 *  - Salvamento: 500 ms depois da última mudança, pela função `save` que a interface injeta (gravação
 *    atômica no processo principal). O estado é `saved` / `saving` / `error`; erro NUNCA é silencioso:
 *    fica no estado, vai para `onSaveError` e a próxima mudança (ou `flush()`) tenta de novo.
 *  - Seleção e intervalo marcado na linha do tempo moram aqui para valer em toda a interface, mas NÃO
 *    entram no histórico.
 *
 * Zustand "vanilla" (sem React) e sem DOM/Node: roda igual nos testes. A interface usa
 * `useStore(store, seletor)`.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { Project } from './types'

export const HISTORY_LIMIT = 100
export const AUTOSAVE_MS = 500
/** Mudanças da mesma chave com menos que isto entre uma e outra viram um passo só. */
export const COALESCE_MS = 900

export type SaveStatus = 'saved' | 'saving' | 'error'

export type SelectionKind = 'zoom' | 'layout' | 'cut'
export type Selection = { kind: SelectionKind; id: string } | null
/** Intervalo marcado arrastando na trilha de vídeo (ms de ORIGEM). */
export type TimeRange = { start: number; end: number }

export type EditorDeps = {
  project: Project
  /** Grava o documento (a interface injeta `window.tomada.projects.save`). */
  save(project: Project): Promise<unknown>
  debounceMs?: number
  historyLimit?: number
  /** Chamado a cada falha de salvamento, com o motivo. */
  onSaveError?(message: string): void
  /** Relógio (ms), para os testes. */
  now?(): number
}

export type ChangeOptions = {
  /** `false`: muda e salva, mas NÃO vira passo de desfazer (ex.: gerar os zooms ao abrir). */
  history?: boolean
  /** Junta mudanças seguidas com a mesma chave num passo só. */
  coalesce?: string
}

export type EditorState = {
  project: Project
  undoCount: number
  redoCount: number
  saveStatus: SaveStatus
  saveError: string | null
  selection: Selection
  range: TimeRange | null

  /** Aplica uma mudança ao documento. Devolve `false` se `fn` devolveu o mesmo objeto (nada mudou). */
  change(fn: (project: Project) => Project, options?: ChangeOptions): boolean
  /** Começa um gesto contínuo (arraste): tudo até `end()` vira UM passo de desfazer. */
  begin(): void
  end(): void
  undo(): boolean
  redo(): boolean
  setSelection(selection: Selection): void
  setRange(range: TimeRange | null): void
  /** Salva agora (e espera o que já estava em voo). */
  flush(): Promise<void>
  /** Cancela o temporizador. Chame `flush()` antes se ainda houver o que gravar. */
  dispose(): void
}

export type EditorStore = StoreApi<EditorState>

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A seleção ainda aponta para algo que existe no documento? */
export function selectionExists(project: Project, selection: Selection): boolean {
  if (!selection) return true
  switch (selection.kind) {
    case 'zoom':
      return project.zooms.some((z) => z.id === selection.id)
    case 'layout':
      return project.layouts.some((l) => l.id === selection.id)
    case 'cut':
      return project.cuts.some((c) => c.id === selection.id)
  }
}

export function createEditorStore(deps: EditorDeps): EditorStore {
  const debounceMs = deps.debounceMs ?? AUTOSAVE_MS
  const limit = deps.historyLimit ?? HISTORY_LIMIT
  const now = deps.now ?? ((): number => Date.now())

  let past: Project[] = []
  let future: Project[] = []
  let group: { base: Project; changed: boolean } | null = null
  let last: { key: string; at: number } | null = null

  let timer: ReturnType<typeof setTimeout> | undefined
  let inflight: Promise<void> = Promise.resolve()
  let dirty = false

  const store = createStore<EditorState>()((set, get) => {
    const counts = (): Pick<EditorState, 'undoCount' | 'redoCount'> => ({ undoCount: past.length, redoCount: future.length })

    const push = (snapshot: Project): void => {
      past.push(snapshot)
      if (past.length > limit) past = past.slice(past.length - limit)
      future = []
    }

    const scheduleSave = (): void => {
      dirty = true
      if (get().saveStatus !== 'saving') set({ saveStatus: 'saving' })
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => void get().flush(), debounceMs)
    }

    const fixSelection = (project: Project): Pick<EditorState, 'selection'> | Record<string, never> =>
      selectionExists(project, get().selection) ? {} : { selection: null }

    return {
      project: deps.project,
      undoCount: 0,
      redoCount: 0,
      saveStatus: 'saved',
      saveError: null,
      selection: null,
      range: null,

      change(fn, options = {}) {
        const prev = get().project
        const next = fn(prev)
        if (next === prev) return false
        if (group) {
          group.changed = true
          set({ project: next })
        } else {
          if (options.history !== false) {
            const t = now()
            if (options.coalesce && last && last.key === options.coalesce && t - last.at <= COALESCE_MS) {
              last.at = t
            } else {
              push(prev)
              last = options.coalesce ? { key: options.coalesce, at: t } : null
            }
          }
          set({ project: next, ...counts() })
        }
        scheduleSave()
        return true
      },

      begin() {
        if (group) return
        group = { base: get().project, changed: false }
      },

      end() {
        if (!group) return
        const g = group
        group = null
        if (g.changed) {
          push(g.base)
          last = null
          set({ ...counts() })
        }
      },

      undo() {
        if (group || past.length === 0) return false
        const current = get().project
        const prev = past[past.length - 1]!
        past = past.slice(0, -1)
        future.push(current)
        last = null
        set({ project: prev, ...counts(), ...fixSelection(prev) })
        scheduleSave()
        return true
      },

      redo() {
        if (group || future.length === 0) return false
        const current = get().project
        const next = future[future.length - 1]!
        future = future.slice(0, -1)
        past.push(current)
        last = null
        set({ project: next, ...counts(), ...fixSelection(next) })
        scheduleSave()
        return true
      },

      setSelection: (selection) => set({ selection }),
      setRange: (range) => set({ range }),

      flush() {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        if (!dirty) return inflight
        dirty = false
        const doc = get().project
        set({ saveStatus: 'saving' })
        inflight = inflight.then(async () => {
          try {
            await deps.save(doc)
            if (!dirty) set({ saveStatus: 'saved', saveError: null })
          } catch (err) {
            dirty = true // a próxima mudança (ou um novo flush) tenta de novo
            const message = messageOf(err)
            set({ saveStatus: 'error', saveError: message })
            deps.onSaveError?.(message)
          }
        })
        return inflight
      },

      dispose() {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
      }
    }
  })

  return store
}
