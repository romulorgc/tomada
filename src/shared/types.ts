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

/** Posição da câmera numa grade 3×3 (relativa à tela, no layout de bolha). */
export type Corner =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'middle-center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'

export type Background =
  /** `angle` em graus no padrão do CSS: 0 = para cima, 90 = para a direita, 135 = para o canto inferior direito. */
  | { type: 'gradient'; from: string; to: string; angle: number }
  | { type: 'solid'; color: string }
  /** Imagem (cobre o quadro). `path` é relativo à pasta do projeto, ou uma URL que o chamador resolva. */
  | { type: 'image'; path: string }

export type CameraStyle = {
  shape: 'circle' | 'rounded' | 'square'
  /** Lado da câmera (diâmetro do círculo, altura dos retângulos) como fração do LADO MENOR do quadro (0..1). */
  size: number
  corner: Corner
  borderWidth: number
  borderColor: string
  mirror: boolean
  /** Esconde a câmera (os layouts se comportam como se não houvesse câmera). */
  hidden: boolean
  /** A bolha encolhe enquanto um zoom está aberto (padrão: sim). */
  shrinkOnZoom: boolean
}

export type CursorStyle = {
  /** 'real' mantém o cursor da captura; 'synthetic' redesenha pelo cursor.jsonl. */
  mode: 'real' | 'synthetic'
  /** Multiplicador de tamanho do cursor sintético. */
  scale: number
  ripple: boolean
  /** Some depois de parado por esse tempo (ms). 0 = nunca. */
  hideAfterIdleMs: number
  /** Halo suave em volta do cursor (modo 'real': desenhado por cima do cursor que já está no vídeo). */
  halo: boolean
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

/** Intensidade do zoom automático. */
export type ZoomPresetId = 'subtle' | 'moderate' | 'intense'

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
  /**
   * Retângulo capturado em pixels FÍSICOS do Windows (origem na tela virtual). Para
   * janela, é a área que o quadro realmente mostra (a área de cliente, ver
   * `chooseCaptureRect`), não o retângulo da moldura.
   */
  boundsPx: Rect
  /** Fator de escala do monitor (1, 1.25, 1.5…). */
  scale: number
  /** Tamanho REAL do quadro capturado (o do MediaStream), em pixels. */
  frameSize?: Size
  /**
   * true quando o cursor do sistema NÃO aparece no vídeo (captura de janela: o Chromium
   * não o desenha). Então o editor precisa desenhar o cursor sintético a partir do
   * `cursor.jsonl`. false: o cursor real está no vídeo (captura de tela).
   */
  cursorHidden?: boolean
  /** Nome da fonte (título da janela ou "Tela 1"), só para exibir. */
  sourceName?: string
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
  /**
   * Em que instante do relógio da gravação (o `t` dos eventos, ms desde o `t0`) o tempo 0
   * de cada arquivo de mídia acontece: `t = tempoNoArquivo + offset`. ≥ 0; o gravador que
   * disparou primeiro tem 0. Vem da diferença entre os dois `start` do MediaRecorder.
   * `voice` e `system` seguem o arquivo de onde foram extraídos (câmera e tela).
   */
  sync: { screenOffsetMs: number; cameraOffsetMs: number }
  capture: CaptureInfo
  cuts: Cut[]
  zooms: Zoom[]
  layouts: LayoutSeg[]
  style: Style
  captions: CaptionStyle
  clips: Clip[]
  /**
   * Preset com o qual os zooms `origin: 'auto'` foram gerados. Ausente = os zooms automáticos
   * nunca foram gerados (o editor gera os do preset padrão ao abrir). `'off'` = o usuário
   * desligou o zoom automático (não regenerar).
   */
  zoomPreset?: ZoomPresetId | 'off'
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
  /** true quando o clique foi FORA da área capturada (x/y já com clamp). */
  out?: boolean
}

/** Retângulo da janela capturada num instante (`events/window.jsonl`, só quando muda). */
export type WindowRectSample = { t: number; x: number; y: number; w: number; h: number }

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
