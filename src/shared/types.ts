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

import type { PipelineState } from './autopilot'
import type { ReviewState } from './review'
import type { VideoScript } from './script'
import type { RetakeMark } from './retake-marker'

export type Rect = { x: number; y: number; w: number; h: number }
export type Size = { w: number; h: number }
export type Point = { x: number; y: number }

/** Intervalo [start, end) em ms. */
export type Range = { start: number; end: number }

/** Proteção de pixels da TELA de origem; compartilhada por YouTube e todos os cortes. */
export type BlurRegion = Range & { id: string; rect: Rect; mode: 'blur' | 'pixelate' | 'solid' }

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
  origin?: 'auto' | 'manual'
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
  | 'stack' // vertical V-B: tela em cima, câmera embaixo (ou o contrário, com `VerticalEdit.cameraTop`)
  | 'screen-focus' // vertical V-A: recorte da tela ocupa tudo (segue o cursor), câmera em bolha
  | 'screen-wide' // vertical V-C: a tela inteira na largura, fundo = o mesmo vídeo desfocado e escurecido

export type LayoutSeg = {
  id: string
  start: number
  end: number
  layout: LayoutKind
  origin?: 'auto' | 'manual'
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
  /** Só na VISÃO do vertical (vem de `VerticalEdit.cameraTop`): no V-B a câmera fica em cima e a tela embaixo. Nunca é gravada aqui. */
  stackCameraTop?: boolean
}

/** Intensidade do zoom automático. */
export type ZoomPresetId = 'subtle' | 'moderate' | 'intense'

/**
 * Estilos de legenda (M4a): `natural` (frase discreta numa caixa, o do 16:9), `highlight` ("Destaque": caixa-alta pesada
 * com contorno e a palavra falada acesa, o do vertical), `clean` ("Limpa": caixa branca, texto escuro) e `karaoke`
 * (frase inteira, a palavra acesa avança). O `plain` das versões antigas do documento vira `natural` ao ler.
 */
export type CaptionStyleId = 'natural' | 'highlight' | 'clean' | 'karaoke'

export type CaptionStyle = {
  enabled: boolean
  style: CaptionStyleId
  /** Palavras por linha. A legenda é de UMA linha (a segunda só existe se as palavras não cabem na largura): 2 no vertical, 5 no 16:9. */
  wordsPerLine: number
  /** Onde fica quando `positionY` não foi escolhido. */
  position: 'bottom' | 'center' | 'top'
  /** Caixa atrás do texto (Natural e Karaokê; a Limpa sempre tem). */
  box: boolean
  /** Cor da palavra falada. */
  highlightColor: string
  /** Cor do texto (padrão do estilo). */
  textColor?: string
  /** Multiplicador do tamanho padrão do estilo (1 = o padrão). */
  size?: number
  /** Posição vertical do CENTRO do bloco, fração 0..1 da altura do quadro (ausente = a do estilo). */
  positionY?: number
  /** Maiúsculas; ausente = o padrão do estilo (só o Destaque usa). */
  uppercase?: boolean
  /** A palavra falada acesa (na cor de destaque); ausente = ligada. A pessoa pode desligar. */
  highlightWord?: boolean
}

export type ClipFormat = 'vertical' | 'horizontal'
/** O layout de um corte vertical: `auto` segue a escolha por atividade do projeto; os outros fixam o layout no corte todo. */
export type VerticalLayout = 'auto' | 'stack' | 'screen-focus' | 'screen-wide' | 'camera'

/**
 * Edição PRÓPRIA do vertical 9:16 (M4a). Zooms, trechos de layout, câmera e legenda do vertical são independentes
 * dos do 16:9: o mesmo `project.json` carrega os dois formatos. Tempos em ms de ORIGEM, como em todo o documento.
 * Ausente = o vertical ainda não foi editado (os padrões valem e o editor gera zooms e layouts ao entrar no 9:16).
 */
export type VerticalEdit = {
  autoExclusions?: { zooms?:string[]; layouts?:string[] }
  /** Layout padrão do vertical (V-A `screen-focus`). */
  layout: LayoutKind
  /** Trechos de layout próprios (a escolha automática por atividade os gera). */
  layouts: LayoutSeg[]
  zooms: Zoom[]
  zoomPreset?: ZoomPresetId | 'off'
  /** Bolha da câmera no vertical: posição na CAIXA SEGURA e tamanho (fração do lado menor, 250 px = 0,2315). */
  camera?: { corner?: Corner; size?: number }
  /** V-B com a câmera EM CIMA e a tela embaixo (o padrão é a tela em cima e a câmera embaixo, o de 6 dos 10 canais medidos). */
  cameraTop?: boolean
  /** Título de gancho (aparece nos 4 primeiros segundos de saída). Vazio = nenhum. */
  hook?: string
  /** Legenda só do vertical; cores ausentes herdam as do horizontal. */
  captions?: Partial<CaptionStyle>
}

/** As três notas de um corte (0-100): gancho nos 3 primeiros segundos, fluxo (começo, meio e fim) e valor para quem assiste. */
export type ClipNotes = { hook: number; flow: number; value: number }

export type Clip = {
  id: string
  title: string
  /** Frase curta (até 8 palavras) que afirma o resultado; vira o título de gancho nos 2 primeiros segundos. */
  hook: string
  /** Pode juntar trechos não contíguos (tempo de origem, ms). Começa em início de frase e termina em fim de frase. */
  ranges: Range[]
  /** Nota geral 0-100. */
  score: number
  /** Notas de gancho, fluxo e valor (0-100). */
  notes?: ClipNotes
  /** Por que este trecho foi escolhido (uma frase). */
  reason: string
  format: ClipFormat
  layoutV: VerticalLayout
  /** Estilo de legenda só deste corte; ausente = o do vertical do projeto. */
  captionStyle?: CaptionStyleId
  captionsEnabled?: boolean
  /** Quem escolheu: a IA, a heurística (sem IA) ou a pessoa (editou os trechos à mão ou pediu pelo texto). */
  source?: 'ai' | 'heuristic' | 'manual'
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

/** Um capítulo do YouTube: onde começa (ms de ORIGEM; o tempo de saída é calculado com os cortes de agora) e o título. */
export type YoutubeChapter = { start: number; title: string }

/** Texto de publicação de um corte: legenda e hashtags de cada plataforma. */
export type ClipMeta = { caption?: string; hashtags?: string[]; tiktok?: string[]; reels?: string[]; shorts?: string[] }

export type ProjectMeta = {
  youtube?: { titles?: string[]; description?: string; tags?: string[]; chapters?: YoutubeChapter[] }
  perClip?: Record<string, ClipMeta>
}

export type Project = {
  autoExclusions?: { zooms?:string[]; layouts?:string[] }
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
  sync: {
    screenOffsetMs: number
    cameraOffsetMs: number
    /** Correção da imagem, positiva quando a câmera está atrasada. Nunca desloca a voz. */
    cameraAvOffsetMs?: number
    cameraAvManualOffsetMs?: number
    cameraAvDetection?: { method: 'syncnet' | 'calibration' | 'none'; confidence: number; segments: number; measuredAt: string; reason?: string }
  }
  capture: CaptureInfo
  cuts: Cut[]
  blurRegions?: BlurRegion[]
  /** Trechos de voz silenciada (muletas no modo "silenciar"). Ausente = nenhum. */
  mutes?: Mute[]
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
  /** O vertical 9:16 (M4a): zooms, layouts, câmera e legenda próprios. */
  vertical?: VerticalEdit
  /**
   * Correções de texto da transcrição, por índice de palavra (`Word.i`): valem para a legenda, nunca para o áudio.
   * Ficam no documento (e não em `transcript.json`) para entrar no desfazer.
   */
  wordFixes?: Record<string, string>
  /** A limpeza automática já foi aplicada a este projeto (acontece uma vez, depois da primeira transcrição). */
  autoCleaned?: boolean
  autopilot?: PipelineState
  review?: ReviewState
  meta?: ProjectMeta
  script?: VideoScript
  retakeMarks?: RetakeMark[]
}

/**
 * Natureza de um item da transcrição. `filler` = hesitação pura ("hã", "hum", "ahn"…); `gap-speech` = o VAD
 * marcou fala onde o motor não transcreveu nada (> 250 ms): costuma ser a hesitação que o Whisper engoliu.
 * "né", "tipo", "então" e "é" são `word`: só viram sugestão de corte pelo contexto (`clean.ts`).
 */
export type WordKind = 'word' | 'filler' | 'gap-speech'

/** Palavra transcrita (tempos em ms, tempo de ORIGEM = relógio da gravação). */
export type Word = {
  /** Posição na transcrição (0, 1, 2…). É assim que a IA e a interface apontam uma palavra. */
  i: number
  /** Como foi dita, com a pontuação que o motor pôs ("pessoal."). */
  text: string
  start: number
  end: number
  /** Confiança 0..1 (probabilidade da palavra). */
  prob: number
  kind: WordKind
}

/** Um trecho de fala que o motor entregou junto (frase ou parte dela). `first`/`last` são índices de palavra. */
export type TranscriptSegment = {
  start: number
  end: number
  text: string
  first: number
  last: number
}

export type Transcript = {
  /** Motor que transcreveu: "faster-whisper", "whisper.cpp" ou "teste". */
  engine: string
  model: string
  language: string
  /** Quanto o áudio dura (ms). */
  durationMs: number
  words: Word[]
  segments: TranscriptSegment[]
  /** Onde o VAD marcou fala (ms, tempo de origem). Vazio = o motor não informou. */
  vad: Range[]
  createdAt: string
}

/** Um trecho cuja voz fica muda (a imagem e o tempo seguem). Usado pelas muletas no modo "silenciar". */
export type Mute = {
  id: string
  start: number
  end: number
  reason: 'filler' | 'manual'
  enabled: boolean
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
