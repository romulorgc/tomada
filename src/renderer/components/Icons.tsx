/**
 * Ícones em SVG inline (traço de 1,6 px, currentColor). Sem biblioteca de ícones:
 * cada um é decorativo (aria-hidden); o botão que o contém leva o rótulo.
 */
import type { SVGProps } from 'react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number }

function Svg({ size = 18, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  )
}

export const LibraryIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4" width="17" height="12" rx="2.5" />
    <path d="M7 20h10" />
    <path d="m10.5 8.2 3.6 1.8-3.6 1.8z" fill="currentColor" stroke="none" />
  </Svg>
)

export const RecordIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none" />
  </Svg>
)

export const SettingsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Svg>
)

export const PencilIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 19.5 5.3 15 15.8 4.5a1.8 1.8 0 0 1 2.5 0l1.2 1.2a1.8 1.8 0 0 1 0 2.5L9 18.7z" />
    <path d="m14 6.5 3.5 3.5" />
  </Svg>
)

export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </Svg>
)

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 7h15M9.5 7V5.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7M10 11v5.5M14 11v5.5" />
  </Svg>
)

export const PlayIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
  </Svg>
)

export const PauseIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
  </Svg>
)

export const ScreenIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="12" rx="2" />
    <path d="M9 20h6M12 16.5V20" />
  </Svg>
)

export const CameraIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6.5" width="12.5" height="11" rx="2.2" />
    <path d="m15.5 11 5-3v8l-5-3z" />
  </Svg>
)

export const BackIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 6 8.5 12l6 6" />
  </Svg>
)

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
)

export const CrossIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
  </Svg>
)

/** Marca do app: cantos de visor com um ponto de gravação no centro. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M3.5 8.5v-3a2 2 0 0 1 2-2h3M15.5 3.5h3a2 2 0 0 1 2 2v3M20.5 15.5v3a2 2 0 0 1-2 2h-3M8.5 20.5h-3a2 2 0 0 1-2-2v-3"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="3.1" fill="var(--color-rec)" />
    </svg>
  )
}

export const StopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />
  </Svg>
)

export const RestartIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12a7 7 0 1 0 2.3-5.2" />
    <path d="M4.5 4.5v4h4" />
  </Svg>
)

export const MicIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3.5" width="6" height="10" rx="3" />
    <path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21" />
  </Svg>
)

// --- Editor ------------------------------------------------------------------

export const UndoIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4.5 4.5 9 9 13.5" />
    <path d="M5 9h8.5a5 5 0 0 1 0 10H10" />
  </Svg>
)

export const RedoIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m15 4.5 4.5 4.5-4.5 4.5" />
    <path d="M19 9h-8.5a5 5 0 0 0 0 10H14" />
  </Svg>
)

export const ScissorsIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6.5" cy="7" r="2.5" />
    <circle cx="6.5" cy="17" r="2.5" />
    <path d="m8.4 8.6 11.1 8.4M8.4 15.4 19.5 7" />
  </Svg>
)

export const SplitIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5v17" />
    <path d="m8 8-3.5 4L8 16M16 8l3.5 4-3.5 4" />
  </Svg>
)

export const ZoomInIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="m15 15 5 5M10.5 8v5M8 10.5h5" />
  </Svg>
)

export const MinusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 12h12" />
  </Svg>
)

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 6v12M6 12h12" />
  </Svg>
)

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
  </Svg>
)

export const SkipStartIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 5.5v13" />
    <path d="M18 6v12l-8.5-6z" fill="currentColor" />
  </Svg>
)

export const SkipEndIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M17.5 5.5v13" />
    <path d="M6 6v12l8.5-6z" fill="currentColor" />
  </Svg>
)

export const FrameBackIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15.5 6 9 12l6.5 6" />
    <path d="M6 6.5v11" />
  </Svg>
)

export const FrameForwardIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.5 6 15 12l-6.5 6" />
    <path d="M18 6.5v11" />
  </Svg>
)

export const CollapseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 5v14M19.5 5v14" />
    <path d="M9 12h6M11.4 9.4 8.8 12l2.6 2.6M12.6 9.4l2.6 2.6-2.6 2.6" />
  </Svg>
)

export const FitIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12h6M14 12h6M7.5 8.5 4 12l3.5 3.5M16.5 8.5 20 12l-3.5 3.5" />
  </Svg>
)

export const ExportIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 15V4M7.5 8.2 12 3.7l4.5 4.5" />
    <path d="M5 13.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4.5" />
  </Svg>
)

export const PaletteIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-.9 2-1.8 0-1.4-1.2-1.7-1.2-2.9 0-.9.8-1.5 1.7-1.5H17a3.5 3.5 0 0 0 3.5-3.5c0-4-3.8-7.3-8.5-7.3z" />
    <circle cx="7.8" cy="11.2" r="1" fill="currentColor" stroke="none" />
    <circle cx="10.2" cy="7.4" r="1" fill="currentColor" stroke="none" />
    <circle cx="14.6" cy="7.4" r="1" fill="currentColor" stroke="none" />
  </Svg>
)

export const LayoutGridIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
    <path d="M3.5 10h17M10 10v9.5" />
  </Svg>
)

export const TextIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 7V5.5h14V7M12 5.5v13M9.5 18.5h5" />
  </Svg>
)

export const SparkleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5c.5 4.3 2.2 6 6.5 6.5-4.3.5-6 2.2-6.5 6.5-.5-4.3-2.2-6-6.5-6.5 4.3-.5 6-2.2 6.5-6.5z" />
    <path d="M18.5 15.5c.2 1.8.9 2.5 2.5 2.7-1.6.2-2.3.9-2.5 2.6-.2-1.7-.9-2.4-2.5-2.6 1.6-.2 2.3-.9 2.5-2.7z" />
  </Svg>
)

export const KeyboardIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6.5" width="18" height="11" rx="2" />
    <path d="M7 10.5h.01M10.5 10.5h.01M14 10.5h.01M17.5 10.5h.01M7.5 14h9" />
  </Svg>
)

export const ImageIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4 17 5-4.5 3.5 3L15.5 13 20 17" />
  </Svg>
)

export const TargetIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="6.5" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
  </Svg>
)

export const PlayFolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="2.4" />
    <path d="m10.5 9.2 4.2 2.8-4.2 2.8z" fill="currentColor" stroke="none" />
  </Svg>
)

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  </Svg>
)

export const AlertIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4.5 3.5 19h17z" />
    <path d="M12 10v4.2M12 16.8h.01" />
  </Svg>
)

/** Diagramas dos layouts (o retângulo do quadro e o que vai dentro dele). */
export const LayoutBubbleIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.2" />
    <circle cx="16.5" cy="14.5" r="2.6" fill="currentColor" stroke="none" />
  </Svg>
)

export const LayoutSideIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.2" />
    <path d="M15 5v14" />
    <rect x="16.4" y="8" width="3" height="8" rx="1" fill="currentColor" stroke="none" />
  </Svg>
)

export const LayoutScreenIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.2" />
    <rect x="6" y="8" width="12" height="8" rx="1" fill="currentColor" fillOpacity="0.35" stroke="none" />
  </Svg>
)

export const LayoutCameraIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.2" />
    <circle cx="12" cy="11" r="2.2" fill="currentColor" stroke="none" />
    <path d="M7.5 17c.6-2.2 2.3-3.4 4.5-3.4s3.9 1.2 4.5 3.4" />
  </Svg>
)

export const ShapeCircleIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="7.5" />
  </Svg>
)

export const ShapeRoundedIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="6.5" width="15" height="11" rx="3.5" />
  </Svg>
)

export const ShapeSquareIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="6.5" width="15" height="11" rx="0.6" />
  </Svg>
)

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="5.5" />
    <path d="m15 15 4.5 4.5" />
  </Svg>
)

export const ChevronUpIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6.5 14.5 5.5-5.5 5.5 5.5" />
  </Svg>
)

// --- M4a: vertical e legendas -------------------------------------------------------------------

/** V-A "Cursor": quadro em pé, recorte da tela em tela cheia e a bolha da câmera no canto. */
export const LayoutFocusIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="2.8" width="10" height="18.4" rx="2" />
    <circle cx="10.2" cy="7.2" r="1.5" fill="currentColor" stroke="none" />
    <path d="M10 14.5l3.6 1.4-1.5.6 1.1 2.1-1 .5-1.1-2.1-1.1 1z" fill="currentColor" stroke="none" />
  </Svg>
)

/** V-B "Câmera + tela": quadro em pé dividido, rosto em cima e tela embaixo. */
export const LayoutStackIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="2.8" width="10" height="18.4" rx="2" />
    <path d="M7 12.2h10" />
    <circle cx="12" cy="7.3" r="1.5" fill="currentColor" stroke="none" />
    <rect x="9" y="14.2" width="6" height="4" rx="0.8" fill="currentColor" fillOpacity="0.35" stroke="none" />
  </Svg>
)

/** V-C "Tela na largura": quadro em pé com a tela inteira ao centro. */
export const LayoutWideIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="2.8" width="10" height="18.4" rx="2" />
    <rect x="7" y="8.4" width="10" height="6" fill="currentColor" fillOpacity="0.35" stroke="none" />
    <path d="M7 8.4h10M7 14.4h10" />
  </Svg>
)

/** Apresentador recortado (16:9): a tela e a pessoa (cabeça e ombros, sem fundo) no canto de baixo. */
export const LayoutPresenterIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.2" />
    <circle cx="16.4" cy="10.6" r="1.9" fill="currentColor" stroke="none" />
    <path d="M12.4 19c0-2.7 1.6-4.3 4-4.3s4 1.6 4 4.3z" fill="currentColor" stroke="none" />
  </Svg>
)

/** V-D Apresentador (9:16): o recorte da tela em cima e a pessoa embaixo, na frente. */
export const LayoutPresenterVerticalIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="2.8" width="10" height="18.4" rx="2" />
    <rect x="7.6" y="3.4" width="8.8" height="7.2" rx="0.8" fill="currentColor" fillOpacity="0.35" stroke="none" />
    <circle cx="12" cy="13.6" r="1.7" fill="currentColor" stroke="none" />
    <path d="M8.2 21.2c0-2.8 1.7-4.4 3.8-4.4s3.8 1.6 3.8 4.4z" fill="currentColor" stroke="none" />
  </Svg>
)

export const CaptionsIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5.5" width="18" height="13" rx="2.4" />
    <path d="M7 10.5h4M7 14h2M13 14h4M13 10.5h4" />
  </Svg>
)

export const GuideIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6.5" y="3" width="11" height="18" rx="2" />
    <rect x="8.6" y="6" width="6.8" height="10.5" rx="0.6" strokeDasharray="1.8 1.8" />
  </Svg>
)

/** Cortes verticais: um quadro em pé com o play no meio. */
export const ClipsIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6.5" y="3" width="11" height="18" rx="2.5" />
    <path d="m10.6 9.4 4 2.6-4 2.6z" fill="currentColor" stroke="none" />
  </Svg>
)

/** Publicar: o envio (seta saindo de uma bandeja). */
export const PublishIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 15V4" />
    <path d="m7.5 8.2 4.5-4.5 4.5 4.5" />
    <path d="M4.5 14.5v3a2.5 2.5 0 0 0 2.5 2.5h10a2.5 2.5 0 0 0 2.5-2.5v-3" />
  </Svg>
)
