/**
 * Contexto do editor: o que todas as peças (barra superior, prévia, painel, linha do tempo, exportação)
 * compartilham - o documento (store), a reprodução (store do motor), o motor, os eventos já lidos e as mídias
 * derivadas (forma de onda, miniaturas).
 */
import { createContext, useContext, type MutableRefObject, type RefObject } from 'react'
import { useStore } from 'zustand'
import type { EditorState, EditorStore } from '@shared/editor-store'
import type { Levels } from '@shared/clean'
import type { ClipQueue } from '@shared/clip-queue'
import type { PeaksData, ProjectDetail, ThumbsData } from '@shared/ipc'
import type { CursorData, Derived } from '@shared/scene'
import type { FaceTrack } from '@shared/face'
import type { Transcript } from '@shared/types'
import type { AiUiStore } from './ai-store'
import type { ClipsUiStore } from './clips-store'
import type { PreviewEngine } from './engine'
import type { PlaybackState, PlaybackStore } from './playback-store'
import type { TextStore } from './text/text-store'
import type { ExportController } from './use-export'

export type AssetState<T> = { status: 'loading' | 'ready' | 'error' | 'none'; data: T | null; error: string | null }

export type EditorCtx = {
  detail: ProjectDetail
  /** Item da Revisão: restaurar uma palavra precisa sobrepor a grafia comum explicitamente. */
  itemId?: string
  store: EditorStore
  playback: PlaybackStore
  engineRef: MutableRefObject<PreviewEngine | null>
  /** Eventos do cursor, depois de lidos, JÁ no espaço do recorte da tela (null enquanto carrega). */
  cursorData: CursorData | null
  /** Os mesmos eventos na tela inteira, sem recorte (de onde o recorte parte; C1). */
  rawData: CursorData | null
  eventsError: string | null
  /** A cena do vídeo (do formato aberto): a linha do tempo e o diálogo de exportar usam esta. */
  derived: Derived | null
  /** O que a prévia e o relógio mostram: a cena do vídeo, ou a do corte que está em prévia (sempre vertical). */
  sceneDerived: Derived | null
  durationMs: number
  hasScreen: boolean
  hasCamera: boolean
  peaks: AssetState<PeaksData>
  thumbs: AssetState<ThumbsData>
  retryAssets(): void
  /** A transcrição do projeto (lida do transcript.json). */
  transcript: AssetState<Transcript>
  reloadTranscript(): void
  /** A análise do rosto na câmera (enquadramento): lida de `media/camera-face.json`; `none` = ainda não existe. */
  face: AssetState<FaceTrack>
  /** O recorte do fundo da câmera (M4c): a URL do vídeo da máscara (`null` = ainda não existe) e se algum trecho do formato aberto o usa. */
  matte: { url: string | null; needed: boolean }
  /** Nível do áudio por quadro (para achar silêncio); só é pedido depois que há transcrição. */
  levels: AssetState<Levels>
  /** Estado da aba Texto (seleção, busca, escolhas da limpeza). */
  text: TextStore
  exporter: ExportController
  /** Estado da aba Cortes (marcados, aberto, em prévia, última sugestão). */
  clips: ClipsUiStore
  /** A fila de exportação dos cortes. */
  queue: ClipQueue
  /** Estado da aba IA (histórico, pedido em andamento, mudança esperando confirmação). */
  ai: AiUiStore
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
