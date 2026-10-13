/**
 * O layout V-E "Green screen" do 9:16 (F2): a página em tela cheia atrás (a janela legível de `legible.ts`, que segue o foco) e
 * você recortado do fundo na frente, ancorado embaixo. Código puro: sem DOM, sem Node.
 *
 * Medidas de vídeos de referência (estudo de 12/10):
 *  - centrado: a pessoa tem 47-49% da altura do quadro, até ~85% da largura, ancorada na borda de baixo; a legenda fica ~6% da altura
 *    acima do topo da cabeça;
 *  - "no canto" (o que o usuário descreveu): 35-45% da altura, no máximo 45% da largura, num canto de baixo, com sombra suave.
 *
 * R4 "apresentador que desvia": no canto, a pessoa fica do lado OPOSTO ao foco da página, para nunca tapar o que está sendo
 * explicado. O lado só muda a cada 4 s no mínimo (tempo de saída) e, de preferência, numa emenda (corte seco); fora de uma emenda
 * o deslize leva 0,4 s.
 */
import { cameraCropRect, type CropTarget, type FaceAim, type FaceFramer } from './face'
import { PRESENTER } from './styles'
import { sampleGrid, type CursorGrid } from './cursor'
import type { Seam } from './seams'
import type { FocusPoint } from './action-focus'
import type { CameraFraming, LayoutKind, PresenterStyle, Range, Rect, Size } from './types'

export type GreenscreenKind = Extract<LayoutKind, 'greenscreen' | 'greenscreen-corner'>
export const isGreenscreen = (layout: LayoutKind): layout is GreenscreenKind => layout === 'greenscreen' || layout === 'greenscreen-corner'

/** As medidas do layout (fração do quadro). */
export const GREENSCREEN = {
  /** Altura da pessoa (da cabeça à borda de baixo) no V-E centrado: 47-49% nas referências. */
  height: 0.47,
  /** Altura da pessoa no V-E "no canto" (35-45%). */
  cornerHeight: 0.4,
  /** Largura da janela da câmera no canto (≤ 45% do quadro, o teto das referências): a janela inteira fica dentro do quadro e o rosto no meio dela. */
  cornerMaxW: 0.45,
  /** A janela do canto nunca fica mais larga que isto vezes a altura dela (uma pessoa de 40% da altura num quadro estreito). */
  cornerMaxAspect: 0.8,
  /** A legenda fica esta fração do quadro ACIMA do topo da cabeça (referências: ~6%). */
  captionGap: 0.06
} as const

/**
 * Rosto no recorte do V-E: a janela mostra a câmera de cima a baixo (sem aproximar além do que o rosto pede) e a pessoa é medida DEPOIS,
 * pelo rosto detectado (`personFit`): é ela que diz onde o cabelo cai na janela, e a altura da janela sai disso para a pessoa ficar com
 * 47% do quadro. (Tentar fixar o tamanho do rosto não funciona: uma webcam de rosto grande já passa dele sem aproximar nada.)
 */
export const GREENSCREEN_TARGET: CropTarget = { targetH: 0.2, headroomY: 0.34, maxZoom: 2.2 }
/** Rosto no recorte do canto: janela estreita, o rosto menor para os ombros caberem. */
export const GREENSCREEN_CORNER_TARGET: CropTarget = { targetH: 0.17, headroomY: 0.34, maxZoom: 2.2 }
/** Do centro do rosto ao topo do cabelo: tantas alturas de rosto (medido no recorte real: 1,04; cabelo cacheado). */
export const HAIR_ABOVE_FACE = 1.04

/** Onde a pessoa cai na janela da câmera (fração da altura da janela, 0 = topo): o cabelo e o centro do rosto. */
export type PersonFit = { hairRel: number; faceCyRel: number }
export const DEFAULT_PERSON_FIT: PersonFit = { hairRel: 0.08, faceCyRel: 0.34 }

/** Altura da pessoa (fração do quadro) no layout: a escolha do usuário em `PresenterStyle.heightV` vale nos dois. */
export function greenscreenHeight(kind: GreenscreenKind, presenter?: PresenterStyle): number {
  const chosen = presenter?.heightV
  if (typeof chosen === 'number' && Number.isFinite(chosen)) return Math.min(PRESENTER.heightV.max, Math.max(PRESENTER.heightV.min, chosen))
  return kind === 'greenscreen' ? GREENSCREEN.height : GREENSCREEN.cornerHeight
}

/** O alvo de enquadramento do rosto no layout. */
export const greenscreenTarget = (kind: GreenscreenKind): CropTarget => (kind === 'greenscreen' ? GREENSCREEN_TARGET : GREENSCREEN_CORNER_TARGET)

/** Altura da janela (fração do quadro) para a PESSOA (do cabelo à borda de baixo) ter a altura do layout. */
export function greenscreenWindowH(kind: GreenscreenKind, presenter: PresenterStyle | undefined, fit: PersonFit = DEFAULT_PERSON_FIT): number {
  const personInWindow = Math.max(0.5, 1 - Math.min(0.3, Math.max(0, fit.hairRel)))
  return Math.min(0.8, greenscreenHeight(kind, presenter) / personInWindow)
}

/**
 * A janela (px do quadro) em que a câmera recortada aparece, ancorada embaixo.
 *  - V-E centrado: a largura toda do quadro;
 *  - V-E no canto: janela estreita; `cornerT` 0 = canto esquerdo, 1 = canto direito (0..1 durante o deslize). Só `cornerMaxW` do
 *    quadro fica visível, o resto da janela passa da borda (o ombro encosta nela).
 */
export function greenscreenWindow(kind: GreenscreenKind, presenter: PresenterStyle | undefined, format: Size, cornerT = 1, fit: PersonFit = DEFAULT_PERSON_FIT): Rect {
  const { w: W, h: H } = format
  const h = greenscreenWindowH(kind, presenter, fit) * H
  if (kind === 'greenscreen') return { x: 0, y: H - h, w: W, h }
  const w = Math.min(h * GREENSCREEN.cornerMaxAspect, GREENSCREEN.cornerMaxW * W)
  const t = Math.min(1, Math.max(0, cornerT))
  return { x: t * (W - w), y: H - h, w, h }
}

/**
 * Mede onde a pessoa cai na janela da câmera: o recorte que o enquadramento automático dá (`cameraCropRect`) sobre o rosto típico
 * (mediana da análise). Sem rosto, o padrão. Duas voltas porque a proporção da janela depende da altura dela.
 */
export function personFit(kind: GreenscreenKind, presenter: PresenterStyle | undefined, format: Size, camera: Size | null, aim: FaceAim | null, framing?: CameraFraming): PersonFit {
  if (!camera || !aim) return DEFAULT_PERSON_FIT
  let fit = DEFAULT_PERSON_FIT
  for (let i = 0; i < 2; i++) {
    const win = greenscreenWindow(kind, presenter, format, 1, fit)
    const rect = cameraCropRect(camera, win.w / win.h, aim, framing, greenscreenTarget(kind))
    const hair = aim.cy - HAIR_ABOVE_FACE * aim.faceH
    fit = { hairRel: (hair - rect.y) / rect.h, faceCyRel: (aim.cy - rect.y) / rect.h }
  }
  return fit
}

/** O rosto típico da gravação (mediana da análise): onde ele costuma ficar na imagem da câmera. `null` sem análise. */
export function typicalAim(framer: FaceFramer | null): FaceAim | null {
  if (!framer || framer.cx.length === 0) return null
  const pick = (arr: readonly number[]): number => {
    const s = arr.filter((_, i) => i % 15 === 0).sort((a, b) => a - b)
    return s[s.length >> 1] ?? 0.5
  }
  return { cx: pick(framer.cx), cy: pick(framer.cy), faceW: framer.faceW, faceH: framer.faceH }
}

/**
 * Topo da cabeça (cabelo) no quadro, fração da altura. Com o punch-in (`punch` ≥ 1) a imagem se aproxima em torno do centro do rosto e
 * o cabelo sobe.
 */
export function greenscreenHeadTop(kind: GreenscreenKind, presenter?: PresenterStyle, punch = 1, fit: PersonFit = DEFAULT_PERSON_FIT): number {
  const windowH = greenscreenWindowH(kind, presenter, fit)
  // o cabelo não passa do topo da janela (o que sobe além dela é cortado)
  const hair = Math.max(0, fit.faceCyRel - (fit.faceCyRel - fit.hairRel) * Math.max(1, punch))
  return 1 - windowH + hair * windowH
}

/** Centro vertical da legenda (fração do quadro): `captionGap` acima do topo da cabeça, nunca sobre o rosto nem sobre o queixo. */
export function greenscreenCaptionY(kind: GreenscreenKind, presenter?: PresenterStyle, punch = 1, fit: PersonFit = DEFAULT_PERSON_FIT): number {
  return greenscreenHeadTop(kind, presenter, punch, fit) - GREENSCREEN.captionGap
}

// ---------------------------------------------------------------------------
// O canto (R4)

/** Menos que isto de SAÍDA entre dois lados: o lado não muda (4 s). */
export const CORNER_MIN_HOLD_MS = 4000
/** O candidato novo precisa se manter por isto (ms) antes de valer: o cursor que só passou pelo meio não troca o lado. */
export const CORNER_CANDIDATE_MS = 600
/** Zona morta no meio do quadro (fração da largura): o foco entre 0,5 ± isto não decide o lado. */
export const CORNER_DEAD_ZONE = 0.1
/** Deslize do canto quando não há emenda por perto (ms). */
export const CORNER_SLIDE_MS = 400
/** Uma emenda a até isto (ms de origem) depois do momento da troca recebe a troca como corte seco. */
export const CORNER_SEAM_REACH_MS = 1500

/** Uma troca de lado: em `t` (origem) o lado vai para `to` (0 = esquerda, 1 = direita) em `ms` (0 = corte seco numa emenda). */
export type CornerSwitch = { t: number; ms: number; to: 0 | 1 }
export type CornerPlan = { initial: 0 | 1; switches: CornerSwitch[] }

export type CornerInput = {
  durationMs: number
  kept: readonly Range[]
  seams: readonly Seam[]
  clicks: readonly Pick<FocusPoint, 't' | 'x' | 'y' | 'strong'>[]
  cursor: CursorGrid
  /** O centro e a largura da janela da página em `t` (fração da área-base). */
  windowAt: (sourceMs: number) => { cx: number; w: number }
  toOutput: (sourceMs: number) => number
  stepMs?: number
}

/** Onde está o foco da página: a última ação forte dos últimos 3 s, senão o cursor. */
export function attentionX(t: number, strong: readonly { t: number; x: number }[], cursor: CursorGrid): number {
  let best: { t: number; x: number } | null = null
  for (const p of strong) {
    if (p.t > t) break
    if (t - p.t <= 3000) best = p
  }
  return best ? best.x : sampleGrid(cursor, t).x
}

/**
 * Em que lado a pessoa fica ao longo da gravação. O foco à direita do centro da janela põe a pessoa à ESQUERDA (0) e vice-versa;
 * perto do centro (zona morta) o lado não muda. A troca exige o candidato estável por `CORNER_CANDIDATE_MS` e `CORNER_MIN_HOLD_MS`
 * de saída desde a troca anterior; se há uma emenda logo depois (até `CORNER_SEAM_REACH_MS`), a troca vira corte seco nela.
 */
export function planGreenCorner(input: CornerInput): CornerPlan {
  const step = input.stepMs ?? 100
  const strong = input.clicks.filter((p) => p.strong).sort((a, b) => a.t - b.t)
  const initial: 0 | 1 = 1
  const switches: CornerSwitch[] = []
  let side: 0 | 1 = initial
  let candidate: 0 | 1 | null = null
  let candidateSince = 0
  let lastSwitchOut = Number.NEGATIVE_INFINITY
  for (const r of input.kept) {
    for (let t = r.start; t < r.end; t += step) {
      const w = input.windowAt(t)
      const fx = w.w > 0 ? 0.5 + (attentionX(t, strong, input.cursor) - w.cx) / w.w : 0.5
      const want: 0 | 1 | null = fx >= 0.5 + CORNER_DEAD_ZONE ? 0 : fx <= 0.5 - CORNER_DEAD_ZONE ? 1 : null
      if (want === null || want === side) {
        candidate = null
        continue
      }
      if (candidate !== want) {
        candidate = want
        candidateSince = t
        continue
      }
      if (t - candidateSince < CORNER_CANDIDATE_MS) continue
      if (input.toOutput(t) - lastSwitchOut < CORNER_MIN_HOLD_MS) continue
      const seam = input.seams.find((s) => s.rightStart >= t && s.rightStart - t <= CORNER_SEAM_REACH_MS)
      const sw: CornerSwitch = seam ? { t: seam.rightStart, ms: 0, to: want } : { t, ms: CORNER_SLIDE_MS, to: want }
      switches.push(sw)
      side = want
      candidate = null
      lastSwitchOut = input.toOutput(sw.t)
    }
  }
  return { initial, switches }
}

const smooth = (u: number): number => u * u * (3 - 2 * u)

/** A posição do canto em `t` (origem): 0 = esquerda, 1 = direita, fração durante o deslize. */
export function cornerAt(plan: CornerPlan, t: number): number {
  let value: number = plan.initial
  for (const s of plan.switches) {
    if (s.t > t) break
    const u = s.ms > 0 ? Math.min(1, (t - s.t) / s.ms) : 1
    value = value + (s.to - value) * smooth(u)
    if (u < 1) return value
  }
  return value
}
