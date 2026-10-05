/**
 * Contexto do editor: o que todas as peças (barra superior, prévia, painel, linha do tempo, exportação)
 * compartilham - o documento (store), a reprodução (store do motor), o motor, os eventos já lidos e as mídias
 * derivadas (forma de onda, miniaturas).
 */
import { createContext, useContext, type MutableRefObject, type RefObject } from 'react'
import { useStore } from 'zustand'
import type { EditorState, EditorStore } from '@shared/editor-store'
import type { PeaksData, ProjectDetail, ThumbsData } from '@shared/ipc'
import type { CursorData, Derived } from '@shared/scene'
import type { PreviewEngine } from './engine'
import type { PlaybackState, PlaybackStore } from './playback-store'
import type { ExportController } from './use-export'

export type AssetState<T> = { status: 'loading' | 'ready' | 'error' | 'none'; data: T | null; error: string | null }

export type EditorCtx = {
  detail: ProjectDetail
  store: EditorStore
  playback: PlaybackStore
  engineRef: MutableRefObject<PreviewEngine | null>
  /** Eventos do cursor, depois de lidos (null enquanto carrega). */
  cursorData: CursorData | null
  eventsError: string | null
  derived: Derived | null
  durationMs: number
  hasScreen: boolean
  hasCamera: boolean
  peaks: AssetState<PeaksData>
  thumbs: AssetState<ThumbsData>
  retryAssets(): void
  exporter: ExportController
  /** Os elementos da prévia que o motor usa (o canvas, onde as mídias invisíveis ficam e o quadro). */
  refs: { canvas: RefObject<HTMLCanvasElement | null>; host: RefObject<HTMLDivElement | null>; frame: RefObject<HTMLDivElement | null> }
}

export const EditorContext = createContext<EditorCtx | null>(null)

export function useEditor(): EditorCtx {
  const ctx = useContext(EditorContext)
  if (!ctx) throw new Error('useEditor fora do <Editor>.')
  return ctx
}

/** Fatia do documento/seleção (re-renderiza só quando ela muda). */
export function useDoc<T>(selector: (state: EditorState) => T): T {
  return useStore(useEditor().store, selector)
}

/** Fatia da reprodução (tempo, tocando…). */
export function usePlayback<T>(selector: (state: PlaybackState) => T): T {
  return useStore(useEditor().playback, selector)
}
