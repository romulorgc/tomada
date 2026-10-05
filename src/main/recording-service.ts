/**
 * Serviço de gravação do processo principal. A interface (renderer) dirige o
 * MediaRecorder; aqui ficam os arquivos em disco (cada pedaço é anexado na hora), o
 * rastreador do mouse, a barra flutuante, os atalhos, o manifesto e o processamento ao
 * parar. Tudo o que depende do Electron entra por interface (`SourceProvider`,
 * `RecordingWindows`), então o fluxo inteiro roda nos testes de integração.
 *
 * Máquina de estados:
 *   idle → preparing → countdown → recording ⇄ paused → stopping → idle (+ processamento)
 */
import { existsSync } from 'node:fs'
import { mkdir, open, rm, statfs, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BarAction,
  BarState,
  BubbleConfig,
  ChunkKind,
  CountdownConfig,
  IpcEvents,
  PrepareResult,
  ProcessSnapshot,
  RecordingStatusView,
  RecordStatus,
  SourceInfo,
  StartedInfo,
  StopInfo
} from '@shared/ipc'
import {
  elapsedMs,
  normalizeIntervals,
  recordingFolderName,
  defaultRecordingTitle,
  uniqueName,
  validateRecordRequest,
  type Interval,
  type RecordRequest
} from '@shared/recording'
import type { Rect, Size } from '@shared/types'
import type { Ffmpeg } from './ffmpeg'
import { pathExists } from './fs-utils'
import type { Logger } from './logger'
import {
  MANIFEST_PATH,
  RAW_CAMERA,
  RAW_MIC,
  RAW_SCREEN,
  writeManifest,
  type RecordingManifest
} from './manifest'
import { createProcessContext, runProcessing, type ProcessContext, type ProcessDeps } from './processing'
import type { Tracker, TrackerConfig, TrackerResult } from './tracker'

/** Uma fonte já resolvida: o que o rastreador e a captura precisam saber. */
export type ResolvedSource = {
  id: string
  kind: 'screen' | 'window'
  name: string
  hwnd: number | null
  /** Retângulo físico: do monitor (tela) ou da moldura da janela (janela). */
  rectPx: Rect
  nativeSize: Size
  scale: number
  /** Limites (em DIP) da tela onde mostrar a contagem, a barra e a bolha. */
  displayBoundsDip: Rect
}

export interface SourceProvider {
  list(): Promise<SourceInfo[]>
  resolve(sourceId: string): Promise<ResolvedSource>
  /** Arma o `setDisplayMediaRequestHandler` com a fonte e se leva o som do computador. */
  arm(sourceId: string, systemAudio: boolean): void
  disarm(): void
}

export interface RecordingWindows {
  setMainMinimized(minimized: boolean): void
  /** Contagem 3-2-1 sobre a tela; `false` se cancelada. */
  countdown(displayBoundsDip: Rect, config: CountdownConfig): Promise<boolean>
  showBar(state: BarState, displayBoundsDip: Rect | null): void
  updateBar(state: BarState): void
  barLevel(level: number): void
  hideBar(): void
  showBubble(config: BubbleConfig, displayBoundsDip: Rect | null): void
  hideBubble(): void
  /** Registra os atalhos globais; devolve o que conseguiu registrar. */
  registerHotkeys(handlers: { stop(): void; pause(): void }): { stop: string; pause: string; ok: boolean }
  unregisterHotkeys(): void
}

export type RecordingDeps = {
  logger: Logger
  /** Raiz atual dos projetos. */
  projectsRoot(): string
  ffmpeg(): Ffmpeg | null
  sources: SourceProvider
  windows: RecordingWindows
  createTracker(config: TrackerConfig): Tracker
  /** Empurra um evento para a janela principal. */
  emit<K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void
  /** Manda uma pasta para a Lixeira (em teste, apaga direto). */
  trash(path: string): Promise<void>
  /** Relógio do processo principal: `performance.timeOrigin + performance.now()`. */
  clock(): number
  now(): Date
  env: NodeJS.ProcessEnv
  /** Espaço livre mínimo para começar (bytes). */
  minFreeBytes?: number
}

export interface RecordingService {
  sources(): Promise<SourceInfo[]>
  prepare(request: RecordRequest): Promise<PrepareResult>
  countdown(): Promise<boolean>
  go(): Promise<void>
  started(info: StartedInfo): Promise<void>
  chunk(kind: ChunkKind, data: ArrayBuffer | Uint8Array): Promise<void>
  pause(at: number): Promise<void>
  resume(at: number): Promise<void>
  stop(info: StopInfo): Promise<{ sessionId: string }>
  abort(reason?: string): Promise<void>
  status(): RecordingStatusView
  /** Comando da barra ou do atalho → janela que grava. */
  command(action: BarAction, source: 'bar' | 'hotkey' | 'window'): void
  barState(): BarState | null
  countdownConfig(): CountdownConfig
  bubbleConfig(): BubbleConfig | null
  level(level: number): void
  retry(sessionId: string): Promise<void>
  /** Chamado ao fechar o app: encerra rastreador, arquivos e atalhos sem apagar nada. */
  shutdown(): Promise<void>
  /** Há gravação em andamento (gravando, pausada ou parando)? */
  readonly recording: boolean
}

type FileSlot = { handle: FileHandle; bytes: number; path: string }

type Session = {
  id: string
  dir: string
  folder: string
  request: RecordRequest
  source: ResolvedSource | null
  manifest: RecordingManifest
  files: Map<ChunkKind, FileSlot>
  tracker: Tracker | null
  trackerFailed: string | null
  trackerResult: TrackerResult | null
  pauses: Interval[]
  openPause: number | null
  writeError: string | null
  /** Quantos ms o renderer está à frente do main (renderer = main − offset). */
  offsetMs: number
  hadData: boolean
}

const COUNTDOWN_SECONDS = 3
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createRecordingService(deps: RecordingDeps): RecordingService {
  const { logger } = deps
  let status: RecordStatus = 'idle'
  let session: Session | null = null
  let processing: { ctx: ProcessContext; snapshot: ProcessSnapshot; running: boolean } | null = null
  let barSnapshot: BarState | null = null
  const minFree = deps.minFreeBytes ?? 1_000_000_000

  const silent = deps.env.TOMADA_TEST_SILENT === '1'
  /** Passos que já falharam por TOMADA_TEST_FAIL_STEP: o "tentar de novo" precisa passar. */
  const failedOnce = new Set<string>()

  const view = (): RecordingStatusView => ({
    status,
    sessionId: session?.id ?? processing?.ctx.manifest.sessionId ?? null,
    processing: processing?.snapshot ?? null
  })
  const setStatus = (next: RecordStatus): void => {
    status = next
    deps.emit('record:status', view())
  }

  const rendererNow = (s: Session): number => deps.clock() - s.offsetMs

  const makeBarState = (s: Session, kind: BarState['status']): BarState => {
    const clock = s.manifest.clock
    const elapsed = clock ? elapsedMs(rendererNow(s), clock.t0, normalizeIntervals(s.pauses), s.openPause) : 0
    return {
      status: kind,
      elapsedMs: elapsed,
      asOf: Date.now(),
      hasMic: Boolean(s.request.micId),
      hasCamera: s.request.mode !== 'screen' && Boolean(s.request.cameraId),
      shortcutStop: 'Ctrl+Shift+R',
      shortcutPause: 'Ctrl+Shift+P'
    }
  }

  const pushBar = (kind: BarState['status']): void => {
    if (!session) return
    barSnapshot = makeBarState(session, kind)
    deps.windows.updateBar(barSnapshot)
  }

  async function closeFiles(s: Session): Promise<void> {
    for (const slot of s.files.values()) {
      try {
        await slot.handle.sync().catch(() => undefined)
        await slot.handle.close()
      } catch (err) {
        logger.warn(`Não consegui fechar ${slot.path}`, err)
      }
    }
    s.files.clear()
  }

  async function stopTrackerQuietly(s: Session): Promise<TrackerResult | null> {
    if (!s.tracker) return null
    try {
      const r = await s.tracker.stop()
      s.trackerResult = r
      return r
    } catch (err) {
      logger.warn('Falha ao parar o rastreador.', err)
      return null
    } finally {
      s.tracker = null
    }
  }

  function leaveRecordingUi(): void {
    deps.windows.unregisterHotkeys()
    deps.windows.hideBar()
    deps.windows.hideBubble()
    barSnapshot = null
  }

  async function discardSession(s: Session): Promise<void> {
    await stopTrackerQuietly(s)
    await closeFiles(s)
    deps.sources.disarm()
    try {
      if (s.hadData) await deps.trash(s.dir)
      else await rm(s.dir, { recursive: true, force: true })
    } catch (err) {
      logger.warn(`Não consegui apagar a pasta da gravação descartada (${s.dir}).`, err)
    }
  }

  async function startProcessing(s: Session, rawEvents: TrackerResult['raw'] | null): Promise<void> {
    const ff = deps.ffmpeg()
    const ctx = createProcessContext({ dir: s.dir, manifest: s.manifest, rawEvents })
    processing = { ctx, snapshot: { sessionId: s.id, folder: s.folder, status: 'running', steps: [], notes: [] }, running: false }
    if (!ff) {
      const message = 'Não encontrei o ffmpeg. A gravação bruta está salva em raw/; escolha o ffmpeg nos Ajustes e clique em "Tentar de novo".'
      processing.snapshot = {
        sessionId: s.id,
        folder: s.folder,
        status: 'failed',
        steps: [],
        error: { step: 'save', message },
        notes: []
      }
      logger.error(message)
      deps.emit('process:progress', processing.snapshot)
      return
    }
    await runOnce(ff)
  }

  async function runOnce(ff: Ffmpeg): Promise<void> {
    const p = processing
    if (!p || p.running) return
    p.running = true
    const failStep = deps.env.TOMADA_TEST_FAIL_STEP?.trim()
    const processDeps: ProcessDeps = {
      ff,
      logger,
      onProgress: (snapshot) => {
        p.snapshot = snapshot
        deps.emit('process:progress', snapshot)
      },
      ...(failStep
        ? {
            beforeStep: (id) => {
              // TOMADA_TEST_FAIL_STEP=voice → falha só na primeira vez (prova o "tentar de novo")
              if (id === failStep && !failedOnce.has(id)) {
                failedOnce.add(id)
                throw new Error(`Falha simulada no passo "${id}" (TOMADA_TEST_FAIL_STEP).`)
              }
            }
          }
        : {}),
      ...(deps.env.TOMADA_TEST_STEP_DELAY_MS ? { stepDelayMs: Number(deps.env.TOMADA_TEST_STEP_DELAY_MS) } : {})
    }
    try {
      p.snapshot = await runProcessing(p.ctx, processDeps)
      p.ctx.rawEvents = p.snapshot.status === 'done' ? null : p.ctx.rawEvents
      deps.emit('process:progress', p.snapshot)
    } finally {
      p.running = false
    }
  }

  function command(action: BarAction, source: 'bar' | 'hotkey' | 'window'): void {
    if (!session) return
    deps.emit('record:command', { cmd: action, source })
  }

  return {
    get recording() {
      return status === 'recording' || status === 'paused' || status === 'stopping'
    },

    sources: () => deps.sources.list(),

    async prepare(request) {
      if (status !== 'idle') throw new Error('Já existe uma gravação em andamento.')
      if (processing?.running) throw new Error('Espere o processamento da gravação anterior terminar.')
      const problem = validateRecordRequest(request)
      if (problem === 'no-source') throw new Error('Escolha a tela ou a janela que vai gravar.')
      if (problem === 'no-camera') throw new Error('Escolha uma câmera.')
      if (problem === 'nothing') throw new Error('Escolha o que gravar: tela, câmera ou microfone.')
      if (!deps.ffmpeg()) throw new Error('Não encontrei o ffmpeg: sem ele o Tomada não consegue processar a gravação. Instale-o ou escolha a pasta nos Ajustes.')

      const root = deps.projectsRoot()
      await mkdir(root, { recursive: true })
      try {
        const fs = await statfs(root)
        const free = Number(fs.bavail) * Number(fs.bsize)
        if (free < minFree) {
          throw new Error(`Pouco espaço livre em disco (${(free / 1e9).toFixed(1)} GB) na pasta dos projetos. Libere ao menos ${(minFree / 1e9).toFixed(0)} GB para gravar.`)
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Pouco espaço')) throw err
        logger.warn('Não consegui medir o espaço livre em disco.', err)
      }

      setStatus('preparing')
      try {
        let source: ResolvedSource | null = null
        if (request.mode !== 'camera') {
          source = await deps.sources.resolve(request.sourceId!)
          deps.sources.arm(source.id, request.systemAudio)
        }
        const date = deps.now()
        const folder = uniqueName(recordingFolderName(date), (n) => existsSync(join(root, n)))
        const dir = join(root, folder)
        await mkdir(join(dir, 'raw'), { recursive: true })

        const sessionId = globalThis.crypto.randomUUID()
        const hasVideo = request.mode !== 'screen' && Boolean(request.cameraId)
        const hasMic = Boolean(request.micId)
        const manifest: RecordingManifest = {
          version: 1,
          sessionId,
          folder,
          title: defaultRecordingTitle(date),
          createdAt: date.toISOString(),
          mode: request.mode,
          fps: request.fps,
          screen: source
            ? {
                file: RAW_SCREEN,
                kind: source.kind,
                sourceId: source.id,
                sourceName: source.name,
                scale: source.scale,
                mime: null,
                hasSystemAudio: request.systemAudio,
                cursorHidden: false,
                frame: null,
                frameEnd: null,
                screenRect: source.rectPx
              }
            : null,
          camera:
            hasVideo || hasMic
              ? { file: hasVideo ? RAW_CAMERA : RAW_MIC, mime: null, hasVideo, hasAudio: hasMic, size: null }
              : null,
          clock: null,
          pauses: [],
          endedAt: null,
          stopReason: null,
          recordedMs: null,
          notes: [],
          saved: null,
          processedAt: null
        }
        await writeManifest(dir, manifest)

        session = {
          id: sessionId,
          dir,
          folder,
          request,
          source,
          manifest,
          files: new Map(),
          tracker: null,
          trackerFailed: null,
          trackerResult: null,
          pauses: [],
          openPause: null,
          writeError: null,
          offsetMs: 0,
          hadData: false
        }
        logger.info(`Gravação preparada: ${folder} (${request.mode}, ${request.fps} qps${source ? `, fonte "${source.name}" [${source.kind}]` : ''})`)
        return {
          sessionId,
          folder,
          kind: source?.kind ?? null,
          sourceName: source?.name ?? null,
          nativeSize: source?.nativeSize ?? null,
          scale: source?.scale ?? 1
        }
      } catch (err) {
        deps.sources.disarm()
        session = null
        status = 'idle'
        deps.emit('record:status', view())
        throw err
      }
    },

    async countdown() {
      const s = session
      if (!s || status !== 'preparing') throw new Error('Não há gravação preparada para a contagem.')
      setStatus('countdown')
      if (s.request.mode !== 'camera') deps.windows.setMainMinimized(true)
      const display = s.source?.displayBoundsDip ?? { x: 0, y: 0, w: 1920, h: 1080 }
      let completed = false
      try {
        completed = await deps.windows.countdown(display, { seconds: COUNTDOWN_SECONDS, silent })
      } catch (err) {
        logger.error('A contagem regressiva falhou.', err)
      }
      if (!completed) {
        logger.info('Contagem cancelada: nada foi gravado.')
        deps.windows.setMainMinimized(false)
        await discardSession(s)
        session = null
        setStatus('idle')
        return false
      }
      return true
    },

    async go() {
      const s = session
      if (!s || status !== 'countdown') throw new Error('A gravação não está pronta para começar.')
      if (s.source) {
        const kind = s.source.kind
        const tracker = deps.createTracker({ kind, hwnd: kind === 'window' ? s.source.hwnd : null })
        try {
          await tracker.start()
          s.tracker = tracker
        } catch (err) {
          s.trackerFailed = messageOf(err)
          logger.error('O rastreador do mouse não iniciou: a gravação segue sem cursor e cliques.', err)
          deps.emit('record:notice', {
            kind: 'error',
            text: 'O rastreador do mouse não iniciou. O vídeo será gravado sem cursor e cliques.',
            detail: s.trackerFailed
          })
          s.manifest.notes.push(`O rastreador do mouse não iniciou: ${s.trackerFailed}`)
        }
      }
    },

    async started(info) {
      const s = session
      if (!s || status !== 'countdown') throw new Error('A gravação não está pronta para começar.')
      s.offsetMs = info.clockOffsetMs
      s.manifest.clock = {
        t0: info.t0,
        screenStartAt: info.screenStartAt,
        cameraStartAt: info.cameraStartAt,
        offsetMs: info.clockOffsetMs,
        rttMs: info.clockRttMs
      }
      if (s.manifest.screen) {
        s.manifest.screen.frame = info.frame
        s.manifest.screen.mime = info.screenMime
        s.manifest.screen.hasSystemAudio = info.screenHasAudio
        s.manifest.screen.cursorHidden = info.cursorHidden
      }
      if (s.manifest.camera) {
        s.manifest.camera.mime = info.cameraMime
        s.manifest.camera.size = info.cameraSize
        s.manifest.camera.hasVideo = info.cameraHasVideo
        s.manifest.camera.hasAudio = info.cameraHasAudio
        // Só áudio: o arquivo bruto não é "camera".
        s.manifest.camera.file = info.cameraHasVideo ? RAW_CAMERA : RAW_MIC
      }
      await writeManifest(s.dir, s.manifest)
      setStatus('recording')
      const state = makeBarState(s, 'recording')
      barSnapshot = state
      const hotkeys = deps.windows.registerHotkeys({
        stop: () => command('stop', 'hotkey'),
        pause: () => command(status === 'paused' ? 'resume' : 'pause', 'hotkey')
      })
      if (!hotkeys.ok) {
        deps.emit('record:notice', {
          kind: 'info',
          text: 'Os atalhos globais não puderam ser registrados (outro programa pode estar usando). Use a barra flutuante.'
        })
      }
      deps.windows.showBar({ ...state, shortcutStop: hotkeys.stop, shortcutPause: hotkeys.pause }, s.source?.displayBoundsDip ?? null)
      if (s.request.showBubble && s.request.cameraId && s.request.mode === 'screen-camera') {
        deps.windows.showBubble({ cameraId: s.request.cameraId, mirror: true }, s.source?.displayBoundsDip ?? null)
      }
      const fmt = (v: number | null): string => (v === null ? '—' : v.toFixed(1))
      logger.info(`Gravando (t0=${info.t0.toFixed(1)}; deslocamentos das chamadas de start(): tela ${fmt(info.screenStartAt === null ? null : info.screenStartAt - info.t0)} ms, câmera ${fmt(info.cameraStartAt === null ? null : info.cameraStartAt - info.t0)} ms; evento start chegou depois de: tela ${fmt(info.startEventLagMs.screen)} ms, câmera ${fmt(info.startEventLagMs.camera)} ms; relógios: main − renderer = ${info.clockOffsetMs.toFixed(2)} ms, ida e volta ${info.clockRttMs.toFixed(2)} ms)`)
    },

    async chunk(kind, data) {
      const s = session
      if (!s) {
        logger.debug(`Pedaço de ${kind} chegou depois do fim da gravação; ignorado.`)
        return
      }
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      try {
        let slot = s.files.get(kind)
        if (!slot) {
          const rel = kind === 'screen' ? RAW_SCREEN : kind === 'camera' ? RAW_CAMERA : RAW_MIC
          const path = join(s.dir, rel)
          slot = { handle: await open(path, 'a'), bytes: 0, path }
          s.files.set(kind, slot)
        }
        await slot.handle.write(bytes)
        slot.bytes += bytes.byteLength
        s.hadData = true
      } catch (err) {
        const message = messageOf(err)
        if (!s.writeError) {
          s.writeError = message
          logger.error(`Erro ao gravar em disco (${kind}).`, err)
          deps.emit('record:notice', { kind: 'error', text: 'Não consegui gravar em disco. A gravação vai parar e salvar o que já está no disco.', detail: message })
        }
        throw new Error(`Erro ao gravar em disco: ${message}`)
      }
    },

    async pause(at) {
      const s = session
      if (!s || status !== 'recording') return
      s.openPause = at
      s.tracker?.pause()
      setStatus('paused')
      pushBar('paused')
    },

    async resume(at) {
      const s = session
      if (!s || status !== 'paused' || s.openPause === null) return
      s.pauses.push({ start: s.openPause, end: at })
      s.openPause = null
      s.tracker?.resume()
      setStatus('recording')
      pushBar('recording')
    },

    async stop(info) {
      const s = session
      if (!s || (status !== 'recording' && status !== 'paused')) throw new Error('Não há gravação em andamento para parar.')
      setStatus('stopping')
      pushBar('stopping')
      if (s.openPause !== null) {
        s.pauses.push({ start: s.openPause, end: info.endedAt })
        s.openPause = null
      }
      leaveRecordingUi()
      deps.windows.setMainMinimized(false)
      const tracked = await stopTrackerQuietly(s)
      await closeFiles(s)
      deps.sources.disarm()

      const pauses = normalizeIntervals(s.pauses)
      const clock = s.manifest.clock
      s.manifest.pauses = pauses
      s.manifest.endedAt = info.endedAt
      s.manifest.stopReason = info.reason
      s.manifest.recordedMs = clock ? Math.max(0, info.endedAt - clock.t0 - pauses.reduce((a, p) => a + (p.end - p.start), 0)) : null
      if (s.manifest.screen) s.manifest.screen.frameEnd = info.frame
      s.manifest.notes.push(...info.notes)
      if (s.writeError) s.manifest.notes.push(`Erro de escrita em disco: ${s.writeError}`)
      if (tracked?.error) s.manifest.notes.push(`O rastreador do mouse falhou durante a gravação: ${tracked.error.split('\n')[0]}`)
      if (tracked?.windowGone) s.manifest.notes.push('A janela gravada foi fechada durante a gravação.')
      await writeManifest(s.dir, s.manifest)
      logger.info(`Gravação parada (${info.reason}): ${s.folder}, ${s.manifest.recordedMs === null ? '?' : (s.manifest.recordedMs / 1000).toFixed(1)} s gravados, ${pauses.length} pausa(s).`)

      const id = s.id
      session = null
      setStatus('idle')
      // O processamento corre em segundo plano; a interface acompanha por `process:progress`.
      void startProcessing(s, tracked?.raw ?? null).catch((err) => logger.error('Falha inesperada no processamento.', err))
      return { sessionId: id }
    },

    async abort(reason) {
      const s = session
      if (!s) return
      logger.info(`Gravação descartada${reason ? ` (${reason})` : ''}: ${s.folder}`)
      leaveRecordingUi()
      deps.windows.setMainMinimized(false)
      await discardSession(s)
      session = null
      setStatus('idle')
    },

    status: view,

    command,

    barState: () => barSnapshot,

    countdownConfig: () => ({ seconds: COUNTDOWN_SECONDS, silent }),

    bubbleConfig() {
      const s = session
      if (!s?.request.cameraId) return null
      return { cameraId: s.request.cameraId, mirror: true }
    },

    level(level) {
      if (status === 'recording' || status === 'paused') deps.windows.barLevel(level)
    },

    async retry(sessionId) {
      const p = processing
      if (!p || p.ctx.manifest.sessionId !== sessionId) throw new Error('Não encontrei essa gravação para tentar de novo.')
      if (p.running) return
      const ff = deps.ffmpeg()
      if (!ff) throw new Error('Não encontrei o ffmpeg. Escolha-o nos Ajustes e tente de novo.')
      logger.info(`Tentando processar de novo: ${p.ctx.manifest.folder}`)
      await runOnce(ff)
    },

    async shutdown() {
      const s = session
      deps.windows.unregisterHotkeys()
      if (s) {
        await stopTrackerQuietly(s)
        await closeFiles(s)
        s.manifest.notes.push('O app foi fechado durante a gravação; o bruto está em raw/.')
        await writeManifest(s.dir, s.manifest).catch(() => undefined)
      }
    }
  }
}

/** A pasta do projeto ainda tem o manifesto? (usado pelos testes e pela recuperação futura) */
export async function hasManifest(dir: string): Promise<boolean> {
  return pathExists(join(dir, MANIFEST_PATH))
}
