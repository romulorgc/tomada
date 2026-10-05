/**
 * Ações do editor que mais de um lugar dispara (botão da barra de ferramentas, atalho do teclado, painel):
 * cortar o intervalo marcado, apagar o selecionado, dividir o layout, criar zoom, desfazer/refazer.
 * Cada uma lê o estado NA HORA da chamada (store), então não fica velha dentro de um `useEffect`.
 */
import { useMemo } from 'react'
import { addManualCut, restoreCut } from '@shared/cuts'
import { createLayoutSeg, createZoom, createZoomAt, deleteLayoutSeg, deleteZoom, splitLayoutAt } from '@shared/edits'
import { cutWords, restoreWords, togglePause } from '@shared/text-edit'
import type { LayoutKind } from '@shared/types'
import { selectionRange } from './text/text-store'
import { useEditor } from './context'

/** Zoom criado com a tecla Z sem intervalo marcado: dura isto (ms) a partir da cabeça de reprodução. */
export const QUICK_ZOOM_MS = 2000

export type EditorOps = ReturnType<typeof useEditorOps>

export function useEditorOps() {
  const { store, playback, engineRef, durationMs, transcript, text } = useEditor()
  const words = transcript.data?.words ?? null
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

      /** Apaga as palavras selecionadas na aba Texto (vira UM corte manual, desfazível). */
      cutWordSelection(): boolean {
        const r = selectionRange(text.getState().selection)
        if (!r || !words) return false
        st().change((p) => ({ ...p, cuts: cutWords(p.cuts, words, r.from, r.to, durationMs) }))
        text.getState().select(null)
        return true
      },

      /** Restaura as palavras selecionadas: o que as cobre sai dos cortes (automático fica desligado). */
      restoreWordSelection(): boolean {
        const r = selectionRange(text.getState().selection)
        if (!r || !words) return false
        st().change((p) => ({ ...p, cuts: restoreWords(p.cuts, words, r.from, r.to, durationMs) }))
        return true
      },

      /** Clicar numa ficha de pausa: corta a pausa, ou restaura se já está cortada. */
      togglePauseAfter(k: number): boolean {
        if (!words) return false
        return st().change((p) => ({ ...p, cuts: togglePause(p.cuts, words, k, durationMs) }))
      },

      /** Corrige o texto de uma palavra (vale para a legenda, não para o áudio). Vazio ou igual ao original volta ao original. */
      fixWord(i: number, value: string): boolean {
        const original = words?.[i]?.text
        if (original === undefined) return false
        const clean = value.replace(/\s+/g, ' ').trim()
        return st().change((p) => {
          const fixes = { ...(p.wordFixes ?? {}) }
          if (clean.length === 0 || clean === original.trim()) delete fixes[String(i)]
          else fixes[String(i)] = clean
          if (JSON.stringify(fixes) === JSON.stringify(p.wordFixes ?? {})) return p
          const next = { ...p }
          if (Object.keys(fixes).length > 0) next.wordFixes = fixes
          else delete next.wordFixes
          return next
        })
      },

      /** Leva a reprodução ao começo da palavra. */
      seekWord(i: number): void {
        const w = words?.[i]
        if (w) engineRef.current?.seekSource(w.start)
      },

      /** Ctrl+F: abre a busca da aba Texto. */
      openSearch(): boolean {
        if (!words) return false
        text.getState().openSearch()
        return true
      },

      /** Delete/Backspace: apaga as palavras selecionadas, o zoom ou trecho de layout selecionado, restaura o corte selecionado ou corta o intervalo. */
      deleteSelected(): boolean {
        if (ops.cutWordSelection()) return true
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
        text.getState().clear()
      },
      engine: () => engineRef.current
    }
    return ops
  }, [store, playback, engineRef, durationMs, words, text])
}
