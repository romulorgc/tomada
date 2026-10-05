/**
 * Ações do editor que mais de um lugar dispara (botão da barra de ferramentas, atalho do teclado, painel):
 * cortar o intervalo marcado, apagar o selecionado, dividir o layout, criar zoom, desfazer/refazer.
 * Cada uma lê o estado NA HORA da chamada (store), então não fica velha dentro de um `useEffect`.
 */
import { useMemo } from 'react'
import { addManualCut, restoreCut } from '@shared/cuts'
import { createLayoutSeg, createZoom, createZoomAt, deleteLayoutSeg, deleteZoom, splitLayoutAt } from '@shared/edits'
import type { LayoutKind } from '@shared/types'
import { useEditor } from './context'

/** Zoom criado com a tecla Z sem intervalo marcado: dura isto (ms) a partir da cabeça de reprodução. */
export const QUICK_ZOOM_MS = 2000

export type EditorOps = ReturnType<typeof useEditorOps>

export function useEditorOps() {
  const { store, playback, engineRef, durationMs } = useEditor()
  return useMemo(() => {
    const st = () => store.getState()
    const ops = {
      /** Corta o intervalo marcado na trilha de vídeo. */
      cutRange(): boolean {
        const { range } = st()
        if (!range) return false
        st().change((p) => ({ ...p, cuts: addManualCut(p.cuts, range.start, range.end, durationMs) }))
        st().setRange(null)
        return true
      },

      /** Delete/Backspace: apaga o zoom ou trecho de layout selecionado, restaura o corte selecionado ou corta o intervalo. */
      deleteSelected(): boolean {
        const { selection } = st()
        if (selection?.kind === 'zoom') {
          st().change((p) => deleteZoom(p, selection.id))
          st().setSelection(null)
          return true
        }
        if (selection?.kind === 'layout') {
          st().change((p) => deleteLayoutSeg(p, selection.id))
          st().setSelection(null)
          return true
        }
        if (selection?.kind === 'cut') {
          st().change((p) => ({ ...p, cuts: restoreCut(p.cuts, selection.id) }))
          st().setSelection(null)
          return true
        }
        return ops.cutRange()
      },

      /** S: divide o layout no ponto da reprodução. */
      splitAtPlayhead(): boolean {
        const t = playback.getState().sourceMs
        let made: string | null = null
        st().change((p) => {
          const r = splitLayoutAt(p, t, durationMs)
          if (!r) return p
          made = r.id
          return r.project
        })
        if (made) st().setSelection({ kind: 'layout', id: made })
        return made !== null
      },

      /** Z: zoom no intervalo marcado, ou de 2 s a partir da cabeça de reprodução. */
      zoomFromRange(): boolean {
        const { range } = st()
        const t = playback.getState().sourceMs
        let made: string | null = null
        st().change((p) => {
          const r = range ? createZoom(p, range.start, range.end, durationMs) : createZoomAt(p, t, QUICK_ZOOM_MS, durationMs)
          if (!r) return p
          made = r.id
          return r.project
        })
        if (made) {
          st().setSelection({ kind: 'zoom', id: made })
          st().setRange(null)
        }
        return made !== null
      },

      /** Cria um trecho de layout arrastando de `a` a `b` na trilha Layout. */
      createLayout(a: number, b: number, layout: LayoutKind): string | null {
        let made: string | null = null
        st().change((p) => {
          const r = createLayoutSeg(p, a, b, durationMs, layout)
          if (!r) return p
          made = r.id
          return r.project
        })
        if (made) st().setSelection({ kind: 'layout', id: made })
        return made
      },

      /** Cria um zoom arrastando de `a` a `b` na trilha Zoom. */
      createZoomDrag(a: number, b: number): string | null {
        let made: string | null = null
        st().change((p) => {
          const r = createZoom(p, a, b, durationMs)
          if (!r) return p
          made = r.id
          return r.project
        })
        if (made) st().setSelection({ kind: 'zoom', id: made })
        return made
      },

      undo(): void {
        st().undo()
      },
      redo(): void {
        st().redo()
      },
      clearSelection(): void {
        st().setSelection(null)
        st().setRange(null)
      },
      engine: () => engineRef.current
    }
    return ops
  }, [store, playback, engineRef, durationMs])
}
