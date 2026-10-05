/**
 * Estado da aba Cortes que NÃO vai para o documento (nada daqui entra no `project.json`): quais cortes estão marcados
 * para exportar, qual está aberto para editar, qual está em prévia e o andamento da última sugestão. Zustand "vanilla", um
 * por editor aberto; sobrevive à troca de aba. A lista de cortes em si mora no documento (`project.clips`), então
 * criar, editar e apagar entram no desfazer.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { ClipDrop } from '@shared/clips'

export type SuggestStatus = 'idle' | 'loading' | 'ready' | 'error'

/** O que a última sugestão fez (para a linha de resumo da aba). */
export type SuggestSummary = { source: 'ai' | 'heuristic'; added: number; skipped: number; dropped: ClipDrop[]; notice: string | null }

export type ClipsUiState = {
  /** Cortes marcados para exportar (ids). */
  selected: string[]
  /** O corte com os campos de edição abertos. */
  openId: string | null
  /** O corte que a prévia mostra (a prévia do corte é sempre vertical). */
  previewId: string | null
  status: SuggestStatus
  error: string | null
  last: SuggestSummary | null

  toggle(id: string): void
  select(ids: readonly string[]): void
  open(id: string | null): void
  preview(id: string | null): void
  setStatus(status: SuggestStatus, error?: string | null): void
  setLast(last: SuggestSummary | null): void
  /** Um corte foi apagado: some de onde estiver. */
  forget(id: string): void
}

export type ClipsUiStore = StoreApi<ClipsUiState>

export function createClipsUiStore(): ClipsUiStore {
  return createStore<ClipsUiState>()((set) => ({
    selected: [],
    openId: null,
    previewId: null,
    status: 'idle',
    error: null,
    last: null,

    toggle: (id) => set((s) => ({ selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id] })),
    select: (ids) => set({ selected: [...ids] }),
    open: (openId) => set({ openId }),
    preview: (previewId) => set({ previewId }),
    setStatus: (status, error) => set({ status, error: error ?? null }),
    setLast: (last) => set({ last }),
    forget: (id) => set((s) => ({ selected: s.selected.filter((x) => x !== id), openId: s.openId === id ? null : s.openId, previewId: s.previewId === id ? null : s.previewId }))
  }))
}
