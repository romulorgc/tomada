/**
 * O layout do vídeo INTEIRO que o estilo da câmera, escolhido antes de gravar, pede. O piloto não alterna mais por atividade da
 * tela: com o mouse sempre em movimento a alternância caía na bolinha no 16:9 e na tela cortada com a bolinha por cima do título
 * no 9:16, contra a escolha do usuário.
 *
 *  - "Quadro ao lado" (também o projeto antigo, sem o campo): 16:9 lado a lado (tela + quadro do rosto) e 9:16 V-B (tela em cima,
 *    rosto embaixo, nada sobre o conteúdo);
 *  - "Apresentador recortado" com o recorte do fundo pronto: 16:9 Apresentador e 9:16 V-D; sem o recorte, cai no quadro ao lado.
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
  if (project.cameraStyle === 'presenter' && matteReady) return { style: 'presenter', horizontal: 'presenter', vertical: 'presenter' }
  return { style: 'side-by-side', horizontal: 'side-by-side', vertical: 'stack' }
}
