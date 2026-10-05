/**
 * Zoom automático (pesquisa §2.2 e §8): geração dos segmentos a partir dos
 * cliques e o CAMINHO DA CÂMERA (escala + centro) a 60 Hz, determinístico e sem estado
 * entre quadros. A mola segue as ideias do OpenScreen (MIT) e do Cap: solução analítica
 * com velocidade carregada, zona morta de 50% × 70% e antecipação pela velocidade.
 *
 * Tempos em ms; posições normalizadas 0..1. Código puro: sem DOM, sem Node.
 */
import { GRID_HZ, GRID_STEP_MS, sampleGrid, type CursorGrid } from './cursor'
import { CAMERA_SPRING, step as springStep, type SpringParams } from './spring'
import type { ClickEvent, KeyEvent, Project, Rect, Zoom, ZoomPresetId } from './types'

// ---------------------------------------------------------------------------
// Presets (projeto; a tabela está em segundos, aqui em ms)

export type ZoomPreset = {
  /** Quanto o zoom abre ANTES do clique (a mola leva ~0,4 s para assentar). */
  lead: number
  /** Quanto o zoom segura DEPOIS do clique. */
  hold: number
  /** Janelas separadas por menos que isto se fundem num só segmento. */
  mergeGap: number
  scale: number
  /** Intervalo mínimo entre dois zooms: menos que isto vira um só. */
  minGap: number
}

export const ZOOM_PRESETS: Record<ZoomPresetId, ZoomPreset> = {
  subtle: { lead: 600, hold: 2000, mergeGap: 2500, scale: 1.4, minGap: 2500 },
  moderate: { lead: 500, hold: 1400, mergeGap: 1800, scale: 1.7, minGap: 1800 },
  intense: { lead: 400, hold: 900, mergeGap: 1200, scale: 2.0, minGap: 1200 }
}

/** Padrão do horizontal 16:9. */
export const DEFAULT_ZOOM_PRESET: ZoomPresetId = 'moderate'

/** Padrão do vertical 9:16: o Intenso, com escala de vertical (ver `zoomPresetFor`). */
export const DEFAULT_VERTICAL_ZOOM_PRESET: ZoomPresetId = 'intense'

/**
 * Escala do zoom por preset NO VERTICAL. O recorte 9:16 já parte de ~1,78× (a altura inteira da tela), então os zooms de
 * clique são só um reforço: 1,3-1,5×, em vez dos 1,4-2× do 16:9. Os tempos (lead, hold, fusão) são os mesmos.
 */
export const VERTICAL_ZOOM_SCALE: Record<ZoomPresetId, number> = { subtle: 1.2, moderate: 1.3, intense: 1.4 }

/** O preset de um formato: no vertical, os tempos do preset com a escala de vertical. */
export function zoomPresetFor(kind: 'horizontal' | 'vertical', id: ZoomPresetId): ZoomPreset {
  const base = ZOOM_PRESETS[id]
  return kind === 'vertical' ? { ...base, scale: VERTICAL_ZOOM_SCALE[id] } : base
}

/** Rajada de digitação: pelo menos 3 teclas com intervalos menores que isto. */
export const TYPING_BURST_GAP_MS = 800
export const TYPING_BURST_MIN_KEYS = 3
/** Dwell (OpenScreen): cursor parado dentro deste raio normalizado, por 450-2600 ms. */
export const DWELL_RADIUS = 0.02
export const DWELL_MIN_MS = 450
export const DWELL_MAX_MS = 2600
/** Zoom mais curto que isto não vale a pena. */
export const MIN_ZOOM_MS = 600

/** Zona morta: a câmera só anda quando o cursor sai desta caixa em volta do centro (fração da área VISÍVEL). */
export const DEAD_ZONE = { w: 0.5, h: 0.7 }
/** Antecipação do foco pela velocidade do cursor. */
export const LOOKAHEAD_MS = 200
/** Quanto a antecipação pode adiantar o foco (normalizado), para um solavanco do cursor não puxar a câmera. */
const LOOKAHEAD_MAX = 0.12
/** Anti-enjoo: o cursor atravessa mais que isto da largura em 0,4 s → a câmera sai do zoom. */
export const SWEEP_DISTANCE = 0.35
export const SWEEP_WINDOW_MS = 400
/** Teto de escala aceito do documento (um valor maluco no project.json não pode explodir o render). */
export const MAX_ZOOM_SCALE = 8

// ---------------------------------------------------------------------------
// Geração

export type AutoZoomInput = {
  clicks: readonly ClickEvent[]
  keys: readonly KeyEvent[]
  cursor: CursorGrid
  /** Duração da gravação (ms). */
  duration: number
  preset: ZoomPresetId | ZoomPreset
}

type Win = { start: number; end: number; focus: 'auto' | { x: number; y: number }; click: boolean }

/** Rajadas de digitação: [{first, last}] em ms. */
export function findTypingBursts(keys: readonly KeyEvent[]): { first: number; last: number }[] {
  const ts = keys.map((k) => k.t).filter(Number.isFinite).sort((a, b) => a - b)
  const out: { first: number; last: number }[] = []
  let run: number[] = []
  const close = (): void => {
    if (run.length >= TYPING_BURST_MIN_KEYS) out.push({ first: run[0]!, last: run[run.length - 1]! })
    run = []
  }
  for (const t of ts) {
    if (run.length > 0 && t - run[run.length - 1]! >= TYPING_BURST_GAP_MS) close()
    run.push(t)
  }
  close()
  return out
}

/** Trechos em que o cursor ficou parado (dentro de `DWELL_RADIUS`) por 450-2600 ms, com o foco médio. */
export function findDwells(cursor: CursorGrid): { start: number; end: number; x: number; y: number }[] {
  const out: { start: number; end: number; x: number; y: number }[] = []
  const n = cursor.t.length
  let i = 0
  while (i < n) {
    const ax = cursor.x[i]!
    const ay = cursor.y[i]!
    let j = i
    let sx = 0
    let sy = 0
    while (j < n && Math.hypot(cursor.x[j]! - ax, cursor.y[j]! - ay) <= DWELL_RADIUS) {
      sx += cursor.x[j]!
      sy += cursor.y[j]!
      j++
    }
    const count = j - i
    const start = cursor.t[i]!
    const len = (count - 1) * GRID_STEP_MS
    // ignora o cursor estacionado desde o primeiro instante da gravação
    if (len >= DWELL_MIN_MS && start >= 300) {
      out.push({ start, end: start + Math.min(len, DWELL_MAX_MS), x: sx / count, y: sy / count })
    }
    i = Math.max(j, i + 1)
  }
  return out
}

function mergeWindows(wins: Win[], gap: number): Win[] {
  const sorted = [...wins].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Win[] = []
  for (const w of sorted) {
    const last = out[out.length - 1]
    if (last && w.start - last.end < gap) {
      last.end = Math.max(last.end, w.end)
      // com cliques no grupo o foco segue o cursor; senão fica o ponto do primeiro
      if (w.click && !last.click) {
        last.focus = 'auto'
        last.click = true
      } else if (last.click) {
        last.focus = 'auto'
      }
    } else {
      out.push({ ...w })
    }
  }
  return out
}

/**
 * Cliques (e rajadas de digitação) → segmentos de zoom em TEMPO DE ORIGEM.
 *
 * 1. cada clique dentro da área abre `[t − lead, t + hold]`;
 * 2. cada rajada de digitação abre `[primeira tecla − lead, última tecla + hold]` no ponto do
 *    último clique antes dela (sem clique antes, onde o cursor estava);
 * 3. janelas separadas por menos que `mergeGap` se fundem e o foco passa a seguir o cursor
 *    dentro do segmento (isto já faz o "pan sem sair do zoom" quando a próxima começa a < 1 s);
 * 4. zooms separados por menos que `minGap` também viram um só;
 * 5. SEM nenhum clique na gravação, cai no "dwell": cursor parado 450-2600 ms.
 * Rolagem não abre zoom (a gravação nem registra a roda do mouse).
 */
export function generateAutoZooms(input: AutoZoomInput): Zoom[] {
  const preset = typeof input.preset === 'string' ? ZOOM_PRESETS[input.preset] : input.preset
  const { duration } = input
  if (!(duration > 0)) return []

  const clicks = input.clicks.filter((c) => !c.out && Number.isFinite(c.t) && c.t >= 0).sort((a, b) => a.t - b.t)
  const wins: Win[] = []

  for (const c of clicks) wins.push({ start: c.t - preset.lead, end: c.t + preset.hold, focus: 'auto', click: true })

  for (const burst of findTypingBursts(input.keys)) {
    let anchor: { x: number; y: number } | null = null
    for (const c of clicks) {
      if (c.t <= burst.first) anchor = { x: c.x, y: c.y }
      else break
    }
    const focus = anchor ?? sampleGrid(input.cursor, burst.first)
    wins.push({ start: burst.first - preset.lead, end: burst.last + preset.hold, focus: { x: focus.x, y: focus.y }, click: false })
  }

  if (clicks.length === 0) {
    for (const d of findDwells(input.cursor)) {
      wins.push({
        start: d.start - preset.lead * 0.5,
        end: d.end + preset.hold * 0.25,
        focus: { x: d.x, y: d.y },
        click: false
      })
    }
  }

  let merged = mergeWindows(wins, preset.mergeGap)
  merged = mergeWindows(merged, preset.minGap)

  const zooms: Zoom[] = []
  for (const w of merged) {
    const start = Math.max(0, w.start)
    const end = Math.min(duration, w.end)
    if (end - start < MIN_ZOOM_MS) continue
    zooms.push({
      id: `zoom-auto-${zooms.length + 1}`,
      start: Math.round(start),
      end: Math.round(end),
      scale: preset.scale,
      focus: w.focus,
      origin: 'auto'
    })
  }
  return zooms
}

/** Troca os zooms automáticos pelos de `preset`, mantendo os manuais. */
export function mergeAutoZooms(existing: readonly Zoom[], auto: readonly Zoom[]): Zoom[] {
  return [...existing.filter((z) => z.origin === 'manual'), ...auto].sort((a, b) => a.start - b.start)
}

// ---------------------------------------------------------------------------
// Caminho da câmera

export type CameraPath = {
  hz: number
  /** ms: `t[i] = i · 1000/60`. */
  t: number[]
  scale: number[]
  /** Centro da área visível, normalizado 0..1 (já dentro dos limites da fonte). */
  cx: number[]
  cy: number[]
  /** Maior escala pedida por algum segmento (o teto do caminho). */
  maxScale: number
}

export type CameraPathOptions = {
  /** Duração do caminho (ms). */
  durationMs: number
  /**
   * Fração da fonte que é visível com escala 1 (largura × altura, normalizadas). Padrão 1×1
   * (recorte da mesma proporção da fonte). O vertical 9:16 sobre tela 16:9 tem `w < 1`.
   */
  view?: { w: number; h: number }
  /** Largura/altura da fonte, para medir "varrida" em larguras de tela (padrão 16/9). */
  sourceAspect?: number
  spring?: SpringParams
  lookaheadMs?: number
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * O caminho da câmera a 60 Hz para a duração inteira. Determinístico: depende só dos zooms,
 * da grade do cursor e das opções.
 *
 *  - alvo de escala = escala do segmento ativo (1 fora de segmento);
 *  - alvo de foco = cursor + antecipação pela velocidade (~200 ms), com zona morta de
 *    50% × 70% da área visível (a câmera só anda quando o cursor sai dela); zoom com foco
 *    manual usa o ponto fixo;
 *  - anti-enjoo: varredura de mais de 35% da largura em 0,4 s → alvo de escala 1 enquanto durar;
 *  - mola da câmera integrada analiticamente a passos de 1/60 s, com a velocidade carregada;
 *  - o retângulo visível sempre cabe na fonte (centro limitado) e a escala fica em [1, máx].
 */
export function computeCameraPath(
  project: Pick<Project, 'zooms'>,
  cursor: CursorGrid,
  opts: CameraPathOptions
): CameraPath {
  const spring = opts.spring ?? CAMERA_SPRING
  const view = opts.view ?? { w: 1, h: 1 }
  const aspect = opts.sourceAspect && opts.sourceAspect > 0 ? opts.sourceAspect : 16 / 9
  const lookahead = opts.lookaheadMs ?? LOOKAHEAD_MS
  const dt = 1 / GRID_HZ
  const n = Math.floor(Math.max(0, opts.durationMs) / GRID_STEP_MS + 1e-9) + 1

  const zooms = project.zooms
    .filter((z) => Number.isFinite(z.start) && Number.isFinite(z.end) && z.end > z.start && z.scale > 1)
    .map((z) => ({ ...z, scale: Math.min(MAX_ZOOM_SCALE, z.scale) }))
    .sort((a, b) => a.start - b.start)
  const maxScale = zooms.reduce((m, z) => Math.max(m, z.scale), 1)

  const t: number[] = new Array<number>(n)
  const scaleOut: number[] = new Array<number>(n)
  const cxOut: number[] = new Array<number>(n)
  const cyOut: number[] = new Array<number>(n)

  // Recorte MENOR que a fonte já na escala 1 (o 9:16 sobre uma tela 16:9, uma faixa de uma tela larga): o enquadramento base
  // NÃO é a fonte inteira, então a câmera precisa seguir o cursor o tempo todo, com ou sem segmento de zoom aberto.
  const follows = view.w < 0.999 || view.h < 0.999

  let sScale = { x: 1, v: 0 }
  let sCx = { x: 0.5, v: 0 }
  let sCy = { x: 0.5, v: 0 }
  let tcx = 0.5
  let tcy = 0.5
  let activeId: string | null = null
  let wasSweeping = false

  for (let i = 0; i < n; i++) {
    const tMs = i * GRID_STEP_MS
    t[i] = tMs

    // segmento ativo: o que começou por último entre os que cobrem o instante
    let active: (typeof zooms)[number] | null = null
    for (let k = 0; k < zooms.length; k++) {
      const z = zooms[k]!
      if (z.start > tMs) break
      if (tMs < z.end) active = z
    }

    // Sem segmento, o recorte base que segue o cursor faz de conta que há um (escala 1, foco no cursor).
    const base = active === null && follows
    const eff = base ? BASE_FOLLOW : active

    let targetScale = 1
    let sweeping = false
    if (eff) {
      targetScale = eff.scale
      if (eff.focus === 'auto' && active && isSweeping(cursor, tMs, aspect)) {
        sweeping = true
        targetScale = 1
      }
    }

    if (eff && !sweeping) {
      const viewW = view.w / eff.scale
      const viewH = view.h / eff.scale
      if (eff.focus !== 'auto') {
        tcx = eff.focus.x
        tcy = eff.focus.y
      } else {
        const fp = focusPoint(cursor, tMs, lookahead)
        // Num recorte que segue sempre, começar um segmento NÃO reposiciona o alvo (a câmera já está no cursor).
        if ((eff.id !== activeId && !follows) || wasSweeping || i === 0) {
          tcx = fp.x
          tcy = fp.y
        } else {
          const hx = DEAD_ZONE.w * viewW * 0.5
          const hy = DEAD_ZONE.h * viewH * 0.5
          const dx = fp.x - tcx
          const dy = fp.y - tcy
          if (dx > hx) tcx = fp.x - hx
          else if (dx < -hx) tcx = fp.x + hx
          if (dy > hy) tcy = fp.y - hy
          else if (dy < -hy) tcy = fp.y + hy
        }
      }
      tcx = clamp(tcx, viewW / 2, 1 - viewW / 2)
      tcy = clamp(tcy, viewH / 2, 1 - viewH / 2)
    } else if (!eff) {
      // fora de segmento: volta para o centro enquanto a escala volta a 1
      tcx = 0.5
      tcy = 0.5
    }
    activeId = eff ? eff.id : null
    wasSweeping = sweeping

    if (i === 0 && follows) {
      // o vídeo começa JÁ enquadrado no cursor (senão a câmera sairia do centro varrendo a tela no primeiro segundo)
      sCx = { x: tcx, v: 0 }
      sCy = { x: tcy, v: 0 }
    } else if (i > 0) {
      sScale = springStep(sScale.x, sScale.v, targetScale, spring, dt)
      sCx = springStep(sCx.x, sCx.v, tcx, spring, dt)
      sCy = springStep(sCy.x, sCy.v, tcy, spring, dt)
    }

    const scale = clamp(sScale.x, 1, maxScale)
    const w = view.w / scale
    const h = view.h / scale
    scaleOut[i] = scale
    cxOut[i] = clamp(sCx.x, w / 2, 1 - w / 2)
    cyOut[i] = clamp(sCy.x, h / 2, 1 - h / 2)
  }

  return { hz: GRID_HZ, t, scale: scaleOut, cx: cxOut, cy: cyOut, maxScale }
}

/** O "segmento" implícito do recorte que segue sempre: escala 1, foco no cursor. */
const BASE_FOLLOW = { id: '__base__', scale: 1, focus: 'auto' as const }

/** Cursor + antecipação pela velocidade (diferença central de ±40 ms). */
function focusPoint(cursor: CursorGrid, tMs: number, lookaheadMs: number): { x: number; y: number } {
  const p = sampleGrid(cursor, tMs)
  const a = sampleGrid(cursor, tMs - 40)
  const b = sampleGrid(cursor, tMs + 40)
  const vx = (b.x - a.x) / 0.08
  const vy = (b.y - a.y) / 0.08
  const ax = clamp((vx * lookaheadMs) / 1000, -LOOKAHEAD_MAX, LOOKAHEAD_MAX)
  const ay = clamp((vy * lookaheadMs) / 1000, -LOOKAHEAD_MAX, LOOKAHEAD_MAX)
  return { x: clamp(p.x + ax, 0, 1), y: clamp(p.y + ay, 0, 1) }
}

/**
 * Varredura: o cursor atravessa mais de 35% da largura da fonte dentro de 0,4 s. Janela
 * CENTRADA no instante (±0,2 s): como o vídeo já está gravado, a câmera começa a sair do zoom
 * quando a varredura começa, não quando ela já acabou.
 */
export function isSweeping(cursor: CursorGrid, tMs: number, sourceAspect = 16 / 9): boolean {
  const half = SWEEP_WINDOW_MS / 2
  const a = sampleGrid(cursor, tMs - half)
  const b = sampleGrid(cursor, tMs + half)
  return Math.hypot(b.x - a.x, (b.y - a.y) / sourceAspect) > SWEEP_DISTANCE
}

/** Amostra do caminho em `tMs` (interpolação linear entre as amostras de 60 Hz). */
export function sampleCameraPath(path: CameraPath, tMs: number): { scale: number; cx: number; cy: number } {
  const n = path.t.length
  if (n === 0) return { scale: 1, cx: 0.5, cy: 0.5 }
  const f = tMs / GRID_STEP_MS
  if (!(f > 0)) return { scale: path.scale[0]!, cx: path.cx[0]!, cy: path.cy[0]! }
  if (f >= n - 1) return { scale: path.scale[n - 1]!, cx: path.cx[n - 1]!, cy: path.cy[n - 1]! }
  const i = Math.floor(f)
  const u = f - i
  const lerp = (arr: number[]): number => arr[i]! + (arr[i + 1]! - arr[i]!) * u
  return { scale: lerp(path.scale), cx: lerp(path.cx), cy: lerp(path.cy) }
}

/** Retângulo visível (normalizado, na fonte) para uma amostra da câmera. */
export function visibleRect(sample: { scale: number; cx: number; cy: number }, view = { w: 1, h: 1 }): Rect {
  const w = view.w / sample.scale
  const h = view.h / sample.scale
  return { x: sample.cx - w / 2, y: sample.cy - h / 2, w, h }
}
