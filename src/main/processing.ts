/**
 * Processamento ao parar a gravação: salvar eventos → normalizar a tela
 * (fps constante, H.264 NVENC com fallback libx264, GOP = 1 s) → normalizar a câmera
 * (30 qps) → `voice.wav` (48 kHz mono) → `system.wav` → miniatura → `project.json`.
 *
 * Nenhuma falha silenciosa: qualquer passo que falhe devolve o snapshot `failed` com o
 * passo e o motivo, o BRUTO continua intacto em `raw/` e `runProcessing` pode ser chamado
 * de novo (passos já concluídos não se repetem). Sem Electron.
 */
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProcessSnapshot, ProcessStepId, ProcessStepState } from '@shared/ipc'
import { createProject, parseProject, serializeProject } from '@shared/project'
import { buildEvents, toJsonLines, type BuiltEvents, type RawEvents } from '@shared/recording'
import type { CaptureInfo, Project, Src } from '@shared/types'
import { writeFileAtomic } from './fs-utils'
import type { Ffmpeg } from './ffmpeg'
import type { Logger } from './logger'
import { writeManifest, type RecordingManifest } from './manifest'
import { extractAudio, makeThumbnail, normalizeVideo } from './normalize'
import { PROJECT_FILE, THUMB_PATH } from './projects'
import { resolveProjectFile } from './project-files'

/** Estado que sobrevive entre uma tentativa e a seguinte (mesma sessão do app). */
export type ProcessContext = {
  dir: string
  manifest: RecordingManifest
  /** Eventos brutos do rastreador, enquanto o passo "salvar" não terminou. */
  rawEvents: RawEvents | null
  /** Passos já concluídos nesta sessão (o "tentar de novo" os pula). */
  done: Set<ProcessStepId>
  sources: { screen?: Src; camera?: Src; voice?: Src; system?: Src }
  notes: string[]
}

export type ProcessDeps = {
  ff: Ffmpeg
  logger: Logger
  onProgress: (snapshot: ProcessSnapshot) => void
  /** Gancho de TESTE: pode lançar para simular falha de um passo (TOMADA_TEST_FAIL_STEP). */
  beforeStep?: (id: ProcessStepId) => void | Promise<void>
  /** Gancho de TESTE: espera antes de cada passo (deixa tirar captura de tela). */
  stepDelayMs?: number
}

export const STEP_ORDER: ProcessStepId[] = ['save', 'screen', 'camera', 'voice', 'system', 'thumb', 'project']

/** Passos que se aplicam a esta gravação, na ordem. */
export function stepsFor(manifest: RecordingManifest): ProcessStepId[] {
  return STEP_ORDER.filter((id) => {
    switch (id) {
      case 'screen':
        return Boolean(manifest.screen)
      case 'camera':
        return Boolean(manifest.camera?.hasVideo)
      case 'voice':
        return Boolean(manifest.camera?.hasAudio)
      case 'system':
        return Boolean(manifest.screen?.hasSystemAudio)
      default:
        return true
    }
  })
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const CAMERA_FPS = 30
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function createProcessContext(args: { dir: string; manifest: RecordingManifest; rawEvents: RawEvents | null }): ProcessContext {
  return { dir: args.dir, manifest: args.manifest, rawEvents: args.rawEvents, done: new Set((args.manifest.processing?.done ?? []).filter((id) => STEP_ORDER.includes(id))), sources: { ...args.manifest.processing?.sources }, notes: [...args.manifest.notes] }
}

/**
 * Roda (ou retoma) o processamento. Nunca lança: o resultado é o snapshot final
 * (`done` ou `failed`).
 */
export async function runProcessing(ctx: ProcessContext, deps: ProcessDeps): Promise<ProcessSnapshot> {
  const { manifest, dir } = ctx
  const { logger } = deps
  const ids = stepsFor(manifest)
  const steps: ProcessStepState[] = ids.map((id) => ({
    id,
    status: ctx.done.has(id) ? 'done' : 'pending',
    fraction: ctx.done.has(id) ? 1 : 0
  }))
  const snapshot: ProcessSnapshot = { sessionId: manifest.sessionId, folder: manifest.folder, status: 'running', steps, notes: ctx.notes }

  try {
    for (const rel of [manifest.screen?.file, manifest.camera?.file, ...Object.values(ctx.sources).map((s) => s.path), 'media/screen.mp4', 'media/camera.mp4', 'media/voice.wav', 'media/system.wav', THUMB_PATH, PROJECT_FILE, 'events/cursor.jsonl', 'events/clicks.jsonl', 'events/keys.jsonl', 'events/window.jsonl']) {
      if (rel) await resolveProjectFile(dir, rel)
    }
  } catch (err) {
    snapshot.status = 'failed'
    snapshot.error = { step: 'save', message: messageOf(err) }
    deps.onProgress(snapshot)
    return snapshot
  }

  let lastEmit = 0
  const emit = (force = true): void => {
    const now = Date.now()
    if (!force && now - lastEmit < 100) return
    lastEmit = now
    deps.onProgress({ ...snapshot, steps: steps.map((s) => ({ ...s })), notes: [...ctx.notes] })
  }
  const stepOf = (id: ProcessStepId): ProcessStepState => steps.find((s) => s.id === id)!
  const note = (message: string): void => {
    ctx.notes.push(message)
    logger.warn(message)
  }

  const expectedMs = manifest.recordedMs ?? undefined
  const rawPath = (rel: string): string => join(dir, rel)
  const mediaPath = (rel: string): string => join(dir, 'media', rel)

  const impl: Record<ProcessStepId, (step: ProcessStepState) => Promise<string | undefined>> = {
    async save() {
      return saveEvents(ctx, deps)
    },

    async screen(step) {
      const screen = manifest.screen!
      const result = await normalizeVideo(deps.ff, {
        input: rawPath(screen.file),
        output: mediaPath('screen.mp4'),
        fps: manifest.fps,
        // A captura de tela só entrega quadro quando algo muda: o rabo estático da gravação não vira
        // quadro nenhum. O vídeo precisa durar o que a gravação durou (o último quadro é repetido).
        ...(expectedMs ? { durationMs: expectedMs, padToMs: expectedMs } : {}),
        onProgress: (f) => {
          step.fraction = f
          emit(false)
        },
        onNote: note
      })
      const v = result.probe.video!
      if (expectedMs && Math.abs(result.probe.durationMs - expectedMs) > 1000) {
        note(`O vídeo da tela ficou com ${(result.probe.durationMs / 1000).toFixed(1)} s e a gravação durou ${(expectedMs / 1000).toFixed(1)} s: a captura de tela parou antes do fim.`)
      }
      ctx.sources.screen ={ path: 'media/screen.mp4', w: v.width ?? 0, h: v.height ?? 0, fps: manifest.fps, durationMs: result.probe.durationMs }
      return `${result.encoder === 'h264_nvenc' ? 'NVENC' : 'libx264'}, ${v.width}×${v.height}`
    },

    async camera(step) {
      const cam = manifest.camera!
      const result = await normalizeVideo(deps.ff, {
        input: rawPath(cam.file),
        output: mediaPath('camera.mp4'),
        fps: CAMERA_FPS,
        ...(expectedMs ? { durationMs: expectedMs } : {}),
        onProgress: (f) => {
          step.fraction = f
          emit(false)
        },
        onNote: note
      })
      const v = result.probe.video!
      ctx.sources.camera = { path: 'media/camera.mp4', w: v.width ?? 0, h: v.height ?? 0, fps: CAMERA_FPS, durationMs: result.probe.durationMs }
      return `${v.width}×${v.height}`
    },

    async voice() {
      const cam = manifest.camera!
      const probe = await extractAudio(deps.ff, { input: rawPath(cam.file), output: mediaPath('voice.wav'), channels: 1, sampleRate: 48_000 })
      ctx.sources.voice = { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs: probe.durationMs }
      return undefined
    },

    async system() {
      const screen = manifest.screen!
      // A faixa pode não existir (nenhum som tocando/dispositivo): só vira aviso, o bruto segue.
      const probe = await deps.ff.probe(rawPath(screen.file))
      if (!probe.audio) {
        note('O som do computador estava ligado, mas a gravação da tela não trouxe nenhuma faixa de áudio.')
        return 'sem faixa de áudio'
      }
      const out = await extractAudio(deps.ff, { input: rawPath(screen.file), output: mediaPath('system.wav'), channels: 2, sampleRate: 48_000 })
      ctx.sources.system = { path: 'media/system.wav', w: 0, h: 0, fps: 0, durationMs: out.durationMs }
      return undefined
    },

    async thumb() {
      const base = ctx.sources.screen ?? ctx.sources.camera
      if (!base) {
        // Gravação só de áudio: sem miniatura (a biblioteca mostra o espaço reservado).
        return 'sem vídeo'
      }
      const at = Math.min(3000, Math.max(0, base.durationMs / 2))
      await makeThumbnail(deps.ff, { input: join(dir, base.path), output: join(dir, THUMB_PATH), atMs: at, width: 640 })
      return undefined
    },

    async project() {
      const saved = manifest.saved
      if (!saved) throw new Error('O passo de salvar eventos não terminou; não dá para montar o project.json.')
      const project: Project = createProject({
        id: manifest.sessionId,
        title: manifest.title,
        createdAt: manifest.createdAt,
        sources: ctx.sources,
        sync: saved.sync,
        capture: saved.capture
      })
      // Sem o cursor do sistema no vídeo, o editor precisa desenhar o sintético; com ele, só ripple/halo.
      project.style.cursor.mode = saved.capture.cursorHidden ? 'synthetic' : 'real'
      if (manifest.script) project.script = manifest.script
      project.retakeMarks = manifest.retakeMarks ?? []
      const text = serializeProject(project)
      parseProject(text) // o que escrevemos precisa passar pelo mesmo esquema de quem lê
      await writeFileAtomic(join(dir, PROJECT_FILE), text)
      manifest.processedAt = new Date().toISOString()
      manifest.notes = [...ctx.notes]
      await writeManifest(dir, manifest)
      return undefined
    }
  }

  await mkdir(join(dir, 'media'), { recursive: true })
  emit()

  for (const id of ids) {
    if (ctx.done.has(id)) continue
    const step = stepOf(id)
    step.status = 'running'
    step.fraction = 0
    delete step.detail
    emit()
    try {
      if (deps.stepDelayMs) await sleep(deps.stepDelayMs)
      await deps.beforeStep?.(id)
      const detail = await impl[id](step)
      step.status = 'done'
      step.fraction = 1
      if (detail) step.detail = detail
      manifest.processing = { done: [...ctx.done, id], sources: { ...ctx.sources } }
      manifest.notes = [...ctx.notes]
      await writeManifest(dir, manifest)
      ctx.done.add(id)
      if (id === 'save') await rm(join(dir, 'raw/events.json'), { force: true }).catch((err: unknown) => logger.warn('Não consegui remover os eventos brutos já salvos.', err))
      logger.info(`Processamento: passo "${id}" concluído${detail ? ` (${detail})` : ''}.`)
      emit()
    } catch (err) {
      manifest.processing = { done: [...ctx.done], sources: { ...ctx.sources } }
      const message = messageOf(err)
      step.status = 'error'
      step.detail = message
      snapshot.status = 'failed'
      snapshot.error = { step: id, message }
      // Arquivo parcial de um passo que falhou não pode ficar com cara de bom.
      await cleanupPartial(dir, id)
      logger.error(`Processamento falhou no passo "${id}" (o bruto foi preservado em ${join(dir, 'raw')}).`, err)
      emit()
      return { ...snapshot, steps: steps.map((s) => ({ ...s })), notes: [...ctx.notes] }
    }
  }

  snapshot.status = 'done'
  emit()
  logger.info(`Gravação processada: ${manifest.folder}`)
  return { ...snapshot, steps: steps.map((s) => ({ ...s })), notes: [...ctx.notes] }
}

async function cleanupPartial(dir: string, id: ProcessStepId): Promise<void> {
  const targets: Record<ProcessStepId, string[]> = {
    save: [],
    screen: ['media/screen.mp4.parcial'],
    camera: ['media/camera.mp4.parcial'],
    voice: ['media/voice.wav'],
    system: ['media/system.wav'],
    thumb: [THUMB_PATH],
    project: []
  }
  for (const rel of targets[id]) await rm(join(dir, rel), { force: true }).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Passo "salvar": eventos → arquivos e decisões de captura/sincronia

async function saveEvents(ctx: ProcessContext, deps: ProcessDeps): Promise<string | undefined> {
  const { manifest, dir } = ctx
  const { logger } = deps
  const screen = manifest.screen

  if (!screen) {
    // Só câmera: não há tela nem cursor. O documento usa a captura padrão.
    manifest.saved = {
      capture: { kind: 'screen', boundsPx: { x: 0, y: 0, w: manifest.camera?.size?.w ?? 1920, h: manifest.camera?.size?.h ?? 1080 }, scale: 1 },
      sync: syncOf(manifest),
      stats: { cursor: 0, clicks: 0, keys: 0 }
    }
    await writeManifest(dir, manifest)
    return 'só câmera'
  }

  const clock = manifest.clock
  if (!clock) throw new Error('A gravação não registrou o instante de início (t0); não dá para alinhar os eventos.')

  if (manifest.saved && (await eventsOnDisk(dir, screen.kind))) {
    return 'já salvo'
  }

  const raw = ctx.rawEvents
  const built: BuiltEvents = buildEvents({
    raw: raw ?? { cursor: [], clicks: [], keys: [], windowRects: [] },
    kind: screen.kind,
    screenRect: screen.kind === 'screen' ? screen.screenRect : null,
    frame: screen.frame,
    t0: clock.t0,
    mainToRenderer: -clock.offsetMs,
    pauses: manifest.pauses
  })
  if (!raw) addNote(ctx, deps, 'O rastreador do mouse não entregou eventos: o vídeo foi salvo sem cursor e cliques.')
  if (built.sizeMismatch) {
    logger.warn(
      `O quadro capturado (${screen.frame?.w}×${screen.frame?.h}) difere do retângulo do Win32 (${built.rectSource}) em ${built.sizeMismatch.dw}×${built.sizeMismatch.dh} px; a normalização usa o quadro real.`
    )
  }
  if (screen.frame && screen.frameEnd && (Math.abs(screen.frame.w - screen.frameEnd.w) > 2 || Math.abs(screen.frame.h - screen.frameEnd.h) > 2)) {
    addNote(ctx, deps, `O tamanho do quadro mudou durante a gravação (${screen.frame.w}×${screen.frame.h} → ${screen.frameEnd.w}×${screen.frameEnd.h}); o cursor pode ficar fora de lugar depois da mudança.`)
  }

  await mkdir(join(dir, 'events'), { recursive: true })
  await writeFileAtomic(join(dir, 'events', 'cursor.jsonl'), toJsonLines(built.cursor))
  await writeFileAtomic(join(dir, 'events', 'clicks.jsonl'), toJsonLines(built.clicks))
  await writeFileAtomic(join(dir, 'events', 'keys.jsonl'), toJsonLines(built.keys))
  if (screen.kind === 'window') await writeFileAtomic(join(dir, 'events', 'window.jsonl'), toJsonLines(built.windowRects))

  const capture: CaptureInfo = {
    kind: screen.kind,
    boundsPx: built.boundsPx,
    scale: screen.scale,
    ...(screen.frame ? { frameSize: screen.frame } : {}),
    // O que a trilha informou: com o Electron 40 o cursor real vai no vídeo (ver README, "cursor sintético").
    cursorHidden: screen.cursorHidden,
    sourceName: screen.sourceName
  }
  manifest.saved = {
    capture,
    sync: syncOf(manifest),
    stats: { cursor: built.cursor.length, clicks: built.clicks.length, keys: built.keys.length }
  }
  await writeManifest(dir, manifest)
  logger.info(
    `Eventos salvos: ${built.cursor.length} amostras de cursor, ${built.clicks.length} cliques, ${built.keys.length} teclas (${built.stats.droppedOutside} descartados por cair antes do início ou dentro de uma pausa; ${built.stats.outsideCursor} amostras fora da área).`
  )
  return `${built.cursor.length} amostras de cursor, ${built.clicks.length} cliques`
}

function addNote(ctx: ProcessContext, deps: ProcessDeps, message: string): void {
  ctx.notes.push(message)
  deps.logger.warn(message)
}

function syncOf(manifest: RecordingManifest): { screenOffsetMs: number; cameraOffsetMs: number } {
  const c = manifest.clock
  if (!c) return { screenOffsetMs: 0, cameraOffsetMs: 0 }
  const off = (at: number | null): number => (at === null ? 0 : Math.max(0, Math.round((at - c.t0) * 10) / 10))
  return { screenOffsetMs: off(c.screenStartAt), cameraOffsetMs: off(c.cameraStartAt) }
}

async function eventsOnDisk(dir: string, kind: 'screen' | 'window'): Promise<boolean> {
  const files = ['cursor.jsonl', 'clicks.jsonl', 'keys.jsonl', ...(kind === 'window' ? ['window.jsonl'] : [])]
  try {
    for (const f of files) await stat(join(dir, 'events', f))
    return true
  } catch {
    return false
  }
}
