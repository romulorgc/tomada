/**
 * ROSTO E ENQUADRAMENTO DA CÂMERA (M4c). A webcam é 16:9, mas o quadro da câmera quase nunca é: a bolha é redonda, o lado a lado
 * é em pé ou quadrado, o V-B é largo e baixo. Cada um recorta a imagem, e um recorte no CENTRO corta a cabeça de quem não está
 * sentado no meio. Por isso o rosto é detectado UMA vez por gravação (em segundo plano, `media/camera-face.json`) e o recorte
 * acompanha o rosto, devagar e sem tremer.
 *
 * Tudo aqui é PURO e determinístico (sem DOM, sem Node):
 *  - `parseFaceTrack`: lê e valida o arquivo da análise;
 *  - `buildFaceFramer`: das detecções (mediana + preenchimento de buracos) ao CAMINHO do centro do rosto no tempo de ORIGEM, com
 *    zona morta (só anda quando o rosto sai dela) e mola crítica (assenta em ~0,9 s): a pessoa mexer a cabeça não balança a imagem;
 *  - `cameraCropRect`: o recorte normalizado da imagem da câmera para um quadro de uma proporção, com o enquadramento automático e
 *    o ajuste manual (aproximação e deslocamento) por cima.
 *
 * Tempos em ms. `FaceBox.t` é o tempo do ARQUIVO da câmera; o tempo de origem é `t + sync.cameraOffsetMs`.
 */
import { z } from 'zod'
import { CAMERA_SPRING, springWithRiseTime, step, type SpringParams } from './spring'
import { coverCrop } from './styles'
import type { CameraFraming, Rect, Size } from './types'

/** Onde a análise mora na pasta do projeto. */
export const FACE_FILE = 'media/camera-face.json'
export const FACE_TRACK_VERSION = 1

/** Um rosto num instante: caixa normalizada 0..1 na imagem da câmera, e a confiança do detector. */
export type FaceBox = { t: number; x: number; y: number; w: number; h: number; score: number }

export type FaceTrack = {
  version: number
  /** Detector que achou os rostos ("yunet", "teste"). */
  engine: string
  /** Tamanho da imagem da câmera, em px. */
  frame: Size
  /** De quanto em quanto tempo o detector olhou (ms). */
  sampleMs: number
  durationMs: number
  /** Só os instantes em que havia rosto; em ordem de tempo. */
  boxes: FaceBox[]
  createdAt: string
}

export class FaceFormatError extends Error {
  override readonly name = 'FaceFormatError'
}

const num = z.number().refine((n) => Number.isFinite(n), 'número inválido')
const boxSchema = z.looseObject({ t: num, x: num, y: num, w: num, h: num, score: num.default(1) })
const trackSchema = z.looseObject({
  version: z.number().int().min(1),
  engine: z.string().default(''),
  frame: z.looseObject({ w: num, h: num }),
  sampleMs: num.default(200),
  durationMs: num.default(0),
  boxes: z.array(boxSchema).max(600_000),
  createdAt: z.string().default('')
})

/** Texto do `camera-face.json` → análise validada e em ordem. Lança `FaceFormatError` com o motivo se não der. */
export function parseFaceTrack(text: string): FaceTrack {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new FaceFormatError(`O camera-face.json não é um JSON válido: ${(err as Error).message}`)
  }
  const parsed = trackSchema.safeParse(raw)
  if (!parsed.success) {
    const why = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('; ')
    throw new FaceFormatError(`camera-face.json inválido: ${why}`)
  }
  const d = parsed.data
  const boxes = d.boxes
    .filter((b) => b.w > 0 && b.h > 0 && b.w <= 1.5 && b.h <= 1.5)
    .map((b): FaceBox => ({ t: b.t, x: b.x, y: b.y, w: b.w, h: b.h, score: b.score }))
    .sort((a, b) => a.t - b.t)
  return { version: d.version, engine: d.engine, frame: { w: d.frame.w, h: d.frame.h }, sampleMs: d.sampleMs, durationMs: d.durationMs, boxes, createdAt: d.createdAt }
}

/** Quanto da gravação tem rosto (0..1): rostos achados sobre os olhares do detector. */
export function faceCoverage(track: FaceTrack): number {
  const looks = track.sampleMs > 0 ? Math.max(1, Math.round(track.durationMs / track.sampleMs)) : track.boxes.length
  return Math.min(1, track.boxes.length / looks)
}

// ---------------------------------------------------------------------------
// O caminho do rosto

/** Taxa da grade do caminho (basta: o rosto anda devagar). */
export const FACE_GRID_HZ = 30
const GRID_STEP_MS = 1000 / FACE_GRID_HZ
/** A mediana de N detecções em volta tira o quadro em que o detector errou. */
export const FACE_MEDIAN_WINDOW = 5
/** Buraco de detecção até este tamanho (ms) se preenche ligando os dois lados; maior que isso o enquadramento FICA onde estava. */
export const FACE_GAP_MS = 2500
/** Zona morta (fração da imagem da câmera): o recorte só anda quando o rosto sai dela. */
export const FACE_DEADZONE = { x: 0.03, y: 0.04 } as const
/** O centro assenta em 95% do caminho em tanto tempo (mola crítica, a mesma forma da câmera do zoom). */
export const FACE_SETTLE_MS = 900
/** A mola do centro: a da câmera do zoom, mas CRÍTICA (ζ = 1): sem passar do ponto e voltar, que numa imagem calma parece balanço. */
const FACE_SPRING: SpringParams = { ...CAMERA_SPRING, c: 2 * Math.sqrt(CAMERA_SPRING.k * CAMERA_SPRING.m) }
/** Altura do rosto no quadro da câmera (fração da altura do quadro): é o que o enquadramento automático persegue. */
export const FACE_TARGET_H = 0.4
/** Mas o rosto nunca passa desta fração da largura do quadro. */
export const FACE_MAX_W_SHARE = 0.55
/** Aproximação automática máxima (não vale de nada aproximar tanto que a imagem vire pixel). */
export const FACE_MAX_AUTO_ZOOM = 1.6
/** Onde o centro do rosto fica na altura do quadro quando há folga vertical: um pouco acima do meio, com espaço para o corpo. */
export const FACE_HEADROOM_Y = 0.42
export const MANUAL_ZOOM = { min: 1, max: 3 } as const
export const MANUAL_OFFSET_MAX = 0.5

export type FaceFramer = {
  /** Amostras por segundo da grade. */
  hz: number
  /** Centro do rosto no TEMPO DE ORIGEM (índice i = i · 1000/hz ms), já suavizado. Normalizado 0..1 na imagem da câmera. */
  cx: number[]
  cy: number[]
  /** Tamanho típico (mediana) do rosto, normalizado: de onde sai a aproximação automática. */
  faceW: number
  faceH: number
  /** Quantas detecções entraram. */
  detections: number
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

type Center = { t: number; cx: number; cy: number; w: number; h: number }

/** Centro e tamanho de cada detecção, com a mediana de uma janela de N em volta (o detector erra um quadro de vez em quando). */
function medianCenters(boxes: readonly FaceBox[]): Center[] {
  const raw = boxes.map((b) => ({ t: b.t, cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h }))
  const half = FACE_MEDIAN_WINDOW >> 1
  return raw.map((c, i) => {
    const win = raw.slice(Math.max(0, i - half), Math.min(raw.length, i + half + 1))
    return { t: c.t, cx: median(win.map((r) => r.cx)), cy: median(win.map((r) => r.cy)), w: median(win.map((r) => r.w)), h: median(win.map((r) => r.h)) }
  })
}

/**
 * O caminho do centro do rosto no tempo de ORIGEM, de 0 a `durationMs`. `cameraOffsetMs` leva o tempo do arquivo da câmera ao
 * relógio da gravação. Sem rosto nenhum devolve `null` (o chamador usa o recorte do centro).
 */
export function buildFaceFramer(track: FaceTrack | null | undefined, cameraOffsetMs: number, durationMs: number): FaceFramer | null {
  if (!track || track.boxes.length === 0 || !(durationMs > 0)) return null
  const centers = medianCenters(track.boxes)
  const n = Math.floor(durationMs / GRID_STEP_MS + 1e-9) + 1
  const sx = springWithRiseTime(FACE_SPRING, FACE_SETTLE_MS)

  const cx = new Array<number>(n)
  const cy = new Array<number>(n)
  let k = 0
  let trackedX = 0
  let trackedY = 0
  let sX = { x: 0, v: 0 }
  let sY = { x: 0, v: 0 }
  const dt = 1 / FACE_GRID_HZ
  for (let i = 0; i < n; i++) {
    const ft = i * GRID_STEP_MS - cameraOffsetMs // tempo no arquivo da câmera
    while (k + 1 < centers.length && centers[k + 1]!.t <= ft) k++
    const a = centers[k]!
    const b = centers[k + 1]
    let tx = a.cx
    let ty = a.cy
    if (ft > a.t && b && b.t - a.t <= FACE_GAP_MS) {
      const u = (ft - a.t) / (b.t - a.t)
      tx = a.cx + (b.cx - a.cx) * u
      ty = a.cy + (b.cy - a.cy) * u
    } else if (ft < a.t) {
      // antes da primeira detecção: espera onde o primeiro rosto apareceu
      tx = a.cx
      ty = a.cy
    }
    if (i === 0) {
      trackedX = tx
      trackedY = ty
      sX = { x: tx, v: 0 }
      sY = { x: ty, v: 0 }
    } else {
      // zona morta: o centro "seguido" só anda quando o rosto sai dela
      if (tx - trackedX > FACE_DEADZONE.x) trackedX = tx - FACE_DEADZONE.x
      else if (trackedX - tx > FACE_DEADZONE.x) trackedX = tx + FACE_DEADZONE.x
      if (ty - trackedY > FACE_DEADZONE.y) trackedY = ty - FACE_DEADZONE.y
      else if (trackedY - ty > FACE_DEADZONE.y) trackedY = ty + FACE_DEADZONE.y
      sX = step(sX.x, sX.v, trackedX, sx, dt)
      sY = step(sY.x, sY.v, trackedY, sx, dt)
    }
    cx[i] = clamp(sX.x, 0, 1)
    cy[i] = clamp(sY.x, 0, 1)
  }
  return { hz: FACE_GRID_HZ, cx, cy, faceW: median(centers.map((c) => c.w)), faceH: median(centers.map((c) => c.h)), detections: centers.length }
}

/** O alvo do enquadramento num instante de origem: centro do rosto (interpolado) e o tamanho típico dele. */
export type FaceAim = { cx: number; cy: number; faceW: number; faceH: number }

export function faceAimAt(framer: FaceFramer, tMs: number): FaceAim {
  const n = framer.cx.length
  const f = tMs / GRID_STEP_MS
  let cx: number
  let cy: number
  if (!(f > 0)) {
    cx = framer.cx[0]!
    cy = framer.cy[0]!
  } else if (f >= n - 1) {
    cx = framer.cx[n - 1]!
    cy = framer.cy[n - 1]!
  } else {
    const i = Math.floor(f)
    const u = f - i
    cx = framer.cx[i]! + (framer.cx[i + 1]! - framer.cx[i]!) * u
    cy = framer.cy[i]! + (framer.cy[i + 1]! - framer.cy[i]!) * u
  }
  return { cx, cy, faceW: framer.faceW, faceH: framer.faceH }
}

// ---------------------------------------------------------------------------
// O recorte

/** O enquadramento com os padrões aplicados (e os valores presos às faixas aceitas). */
export function resolveFraming(framing: CameraFraming | undefined): { auto: boolean; zoom: number; dx: number; dy: number } {
  return {
    auto: framing?.auto !== false,
    zoom: clamp(Number.isFinite(framing?.zoom) ? framing!.zoom! : 1, MANUAL_ZOOM.min, MANUAL_ZOOM.max),
    dx: clamp(Number.isFinite(framing?.dx) ? framing!.dx! : 0, -MANUAL_OFFSET_MAX, MANUAL_OFFSET_MAX),
    dy: clamp(Number.isFinite(framing?.dy) ? framing!.dy! : 0, -MANUAL_OFFSET_MAX, MANUAL_OFFSET_MAX)
  }
}

/** A aproximação automática: o rosto na altura de `FACE_TARGET_H` do quadro, sem passar de `FACE_MAX_W_SHARE` da largura. */
export function autoZoomFor(aim: Pick<FaceAim, 'faceW' | 'faceH'>, base: Pick<Rect, 'w' | 'h'>): number {
  const byHeight = aim.faceH > 0 ? (FACE_TARGET_H * base.h) / aim.faceH : 1
  const byWidth = aim.faceW > 0 ? (FACE_MAX_W_SHARE * base.w) / aim.faceW : 1
  return clamp(Math.min(byHeight, byWidth), 1, FACE_MAX_AUTO_ZOOM)
}

/**
 * O recorte (normalizado 0..1 na imagem da câmera) para um quadro de proporção `destAspect` (largura/altura).
 *
 *  - sem rosto (ou com `auto` desligado): o recorte "cobrir" do centro, como sempre foi;
 *  - com rosto: centra no rosto, com a aproximação que põe o rosto na altura certa do quadro e o centro do rosto um pouco acima
 *    do meio (`FACE_HEADROOM_Y`) quando o recorte tem folga vertical;
 *  - o ajuste manual (`zoom`, `dx`, `dy`) vem por cima; o recorte sempre cabe dentro da imagem.
 */
export function cameraCropRect(cam: Size, destAspect: number, aim: FaceAim | null, framing?: CameraFraming): Rect {
  const base = coverCrop(cam, destAspect)
  const f = resolveFraming(framing)
  const useAuto = aim !== null && f.auto
  const zoom = (useAuto ? autoZoomFor(aim, base) : 1) * f.zoom
  const w = base.w / zoom
  const h = base.h / zoom
  let cx = 0.5
  let cy = 0.5
  if (useAuto) {
    cx = aim.cx
    cy = aim.cy + (0.5 - FACE_HEADROOM_Y) * h
  }
  cx = clamp(cx + f.dx, w / 2, 1 - w / 2)
  cy = clamp(cy + f.dy, h / 2, 1 - h / 2)
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

/**
 * Arrastar dentro da câmera, na prévia, move a IMAGEM: o recorte anda ao contrário. `moveX`/`moveY` são o arraste em px do quadro
 * de saída, `dest` o tamanho do cartão da câmera em px, `crop` o recorte de agora e `mirror` se a câmera está espelhada. Devolve o novo
 * `dx`/`dy` do enquadramento.
 */
export function panFraming(
  framing: CameraFraming | undefined,
  moveX: number,
  moveY: number,
  dest: Size,
  crop: Pick<Rect, 'w' | 'h'>,
  mirror = false
): { dx: number; dy: number } {
  const f = resolveFraming(framing)
  // espelhada, a imagem aparece invertida na horizontal: arrastar para a direita leva o recorte para o outro lado
  const dx = f.dx - (dest.w > 0 ? ((mirror ? -moveX : moveX) / dest.w) * crop.w : 0)
  const dy = f.dy - (dest.h > 0 ? (moveY / dest.h) * crop.h : 0)
  return { dx: clamp(dx, -MANUAL_OFFSET_MAX, MANUAL_OFFSET_MAX), dy: clamp(dy, -MANUAL_OFFSET_MAX, MANUAL_OFFSET_MAX) }
}
