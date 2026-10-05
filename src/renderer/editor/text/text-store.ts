/**
 * Estado da aba Texto (fora do documento: nada daqui vai para o `project.json`): a seleção de palavras, a busca,
 * a palavra em correção e as escolhas do painel de Limpeza (inclusive os recomeços que a IA apontou). Zustand
 * "vanilla", um por editor aberto; sobrevive à troca de aba.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import { DEFAULT_CLEAN, type CleanOptions } from '@shared/clean'
import type { RetakesResult } from '@shared/transcription'

/** Palavras selecionadas: `anchor` é onde começou, `focus` onde está agora (podem estar em qualquer ordem). */
export type WordSelection = { anchor: number; focus: number }

/** As duas metades da aba: o texto em si e o painel de limpeza. */
export type TextPane = 'text' | 'clean'

export type RetakesStatus = 'idle' | 'loading' | 'ready' | 'error'

/** As abas que um pedido de dentro do editor pode abrir. */
export type RequestableTab = 'text' | 'clips' | 'publish' | 'ai'

export type TextState = {
  selection: WordSelection | null
  /** Onde a pessoa clicou por último (o "cursor" do texto): Shift+clique estende a partir daqui. */
  caret: number | null
  searchOpen: boolean
  query: string
  /** Qual resultado da busca está em foco (posição na lista de resultados). */
  matchAt: number
  /** Palavra com o campo de correção aberto. */
  editing: number | null
  pane: TextPane
  options: CleanOptions
  retakes: RetakesResult | null
  retakesStatus: RetakesStatus
  retakesError: string | null
  /** Pedido de troca de aba (Ctrl+F leva ao Texto; um painel sem transcrição leva até lá); o painel lateral reage ao número. */
  tabRequest: { tab: RequestableTab; n: number } | null

  select(selection: WordSelection | null): void
  setCaret(i: number | null): void
  openSearch(): void
  /** Abre outra aba do painel lateral. */
  requestTab(tab: RequestableTab): void
  closeSearch(): void
  setQuery(query: string): void
  setMatchAt(at: number): void
  edit(i: number | null): void
  setPane(pane: TextPane): void
  setOptions(patch: Partial<CleanOptions>): void
  setRetakes(status: RetakesStatus, result?: RetakesResult | null, error?: string | null): void
  /** Esc / trocar de projeto: some a seleção e fecha o que estiver aberto. */
  clear(): void
}

export type TextStore = StoreApi<TextState>

/** Faixa [de, até] (ordenada) de uma seleção. */
export const selectionRange = (s: WordSelection | null): { from: number; to: number } | null => (s ? { from: Math.min(s.anchor, s.focus), to: Math.max(s.anchor, s.focus) } : null)

export function createTextStore(): TextStore {
  let tabSeq = 0
  return createStore<TextState>()((set) => ({
    selection: null,
    caret: null,
    searchOpen: false,
    query: '',
    matchAt: 0,
    editing: null,
    pane: 'text',
    options: { ...DEFAULT_CLEAN },
    retakes: null,
    retakesStatus: 'idle',
    retakesError: null,
    tabRequest: null,

    select: (selection) => set({ selection, editing: null }),
    setCaret: (caret) => set({ caret }),
    openSearch: () => set({ searchOpen: true, pane: 'text', tabRequest: { tab: 'text', n: ++tabSeq } }),
    requestTab: (tab) => set({ tabRequest: { tab, n: ++tabSeq } }),
    closeSearch: () => set({ searchOpen: false, query: '', matchAt: 0 }),
    setQuery: (query) => set({ query, matchAt: 0 }),
    setMatchAt: (matchAt) => set({ matchAt }),
    edit: (editing) => set({ editing }),
    setPane: (pane) => set({ pane }),
    setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),
    setRetakes: (retakesStatus, result, error) =>
      set((s) => ({ retakesStatus, retakes: result === undefined ? s.retakes : result, retakesError: error ?? null })),
    clear: () => set({ selection: null, editing: null, searchOpen: false, query: '', matchAt: 0 })
  }))
}
