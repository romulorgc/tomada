/**
 * Tipos do documento de edição e dos eventos de gravação.
 *
 * Código puro: sem DOM, sem Node.
 *
 * ⏱ UNIDADE DE TEMPO: **todo tempo é em milissegundos** (início/fim de cortes,
 * zooms, legendas, palavras, `durationMs`, `t` dos eventos). Só a interface,
 * ao falar com `<video>`, converte de/para segundos (`currentTime`).
 * Toda edição vive em TEMPO DE ORIGEM (o da gravação); o tempo de saída é derivado.
 */

export type Rect = { x: number; y: number; w: number; h: number }
export type Size = { w: number; h: number }
export type Point = { x: number; y: number }

/** Intervalo [start, end) em ms. */
export type Range = { start: number; end: number }

/** Uma fonte de mídia do projeto. `path` é RELATIVO à pasta do projeto. */
export type Src = {
  path: string
  w: number
  h: number
  fps: number
  durationMs: number
}

export type CutReason = 'silence' | 'filler' | 'retake' | 'manual' | 'ai'

export type Cut = {
  id: string
  start: number
  end: number
  reason: CutReason
  enabled: boolean
}

export type ZoomFocus = 'auto' | { x: number; y: number }

export type Zoom = {
  id: string
  start: number
  end: number
  scale: number
  /** 'auto' = segue o cursor; {x,y} = ponto fixo normalizado 0..1. */
  focus: ZoomFocus
  origin: 'auto' | 'manual'
}

export type LayoutKind =
  | 'bubble' // tela + câmera em bolha/canto (horizontal)
  | 'side-by-side' // tela e câmera lado a lado (horizontal)
  | 'screen' // só tela
  | 'camera' // só câmera
  | 'stack' // vertical: câmera em cima, recorte da tela embaixo
  | 'screen-focus' // vertical: recorte da tela ocupa tudo, câmera em bolha

export type LayoutSeg = {
  id: string
  start: number
  end: number
  layout: LayoutKind
}

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export type Background =
  | { type: 'gradient'; from: string; to: string; angle: number }
  | { type: 'solid'; color: string }

export type CameraStyle = {
  shape: 'circle' | 'rounded' | 'square'
  /** Lado da câmera como fração da altura do quadro (0..1). */
  size: number
  corner: Corner
  borderWidth: number
  borderColor: string
  mirror: boolean
}

export type CursorStyle = {
  /** 'real' mantém o cursor da captura; 'synthetic' redesenha pelo cursor.jsonl. */
  mode: 'real' | 'synthetic'
  /** Multiplicador de tamanho do cursor sintético. */
  scale: number
  ripple: boolean
  /** Some depois de parado por esse tempo (ms). 0 = nunca. */
  hideAfterIdleMs: number
}

export type Style = {
  background: Background
  /** Margem em torno da tela, fração do lado menor do quadro (0..0.3). */
  padding: number
  /** Raio dos cantos em px, na altura de 1080. */
  radius: number
  shadow: { blur: number; opacity: number; offsetY: number }
  defaultLayout: LayoutKind
  camera: CameraStyle
  cursor: CursorStyle
}

export type CaptionStyle = {
  enabled: boolean
  style: 'plain' | 'karaoke'
  wordsPerLine: number
  position: 'bottom' | 'center' | 'top'
  box: boolean
  highlightColor: string
}

export type ClipFormat = 'vertical' | 'horizontal'
export type VerticalLayout = 'stack' | 'screen-focus' | 'camera'

export type Clip = {
  id: string
  title: string
  hook: string
  /** Pode juntar trechos não contíguos (tempo de origem). */
  ranges: Range[]
  score: number
  reason: string
  format: ClipFormat
  layoutV: VerticalLayout
}

export type CaptureInfo = {
  kind: 'screen' | 'window'
  /** Retângulo capturado em pixels FÍSICOS do Windows. */
  boundsPx: Rect
  /** Fator de escala do monitor (1, 1.25, 1.5…). */
  scale: number
}

export type ProjectMeta = {
  youtube?: { titles?: string[]; description?: string; tags?: string[] }
  perClip?: Record<string, { caption?: string; hashtags?: string[] }>
}

export type Project = {
  /**
   * Versão do formato. Este código escreve 2; aceita ≥ 2 (documentos de versões
   * futuras são lidos preservando os campos que não conhece).
   */
  version: number
  id: string
  title: string
  createdAt: string
  sources: { screen?: Src; camera?: Src; voice?: Src; system?: Src }
  sync: { screenOffsetMs: number; cameraOffsetMs: number }
  capture: CaptureInfo
  cuts: Cut[]
  zooms: Zoom[]
  layouts: LayoutSeg[]
  style: Style
  captions: CaptionStyle
  clips: Clip[]
  meta?: ProjectMeta
}

/** Palavra transcrita (tempos em ms, tempo de origem). */
export type Word = {
  text: string
  start: number
  end: number
  /** Confiança 0..1, quando o transcritor informa. */
  confidence?: number
}

export type Transcript = {
  language: string
  words: Word[]
}

/** Amostra de cursor: x/y normalizados 0..1 na área capturada. */
export type CursorSample = {
  t: number
  x: number
  y: number
  /** true quando o cursor estava fora da área capturada (x/y já com clamp). */
  out?: boolean
}

export type MouseButton = 'left' | 'right' | 'middle'

export type ClickEvent = {
  t: number
  x: number
  y: number
  button: MouseButton
  /** Instante em que o botão subiu (ms). */
  upT?: number
}

/** "Houve digitação". NUNCA a tecla (privacidade). */
export type KeyEvent = { t: number }

/** Resumo para a biblioteca (não carrega o documento inteiro na tela). */
export type ProjectSummary = {
  /** Nome da pasta do projeto dentro da raiz. Identifica o projeto. */
  id: string
  title: string
  createdAt: string
  durationMs: number
  /** Caminho relativo da miniatura, se existir no disco. */
  thumbPath: string | null
  /** Marca de mudança da miniatura (mtime em ms), para furar o cache. */
  thumbVersion: number
  hasScreen: boolean
  hasCamera: boolean
}
