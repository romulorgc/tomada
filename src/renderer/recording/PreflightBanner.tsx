import { useEffect, useState } from 'react'
import type { PreflightResult, FaceCheck, FacePreflightProvider } from '@shared/preflight'
import { useMicCheck } from './preflight'
import { t } from '../i18n/pt-BR'

export function PreflightBanner({ stream, hasMic, hasCamera, idle, onRecord,faceProvider }: { stream: MediaStream | null; hasMic: boolean; hasCamera: boolean; idle: boolean; onRecord(): void; faceProvider?:FacePreflightProvider }) {
  const mic = useMicCheck(stream)
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  const [face,setFace] = useState<FaceCheck|null>(null)
  useEffect(() => {
    // TODO M4c: injetar o provedor do detector na tela Gravar.
    if(!idle || !hasCamera || !faceProvider) return
    let alive = true
    const sample = () => { void faceProvider.check().then((result) => {if(alive) setFace(result)}).catch(() => {if(alive) setFace({status:'unknown'})}) }
    sample(); const timer = setInterval(sample,2000)
    return () => {alive=false;clearInterval(timer)}
  },[idle,hasCamera,faceProvider])
  useEffect(() => {
    if (!idle) return
    let alive = true
    void window.tomada.record.preflight().then((p) => { if (alive) setPreflight(p) }).catch((err: unknown) => window.tomada.log({ level: 'warn', message: t.preparation.diskUnknown, detail: String(err) }))
    return () => { alive = false }
  }, [idle])
  if (!idle) return null
  const warning = mic?.status === 'low' || mic?.status === 'clipping' || preflight?.disk === 'low'
  const db = (n: number): number => Math.max(-90, 20 * Math.log10(Math.max(n, 0.00001)))
  return <section className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-thumb border border-line bg-surface px-4 py-3 text-[0.8125rem] text-muted" aria-label={t.preparation.preflight} data-testid="preflight-banner" data-face={preflight?.face}>
    <div className="grid gap-1"><span data-testid="preflight-mic" data-status={mic?.status ?? 'listening'}>{hasMic ? t.preparation.mic[mic?.status ?? 'listening'] : t.preparation.noMic}</span>{mic ? <span className="text-faint tnum" data-testid="preflight-mic-values">{t.preparation.micValues(db(mic.rms), db(mic.peak))}</span> : null}</div>
    <span>{preflight?.disk === 'low' ? `${t.preparation.diskLow} ` : ''}{preflight?.freeBytes !== null && preflight?.freeBytes !== undefined ? t.preparation.disk(preflight.freeBytes) : t.preparation.diskUnknown}</span>
    <span>{t.preparation.dnd}</span>
    {hasCamera ? <span>{face ? t.preparation.faceChecks[face.status] : t.preparation.face}</span> : null}
    {warning ? <button type="button" className="btn btn-small ml-auto" onClick={onRecord} data-testid="preflight-record-anyway">{t.preparation.anyway}</button> : null}
  </section>
}
