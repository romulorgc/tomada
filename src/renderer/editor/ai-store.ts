/**
 * Estado da aba IA ("editar pedindo") que NÃO vai para o documento: o histórico desta sessão, o pedido em andamento e a
 * mudança que espera confirmação (passou de 20% do vídeo). A mudança aplicada, essa sim, vai para o documento e para o
 * desfazer (uma só). Zustand "vanilla", um por editor aberto.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

export type AiEntryStatus = 'applied' | 'refused' | 'noop' | 'cancelled' | 'error'

export type AiEntry = {
  id: number
  instruction: string
  status: AiEntryStatus
  /** O resumo humano ("Cortei 3 trechos (−42 s)."), a frase da IA ou o motivo do erro. */
  text: string
  /** O que foi recusado, uma frase por operação. */
  refused: string[]
}

/** A mudança que espera um "Aplicar" (ela tira mais de 20% do vídeo). */
export type AiPending = {
  instruction: string
  ops: unknown[]
  reply: string | null
  summary: string
  removedMs: number
  pct: number
}

/** O andamento da aba Publicar (o texto gerado vai para o documento; isto é só o que a tela mostra). */
export type PublishUi = {
  busy: boolean
  error: string | null
  /** O que foi descartado ou corrigido nas respostas da IA (a conferência dos capítulos, das tags…). */
  notes: string[]
  /** Os capítulos atuais vieram das pausas (sem IA): a tela pede para conferir os títulos. */
  chaptersByPauses: boolean
  /** Por que não saíram capítulos pelas pausas (vídeo curto demais, poucas pausas…). */
  chaptersWhy: string | null
}

export type AiUiState = {
  busy: boolean
  history: AiEntry[]
  pending: AiPending | null
  publish: PublishUi

  setBusy(busy: boolean): void
  setPublish(patch: Partial<PublishUi>): void
  setPending(pending: AiPending | null): void
  record(entry: Omit<AiEntry, 'id'>): void
}

export type AiUiStore = StoreApi<AiUiState>

export function createAiUiStore(): AiUiStore {
  let seq = 0
  return createStore<AiUiState>()((set) => ({
    busy: false,
    history: [],
    pending: null,
    publish: { busy: false, error: null, notes: [], chaptersByPauses: false, chaptersWhy: null },

    setBusy: (busy) => set({ busy }),
    setPublish: (patch) => set((s) => ({ publish: { ...s.publish, ...patch } })),
    setPending: (pending) => set({ pending }),
    record: (entry) => set((s) => ({ history: [{ ...entry, id: ++seq }, ...s.history].slice(0, 50) }))
  }))
}
