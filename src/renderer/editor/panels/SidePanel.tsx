/**
 * Painel lateral com abas: Estilo, Câmera, Zoom, Layout e, marcadas "em breve", Texto e IA. Selecionar um zoom
 * ou um trecho de layout na linha do tempo leva para a aba dele.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LayoutGridIcon, PaletteIcon, CameraIcon, SparkleIcon, TextIcon, ZoomInIcon } from '../../components/Icons'
import { t } from '../../i18n/pt-BR'
import { useDoc } from '../context'
import { CameraPanel } from './CameraPanel'
import { LayoutPanel } from './LayoutPanel'
import { StylePanel } from './StylePanel'
import { ZoomPanel } from './ZoomPanel'

export type TabId = 'style' | 'camera' | 'zoom' | 'layout' | 'text' | 'ai'

const TABS: { id: TabId; label: string; icon: ReactNode; soon?: boolean }[] = [
  { id: 'style', label: t.editor.tabs.style, icon: <PaletteIcon size={18} /> },
  { id: 'camera', label: t.editor.tabs.camera, icon: <CameraIcon size={18} /> },
  { id: 'zoom', label: t.editor.tabs.zoom, icon: <ZoomInIcon size={18} /> },
  { id: 'layout', label: t.editor.tabs.layout, icon: <LayoutGridIcon size={18} /> },
  { id: 'text', label: t.editor.tabs.text, icon: <TextIcon size={18} />, soon: true },
  { id: 'ai', label: t.editor.tabs.ai, icon: <SparkleIcon size={18} />, soon: true }
]

function SoonPanel({ id }: { id: 'text' | 'ai' }) {
  const copy = t.editor.soon[id]
  return (
    <div className="panel" data-testid={`${id}-panel`}>
      <div className="empty-state soon">
        {id === 'text' ? <TextIcon size={30} /> : <SparkleIcon size={30} />}
        <span className="soon-badge">{t.editor.soon.badge}</span>
        <h3>{copy.title}</h3>
        <p>{copy.body}</p>
      </div>
    </div>
  )
}

export function SidePanel() {
  const [tab, setTab] = useState<TabId>('style')
  const selection = useDoc((s) => s.selection)
  const last = useRef<string | null>(null)

  // selecionar um item na linha do tempo abre a aba dele (uma vez por item)
  useEffect(() => {
    const key = selection ? `${selection.kind}:${selection.id}` : null
    if (key && key !== last.current) {
      if (selection?.kind === 'zoom') setTab('zoom')
      else if (selection?.kind === 'layout') setTab('layout')
    }
    last.current = key
  }, [selection])

  return (
    <aside className="ed-panel" aria-label={t.editor.tabs.label} data-testid="side-panel">
      <div className="ed-tabs" role="tablist" aria-label={t.editor.tabs.label}>
        {TABS.map((tb) => (
          <button
            key={tb.id}
            type="button"
            role="tab"
            id={`tab-${tb.id}`}
            aria-selected={tab === tb.id}
            aria-controls={`tabpanel-${tb.id}`}
            data-testid={`tab-${tb.id}`}
            data-soon={tb.soon ? 'true' : undefined}
            title={tb.soon ? `${tb.label} · ${t.editor.tabs.soon}` : tb.label}
            onClick={() => setTab(tb.id)}
          >
            {tb.icon}
            <span>{tb.label}</span>
          </button>
        ))}
      </div>
      <div className="ed-panel-body" role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'style' ? <StylePanel /> : null}
        {tab === 'camera' ? <CameraPanel /> : null}
        {tab === 'zoom' ? <ZoomPanel /> : null}
        {tab === 'layout' ? <LayoutPanel /> : null}
        {tab === 'text' ? <SoonPanel id="text" /> : null}
        {tab === 'ai' ? <SoonPanel id="ai" /> : null}
      </div>
    </aside>
  )
}
