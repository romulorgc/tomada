import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Bar } from './overlay/Bar'
import { Bubble } from './overlay/Bubble'
import { Countdown } from './overlay/Countdown'
import './styles.css'

// Nenhuma falha silenciosa: o que escapar da interface vai para o arquivo de log.
window.addEventListener('error', (e) => {
  window.tomada.log({ level: 'error', message: `Erro não tratado: ${e.message}`, detail: `${e.filename}:${e.lineno}:${e.colno}` })
})
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason)
  window.tomada.log({ level: 'error', message: 'Promessa rejeitada sem tratamento', detail: reason })
})

// A mesma interface serve às janelas auxiliares da gravação (barra, contagem, bolha): o main as abre com #nome.
const AUX = { bar: Bar, countdown: Countdown, bubble: Bubble } as const
const hash = window.location.hash.replace(/^#/, '')
const Aux = hash in AUX ? AUX[hash as keyof typeof AUX] : null
if (Aux) document.documentElement.dataset.aux = hash

if (hash.startsWith('export:') || hash === 'export-lab') {
  // Janela ESCONDIDA da exportação: sem React, só o motor de render (processo à parte da interface).
  document.documentElement.dataset.aux = 'export'
  void import('./export/exporter').then((m) => {
    if (hash === 'export-lab') m.runExportLab()
    else void m.runExporterWindow(hash.slice('export:'.length))
  })
} else {
  const root = document.getElementById('root')
  if (!root) throw new Error('Elemento #root não encontrado em index.html')
  createRoot(root).render(<StrictMode>{Aux ? <Aux /> : <App />}</StrictMode>)
}
