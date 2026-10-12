/**
 * Os layouts que o usuário escolhe no editor (aba Layout e barra rápida da prévia): a lista de cada formato, a miniatura (ícone) de cada um e
 * o motivo de um layout não estar disponível. Num lugar só para a aba e a barra nunca divergirem.
 */
import type { ReactNode } from 'react'
import type { LayoutKind } from '@shared/types'
import {
  LayoutBubbleIcon,
  LayoutCameraIcon,
  LayoutFocusIcon,
  LayoutGreenscreenCornerIcon,
  LayoutGreenscreenIcon,
  LayoutPresenterIcon,
  LayoutPresenterVerticalIcon,
  LayoutScreenIcon,
  LayoutSideIcon,
  LayoutStackIcon,
  LayoutWideIcon
} from '../components/Icons'
import { t } from '../i18n/pt-BR'

const T = t.editor.layout

/** No 16:9. */
export const KINDS: LayoutKind[] = ['bubble', 'side-by-side', 'presenter', 'screen', 'camera']
/** No vertical: V-E Green screen (e no canto), V-A Cursor, V-B Câmera + tela, V-D Você sem fundo (tela em cima), V-C Tela na largura e só a câmera. */
export const VERTICAL_KINDS: LayoutKind[] = ['greenscreen', 'greenscreen-corner', 'screen-center', 'screen-focus', 'stack', 'presenter', 'screen-wide', 'camera']

export const kindsOf = (vertical: boolean): LayoutKind[] => (vertical ? VERTICAL_KINDS : KINDS)

const ICONS: Record<string, (size: number) => ReactNode> = {
  bubble: (s) => <LayoutBubbleIcon size={s} />,
  'side-by-side': (s) => <LayoutSideIcon size={s} />,
  screen: (s) => <LayoutScreenIcon size={s} />,
  camera: (s) => <LayoutCameraIcon size={s} />,
  'screen-focus': (s) => <LayoutFocusIcon size={s} />,
  'screen-center': (s) => <LayoutScreenIcon size={s} />,
  stack: (s) => <LayoutStackIcon size={s} />,
  'screen-wide': (s) => <LayoutWideIcon size={s} />,
  presenter: (s) => <LayoutPresenterIcon size={s} />,
  greenscreen: (s) => <LayoutGreenscreenIcon size={s} />,
  'greenscreen-corner': (s) => <LayoutGreenscreenCornerIcon size={s} />
}

/** A miniatura do layout (o desenho do quadro com a página e você). */
export const layoutIcon = (l: LayoutKind, vertical: boolean, size = 26): ReactNode => (l === 'presenter' && vertical ? <LayoutPresenterVerticalIcon size={size} /> : ICONS[l]?.(size))

export const layoutLabel = (l: LayoutKind): string => T.options[l as keyof typeof T.options] ?? l

export const layoutHint = (l: LayoutKind): string | undefined => (T.optionHints as Record<string, string>)[l]

/** Por que um layout não está disponível neste projeto (ou `null` se está). */
export function layoutUnavailable(l: LayoutKind, hasScreen: boolean, hasCamera: boolean): string | null {
  if (l === 'camera') return hasCamera ? null : T.needsCamera
  if (l === 'screen' || l === 'screen-focus' || l === 'screen-center' || l === 'screen-wide') return hasScreen ? null : T.needsScreen
  return hasCamera && hasScreen ? null : hasCamera ? T.needsScreen : T.needsCamera
}
