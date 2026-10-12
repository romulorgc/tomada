/**
 * O layout do vídeo INTEIRO que o estilo da câmera, escolhido antes de gravar, e o recorte do fundo pedem. O piloto não alterna mais
 * por atividade da tela: com o mouse sempre em movimento a alternância caía na bolinha no 16:9 e na tela cortada com a bolinha por cima
 * do título no 9:16, contra a escolha do usuário.
 *
 * Desde o F2 (green screen) o recorte do fundo nasce sozinho para TODA gravação com câmera, e os dois formatos se decidem à parte:
 *  - 9:16: com o recorte pronto, V-E "Green screen" (a página em tela cheia atrás, você recortado embaixo); sem ele, V-B (tela em cima,
 *    rosto embaixo, nada sobre o conteúdo). O estilo escolhido ao gravar não pesa aqui: o 9:16 é o formato do green screen;
 *  - 16:9: "Apresentador recortado" (hoje "Você sem fundo") com o recorte pronto SE foi a escolha ao gravar; senão (e no projeto antigo,
 *    sem o campo) "Quadro ao lado".
 *
 * A bolinha só existe por escolha manual. Sem tela ou sem câmera (ou com a câmera escondida) não há o que impor: `null`.
 * Código puro: sem DOM, sem Node.
 */
import type { LayoutKind, Project } from './types'

export type StyleLayouts = { style: 'side-by-side' | 'presenter'; horizontal: LayoutKind; vertical: LayoutKind }

export function cameraStyleLayouts(project: Pick<Project, 'cameraStyle' | 'sources' | 'style'>, matteReady: boolean): StyleLayouts | null {
  const hasScreen = !!project.sources.screen
  const hasCamera = !!project.sources.camera && !project.style.camera.hidden
  if (!hasScreen || !hasCamera) return null
  const presenter = project.cameraStyle === 'presenter' && matteReady
  return { style: presenter ? 'presenter' : 'side-by-side', horizontal: presenter ? 'presenter' : 'side-by-side', vertical: matteReady ? 'greenscreen' : 'stack' }
}
