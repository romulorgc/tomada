/**
 * COMO cada estilo de legenda se desenha: fonte, tamanho, contorno, cores, caixa, onde fica. Os números vêm dos 115 vídeos
 * publicados que a medição de 05/10/2026 analisou, não mais de blogs. No vertical:
 *
 *  - Destaque: Montserrat ExtraBold em CAIXA ALTA, maiúscula de 58 px (corpo de 80), contorno de ~5 px, a palavra falada em
 *    #FFD93D com "pop" (E1: 58 [54-61] px, n = 21);
 *  - Natural (o padrão do pt-BR): Inter ExtraBold em caixa mista, branco com contorno fino, SEM caixa atrás, maiúscula de 46 px
 *    (corpo de 63; E1: 46 [41-57] px, n = 34; 72% das legendas brasileiras são em caixa mista);
 *  - Limpa: caixa branca e texto escuro; as palavras ainda não ditas ficam apagadas (corpo de 63);
 *  - Karaokê: Montserrat Bold, a palavra falada ganha uma pílula (corpo de 66);
 *  - todos: uma linha de 2 palavras [1-3], bloco de no máximo 660 px, centro em y 70% (E1: 70,3% [58,7-77,9]).
 *
 * No 16:9 (n = 4, confiança baixa): maiúscula de 26 px (corpo de 36), centro em y 94%, 1 linha de 5 palavras numa caixa escura
 * translúcida. Tamanhos em px "de 1080" (o lado menor do quadro; `unit` escala para a prévia e a exportação). Código puro.
 */
import { CAPTION_Y_VERTICAL, SAFE_BOX } from './vertical'
import type { FormatSpec } from './scene'
import type { CaptionStyle, CaptionStyleId } from './types'

/** Famílias empacotadas (OFL); a interface as registra com `FontFace` antes do primeiro quadro (`renderer/fonts.ts`). */
export const FONT = {
  montserrat: '"Tomada Montserrat", Montserrat, "Segoe UI", sans-serif',
  anton: '"Tomada Anton", Anton, Impact, "Segoe UI", sans-serif',
  inter: '"Tomada Inter", Inter, "Segoe UI", sans-serif'
} as const

/** As fontes que o motor precisa: família registrada, peso e arquivo (relativo a `renderer/assets/fonts`). */
export const CAPTION_FONT_FILES: readonly { family: string; weight: number; file: string }[] = [
  { family: 'Tomada Montserrat', weight: 800, file: 'Montserrat-ExtraBold.woff2' },
  { family: 'Tomada Montserrat', weight: 700, file: 'Montserrat-Bold.woff2' },
  { family: 'Tomada Anton', weight: 400, file: 'Anton-Regular.woff2' },
  { family: 'Tomada Inter', weight: 600, file: 'Inter-SemiBold.woff2' },
  { family: 'Tomada Inter', weight: 700, file: 'Inter-Bold.woff2' },
  { family: 'Tomada Inter', weight: 800, file: 'inter-latin-wght-normal.woff2' }
]

export type CaptionRenderStyle = {
  style: CaptionStyleId
  fontFamily: string
  fontWeight: number
  /** Tamanho em px do quadro (já com `unit` e o ajuste de tamanho). */
  fontPx: number
  /** Encolhe até aqui quando uma palavra comprida não cabe na largura. */
  minFontPx: number
  lineHeight: number
  uppercase: boolean
  /** Contorno VISÍVEL em px (0 = sem). */
  outlinePx: number
  outlineColor: string
  /** Sombra dura embaixo do texto. */
  shadow: boolean
  color: string
  /** Como a palavra falada aparece. */
  active: { mode: 'color' | 'pill' | 'none'; color: string; textColor: string; pop: number }
  /** Palavras que ainda não foram ditas ficam com esta opacidade (1 = iguais às outras). */
  upcomingAlpha: number
  maxWidth: number
  centerX: number
  centerY: number
  maxLines: number
  box: null | { color: string; padX: number; padY: number; radius: number }
  /** Faixa (px do quadro) onde o bloco precisa ficar inteiro (a caixa segura do vertical). */
  safeY: { min: number; max: number } | null
}

type Spec = {
  font: keyof typeof FONT
  weight: number
  /** px de 1080: no vertical e no horizontal. */
  v: number
  h: number
  lineHeight: number
  uppercase: boolean
  outline: { v: number; h: number }
  shadow: boolean
  color: string
  active: { mode: 'color' | 'pill' | 'none'; textColor: string; pop: number }
  upcomingAlpha: number
  /** Largura máxima: no vertical em px de 1080; no horizontal, fração da largura do quadro. */
  width: { v: number; h: number }
  box: { color: string; padX: number; padY: number; radius: number } | null
  /** Caixa que o usuário pode ligar e desligar (Natural e Karaokê). */
  boxOptional: boolean
}

const DARK = '#12151B'

const SPECS: Record<CaptionStyleId, Spec> = {
  natural: {
    font: 'inter',
    // Nota 5 da conferência: mais tinta sobre fundos claros, sem alterar as medidas calibradas.
    weight: 800,
    v: 63,
    h: 36,
    lineHeight: 1.28,
    uppercase: false,
    outline: { v: 5, h: 3 },
    shadow: false,
    color: '#FFFFFF',
    active: { mode: 'color', textColor: '#FFFFFF', pop: 0.06 },
    upcomingAlpha: 1,
    width: { v: 660, h: 0.68 },
    box: { color: 'rgba(10,12,16,0.62)', padX: 0.55, padY: 0.3, radius: 0.42 },
    boxOptional: true
  },
  highlight: {
    font: 'montserrat',
    weight: 800,
    v: 80,
    h: 58,
    lineHeight: 1.1,
    uppercase: true,
    outline: { v: 5, h: 4 },
    shadow: true,
    color: '#FFFFFF',
    active: { mode: 'color', textColor: '#FFFFFF', pop: 0.08 },
    upcomingAlpha: 1,
    width: { v: 660, h: 0.62 },
    box: null,
    boxOptional: false
  },
  clean: {
    font: 'inter',
    weight: 700,
    v: 63,
    h: 36,
    lineHeight: 1.28,
    uppercase: false,
    outline: { v: 0, h: 0 },
    shadow: false,
    color: DARK,
    active: { mode: 'none', textColor: DARK, pop: 0 },
    upcomingAlpha: 0.38,
    width: { v: 660, h: 0.62 },
    box: { color: 'rgba(255,255,255,0.97)', padX: 0.62, padY: 0.36, radius: 0.46 },
    boxOptional: false
  },
  karaoke: {
    font: 'montserrat',
    weight: 700,
    v: 66,
    h: 39,
    lineHeight: 1.34,
    uppercase: false,
    outline: { v: 5, h: 4 },
    shadow: false,
    color: '#FFFFFF',
    active: { mode: 'pill', textColor: DARK, pop: 0.06 },
    upcomingAlpha: 1,
    width: { v: 660, h: 0.7 },
    box: { color: 'rgba(10,12,16,0.66)', padX: 0.5, padY: 0.3, radius: 0.4 },
    boxOptional: true
  }
}

export const CAPTION_STYLE_IDS: readonly CaptionStyleId[] = ['highlight', 'natural', 'clean', 'karaoke']

/**
 * O que cada estilo traz de partida quando é escolhido, por formato: palavras por linha e se tem caixa (a aba Legendas, o estilo
 * de um corte e o pedido de "editar pedindo"). No vertical, 2 palavras numa linha e SEM caixa atrás (E1: 1 × 2 [1-3]; caixa em 7 de 17
 * canais); no 16:9, 5 palavras numa linha (E1: 5 [4-6]) e, nos estilos que a aceitam, a caixa escura translúcida.
 */
export function captionStyleDefaults(style: CaptionStyleId, kind: FormatSpec['kind']): { wordsPerLine: number; box: boolean } {
  if (kind === 'vertical') return { wordsPerLine: 2, box: false }
  return { wordsPerLine: 5, box: style !== 'highlight' }
}

/** Palavras por linha que o controle aceita: no vertical de 1 a 3 (a faixa medida), no 16:9 de 1 a 6. */
export function maxWordsPerLine(kind: FormatSpec['kind']): number {
  return kind === 'vertical' ? 3 : 6
}

/** Centro vertical padrão do bloco (fração da altura): no vertical y 70% (≈ 1344 de 1920, E1); no 16:9 y 94% (E1, n = 4). */
export function defaultCaptionY(position: CaptionStyle['position'], kind: FormatSpec['kind']): number {
  if (kind === 'vertical') return position === 'top' ? 0.22 : position === 'center' ? 0.5 : CAPTION_Y_VERTICAL
  return position === 'top' ? 0.12 : position === 'center' ? 0.5 : 0.94
}

export const CAPTION_SIZE_MIN = 0.6
export const CAPTION_SIZE_MAX = 1.5

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** Quanto a tinta passa do texto nos lados: metade do traço da sombra (contorno × 2 + 5% do corpo). */
export function inkMarginX(outlinePx: number, fontPx: number): number {
  return outlinePx > 0 ? outlinePx + fontPx * 0.025 : 0
}

/** E em cima e embaixo: o mesmo mais o deslocamento da sombra e a folga do descendente (g, p, Q, J). */
export function inkMarginY(outlinePx: number, fontPx: number): number {
  return outlinePx > 0 ? outlinePx + fontPx * 0.14 : 0
}

/**
 * O estilo resolvido para o formato. `autoY` é o centro vertical que o LAYOUT pede (fração da altura: no V-B a emenda tela/câmera,
 * na tela na largura 71%…): vale só quando a pessoa não escolheu a posição (`positionY`) nem pôs a legenda no alto ou no meio.
 */
export function resolveCaptionStyle(cs: CaptionStyle, format: Pick<FormatSpec, 'kind' | 'w' | 'h'>, autoY?: number): CaptionRenderStyle {
  const spec = SPECS[cs.style]
  const vertical = format.kind === 'vertical'
  const unit = Math.min(format.w, format.h) / 1080
  const size = clamp(Number.isFinite(cs.size) ? (cs.size as number) : 1, CAPTION_SIZE_MIN, CAPTION_SIZE_MAX)
  const fontPx = (vertical ? spec.v : spec.h) * size * unit
  const fallbackY = autoY !== undefined && vertical && cs.position === 'bottom' ? autoY : defaultCaptionY(cs.position, format.kind)
  const y = clamp(Number.isFinite(cs.positionY) ? (cs.positionY as number) : fallbackY, 0.04, 0.96)
  const showBox = spec.box !== null && (!spec.boxOptional || cs.box)
  // com a caixa por trás o texto já tem fundo; sem ela, o texto claro precisa do contorno para não sumir em cima da tela
  const outlinePx = showBox ? 0 : (vertical ? spec.outline.v : spec.outline.h) * size * unit
  const safe = vertical ? { min: SAFE_BOX.y * unit, max: (SAFE_BOX.y + SAFE_BOX.h) * unit } : null
  return {
    style: cs.style,
    fontFamily: FONT[spec.font],
    fontWeight: spec.weight,
    fontPx,
    minFontPx: fontPx * 0.72,
    lineHeight: spec.lineHeight,
    uppercase: cs.uppercase ?? spec.uppercase,
    outlinePx,
    outlineColor: '#000000',
    shadow: spec.shadow,
    color: cs.textColor ?? spec.color,
    // a palavra falada acesa vem ligada (E1: em cor própria em 5 de 17 canais); a pessoa a desliga
    active:
      cs.highlightWord === false
        ? { mode: 'none', color: cs.highlightColor, textColor: spec.active.textColor, pop: 0 }
        : { mode: spec.active.mode, color: cs.highlightColor, textColor: spec.active.textColor, pop: spec.active.pop },
    upcomingAlpha: spec.upcomingAlpha,
    // o contorno e a sombra saem do texto: a largura do texto desconta a margem de tinta (a TINTA fica dentro da caixa segura)
    maxWidth: (vertical ? spec.width.v * unit : format.w * spec.width.h) - 2 * inkMarginX(outlinePx, fontPx),
    centerX: format.w / 2,
    centerY: y * format.h,
    maxLines: 2,
    box: showBox ? { color: spec.box!.color, padX: spec.box!.padX * fontPx, padY: spec.box!.padY * fontPx, radius: spec.box!.radius * fontPx } : null,
    safeY: safe
  }
}

// ---------------------------------------------------------------------------
// Título de gancho (vertical)

/** O gancho: o Anton de 54 px tem a maiúscula de 46 px (a maiúscula do Anton é 0,859 do corpo; E1: 44 px [41-48]). */
export const HOOK_FONT_PX = 54
export const HOOK_OUTLINE_PX = 4

export type HookRenderStyle = {
  fontFamily: string
  fontWeight: number
  /** O maior tamanho (1 linha); encolhe para caber em duas linhas na faixa. */
  fontPx: number
  minFontPx: number
  lineHeight: number
  color: string
  outlinePx: number
  outlineColor: string
  maxWidth: number
  centerX: number
  bandTop: number
  bandBottom: number
}

export function resolveHookStyle(format: Pick<FormatSpec, 'w' | 'h'>, band: { top: number; bottom: number }): HookRenderStyle {
  const unit = Math.min(format.w, format.h) / 1080
  return {
    fontFamily: FONT.anton,
    fontWeight: 400,
    fontPx: HOOK_FONT_PX * unit,
    minFontPx: 42 * unit,
    lineHeight: 1,
    color: '#FFFFFF',
    outlinePx: HOOK_OUTLINE_PX * unit,
    outlineColor: '#000000',
    maxWidth: (800 - 2 * (HOOK_OUTLINE_PX + HOOK_FONT_PX * 0.025)) * unit,
    centerX: format.w / 2,
    bandTop: band.top * unit,
    bandBottom: band.bottom * unit
  }
}
