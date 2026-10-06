/**
 * Controle da exportação para a interface do editor: assina o progresso que o processo principal empurra,
 * dispara e cancela. A exportação roda FORA da tela do editor (janela escondida + ffmpeg): o estado aqui
 * só reflete o que o main informa, então fechar o diálogo não a interrompe.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExportOptions } from '@shared/export'
import type { ExportProgress } from '@shared/ipc'
import type { DiskEstimate } from '@shared/disk'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'

export type ExportController = {
  progress: ExportProgress | null
  /** Há uma exportação deste projeto em andamento (preparando, gerando, juntando ou conferindo). */
  busy: boolean
  cancelling: boolean
  open: boolean
  setOpen(open: boolean): void
  start(options: ExportOptions): Promise<void>
  diskSpace(options: ExportOptions): Promise<DiskEstimate>
  cancel(): Promise<void>
  /** Esquece o resultado anterior (volta ao formulário). */
  reset(): void
}

const FINAL = new Set<ExportProgress['phase']>(['done', 'error', 'cancelled'])
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function useExportController(projectId: string, flush: () => Promise<void>, itemId?: string): ExportController {
  const notify = useApp((s) => s.notify)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [open, setOpenState] = useState(false)
  const openRef = useRef(false)
  const setOpen = useCallback((value: boolean) => {
    openRef.current = value
    setOpenState(value)
  }, [])

  useEffect(() => {
    let alive = true
    const off = window.tomada.on('export:progress', (p) => {
      // a exportação de um corte (fila da aba Cortes) tem o andamento dela; este controle é do vídeo inteiro
      if (p.projectId !== projectId || !alive || p.clipId !== (itemId && itemId !== 'youtube' ? itemId : undefined)) return
      setProgress(p)
      if (FINAL.has(p.phase)) {
        setCancelling(false)
        // fechou o diálogo e a exportação terminou: o resultado não pode passar batido
        if (!openRef.current && p.phase === 'done') notify({ kind: 'info', text: t.editor.export.doneTitle, detail: p.outputPath?.split(/[\\/]/).pop() ?? '' })
        if (!openRef.current && p.phase === 'error') notify({ kind: 'error', text: t.editor.export.failedTitle, detail: p.message ?? '' })
      }
    })
    // abriu o projeto com uma exportação ainda rodando: retoma o acompanhamento
    void window.tomada.exporter.status().then((p) => {
      if (alive && p && p.projectId === projectId && p.clipId === (itemId && itemId !== 'youtube' ? itemId : undefined) && !FINAL.has(p.phase)) setProgress(p)
    })
    return () => {
      alive = false
      off()
    }
  }, [projectId, notify, itemId])

  // O cálculo de espaço e a exportação usam a mesma pasta/identidade do item.
  const requestFor = useCallback((options: ExportOptions) => ({projectId, ...options, ...(itemId && itemId !== 'youtube' ? {clipId:itemId} : {})}), [projectId,itemId])
  const diskSpace = useCallback(async (options: ExportOptions) => {
    await flush()
    return window.tomada.exporter.diskSpace(requestFor(options))
  }, [flush,requestFor])

  const start = useCallback(
    async (options: ExportOptions) => {
      setCancelling(false)
      setProgress(null)
      try {
        await flush()
        await window.tomada.exporter.start(requestFor(options))
      } catch (err) {
        setProgress({
          exportId: '',
          projectId,
          phase: 'error',
          fraction: 0,
          frame: 0,
          totalFrames: 0,
          renderFps: null,
          etaMs: null,
          audioReady: false,
          message: messageOf(err)
        })
      }
    },
    [flush, projectId, requestFor]
  )

  const cancel = useCallback(async () => {
    if (!progress || FINAL.has(progress.phase)) return
    setCancelling(true)
    try {
      await window.tomada.exporter.cancel(progress.exportId)
    } catch (err) {
      setCancelling(false)
      notify({ kind: 'error', text: 'Não consegui cancelar a exportação', detail: messageOf(err) })
    }
  }, [progress, notify])

  const reset = useCallback(() => {
    setProgress(null)
    setCancelling(false)
  }, [])

  const busy = progress !== null && !FINAL.has(progress.phase)
  return { progress, busy, cancelling, open, setOpen, start, diskSpace, cancel, reset }
}
