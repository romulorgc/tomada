import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { ErrorPanel, Toasts } from './components/Feedback'
import { Sidebar } from './components/Sidebar'
import { t } from './i18n/pt-BR'
import { useRecorder } from './recording/controller'
import { useApp } from './store'
import { useTranscription } from './transcription-store'
import { Library } from './views/Library'
import { Processing } from './views/Processing'
import { ProjectView } from './views/ProjectView'
import { Record } from './views/Record'
import { Settings } from './views/Settings'
import { Review } from './views/Review'
import { SettingsOnboarding } from './views/SettingsOnboarding'
import { RecoveryPrompt } from './components/RecoveryPrompt'
import { m5Settings } from './i18n/m5-settings'

/** Se uma tela quebrar, aparece o motivo e um botão - não uma janela em branco. */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    window.tomada.log({ level: 'error', message: `Erro na interface: ${error.message}`, detail: `${error.stack ?? ''}\n${info.componentStack ?? ''}` })
  }

  override render() {
    if (this.state.error) {
      return <ErrorPanel title={t.common.crashed} detail={this.state.error.message} onRetry={() => this.setState({ error: null })} />
    }
    return this.props.children
  }
}

function CurrentView() {
  const view = useApp((s) => s.view)
  switch (view.name) {
    case 'library':
      return <Library />
    case 'project':
      return <ProjectView key={`${view.id}-${view.itemId ?? "base"}`} id={view.id} itemId={view.itemId} />
    case 'review':
      return <Review key={view.id} id={view.id} />
    case 'record':
      return <Record />
    case 'processing':
      return <Processing />
    case 'settings':
      return <Settings />
    case 'setup':
      return <SettingsOnboarding />
  }
}

export function App() {
  const viewName = useApp((s) => s.view.name)
  // Comandos da barra/atalhos, avisos e progresso do processamento chegam do processo principal.
  useEffect(() => useRecorder.getState().attach(), [])
  // O estado da transcrição (preparação e fila) também chega por evento e vale em qualquer tela.
  useEffect(() => useTranscription.getState().attach(), [])
  useEffect(() => {
    let alive = true
    void window.tomada.diagnostics.get().then((snapshot) => { if (alive && snapshot.shouldGuide && useApp.getState().view.name === 'library') useApp.getState().go({ name: 'setup' }) }).catch((err: unknown) => { if (alive) useApp.getState().notify({ kind: 'error', text: m5Settings.setup.failed, detail: err instanceof Error ? err.message : String(err) }) })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    const off = window.tomada.on('autopilot:progress',(state) => { const app = useApp.getState(); if (app.view.name === 'processing' || (app.view.name === 'review' && app.view.id === state.projectId)) app.go({ name: 'review', id: state.projectId }) })
    const ready = window.tomada.on('autopilot:ready',({ projectId }) => useApp.getState().go({ name: 'review',id: projectId }))
    return () => { off(); ready() }
  },[])
  return (
    <div className="flex h-full">
      {/* O editor ocupa a janela inteira: a navegação do app só volta ao fechar o projeto. */}
      {viewName === 'project' || viewName === 'review' ? null : <Sidebar />}
      <main className={['min-w-0 flex-1', viewName === 'project' ? 'overflow-hidden' : 'overflow-y-auto'].join(' ')} aria-label={t.app.name} data-view={viewName}>
        <Boundary>
          <CurrentView />
        </Boundary>
      </main>
      <Toasts />
      <RecoveryPrompt />
    </div>
  )
}
