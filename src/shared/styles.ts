/**
 * Estilos do vídeo: os 18 fundos do legado (`legado/lib/layout.mjs`), padrões de margem,
 * raio, sombra e câmera, e a geometria de posição da câmera na grade 3×3.
 * Código puro: sem DOM, sem Node.
 */
import type { Background, CameraStyle, Corner, PresenterStyle, SideBySideStyle, Size } from './types'

export type BackgroundPreset = { id: string; name: string; from: string; to: string }

/** Os 18 fundos do v1 (gradiente diagonal). Nomes em pt-BR, agrupados por família. */
export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  // Quentes
  { id: 'sunset', name: 'Pôr do sol', from: '#f97316', to: '#fbbf24' },
  { id: 'coral', name: 'Coral', from: '#fb7185', to: '#fdba74' },
  { id: 'ferrugem', name: 'Ferrugem', from: '#9a3412', to: '#ea580c' },
  { id: 'areia', name: 'Areia', from: '#fef3c7', to: '#fcd34d' },
  // Frios
  { id: 'navy', name: 'Navy', from: '#1e3a5f', to: '#0ea5e9' },
  { id: 'oceano', name: 'Oceano', from: '#0369a1', to: '#22d3ee' },
  { id: 'ceu', name: 'Céu', from: '#dbeafe', to: '#93c5fd' },
  { id: 'petroleo', name: 'Petróleo', from: '#0f172a', to: '#0e7490' },
  // Violetas
  { id: 'violeta', name: 'Violeta', from: '#7c3aed', to: '#ec4899' },
  { id: 'ultra', name: 'Ultravioleta', from: '#4c1d95', to: '#7c3aed' },
  { id: 'rose', name: 'Rosé', from: '#fecdd3', to: '#fb7185' },
  // Verdes
  { id: 'menta', name: 'Menta', from: '#059669', to: '#34d399' },
  { id: 'floresta', name: 'Floresta', from: '#064e3b', to: '#10b981' },
  // Neutros
  { id: 'grafite', name: 'Grafite', from: '#1f2937', to: '#4b5563' },
  { id: 'carvao', name: 'Carvão', from: '#0f172a', to: '#334155' },
  { id: 'papel', name: 'Papel', from: '#f8fafc', to: '#e2e8f0' },
  { id: 'preto', name: 'Preto', from: '#000000', to: '#000000' },
  { id: 'branco', name: 'Branco', from: '#ffffff', to: '#ffffff' }
]

/** Padrão do app (o gradiente azul-noite de `defaultStyle`), que não está entre os 18. */
export const DEFAULT_BACKGROUND_ID = 'noite'
export const NIGHT_PRESET: BackgroundPreset = { id: DEFAULT_BACKGROUND_ID, name: 'Noite', from: '#1d2740', to: '#0b0c10' }

/** Ângulo do gradiente dos presets (CSS: 135 = do canto superior esquerdo ao inferior direito). */
export const PRESET_ANGLE = 135

export function backgroundFromPreset(id: string): Background {
  const p = [NIGHT_PRESET, ...BACKGROUND_PRESETS].find((b) => b.id === id) ?? NIGHT_PRESET
  return p.from === p.to ? { type: 'solid', color: p.from } : { type: 'gradient', from: p.from, to: p.to, angle: PRESET_ANGLE }
}

/** Qual preset este fundo é? (para marcar o seletor); `null` se for personalizado. */
export function presetIdOf(bg: Background): string | null {
  const all = [NIGHT_PRESET, ...BACKGROUND_PRESETS]
  if (bg.type === 'gradient') {
    return all.find((p) => p.from !== p.to && p.from === bg.from.toLowerCase() && p.to === bg.to.toLowerCase())?.id ?? null
  }
  if (bg.type === 'solid') return all.find((p) => p.from === p.to && p.from === bg.color.toLowerCase())?.id ?? null
  return null
}

/** Chave estável do fundo (para o cache de bitmaps). */
export function backgroundKey(bg: Background): string {
  switch (bg.type) {
    case 'gradient':
      return `g:${bg.from}:${bg.to}:${bg.angle}`
    case 'solid':
      return `s:${bg.color}`
    case 'image':
      return `i:${bg.path}`
  }
}

/**
 * Pontos de início e fim do gradiente num retângulo `w × h`, no padrão do CSS `linear-gradient`:
 * a linha passa pelo centro e é longa o bastante para que os quatro cantos recebam as cores extremas.
 */
export function gradientEndpoints(angleDeg: number, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } {
  const a = (angleDeg * Math.PI) / 180
  const dx = Math.sin(a)
  const dy = -Math.cos(a)
  const len = Math.abs(w * dx) + Math.abs(h * dy)
  const cx = w / 2
  const cy = h / 2
  return { x0: cx - (dx * len) / 2, y0: cy - (dy * len) / 2, x1: cx + (dx * len) / 2, y1: cy + (dy * len) / 2 }
}

// ---------------------------------------------------------------------------
// Câmera: posição 3×3

export const CAMERA_CORNERS: readonly Corner[] = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
]

/** Fração horizontal/vertical (0, 0,5 ou 1) da posição na grade 3×3. */
export function cornerFractions(corner: Corner): { fx: 0 | 0.5 | 1; fy: 0 | 0.5 | 1 } {
  const [row, col] = corner.split('-') as ['top' | 'middle' | 'bottom', 'left' | 'center' | 'right']
  return {
    fx: col === 'left' ? 0 : col === 'center' ? 0.5 : 1,
    fy: row === 'top' ? 0 : row === 'middle' ? 0.5 : 1
  }
}

/** Proporção (largura/altura) da caixa da câmera por forma. Círculo é quadrado; as outras são 4:3. */
export function cameraBoxAspect(shape: CameraStyle['shape']): number {
  return shape === 'circle' ? 1 : 4 / 3
}

/** Raio (px) dos cantos da câmera numa caixa `w × h`: círculo = metade do menor lado; retângulo = reto. */
export function cameraRadius(shape: CameraStyle['shape'], w: number, h: number): number {
  const m = Math.min(w, h)
  if (shape === 'circle') return m / 2
  if (shape === 'rounded') return m * 0.2
  return 0
}

// ---------------------------------------------------------------------------
// Câmera AO LADO da tela (lado a lado, estilo Tella)

/**
 * Largura do cartão da câmera: fração da largura do quadro. As referências lado a lado (Tella, estudo E1, e as de 12/10) têm a câmera em pé
 * em x 68-74% a 97% (23-29% do quadro) e a tela em 60-69%. O padrão é 24% (era 27%): com a página do navegador gravada em ~2,1:1
 * (1920×912, o caso do usuário) o cartão de 24% tem a MESMA altura da página (614 contra 613 px), como o padrão de 27% tinha numa tela
 * 16:9, e a página ganha 5% de largura. O rosto não encolhe: o recorte da câmera fecha mais (`sideBySideTarget`, em face.ts).
 */
export const SIDE_WIDTH = { min: 0.2, max: 0.45, default: 0.24 } as const
/** Espaço entre a tela e a câmera: fração do lado menor do quadro (o padrão é o de sempre: 60% da margem de 6%). */
export const SIDE_GAP = { min: 0, max: 0.08, default: 0.036 } as const

const clampTo = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback)

/** O lado a lado com os padrões aplicados e os valores presos às faixas aceitas. `aspect` = largura/altura do cartão da câmera. */
export function resolveSideBySide(s: SideBySideStyle | undefined): { side: 'left' | 'right'; ratio: 'portrait' | 'square'; aspect: number; width: number; gap: number } {
  const ratio = s?.ratio === 'square' ? 'square' : 'portrait'
  return {
    side: s?.side === 'left' ? 'left' : 'right',
    ratio,
    aspect: ratio === 'square' ? 1 : 3 / 4,
    width: clampTo(s?.width, SIDE_WIDTH.min, SIDE_WIDTH.max, SIDE_WIDTH.default),
    gap: clampTo(s?.gap, SIDE_GAP.min, SIDE_GAP.max, SIDE_GAP.default)
  }
}

// ---------------------------------------------------------------------------
// Apresentador RECORTADO (M4c)

/**
 * Medido em vídeos reais de referência: no YouTube 16:9 (11 vídeos, 3 criadores) a pessoa recortada tem 56% da
 * altura do quadro [52-65], 36% da largura [31-37], ancorada na borda de baixo e colada na borda da direita (centro em x 81%);
 * nos Shorts 9:16 verdes (14 vídeos, 3 criadores) ela tem 43% da altura [38-48], o topo da cabeça em y 57% [52-62] e 84% da largura.
 * A pessoa ocupa ~85% da altura da JANELA (o recorte da webcam), que é de onde a janela sai a partir da altura da pessoa.
 */
export const PRESENTER = {
  /** Quanto da altura da janela da webcam a pessoa (da cabeça à borda de baixo) ocupa. */
  personFrac: 0.85,
  /**
   * Proporção (largura/altura) da janela no 16:9. A janela é só o recorte da webcam: fora da pessoa ela é transparente, então largura a mais não custa
   * nada e evita que as mãos e o braço sejam cortados por uma linha reta no meio da tela (com 1,2 o recorte da webcam cortava a mão de lado).
   */
  aspect: 1.5,
  /**
   * Fração da largura da janela que passa da borda do quadro: põe o centro da pessoa em x ≈ 82% (a mediana medida, 81%) e o ombro encostado na borda,
   * como nas referências. Vale de 0,5 − 0,185·(largura do quadro ÷ largura da janela) = 0,17 para a janela de 1,5.
   */
  bleed: 0.165,
  /** Altura da pessoa: 16:9 e 9:16. */
  height: { min: 0.45, max: 0.75, default: 0.56 },
  heightV: { min: 0.35, max: 0.6, default: 0.45 },
  /** Contorno branco de figurinha: 6-12 px na altura de 1080. */
  outline: { min: 6, max: 12, default: 8 },
  /** No V-D a tela acaba esta fração do quadro abaixo do topo da cabeça (mãos e ombros invadem a tela). */
  screenOverlapV: 0.07,
  /** No V-D a legenda fica esta fração do quadro acima do topo da cabeça (medido: de 3 a 12 pontos, mediana 4,5). */
  captionGapV: 0.04
} as const

/** O apresentador com os padrões aplicados e os valores presos às faixas aceitas. */
export function resolvePresenter(p: PresenterStyle | undefined): {
  side: 'left' | 'right'
  height: number
  heightV: number
  outline: boolean
  outlineWidth: number
  shadow: boolean
} {
  return {
    side: p?.side === 'left' ? 'left' : 'right',
    height: clampTo(p?.height, PRESENTER.height.min, PRESENTER.height.max, PRESENTER.height.default),
    heightV: clampTo(p?.heightV, PRESENTER.heightV.min, PRESENTER.heightV.max, PRESENTER.heightV.default),
    outline: p?.outline === true,
    outlineWidth: clampTo(p?.outlineWidth, PRESENTER.outline.min, PRESENTER.outline.max, PRESENTER.outline.default),
    shadow: p?.shadow !== false
  }
}

/**
 * A janela (retângulo em px do quadro) em que a webcam recortada aparece. 16:9: ancorada embaixo, no canto, passando um pouco da borda
 * (`bleed`). 9:16 (V-D): a largura toda, ancorada embaixo. A altura da janela vem da altura da pessoa (`personFrac`).
 */
export function presenterWindow(p: ReturnType<typeof resolvePresenter>, format: Size & { kind?: string }, vertical: boolean): { x: number; y: number; w: number; h: number } {
  const { w: W, h: H } = format
  if (vertical) {
    const h = Math.min(H, (p.heightV / PRESENTER.personFrac) * H)
    return { x: 0, y: H - h, w: W, h }
  }
  const h = Math.min(H, (p.height / PRESENTER.personFrac) * H)
  const w = h * PRESENTER.aspect
  const x = p.side === 'right' ? W - w * (1 - PRESENTER.bleed) : -w * PRESENTER.bleed
  return { x, y: H - h, w, h }
}

/** V-D: a altura (fração do quadro) da faixa de cima que é a tela: vai um pouco abaixo do topo da cabeça. */
export function presenterScreenHeightV(p: ReturnType<typeof resolvePresenter>): number {
  return Math.min(0.75, 1 - p.heightV + PRESENTER.screenOverlapV)
}

// ---------------------------------------------------------------------------
// Medidas

/**
 * Unidade de px do estilo: raio, sombra e bordas valem "na altura de 1080". Num quadro de
 * outro tamanho (prévia, 4K, vertical) tudo escala pelo lado MENOR sobre 1080.
 */
export function styleUnit(size: Size): number {
  return Math.min(size.w, size.h) / 1080
}

/** Recorte "cobrir" normalizado (0..1) da fonte para preencher um destino de proporção `destAspect`. */
export function coverCrop(src: Size, destAspect: number): { x: number; y: number; w: number; h: number } {
  if (!(src.w > 0) || !(src.h > 0) || !(destAspect > 0)) return { x: 0, y: 0, w: 1, h: 1 }
  const srcAspect = src.w / src.h
  if (srcAspect > destAspect) {
    const w = destAspect / srcAspect
    return { x: (1 - w) / 2, y: 0, w, h: 1 }
  }
  const h = srcAspect / destAspect
  return { x: 0, y: (1 - h) / 2, w: 1, h }
}
