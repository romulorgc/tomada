import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { ErrorPanel, Toasts } from './components/Feedback'
import { Sidebar } from './components/Sidebar'
import { t } from './i18n/pt-BR'
import { useRecorder } from './recording/controller'
import { useApp } from './store'
import { Library } from './views/Library'
import { Processing } from './views/Processing'
import { ProjectView } from './views/ProjectView'
import { Record } from './views/Record'
import { Settings } from './views/Settings'

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
      return <ProjectView key={view.id} id={view.id} />
    case 'record':
      return <Record />
    case 'processing':
      return <Processing />
    case 'settings':
      return <Settings />
  }
}

export function App() {
  const viewName = useApp((s) => s.view.name)
  // Comandos da barra/atalhos, avisos e progresso do processamento chegam do processo principal.
  useEffect(() => useRecorder.getState().attach(), [])
  return (
    <div className="flex h-full">
      {/* O editor ocupa a janela inteira: a navegação do app só volta ao fechar o projeto. */}
      {viewName === 'project' ? null : <Sidebar />}
      <main className={['min-w-0 flex-1', viewName === 'project' ? 'overflow-hidden' : 'overflow-y-auto'].join(' ')} aria-label={t.app.name} data-view={viewName}>
        <Boundary>
          <CurrentView />
        </Boundary>
      </main>
      <Toasts />
    </div>
  )
}
