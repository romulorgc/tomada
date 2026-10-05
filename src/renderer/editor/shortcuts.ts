/**
 * Atalhos do teclado do editor (um `keydown` na janela, ativo só enquanto o editor está aberto).
 * Não age quando a pessoa está digitando num campo (título, nome do arquivo), exceto Esc.
 *
 *   Espaço tocar/pausar · J/K/L voltar/parar/avançar · ←/→ um quadro · Shift+←/→ 1 s · Home/End
 *   Delete/Backspace corta o intervalo (ou apaga o selecionado) · S divide o layout · Z cria zoom
 *   Ctrl+Z desfazer · Ctrl+Shift+Z / Ctrl+Y refazer · Esc limpa a seleção
 */
import { useEffect } from 'react'
import type { EditorOps } from './ops'

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'INPUT') {
    // controle deslizante, cor, caixa de marcar e botão de rádio não são "digitar"
    const type = (el as HTMLInputElement).type
    return !['range', 'color', 'checkbox', 'radio', 'button'].includes(type)
  }
  return TYPING.has(el.tagName)
}

export function useEditorShortcuts(ops: EditorOps, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      const engine = ops.engine()
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      const typing = isTyping(e.target)

      if (e.key === 'Escape') {
        if (typing) return
        ops.clearSelection()
        return
      }
      if (typing) return

      // desfazer / refazer valem em qualquer lugar do editor
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) ops.redo()
        else ops.undo()
        return
      }
      if (mod && key === 'y') {
        e.preventDefault()
        ops.redo()
        return
      }
      if (mod || e.altKey) return // não rouba Ctrl+S, Alt+F4 etc.
      if (!engine) return

      switch (e.code) {
        case 'Space':
          e.preventDefault()
          if (e.repeat) return
          // um botão que ficou com o foco ativaria com a barra de espaço: o foco sai dele
          if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') (e.target as HTMLElement).blur()
          engine.toggle()
          return
        case 'KeyJ':
        case 'KeyK':
        case 'KeyL':
          e.preventDefault()
          if (e.repeat) return
          engine.shuttle(e.code === 'KeyJ' ? 'J' : e.code === 'KeyK' ? 'K' : 'L')
          return
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault()
          const dir = e.code === 'ArrowLeft' ? -1 : 1
          if (e.shiftKey) engine.stepSeconds(dir)
          else engine.stepFrames(dir)
          return
        }
        case 'Home':
          e.preventDefault()
          engine.jumpTo('start')
          return
        case 'End':
          e.preventDefault()
          engine.jumpTo('end')
          return
        case 'Delete':
        case 'Backspace':
          if (ops.deleteSelected()) e.preventDefault()
          return
        case 'KeyS':
          if (ops.splitAtPlayhead()) e.preventDefault()
          return
        case 'KeyZ':
          if (ops.zoomFromRange()) e.preventDefault()
          return
        default:
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ops, enabled])
}
