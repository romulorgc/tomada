/**
 * Enquanto o recorte do fundo não existe, a PRÉVIA do editor não pode desenhar a câmera inteira por cima da página (era o que o layout
 * "Você sem fundo" fazia sem máscara): ela mostra o layout que não precisa do recorte, com um aviso de "recorte em andamento". Só a
 * prévia: o documento do usuário guarda a escolha dele (o V-E), e a exportação espera o recorte (ou diz por quê).
 *
 * Código puro: sem DOM, sem Node.
 */
import { isCutoutLayout, type FormatSpec } from './scene'
import type { LayoutKind, Project } from './types'

/** O layout que fica no lugar de um layout com recorte enquanto o recorte não existe: Câmera + tela no 9:16, lado a lado no 16:9. */
export function matteFallbackLayout(layout: LayoutKind, kind: FormatSpec['kind']): LayoutKind {
  if (!isCutoutLayout(layout)) return layout
  return kind === 'vertical' ? 'stack' : 'side-by-side'
}

/**
 * O projeto (a visão do formato) sem nenhum layout que precise do recorte do fundo. Devolve o MESMO objeto quando não há o que trocar.
 */
export function withMatteFallback(project: Project, kind: FormatSpec['kind']): Project {
  const base = matteFallbackLayout(project.style.defaultLayout, kind)
  const swap = project.layouts.some((s) => matteFallbackLayout(s.layout, kind) !== s.layout)
  if (base === project.style.defaultLayout && !swap) return project
  return {
    ...project,
    style: base === project.style.defaultLayout ? project.style : { ...project.style, defaultLayout: base },
    layouts: swap ? project.layouts.map((s) => ({ ...s, layout: matteFallbackLayout(s.layout, kind) })) : project.layouts
  }
}
