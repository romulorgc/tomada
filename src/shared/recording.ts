/**
 * Lógica PURA da gravação (M1b): preferências, relógio e pausas, área capturada,
 * conversão dos eventos brutos em `cursor/clicks/keys.jsonl`, escolha de codec.
 * Sem DOM, sem Node: 100% testável por unidade.
 *
 * ⏱ Todo tempo em MILISSEGUNDOS. Dois relógios aparecem aqui:
 *  - o do RENDERER (`performance.timeOrigin + performance.now()`): dele vêm `t0`, os
 *    `start` dos MediaRecorder e as pausas;
 *  - o do PROCESSO PRINCIPAL (mesma fórmula, no worker do rastreador): dele vêm as
 *    amostras de cursor/cliques/teclas.
 * `estimateClockOffset` mede a diferença entre os dois (ida e volta pela IPC).
 */
import { z } from 'zod'
import { videoScriptSchema, type VideoScript } from './script'
import { normalizePoint } from './geometry'
import { FULL_RECT, sanitizeRect } from './crop'
import { CAMERA_QUALITIES, DEFAULT_CAMERA_QUALITY, type CameraQuality } from './camera-quality'
import type { CameraStyleChoice, ClickEvent, ContentRectSample, CursorSample, KeyEvent, MouseButton, Rect, Size, WindowRectSample } from './types'

// ---------------------------------------------------------------------------
// Preferências e pedido de gravação

export type RecordMode = 'screen-camera' | 'screen' | 'camera'
export type FrameRate = 30 | 60

export type RecordPrefs = {
  mode: RecordMode
  /** Última fonte escolhida (`screen:…` / `window:…`). Janela pode não existir mais. */
  sourceId: string | null
  sourceName: string | null
  /** deviceId da câmera; null = sem câmera. */
  cameraId: string | null
  /** deviceId do microfone; null = sem microfone. */
  micId: string | null
  systemAudio: boolean
  fps: FrameRate
  /** Supressão de ruído do Chrome no microfone (padrão: ligada). */
  noiseSuppression: boolean
  /** Cancelamento de eco do Chrome no microfone (padrão: desligado). */
  echoCancellation: boolean
  /** Bolha da câmera sobre a tela durante a gravação (fora da captura). */
  showBubble: boolean
  /** Moldura-guia sobre a prévia da câmera (onde ficam a cabeça, o tronco e as mãos), para o layout Apresentador. Só na prévia: não vai para o vídeo. */
  framingGuide: boolean
  /** Qualidade da câmera (Ajustes): "Máxima" abre o 4K quando a luz deixa a câmera sustentar 30 qps; "Alta" fica no 1080p. */
  cameraQuality: CameraQuality
  /** Estilo da câmera (só com tela + câmera): quadro ao lado ou apresentador recortado. Lembra a última escolha; Ajustes mostra o mesmo padrão. */
  cameraStyle: CameraStyleChoice
  /** Já escolhemos câmera e microfone padrão na primeira abertura? (null ≠ "nunca escolheu") */
  setupDone: boolean
  /**
   * Pedir ao Chromium para NÃO desenhar o cursor do sistema (`cursor: 'never'`). Sem tela de
   * ajuste: o Electron 40 ignora o pedido (medido; ver README), e o que vale é o que a trilha
   * informa (`project.capture.cursorHidden`). Fica ligado para passar a valer sozinho quando
   * um Electron futuro honrar.
   */
  hideCursor: boolean
  retakeShortcut: string
  teleprompter: { mode: 'scroll' | 'topics'; speed: number }
}

export const DEFAULT_RECORD_PREFS: RecordPrefs = {
  mode: 'screen-camera',
  sourceId: null,
  sourceName: null,
  cameraId: null,
  micId: null,
  systemAudio: false,
  fps: 30,
  noiseSuppression: true,
  echoCancellation: false,
  showBubble: true,
  framingGuide: true,
  cameraStyle: 'side-by-side',
  cameraQuality: DEFAULT_CAMERA_QUALITY,
  setupDone: false,
  hideCursor: true,
  retakeShortcut: 'Ctrl+Alt+Z',
  teleprompter: { mode: 'scroll', speed: 35 }
}

export const retakeShortcutSchema = z.string().regex(/^(?:Ctrl\+Alt|Ctrl\+Shift|Alt\+Shift)\+[A-Z0-9]$/).refine((s) => !['Ctrl+Shift+R', 'Ctrl+Shift+P', 'Ctrl+Shift+Z'].includes(s))

const recordPrefsSchema = z.looseObject({
  mode: z.enum(['screen-camera', 'screen', 'camera']).catch(DEFAULT_RECORD_PREFS.mode),
  sourceId: z.string().nullable().catch(null),
  sourceName: z.string().nullable().catch(null),
  cameraId: z.string().nullable().catch(null),
  micId: z.string().nullable().catch(null),
  systemAudio: z.boolean().catch(DEFAULT_RECORD_PREFS.systemAudio),
  fps: z.union([z.literal(30), z.literal(60)]).catch(DEFAULT_RECORD_PREFS.fps),
  noiseSuppression: z.boolean().catch(DEFAULT_RECORD_PREFS.noiseSuppression),
  echoCancellation: z.boolean().catch(DEFAULT_RECORD_PREFS.echoCancellation),
  showBubble: z.boolean().catch(DEFAULT_RECORD_PREFS.showBubble),
  framingGuide: z.boolean().catch(DEFAULT_RECORD_PREFS.framingGuide),
  cameraStyle: z.enum(['side-by-side', 'presenter']).catch(DEFAULT_RECORD_PREFS.cameraStyle),
  cameraQuality: z.enum(CAMERA_QUALITIES as [CameraQuality, ...CameraQuality[]]).catch(DEFAULT_RECORD_PREFS.cameraQuality),
  setupDone: z.boolean().catch(DEFAULT_RECORD_PREFS.setupDone),
  hideCursor: z.boolean().catch(DEFAULT_RECORD_PREFS.hideCursor),
  retakeShortcut: retakeShortcutSchema.catch(DEFAULT_RECORD_PREFS.retakeShortcut),
  teleprompter: z.object({ mode: z.enum(['scroll', 'topics']), speed: z.number().min(10).max(120) }).catch(DEFAULT_RECORD_PREFS.teleprompter)
})

/** Qualquer coisa (inclusive lixo) → preferências válidas; campo ruim volta ao padrão. */
export function normalizeRecordPrefs(raw: unknown): RecordPrefs {
  const input = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const merged = { ...DEFAULT_RECORD_PREFS, ...(input as Record<string, unknown>) }
  const parsed = recordPrefsSchema.parse(merged)
  return {
    mode: parsed.mode,
    sourceId: parsed.sourceId,
    sourceName: parsed.sourceName,
    cameraId: parsed.cameraId,
    micId: parsed.micId,
    systemAudio: parsed.systemAudio,
    fps: parsed.fps,
    noiseSuppression: parsed.noiseSuppression,
    echoCancellation: parsed.echoCancellation,
    showBubble: parsed.showBubble,
    framingGuide: parsed.framingGuide,
    cameraStyle: parsed.cameraStyle,
    cameraQuality: parsed.cameraQuality,
    setupDone: parsed.setupDone,
    hideCursor: parsed.hideCursor,
    retakeShortcut: parsed.retakeShortcut,
    teleprompter: parsed.teleprompter
  }
}

/** O que a interface pede ao main para preparar uma gravação (já com o modo EFETIVO). */
export type RecordRequest = {
  mode: RecordMode
  /** Obrigatório quando há tela. */
  sourceId: string | null
  fps: FrameRate
  cameraId: string | null
  micId: string | null
  systemAudio: boolean
  showBubble: boolean
  /** Pede `cursor: 'never'` na captura (o Chromium pode ignorar; vale o que a trilha informar). */
  hideCursor: boolean
  /** Só com tela + câmera. Ausente = quadro ao lado. */
  cameraStyle?: CameraStyleChoice
  /** Qualidade da câmera; ausente = Máxima. */
  cameraQuality?: CameraQuality
  script?: VideoScript
  retakeShortcut?: string
}

/** Validação do pedido que atravessa a IPC (a interface é nossa, mas o contrato é verificado). */
export const recordRequestSchema = z.object({
  mode: z.enum(['screen-camera', 'screen', 'camera']),
  sourceId: z.string().min(1).max(200).nullable(),
  fps: z.union([z.literal(30), z.literal(60)]),
  cameraId: z.string().max(500).nullable(),
  micId: z.string().max(500).nullable(),
  systemAudio: z.boolean(),
  showBubble: z.boolean(),
  hideCursor: z.boolean(),
  cameraStyle: z.enum(['side-by-side', 'presenter']).optional(),
  cameraQuality: z.enum(CAMERA_QUALITIES as [CameraQuality, ...CameraQuality[]]).optional(),
  script: videoScriptSchema.optional(),
  retakeShortcut: retakeShortcutSchema.optional()
})

/**
 * Modo efetivo: "tela + câmera" sem câmera escolhida vira "só tela". Retorna `null`
 * quando o pedido não faz sentido ("só câmera" sem câmera).
 */
export function effectiveMode(prefs: Pick<RecordPrefs, 'mode' | 'cameraId'>): RecordMode | null {
  if (prefs.mode === 'camera') return prefs.cameraId ? 'camera' : null
  if (prefs.mode === 'screen-camera') return prefs.cameraId ? 'screen-camera' : 'screen'
  return 'screen'
}

export type RequestProblem = 'no-source' | 'no-camera' | 'nothing'

/** Pedido válido? Devolve o motivo (código) ou `null`. A interface traduz o código. */
export function validateRecordRequest(r: RecordRequest): RequestProblem | null {
  const hasScreen = r.mode !== 'camera'
  const hasCamera = r.mode !== 'screen'
  if (hasScreen && !r.sourceId) return 'no-source'
  if (hasCamera && !r.cameraId) return 'no-camera'
  if (!hasScreen && !hasCamera && !r.micId) return 'nothing'
  return null
}

// ---------------------------------------------------------------------------
// Pausas e relógio

/** Intervalo [start, end) em ms, em algum relógio absoluto. */
export type Interval = { start: number; end: number }

/** Ordena, descarta vazios e funde sobrepostos. */
export function normalizeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const i of sorted) {
    const last = out[out.length - 1]
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end)
    else out.push(i)
  }
  return out
}

/** Tempo total pausado ANTES do instante `abs` (pausa em andamento conta só até `abs`). */
export function pausedBefore(abs: number, pauses: Interval[]): number {
  let total = 0
  for (const p of pauses) {
    if (p.start >= abs) break
    total += Math.min(p.end, abs) - p.start
  }
  return total
}

/** `abs` cai dentro de uma pausa? */
export function isPaused(abs: number, pauses: Interval[]): boolean {
  return pauses.some((p) => abs >= p.start && abs < p.end)
}

/**
 * Instante absoluto → tempo da gravação (ms desde `t0`, sem contar o tempo pausado).
 * `null` se foi antes do `t0` ou DURANTE uma pausa (a mídia do MediaRecorder pula a
 * pausa, então o evento não tem onde cair).
 */
export function toRecordingTime(abs: number, t0: number, pauses: Interval[]): number | null {
  if (abs < t0 || isPaused(abs, pauses)) return null
  return abs - t0 - pausedBefore(abs, pauses)
}

/** Cronômetro da barra: tempo gravado até `now`, com a pausa em andamento (se houver) descontada. */
export function elapsedMs(now: number, t0: number, pauses: Interval[], openPauseStart: number | null = null): number {
  const closed = pausedBefore(Math.min(now, openPauseStart ?? now), pauses)
  const end = openPauseStart ?? now
  return Math.max(0, end - t0 - closed)
}

export type ClockPing = { sentAt: number; receivedAt: number; remoteNow: number }

/**
 * Diferença entre o relógio remoto e o local, medida por pings. Para cada ping o instante
 * remoto corresponde ao ponto médio da ida e volta; vale o ping de MENOR ida e volta (o
 * menos contaminado por fila). `offsetMs` = remoto − local.
 */
export function estimateClockOffset(pings: ClockPing[]): { offsetMs: number; rttMs: number } {
  let best: { offsetMs: number; rttMs: number } | null = null
  for (const p of pings) {
    const rtt = p.receivedAt - p.sentAt
    if (!(rtt >= 0)) continue
    const offset = p.remoteNow - (p.sentAt + p.receivedAt) / 2
    if (!best || rtt < best.rttMs) best = { offsetMs: offset, rttMs: rtt }
  }
  if (!best) throw new RangeError('estimateClockOffset: nenhum ping válido')
  return best
}

// ---------------------------------------------------------------------------
// Área capturada

export type MonitorRect = { rect: Rect; primary: boolean }

export type DisplayInfo = {
  /** Retângulo do display em pixels FÍSICOS, segundo o Electron (`screen.dipToScreenRect`). */
  rectPx: Rect
}

const rectDistance = (a: Rect, b: Rect): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.w - b.w) + Math.abs(a.h - b.h)

export type ScreenRectResolution = {
  rect: Rect
  source: 'win32' | 'electron'
  /** Diferença entre o que o Electron disse e o monitor do Win32 (0 = idêntico). */
  distance: number
  note?: string
}

/**
 * Retângulo FÍSICO de uma tela: o do monitor do Win32 que casa com o display do Electron
 * (mesmo tamanho e origem; DPI misto muda a origem em DIP, mas não em pixels físicos).
 * Sem monitor parecido, vale o do Electron, com aviso.
 */
export function resolveScreenRect(display: DisplayInfo, monitors: MonitorRect[]): ScreenRectResolution {
  let best: { m: MonitorRect; d: number } | null = null
  for (const m of monitors) {
    const d = rectDistance(m.rect, display.rectPx)
    if (!best || d < best.d) best = { m, d }
  }
  if (best && best.d === 0) return { rect: { ...best.m.rect }, source: 'win32', distance: 0 }
  if (best && best.d <= 8) {
    return {
      rect: { ...best.m.rect },
      source: 'win32',
      distance: best.d,
      note: `O Electron e o Win32 divergem em ${best.d} px; usei o retângulo do monitor (Win32).`
    }
  }
  return {
    rect: { ...display.rectPx },
    source: 'electron',
    distance: best?.d ?? Number.POSITIVE_INFINITY,
    note: best
      ? `Nenhum monitor do Win32 casa com o display (distância mínima ${best.d} px); usei o retângulo do Electron.`
      : 'O Win32 não listou monitores; usei o retângulo do Electron.'
  }
}

export type RectCandidate = { name: 'client' | 'frame' | 'monitor'; rect: Rect }

export type ChosenCapture = {
  /** Origem do candidato escolhido + tamanho do quadro REAL (quando conhecido). */
  rect: Rect
  source: RectCandidate['name']
  /** quadro − candidato, em px, quando diferem (a normalização usa o quadro real e o log registra). */
  sizeMismatch: { dw: number; dh: number } | null
}

const SIZE_TOLERANCE_PX = 2

/**
 * Qual retângulo do Win32 o quadro capturado realmente mostra? Para JANELA de outro
 * programa, o quadro é a moldura inteira (`DWMWA_EXTENDED_FRAME_BOUNDS`, com barra de
 * título; medido: 1134×792 = moldura, origem na moldura). Janelas do PRÓPRIO processo são
 * capturadas pelo compositor (só a área de cliente), mas o Tomada nunca grava as suas.
 * Mesmo assim casamos pelo TAMANHO do quadro em vez de supor: vale o primeiro candidato (na
 * ordem dada) com tamanho dentro de 2 px; senão o mais próximo. Com o quadro real conhecido,
 * o retângulo final usa a origem do candidato e o tamanho do quadro (a normalização usa o
 * quadro real; a diferença vai para o log).
 */
export function chooseCaptureRect(frame: Size | null, candidates: RectCandidate[]): ChosenCapture {
  if (candidates.length === 0) throw new RangeError('chooseCaptureRect: sem candidatos')
  const first = candidates[0]!
  if (!frame || !(frame.w > 0) || !(frame.h > 0)) {
    return { rect: { ...first.rect }, source: first.name, sizeMismatch: null }
  }
  const diff = (c: RectCandidate): { dw: number; dh: number } => ({ dw: frame.w - c.rect.w, dh: frame.h - c.rect.h })
  let pick = candidates.find((c) => {
    const d = diff(c)
    return Math.abs(d.dw) <= SIZE_TOLERANCE_PX && Math.abs(d.dh) <= SIZE_TOLERANCE_PX
  })
  if (!pick) {
    pick = candidates.reduce((a, b) => {
      const da = diff(a)
      const db = diff(b)
      return Math.abs(db.dw) + Math.abs(db.dh) < Math.abs(da.dw) + Math.abs(da.dh) ? b : a
    })
  }
  const d = diff(pick)
  return {
    rect: { x: pick.rect.x, y: pick.rect.y, w: frame.w, h: frame.h },
    source: pick.name,
    sizeMismatch: d.dw !== 0 || d.dh !== 0 ? d : null
  }
}

// ---------------------------------------------------------------------------
// Eventos brutos → arquivos do projeto

export type RawClick = { t: number; upT?: number; x: number; y: number; button: MouseButton }

/**
 * Retângulos da janela lidos pelo rastreador (relógio do main, pixels físicos). `content` (C1): a página do navegador Chromium
 * (coordenadas de tela); ausente = não medida (janela que não é navegador).
 */
export type RawWindowRect = { t: number; frame: Rect; client: Rect; content?: Rect | null }

/** Captura de TELA (C1): a página do navegador em primeiro plano num instante (`null` = nenhum navegador à frente). */
export type RawPage = { t: number; rect: Rect | null; exe?: string }

export type RawEvents = {
  /** Plano: [t, x, y, t, x, y, …] (px físicos). */
  cursor: number[]
  clicks: RawClick[]
  keys: number[]
  /** Só quando muda (primeiro elemento = estado inicial). Vazio para tela inteira. */
  windowRects: RawWindowRect[]
  /** Só em tela inteira (C1): a página do navegador que estava à frente, só quando muda. */
  pages?: RawPage[]
}

export type BuildEventsInput = {
  raw: RawEvents
  kind: 'screen' | 'window'
  /** Tela inteira: retângulo físico do monitor. */
  screenRect: Rect | null
  /** Tamanho real do quadro capturado (null = desconhecido). */
  frame: Size | null
  /** t0 no relógio do RENDERER. */
  t0: number
  /** Somar ao tempo do main para obter o do renderer (= −offset de `estimateClockOffset`). */
  mainToRenderer: number
  /** Pausas no relógio do RENDERER. */
  pauses: Interval[]
}

export type BuiltEvents = {
  cursor: CursorSample[]
  clicks: ClickEvent[]
  keys: KeyEvent[]
  /** Retângulo da janela ao longo da gravação, em tempo de gravação (vazio para tela). */
  windowRects: WindowRectSample[]
  /**
   * A página do navegador ao longo da gravação (C1), normalizada no QUADRO capturado, só quando muda. Vazio = não há navegador
   * medido (janela de outro programa; tela sem nenhum navegador Chromium à frente).
   */
  contentRects: ContentRectSample[]
  /** Quem foi medido: o navegador de uma janela, ou o que apareceu em primeiro plano numa gravação de tela. */
  contentExe: string | null
  /** Retângulo físico usado na normalização (origem + tamanho do quadro real). */
  boundsPx: Rect
  rectSource: RectCandidate['name']
  sizeMismatch: { dw: number; dh: number } | null
  stats: { cursor: number; clicks: number; keys: number; outsideCursor: number; /** Eventos que caíram antes do t0 ou dentro de uma pausa. */ droppedOutside: number }
}

const round1 = (n: number): number => Math.round(n * 10) / 10
const round5 = (n: number): number => Math.round(n * 1e5) / 1e5

/** Retângulo vigente em `t` (relógio do main): o último cuja marca é ≤ t (ou o primeiro). */
function rectAt<T extends { t: number }>(timeline: T[], t: number, hint: { i: number }): T {
  let i = hint.i
  while (i + 1 < timeline.length && timeline[i + 1]!.t <= t) i++
  while (i > 0 && timeline[i]!.t > t) i--
  hint.i = i
  return timeline[i]!
}

/**
 * Converte o que o rastreador viu em eventos do projeto: tempo da gravação (sem pausas),
 * coordenadas normalizadas 0..1 na área capturada, sem o que caiu dentro de pausas.
 * Ordena por tempo. Para janela, a área é a que o quadro mostra (ver `chooseCaptureRect`)
 * e acompanha a janela quando ela se mexe.
 */
/**
 * As amostras de um estado que só se registra quando MUDA (o retângulo da janela, a página do navegador), cada uma com o tempo da
 * gravação. Uma amostra que cai DENTRO de uma pausa (ou antes do t0) não tem onde cair no vídeo, mas o estado que ela mediu vale
 * quando a gravação volta (a retomada, ou o instante 0): o rastreador não repete uma medida que não mudou, então, se a janela mudou
 * durante a pausa (F11 → pausar → sair do F11 → retomar), não haverá outra amostra depois. Vale a ÚLTIMA amostra de cada trecho perdido.
 * `entry.t` no relógio do processo principal; `-Infinity` é "desde o começo".
 */
export function placeSamples<T extends { t: number }>(entries: readonly T[], t0: number, mainToRenderer: number, pauses: Interval[]): { t: number; entry: T }[] {
  const out: { t: number; entry: T }[] = []
  let lost: { entry: T; at: number } | null = null
  const flush = (): void => {
    if (lost) out.push({ t: lost.at, entry: lost.entry })
    lost = null
  }
  for (const entry of entries) {
    if (!Number.isFinite(entry.t)) {
      flush()
      out.push({ t: 0, entry })
      continue
    }
    const abs = entry.t + mainToRenderer
    const rec = toRecordingTime(abs, t0, pauses)
    if (rec === null) {
      const pause = pauses.find((p) => abs >= p.start && abs < p.end)
      const at = pause ? Math.max(0, pause.end - t0 - pausedBefore(pause.end, pauses)) : 0
      // cada trecho perdido (o de antes do t0, cada pausa) tem o seu estado: só a ÚLTIMA amostra DE CADA UM vale
      if (lost && lost.at !== at) flush()
      lost = { entry, at }
      continue
    }
    flush()
    out.push({ t: rec, entry })
  }
  flush()
  return out
}

export function buildEvents(input: BuildEventsInput): BuiltEvents {
  const { raw, kind, frame } = input
  const pauses = normalizeIntervals(input.pauses)
  const toT = (mainAbs: number): number | null => toRecordingTime(mainAbs + input.mainToRenderer, input.t0, pauses)

  // --- Área capturada ao longo do tempo
  let timeline: { t: number; rect: Rect }[]
  let boundsPx: Rect
  let rectSource: RectCandidate['name']
  let sizeMismatch: { dw: number; dh: number } | null = null
  if (kind === 'window' && raw.windowRects.length > 0) {
    const first = raw.windowRects[0]!
    const chosen = chooseCaptureRect(frame, [
      { name: 'frame', rect: first.frame },
      { name: 'client', rect: first.client }
    ])
    rectSource = chosen.source
    sizeMismatch = chosen.sizeMismatch
    const size = frame && frame.w > 0 && frame.h > 0 ? frame : { w: chosen.rect.w, h: chosen.rect.h }
    const firstSrc = chosen.source === 'client' ? first.client : first.frame
    // A janela pode ser redimensionada no meio da gravação: o quadro capturado acompanha (e o ffmpeg o estica ao tamanho do
    // primeiro), então a escala do quadro real sobre o primeiro retângulo vale para todos.
    const kx = firstSrc.w > 0 ? size.w / firstSrc.w : 1
    const ky = firstSrc.h > 0 ? size.h / firstSrc.h : 1
    timeline = raw.windowRects.map((r) => {
      const src = chosen.source === 'client' ? r.client : r.frame
      return { t: r.t, rect: { x: src.x, y: src.y, w: src.w * kx, h: src.h * ky } }
    })
    boundsPx = timeline[0]!.rect
  } else {
    const base = input.screenRect ?? { x: 0, y: 0, w: frame?.w ?? 1920, h: frame?.h ?? 1080 }
    const chosen = chooseCaptureRect(frame, [{ name: 'monitor', rect: base }])
    rectSource = 'monitor'
    sizeMismatch = chosen.sizeMismatch
    boundsPx = chosen.rect
    timeline = [{ t: Number.NEGATIVE_INFINITY, rect: boundsPx }]
  }

  // --- Cursor
  const cursor: CursorSample[] = []
  let outsideCursor = 0
  let dropped = 0
  const hintC = { i: 0 }
  for (let k = 0; k + 2 < raw.cursor.length; k += 3) {
    const t = toT(raw.cursor[k]!)
    if (t === null) {
      dropped++
      continue
    }
    const r = rectAt(timeline, raw.cursor[k]!, hintC).rect
    const n = normalizePoint({ x: raw.cursor[k + 1]!, y: raw.cursor[k + 2]! }, r)
    const sample: CursorSample = { t: round1(t), x: round5(n.x), y: round5(n.y) }
    if (n.outside) {
      sample.out = true
      outsideCursor++
    }
    cursor.push(sample)
  }

  // --- Cliques
  const clicks: ClickEvent[] = []
  const hintK = { i: 0 }
  const sortedClicks = [...raw.clicks].sort((a, b) => a.t - b.t)
  for (const c of sortedClicks) {
    const t = toT(c.t)
    if (t === null) {
      dropped++
      continue
    }
    const r = rectAt(timeline, c.t, hintK).rect
    const n = normalizePoint({ x: c.x, y: c.y }, r)
    const ev: ClickEvent = { t: round1(t), x: round5(n.x), y: round5(n.y), button: c.button }
    if (c.upT !== undefined) {
      // Soltar depois de uma pausa: o instante de subida é o da própria pausa que começou.
      const up = toRecordingTime(c.upT + input.mainToRenderer, input.t0, pauses)
      ev.upT = round1(up ?? t)
    }
    if (n.outside) ev.out = true
    clicks.push(ev)
  }

  // --- Teclas (só "houve")
  const keys: KeyEvent[] = []
  for (const kt of [...raw.keys].sort((a, b) => a - b)) {
    const t = toT(kt)
    if (t === null) {
      dropped++
      continue
    }
    keys.push({ t: round1(t) })
  }

  // --- Retângulos da janela, em tempo de gravação (só os que caem fora de pausa)
  const windowRects: WindowRectSample[] = []
  if (kind === 'window') {
    // O estado que vale no começo (marca antes do t0) e na retomada (marca dentro de uma pausa): ver `placeSamples`.
    for (const { t, entry } of placeSamples(timeline, input.t0, input.mainToRenderer, pauses)) {
      windowRects.push({ t: round1(t), x: entry.rect.x, y: entry.rect.y, w: entry.rect.w, h: entry.rect.h })
    }
  }

  // --- A página do navegador (C1), normalizada no quadro capturado
  const contentRects: ContentRectSample[] = []
  let contentExe: string | null = null
  const pushContent = (t: number, r: Rect | null): void => {
    const rect = r ? sanitizeRect(r) : FULL_RECT
    const n = rect ?? FULL_RECT
    const sample: ContentRectSample = { t: round1(t), x: round5(n.x), y: round5(n.y), w: round5(n.w), h: round5(n.h) }
    const last = contentRects[contentRects.length - 1]
    if (last && last.x === sample.x && last.y === sample.y && last.w === sample.w && last.h === sample.h) return
    contentRects.push(sample)
  }
  if (kind === 'window' && raw.windowRects.some((r) => r.content)) {
    const chosenSource = rectSource === 'client' ? 'client' : 'frame'
    const measured = raw.windowRects.filter((r) => r.content)
    for (const { t, entry: r } of placeSamples(measured, input.t0, input.mainToRenderer, pauses)) {
      const src = chosenSource === 'client' ? r.client : r.frame
      if (!(src.w > 0) || !(src.h > 0)) continue
      const c = r.content!
      pushContent(t, { x: (c.x - src.x) / src.w, y: (c.y - src.y) / src.h, w: c.w / src.w, h: c.h / src.h })
    }
  } else if (kind === 'screen' && raw.pages && raw.pages.some((p) => p.rect)) {
    const base = boundsPx
    for (const { t: tt, entry: p } of placeSamples(raw.pages, input.t0, input.mainToRenderer, pauses)) {
      if (p.exe && !contentExe) contentExe = p.exe
      if (!p.rect) {
        pushContent(tt, null)
        continue
      }
      // só a parte que cai neste monitor (a janela pode estar em outro)
      const x0 = Math.max(base.x, p.rect.x)
      const y0 = Math.max(base.y, p.rect.y)
      const x1 = Math.min(base.x + base.w, p.rect.x + p.rect.w)
      const y1 = Math.min(base.y + base.h, p.rect.y + p.rect.h)
      if (x1 - x0 < 16 || y1 - y0 < 16) pushContent(tt, null)
      else pushContent(tt, { x: (x0 - base.x) / base.w, y: (y0 - base.y) / base.h, w: (x1 - x0) / base.w, h: (y1 - y0) / base.h })
    }
  }

  return {
    cursor,
    clicks,
    keys,
    windowRects,
    contentRects,
    contentExe,
    boundsPx,
    rectSource,
    sizeMismatch,
    stats: { cursor: cursor.length, clicks: clicks.length, keys: keys.length, outsideCursor, droppedOutside: dropped }
  }
}

/** Uma linha por objeto (JSON Lines), com quebra de linha final; vazio = string vazia. */
export function toJsonLines(items: readonly unknown[]): string {
  return items.length === 0 ? '' : `${items.map((i) => JSON.stringify(i)).join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Codec e taxa de bits (medidos na M1b; ver README)

const SCREEN_VIDEO_ONLY = ['video/webm;codecs=h264', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
const VIDEO_WITH_AUDIO = [
  'video/webm;codecs=h264,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
]
const AUDIO_ONLY = ['audio/webm;codecs=opus', 'audio/webm']

/**
 * Preferência de formato do MediaRecorder: H.264 primeiro (medido: mesmo número de quadros
 * e mesma CPU que o VP9, com metade do tamanho de arquivo e taxa de bits que obedece ao
 * pedido), depois VP9, VP8. Quem chama passa o que o navegador aceita.
 */
export function recorderMimePreference(kind: { video: boolean; audio: boolean }): string[] {
  if (kind.video) return kind.audio ? VIDEO_WITH_AUDIO : SCREEN_VIDEO_ONLY
  return AUDIO_ONLY
}

export function pickRecorderMime(
  isSupported: (mime: string) => boolean,
  kind: { video: boolean; audio: boolean }
): string | null {
  return recorderMimePreference(kind).find((m) => isSupported(m)) ?? null
}

/** Taxa de bits da tela: ~0,13 bit por pixel por quadro (1080p60 ≈ 16 Mbps), entre 8 e 60 Mbps. */
export function screenBitrate(size: Size, fps: number): number {
  const raw = size.w * size.h * fps * 0.13
  return Math.round(Math.min(60_000_000, Math.max(8_000_000, raw)))
}

/** Câmera: 1080p30 ≈ 8 Mbps. */
export function cameraBitrate(size: Size, fps: number): number {
  const raw = size.w * size.h * fps * 0.13
  return Math.round(Math.min(16_000_000, Math.max(2_500_000, raw)))
}

// ---------------------------------------------------------------------------
// Nomes de pasta e título

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** "Gravação 15:00" (hora local). */
export function defaultRecordingTitle(date: Date): string {
  return `Gravação ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** "2026-10-04 1500 Gravação" (hora local). `title` já vem sem caracteres proibidos pelo Windows. */
export function recordingFolderName(date: Date, label = 'Gravação'): string {
  const clean = label.replace(/[\\/:*?"<>|\0]/g, ' ').replace(/\s+/g, ' ').trim() || 'Gravação'
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}${pad2(date.getMinutes())} ${clean}`
}

/** Acrescenta " (2)", " (3)"… até o nome ficar livre. */
export function uniqueName(base: string, exists: (name: string) => boolean): string {
  if (!exists(base)) return base
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base} (${n})`
    if (!exists(candidate)) return candidate
  }
  throw new Error(`Não achei nome livre para "${base}".`)
}

// ---------------------------------------------------------------------------
// Medidor de nível do microfone

/** Pico de um bloco de amostras de áudio de 8 bits (centro 128), 0..1. */
export function peakFromBytes(bytes: ArrayLike<number>): number {
  let peak = 0
  for (let i = 0; i < bytes.length; i++) {
    const v = Math.abs(bytes[i]! - 128)
    if (v > peak) peak = v
  }
  return Math.min(1, peak / 128)
}

/** Nível linear 0..1 → posição no medidor 0..1 (escala em dB: −60 dB = vazio, 0 dB = cheio). */
export function levelToMeter(level: number): number {
  if (!(level > 0)) return 0
  const db = 20 * Math.log10(level)
  return Math.min(1, Math.max(0, (db + 60) / 60))
}

/** Ataque instantâneo, queda suave (padrão de medidor): `dtMs` desde a última leitura. */
export function smoothMeter(previous: number, next: number, dtMs: number, releasePerSecond = 1.6): number {
  if (next >= previous) return next
  return Math.max(next, previous - (releasePerSecond * dtMs) / 1000)
}
