/**
 * Painel lateral com abas: Estilo, Câmera, Zoom, Layout, Texto (transcrição, limpeza), Legendas, Cortes (cortes verticais em
 * lote), Publicar (títulos, descrição, capítulos, hashtags) e IA (editar pedindo). Selecionar um zoom ou um trecho de layout na
 * linha do tempo leva para a aba dele; Ctrl+F leva ao Texto; um painel que depende da transcrição leva até o Texto.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { BlurIcon, CaptionsIcon, ClipsIcon, LayoutGridIcon, PaletteIcon, CameraIcon, PublishIcon, SparkleIcon, TextIcon, ZoomInIcon } from '../../components/Icons'
import { t } from '../../i18n/pt-BR'
import { useDoc, useEditor } from '../context'
import { TextPanel } from '../text/TextPanel'
import { AiPanel } from './AiPanel'
import { CameraPanel } from './CameraPanel'
import { CaptionsPanel } from './CaptionsPanel'
import { ClipsPanel } from './ClipsPanel'
import { LayoutPanel } from './LayoutPanel'
import { PublishPanel } from './PublishPanel'
import { StylePanel } from './StylePanel'
import { ZoomPanel } from './ZoomPanel'
import { BlurPanel } from './BlurPanel'

export type TabId = 'style' | 'camera' | 'zoom' | 'layout' | 'text' | 'captions' | 'clips' | 'publish' | 'ai' | 'blur'

const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: 'blur', label: t.editor.tabs.blur, icon: <BlurIcon size={18} /> },
  { id: 'style', label: t.editor.tabs.style, icon: <PaletteIcon size={18} /> },
  { id: 'camera', label: t.editor.tabs.camera, icon: <CameraIcon size={18} /> },
  { id: 'zoom', label: t.editor.tabs.zoom, icon: <ZoomInIcon size={18} /> },
  { id: 'layout', label: t.editor.tabs.layout, icon: <LayoutGridIcon size={18} /> },
  { id: 'text', label: t.editor.tabs.text, icon: <TextIcon size={18} /> },
  { id: 'captions', label: t.editor.tabs.captions, icon: <CaptionsIcon size={18} /> },
  { id: 'clips', label: t.editor.tabs.clips, icon: <ClipsIcon size={18} /> },
  { id: 'publish', label: t.editor.tabs.publish, icon: <PublishIcon size={18} /> },
  { id: 'ai', label: t.editor.tabs.ai, icon: <SparkleIcon size={18} /> }
]

export function SidePanel() {
  const [tab, setTab] = useState<TabId>('style')
  const selection = useDoc((s) => s.selection)
  const last = useRef<string | null>(null)
  const { text } = useEditor()
  const tabRequest = useStore(text, (s) => s.tabRequest)

  // Ctrl+F (ou outro pedido de dentro do editor) leva à aba pedida
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab)
  }, [tabRequest])

  // selecionar um item na linha do tempo abre a aba dele (uma vez por item)
  useEffect(() => {
    const key = selection ? `${selection.kind}:${selection.id}` : null
    if (key && key !== last.current) {
      if (selection?.kind === 'zoom') setTab('zoom')
      else if (selection?.kind === 'layout') setTab('layout')
      else if (selection?.kind === 'blur') setTab('blur')
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
            title={tb.label}
            onClick={() => setTab(tb.id)}
          >
            {tb.icon}
            <span>{tb.label}</span>
          </button>
        ))}
      </div>
      <div className="ed-panel-body" role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'style' ? <StylePanel /> : null}
        {tab === 'blur' ? <BlurPanel /> : null}
        {tab === 'camera' ? <CameraPanel /> : null}
        {tab === 'zoom' ? <ZoomPanel /> : null}
        {tab === 'layout' ? <LayoutPanel /> : null}
        {tab === 'text' ? <TextPanel /> : null}
        {tab === 'captions' ? <CaptionsPanel /> : null}
        {tab === 'clips' ? <ClipsPanel /> : null}
        {tab === 'publish' ? <PublishPanel /> : null}
        {tab === 'ai' ? <AiPanel /> : null}
      </div>
    </aside>
  )
}
