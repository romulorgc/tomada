/**
 * Estado global da interface (Zustand): navegação, biblioteca e avisos.
 * Toda falha vira aviso visível com o motivo; nada se perde em silêncio.
 */
import { create } from 'zustand'
import type { ProjectSummary } from '@shared/types'
import { t } from './i18n/pt-BR'

export type View =
  | { name: 'library' }
  | { name: 'project'; id: string; itemId?: string }
  | { name: 'review'; id: string }
  | { name: 'record' }
  | { name: 'processing' }
  | { name: 'settings' }

export type Notice = {
  id: number
  kind: 'info' | 'error'
  /** Frase curta. Em erro, o que não deu certo. */
  text: string
  /** Motivo detalhado (mensagem do sistema), se houver. */
  detail?: string
}

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

interface AppStore {
  view: View
  go: (view: View) => void

  projects: ProjectSummary[]
  status: LoadStatus
  error: string | null
  loadProjects: () => Promise<void>
  renameProject: (id: string, title: string) => Promise<boolean>
  trashProject: (id: string) => Promise<boolean>
  revealProject: (id: string) => Promise<void>

  notices: Notice[]
  notify: (n: Omit<Notice, 'id'>) => void
  dismiss: (id: number) => void
}

let noticeSeq = 0
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export const useApp = create<AppStore>()((set, get) => ({
  view: { name: 'library' },
  go: (view) => set({ view }),

  projects: [],
  status: 'idle',
  error: null,

  async loadProjects() {
    // Só mostra "carregando" na primeira vez; as atualizações seguintes não piscam a tela.
    if (get().status !== 'ready') set({ status: 'loading', error: null })
    try {
      const projects = await window.tomada.projects.list()
      set({ projects, status: 'ready', error: null })
    } catch (err) {
      window.tomada.log({ level: 'error', message: 'Falha ao listar projetos' /* log técnico, não aparece na tela */, detail: messageOf(err) })
      set({ status: 'error', error: messageOf(err) })
    }
  },

  async renameProject(id, title) {
    try {
      const updated = await window.tomada.projects.rename(id, title)
      set((s) => ({ projects: s.projects.map((p) => (p.id === id ? updated : p)) }))
      return true
    } catch (err) {
      get().notify({ kind: 'error', text: t.library.notices.renameFailed, detail: messageOf(err) })
      return false
    }
  },

  async trashProject(id) {
    try {
      await window.tomada.projects.trash(id)
      set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }))
      return true
    } catch (err) {
      get().notify({ kind: 'error', text: t.library.notices.removeFailed, detail: messageOf(err) })
      return false
    }
  },

  async revealProject(id) {
    try {
      await window.tomada.projects.reveal(id)
    } catch (err) {
      get().notify({ kind: 'error', text: t.library.notices.revealFailed, detail: messageOf(err) })
    }
  },

  notices: [],
  notify(n) {
    const notice: Notice = { ...n, id: ++noticeSeq }
    set((s) => ({ notices: [...s.notices, notice].slice(-4) }))
  },
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }))
}))
