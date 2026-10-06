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
 * FORMATO (M4a): o documento guarda duas edições, a do 16:9 e a do vertical 9:16 (`project.vertical`). `doc` é o
 * documento INTEIRO (é ele que vai para o disco e para o histórico); `project` é a VISÃO do formato aberto
 * (`projectForFormat`): no 16:9 é o próprio documento (mesmo objeto), no 9:16 traz os zooms, layouts, câmera e legenda
 * do vertical no lugar dos do 16:9. Toda a interface lê e muda `project` e não sabe de que formato é: `change(fn)`
 * aplica `fn` à visão e devolve o resultado ao documento (`mergeFormatView`).
 *
 * Zustand "vanilla" (sem React) e sem DOM/Node: roda igual nos testes. A interface usa
 * `useStore(store, seletor)`.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { Project } from './types'
import { mergeFormatView, projectForFormat } from './vertical'
import { preserveManualDecisions } from './review'

export type FormatKind = 'horizontal' | 'vertical'

export const HISTORY_LIMIT = 100
export const AUTOSAVE_MS = 500
/** Mudanças da mesma chave com menos que isto entre uma e outra viram um passo só. */
export const COALESCE_MS = 900

export type SaveStatus = 'saved' | 'saving' | 'error'

export type SelectionKind = 'zoom' | 'layout' | 'cut' | 'blur'
export type Selection = { kind: SelectionKind; id: string } | null
/** Intervalo marcado arrastando na trilha de vídeo (ms de ORIGEM). */
export type TimeRange = { start: number; end: number }

export type EditorDeps = {
  project: Project
  /** Grava o documento (a interface injeta `window.tomada.projects.save`). */
  save(project: Project, lastSubmitted: Project): Promise<unknown>
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
  /** O documento como o formato aberto o enxerga (no 16:9, o próprio documento). */
  project: Project
  /** O documento inteiro: é o que se grava e o que o desfazer guarda. */
  doc: Project
  format: FormatKind
  /** Mostra na prévia as zonas da interface das plataformas (só o vertical; nunca vai para a exportação). */
  safeGuide: boolean
  blurDrawing: boolean
  undoCount: number
  redoCount: number
  saveStatus: SaveStatus
  saveError: string | null
  selection: Selection
  range: TimeRange | null

  /** Aplica uma mudança à visão do formato aberto. Devolve `false` se `fn` devolveu o mesmo objeto (nada mudou). */
  change(fn: (project: Project) => Project, options?: ChangeOptions): boolean
  /** Aplica uma mudança ao documento INTEIRO (as duas edições), como a que cria a edição vertical na primeira vez. */
  changeDoc(fn: (doc: Project) => Project, options?: ChangeOptions): boolean
  /** Troca o formato aberto (16:9 ou 9:16). Não é um passo de desfazer. */
  setFormat(format: FormatKind): void
  setSafeGuide(on: boolean): void
  setBlurDrawing(on: boolean): void
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
export function selectionExists(project: Pick<Project, 'zooms' | 'layouts' | 'cuts' | 'blurRegions'>, selection: Selection): boolean {
  if (!selection) return true
  switch (selection.kind) {
    case 'blur':
      return Boolean(project.blurRegions?.some(r => r.id === selection.id))
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
  let lastSubmitted = deps.project

  let viewCache: { doc: Project; format: FormatKind; view: Project } | null = null
  /** A visão do formato (a mesma de antes enquanto o documento é o mesmo objeto: a identidade importa para quem compara). */
  const viewOf = (doc: Project, format: FormatKind): Project => {
    if (format === 'horizontal') return doc
    if (viewCache && viewCache.doc === doc && viewCache.format === format) return viewCache.view
    const view = projectForFormat(doc, format)
    viewCache = { doc, format, view }
    return view
  }

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
      timer = setTimeout(() => void get().flush().catch(() => undefined), debounceMs)
    }

    const fixSelection = (doc: Project): Pick<EditorState, 'selection'> | Record<string, never> =>
      selectionExists(viewOf(doc, get().format), get().selection) ? {} : { selection: null }

    /** O documento e a visão dele andam juntos. */
    const docPatch = (doc: Project): Pick<EditorState, 'doc' | 'project'> => ({ doc, project: viewOf(doc, get().format) })

    const apply = (next: Project, prev: Project, options: ChangeOptions): boolean => {
      if (next === prev) return false
      if (options.history !== false) next = preserveManualDecisions(prev, next)
      if (group) {
        group.changed = true
        set(docPatch(next))
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
        set({ ...docPatch(next), ...counts() })
      }
      scheduleSave()
      return true
    }

    return {
      project: viewOf(deps.project, 'horizontal'),
      doc: deps.project,
      format: 'horizontal',
      safeGuide: false,
      blurDrawing: false,
      undoCount: 0,
      redoCount: 0,
      saveStatus: 'saved',
      saveError: null,
      selection: null,
      range: null,

      change(fn, options = {}) {
        const { doc: prevDoc, project: prevView, format } = get()
        const nextView = fn(prevView)
        if (nextView === prevView) return false
        return apply(mergeFormatView(prevDoc, nextView, format), prevDoc, options)
      },

      changeDoc(fn, options = {}) {
        const prevDoc = get().doc
        return apply(fn(prevDoc), prevDoc, options)
      },

      setFormat(format) {
        if (get().format === format) return
        const doc = get().doc
        const view = viewOf(doc, format)
        set({ format, project: view, selection: selectionExists(view, get().selection) ? get().selection : null })
      },

      setSafeGuide: (on) => set({ safeGuide: on }),
      setBlurDrawing: (on) => set({ blurDrawing: on }),

      begin() {
        if (group) return
        group = { base: get().doc, changed: false }
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
        const current = get().doc
        const prev = past[past.length - 1]!
        past = past.slice(0, -1)
        future.push(current)
        last = null
        set({ ...docPatch(prev), ...counts(), ...fixSelection(prev) })
        scheduleSave()
        return true
      },

      redo() {
        if (group || future.length === 0) return false
        const current = get().doc
        const next = future[future.length - 1]!
        future = future.slice(0, -1)
        past.push(current)
        last = null
        set({ ...docPatch(next), ...counts(), ...fixSelection(next) })
        scheduleSave()
        return true
      },

      setSelection: (selection) => set({ selection }),
      setRange: (range) => set({ range }),

      flush() {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        if (!dirty) return inflight
        set({ saveStatus: 'saving' })
        inflight = inflight.catch(() => undefined).then(async () => {
          const doc = get().doc
          dirty = false
          try {
            await deps.save(doc, lastSubmitted)
            lastSubmitted = doc
            dirty = get().doc !== doc
            if (!dirty) set({ saveStatus: 'saved', saveError: null })
          } catch (err) {
            dirty = true // a próxima mudança (ou um novo flush) tenta de novo
            const message = messageOf(err)
            set({ saveStatus: 'error', saveError: message })
            deps.onSaveError?.(message)
            throw err
          }
        })
        // Uma edição durante o save também precisa chegar ao disco antes de liberar a exportação.
        return inflight.then(() => dirty ? get().flush() : undefined)
      },

      dispose() {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
      }
    }
  })

  return store
}
