/**
 * Embaixo da prévia: o aviso do recorte do fundo ("Recortando você do fundo: 63%", ou o erro com "Tentar de novo") e a troca rápida de
 * layout com a miniatura de cada um, nos dois formatos. Vale para o vídeo todo; com um trecho de layout selecionado na trilha vale para o
 * trecho; na prévia de um corte vale para o corte (é a escolha "por vídeo e por corte" do usuário, sem precisar abrir a aba Layout).
 */
import { useStore } from 'zustand'
import { setLayoutOfSeg } from '@shared/edits'
import type { Clip, LayoutKind, Project, VerticalLayout } from '@shared/types'
import { cameraJobKey, isCameraJobActive, useCamera } from '../camera-store'
import { t } from '../i18n/pt-BR'
import { useDoc, useEditor } from './context'
import { kindsOf, layoutHint, layoutIcon, layoutLabel, layoutUnavailable } from './layout-kinds'

const T = t.editor.layout

const mapClip = (doc: Project, id: string, fn: (c: Clip) => Clip): Project => ({ ...doc, clips: doc.clips.map((c) => (c.id === id ? fn(c) : c)) })

/**
 * O estado do recorte do fundo, em uma linha, lido do que o serviço da câmera já publica (`useCamera.jobs` do trabalho `matte`, o motor e
 * `matte.url`): andamento, falha com "Tentar de novo", cancelado com "Recortar agora" ou o motor ainda não preparado. Só CONSOME o estado do
 * recorte; quem gera, retoma e persiste o recorte é o pipeline do processo principal.
 */
export function MatteNotice() {
  const { detail, matte, hasCamera } = useEditor()
  const job = useCamera((s) => s.jobs[cameraJobKey(detail.id, 'matte')])
  const engineState = useCamera((s) => s.view?.matte.state ?? null)
  const analyze = useCamera((s) => s.analyze)
  const M = T.matte
  if (!hasCamera || matte.url) return null
  const pct = Math.round((job?.fraction ?? 0) * 100)
  if (isCameraJobActive(job)) {
    const queued = job!.state === 'queued'
    return (
      <div className="matte-notice" role="status" data-testid="matte-notice" data-state={job!.state} data-fallback={String(matte.fallback)}>
        <span>{queued ? M.queued : matte.fallback ? M.runningFallback(pct) : M.running(pct)}</span>
        <span className="mn-meter" role="progressbar" aria-label={M.running(pct)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <i style={{ width: `${pct}%` }} />
        </span>
      </div>
    )
  }
  if (job?.state === 'error') {
    return (
      <div className="matte-notice" role="alert" data-testid="matte-notice" data-state="error">
        <span>
          {M.failed}
          {job.error ? `: ${job.error}` : ''}
        </span>
        <button type="button" className="btn" data-testid="matte-notice-retry" onClick={() => void analyze(detail.id, 'matte', true)}>
          {M.retry}
        </button>
      </div>
    )
  }
  if (job?.state === 'cancelled') {
    return (
      <div className="matte-notice" role="status" data-testid="matte-notice" data-state="cancelled">
        <span>{M.cancelled}</span>
        <button type="button" className="btn" data-testid="matte-notice-start" onClick={() => void analyze(detail.id, 'matte')}>
          {M.start}
        </button>
      </div>
    )
  }
  if (matte.fallback && engineState !== null && engineState !== 'ready') {
    return (
      <div className="matte-notice" role="status" data-testid="matte-notice" data-state="needs-engine">
        <span>{M.needsEngine}</span>
      </div>
    )
  }
  return null
}

export function LayoutQuickBar() {
  const { store, clips, hasScreen, hasCamera } = useEditor()
  const format = useDoc((s) => s.format)
  const base = useDoc((s) => s.project.style.defaultLayout)
  const layouts = useDoc((s) => s.project.layouts)
  const selection = useDoc((s) => s.selection)
  const previewId = useStore(clips, (s) => s.previewId)
  const previewClip = useDoc((s) => (previewId ? s.doc.clips.find((c) => c.id === previewId) : undefined))
  const vertical = format === 'vertical'
  const seg = !previewClip && selection?.kind === 'layout' ? layouts.find((l) => l.id === selection.id) : undefined
  const value: LayoutKind | null = previewClip ? (previewClip.layoutV === 'auto' ? null : previewClip.layoutV) : seg ? seg.layout : base
  // com a prévia de um corte o formato é sempre o vertical
  const kinds = kindsOf(vertical || Boolean(previewClip))

  const pick = (l: LayoutKind): void => {
    if (previewClip) {
      store.getState().changeDoc((doc) => mapClip(doc, previewClip.id, (c) => ({ ...c, layoutV: l as VerticalLayout })))
      return
    }
    if (seg) {
      store.getState().change((p) => setLayoutOfSeg(p, seg.id, l))
      return
    }
    store.getState().change((p) => ({ ...p, style: { ...p.style, defaultLayout: l } }))
  }

  return (
    <div className="preview-dock" data-testid="preview-dock">
      <MatteNotice />
      <div className="layout-quick" role="group" aria-label={previewClip ? T.quick.titleClip : seg ? T.quick.titleSegment : T.quick.title} data-testid="layout-quick" data-scope={previewClip ? 'clip' : seg ? 'segment' : 'video'}>
        {kinds.map((l) => {
          const reason = layoutUnavailable(l, hasScreen, hasCamera)
          return (
            <button
              key={l}
              type="button"
              className="lq-btn"
              aria-pressed={value === l}
              disabled={reason !== null}
              title={reason ?? layoutHint(l) ?? layoutLabel(l)}
              data-testid={`layout-quick-${l}`}
              onClick={() => pick(l)}
            >
              {layoutIcon(l, vertical || Boolean(previewClip), 22)}
              <span>{layoutLabel(l)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
