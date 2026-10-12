/**
 * Emenda na IMAGEM (F1, item 6). Código puro: sem DOM, sem Node. Prévia e exportação leem o mesmo plano (`deriveProject`).
 *
 * Nas referências de edição de fala, a emenda "visível" quase nunca é a mesma imagem pulando: 57% das emendas de rosto mudam o
 * tamanho do rosto em mais de 6% (razão mediana 1,32×), em corte seco de 1 quadro. Aqui:
 *  - **punch-in alternado**: trechos pares ficam em 1,00× e os ímpares em `PUNCH_SCALE` (1,28×, faixa 1,25-1,35), centrado no rosto
 *    (`camera-face.json`), só nos layouts em que a câmera/rosto aparece com destaque (quadro ao lado, apresentador, V-B, só câmera).
 *    Corte seco, sem animação. Nunca duas emendas seguidas no mesmo enquadramento quando o trecho vizinho tem menos de 3 s;
 *  - **dissolve curto** (200 ms) só quando o trecho removido tem pelo menos 1 s E a tela mudou; senão, corte seco.
 *
 * O punch-in age só no RECORTE da imagem da câmera (dentro da imagem, que não tem como sair do quadro) e é limitado para o recorte
 * não passar de 1/`MAX_CROP_ZOOM` da imagem (câmera 1080p ampliada demais vira pixel). Ele não mexe no zoom da tela do 16:9.
 */
import type { Seam } from './seams'
import type { Range, Rect } from './types'

/** Aproximação do rosto nos trechos ímpares (1,25-1,35 nas referências). */
export const PUNCH_SCALE = 1.28
export const PUNCH_SCALE_RANGE = { min: 1.25, max: 1.35 } as const
/** Trecho curto vizinho (ms): abaixo disto a emenda SEMPRE troca de enquadramento. */
export const PUNCH_SHORT_SEGMENT_MS = 3000
/** O recorte da câmera nunca fica menor que esta fração da largura da imagem (no máximo ~6,7× de aproximação total, com o enquadramento automático). */
export const MIN_CROP_W = 0.15

/** Dissolve: duração (150-250 ms), e o mínimo cortado (ms) para valer a pena. */
export const DISSOLVE_MS = 200
export const DISSOLVE_MIN_REMOVED_MS = 1000
/** A tela "mudou" entre dois instantes quando a grade de conteúdo varia pelo menos isto (0..1). */
export const DISSOLVE_SCREEN_CHANGE_MIN = 0.05

/**
 * O fator do punch-in de cada trecho mantido (1 ou `scale`). O primeiro trecho é 1,00. Emenda com um trecho vizinho menor que 3 s
 * troca sempre; entre dois trechos longos, uma sim e uma não (a conta é determinística: o mesmo vídeo sai sempre igual).
 */
export function punchScales(kept: readonly Range[], scale: number = PUNCH_SCALE): number[] {
  const s = Math.min(PUNCH_SCALE_RANGE.max, Math.max(PUNCH_SCALE_RANGE.min, scale))
  const out: number[] = []
  let punched = false
  let optional = 0
  for (let i = 0; i < kept.length; i++) {
    if (i > 0) {
      const a = kept[i - 1]!.end - kept[i - 1]!.start
      const b = kept[i]!.end - kept[i]!.start
      const mustToggle = Math.min(a, b) < PUNCH_SHORT_SEGMENT_MS
      if (mustToggle || optional % 2 === 0) punched = !punched
      if (!mustToggle) optional++
    }
    out.push(punched ? s : 1)
  }
  return out
}

/**
 * Aproxima o recorte `rect` (normalizado na imagem da câmera) em `scale` mantendo o rosto onde ele já estava na janela: o ponto
 * `focus` (centro do rosto) fica na mesma posição relativa. Sem rosto, aproxima pelo centro. O resultado sempre cabe na imagem e
 * nunca fica estreito demais (`MIN_CROP_W`).
 */
export function punchCrop(rect: Rect, scale: number, focus: { cx: number; cy: number } | null): Rect {
  if (!(scale > 1)) return rect
  const s = Math.max(1, Math.min(scale, rect.w / MIN_CROP_W))
  if (s <= 1) return rect
  const w = rect.w / s
  const h = rect.h / s
  const fx = focus ? Math.min(1, Math.max(0, (focus.cx - rect.x) / rect.w)) : 0.5
  const fy = focus ? Math.min(1, Math.max(0, (focus.cy - rect.y) / rect.h)) : 0.5
  const ax = focus ? focus.cx : rect.x + rect.w / 2
  const ay = focus ? focus.cy : rect.y + rect.h / 2
  const x = Math.min(1 - w, Math.max(0, ax - fx * w))
  const y = Math.min(1 - h, Math.max(0, ay - fy * h))
  return { x, y, w, h }
}

/** Que emendas dissolvem: removido ≥ 1 s E a tela mudou entre o fim do trecho e o começo do seguinte. */
export function dissolveFlags(seams: readonly Seam[], screenChanged: (fromMs: number, toMs: number) => boolean): boolean[] {
  return seams.map((s) => s.removedMs >= DISSOLVE_MIN_REMOVED_MS && screenChanged(s.leftEnd, s.rightStart))
}

/**
 * O peso do quadro que SAI (0..1) no instante de saída `outMs`: 1 logo na emenda, 0 depois de `DISSOLVE_MS`. 0 fora de uma emenda
 * que dissolve. `kept` limita a duração ao trecho que entra (nunca mais da metade dele).
 */
export function dissolveWeight(seams: readonly Seam[], flags: readonly boolean[], kept: readonly Range[], outMs: number): number {
  // busca binária: a última emenda com outMs ≤ outMs
  let lo = 0
  let hi = seams.length - 1
  let at = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (seams[mid]!.outMs <= outMs) {
      at = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (at < 0 || !flags[at]) return 0
  const next = kept[at + 1]
  const dur = Math.min(DISSOLVE_MS, next ? (next.end - next.start) / 2 : DISSOLVE_MS)
  const u = (outMs - seams[at]!.outMs) / dur
  if (!(u >= 0) || u >= 1) return 0
  return 1 - u * u * (3 - 2 * u)
}

/** Quanto a grade de conteúdo varia (0..1) entre os instantes `a` e `b` (a amostra vigente em cada um). */
export function contentDifference(map: readonly { t: number; cells: ArrayLike<number> }[], a: number, b: number): number {
  if (map.length === 0) return 0
  const at = (t: number): { t: number; cells: ArrayLike<number> } => {
    let lo = 0
    let hi = map.length - 1
    let found = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (map[mid]!.t <= t) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return map[found]!
  }
  const x = at(a).cells
  const y = at(b).cells
  const n = Math.min(x.length, y.length)
  if (n === 0) return 0
  let sum = 0
  for (let k = 0; k < n; k++) sum += Math.abs(x[k]! - y[k]!)
  return sum / n / 255
}

/**
 * Os quadros de saída cujo desenho vira o "quadro que sai" de um dissolve: o último de cada trecho que antecede uma emenda que
 * dissolve. A exportação guarda uma cópia do canvas nesses quadros (o `sourceTimeOfFrame` soma meio ms ao instante de saída).
 */
export function dissolveSnapFrames(seams: readonly Seam[], flags: readonly boolean[], fps: number): Set<number> {
  const out = new Set<number>()
  seams.forEach((s, i) => {
    if (!flags[i]) return
    const first = Math.ceil(((s.outMs - 0.5) * fps) / 1000) // primeiro quadro do trecho novo
    if (first >= 1) out.add(first - 1)
  })
  return out
}
