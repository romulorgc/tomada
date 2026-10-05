/**
 * Renderização do vídeo (roda na janela ESCONDIDA de exportação, num processo próprio).
 *
 * mediabunny lê `media/screen.mp4` e `media/camera.mp4` por `tomada-media://` (Range) e entrega os
 * quadros pelo sink de amostras por timestamp (eficiente para sequência crescente, com saltos nos
 * cortes); cada quadro de saída é desenhado por `evaluateScene` + `renderFrame` num OffscreenCanvas
 * (as MESMAS funções da prévia) e codificado em H.264 por hardware num MP4 sem áudio. Os pedaços
 * saem por IPC (posição + bytes) direto para o disco: o vídeo inteiro nunca fica na memória.
 */
import {
  ALL_FORMATS,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
  VideoSampleSink,
  type StreamTargetChunk,
  type VideoSample
} from 'mediabunny'
import { avcCodecString, fileTimeSeconds, outputFrameCount, sourceTimeOfFrame } from '@shared/export'
import { eventsFromText } from '@shared/events'
import type { ExportJob } from '@shared/ipc'
import { mediaUrl } from '@shared/media-url'
import {
  createRenderCache,
  drawShadow,
  renderFrame,
  roundedRectPath,
  type CanvasFactory,
  type Ctx2D,
  type FrameSet,
  type FrameSource,
  type RenderCache
} from '@shared/render'
import { deriveProject, evaluateScene, prepareEvents, type Derived, type FormatSpec } from '@shared/scene'
import type { Project } from '@shared/types'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function fetchText(url: string | null): Promise<string | undefined> {
  if (!url) return undefined
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Não consegui ler ${url} (${response.status}).`)
  return response.text()
}

/** Uma fonte de vídeo aberta: o arquivo e o sink de amostras por timestamp. */
type Track = { input: Input; sink: VideoSampleSink; offsetMs: number }

async function openTrack(url: string | null, offsetMs: number): Promise<Track | null> {
  if (!url) return null
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error(`O arquivo de vídeo não tem trilha de imagem: ${url}`)
  if (!(await track.canDecode())) throw new Error(`Este computador não consegue decodificar o vídeo (${await track.getCodecParameterString()}).`)
  return { input, sink: new VideoSampleSink(track), offsetMs }
}

function closeTrack(t: Track | null): void {
  if (!t) return
  try {
    t.input.dispose()
  } catch {
    // já fechado
  }
}

/** Quadro que fica "no ar" até o seguinte chegar (e para além do fim do arquivo: o último). */
class FrameHold {
  frame: VideoFrame | null = null
  update(sample: VideoSample | null): void {
    if (!sample) return
    const next = sample.toVideoFrame()
    sample.close()
    this.frame?.close()
    this.frame = next
  }
  source(): FrameSource | null {
    const f = this.frame
    return f ? { image: f, w: f.displayWidth, h: f.displayHeight } : null
  }
  close(): void {
    this.frame?.close()
    this.frame = null
  }
}

const canvasFactory: CanvasFactory = (w, h) => new OffscreenCanvas(w, h) as unknown as ReturnType<CanvasFactory>

/** Pré-carrega a imagem de fundo (se o estilo usa uma) para o cache do render. */
export async function loadBackgroundImage(project: Project, projectId: string, cache: RenderCache): Promise<void> {
  const bg = project.style.background
  if (bg.type !== 'image' || cache.images.has(bg.path)) return
  const url = /^[a-z]+:\/\//i.test(bg.path) ? bg.path : mediaUrl(projectId, bg.path)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Não consegui ler a imagem de fundo (${response.status}): ${bg.path}`)
  const bitmap = await createImageBitmap(await response.blob())
  cache.images.set(bg.path, { image: bitmap, w: bitmap.width, h: bitmap.height })
}

type Context = {
  project: Project
  format: FormatSpec
  derived: Derived
  cache: RenderCache
  canvas: OffscreenCanvas
  ctx: Ctx2D
  screen: Track | null
  camera: Track | null
  close(): void
}

async function createContext(job: Pick<ExportJob, 'projectId' | 'project' | 'screenUrl' | 'cameraUrl' | 'eventUrls'>, format: FormatSpec): Promise<Context> {
  const { project } = job
  const [cursor, clicks, keys] = await Promise.all([
    fetchText(job.eventUrls.cursor),
    fetchText(job.eventUrls.clicks),
    fetchText(job.eventUrls.keys)
  ])
  const events = eventsFromText({ cursor, clicks, keys })
  const durationMs = Math.max(project.sources.screen?.durationMs ?? 0, project.sources.camera?.durationMs ?? 0, project.sources.voice?.durationMs ?? 0, project.sources.system?.durationMs ?? 0)
  const derived = deriveProject(project, prepareEvents(events, durationMs), format)

  const canvas = new OffscreenCanvas(format.w, format.h)
  const raw = canvas.getContext('2d', { alpha: false })
  if (!raw) throw new Error('Não consegui criar o canvas de exportação.')
  const cache = createRenderCache(canvasFactory)
  await loadBackgroundImage(project, job.projectId, cache)

  const screen = await openTrack(job.screenUrl, project.sync.screenOffsetMs)
  const camera = await openTrack(job.cameraUrl, project.sync.cameraOffsetMs)
  return {
    project,
    format,
    derived,
    cache,
    canvas,
    ctx: raw as unknown as Ctx2D,
    screen,
    camera,
    close() {
      closeTrack(screen)
      closeTrack(camera)
    }
  }
}

export type VideoRenderIo = {
  /** Escreve um pedaço do MP4 no disco (posição + bytes). */
  write(position: number, data: Uint8Array): Promise<void>
  onProgress?(frame: number, renderFps: number | null): void
  signal?: AbortSignal
}

/** Média de quadros por segundo nos últimos ~2 s. */
class FpsMeter {
  private marks: { t: number; n: number }[] = []
  tick(n: number): number | null {
    const t = performance.now()
    this.marks.push({ t, n })
    while (this.marks.length > 2 && t - this.marks[1]!.t > 2000) this.marks.shift()
    const first = this.marks[0]!
    const dt = t - first.t
    return dt > 200 ? ((n - first.n) / dt) * 1000 : null
  }
}

/**
 * Escolhe o encoder H.264 que o Chromium ACEITA para esta configuração: o de hardware, se ele aceita; senão o que
 * o navegador oferecer (software). Sem nenhum dos dois, falha logo, com o motivo e o que fazer.
 */
async function pickAcceleration(codec: string, width: number, height: number, framerate: number, bitrate: number): Promise<'prefer-hardware' | 'no-preference'> {
  const base = { codec, width, height, framerate, bitrate, latencyMode: 'quality' as const, avc: { format: 'avc' as const } }
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
    try {
      if ((await VideoEncoder.isConfigSupported({ ...base, hardwareAcceleration })).supported) return hardwareAcceleration
    } catch {
      // configuração recusada: tenta a próxima
    }
  }
  throw new Error(`Este computador não consegue codificar H.264 em ${width}×${height} a ${framerate} qps (${codec}). Tente uma resolução ou uma taxa de quadros menor.`)
}

/**
 * Renderiza o vídeo (sem áudio) e o entrega por `io.write`. Devolve quantos quadros saíram e
 * qual encoder foi usado.
 */
export async function renderVideoJob(job: ExportJob, io: VideoRenderIo): Promise<{ frames: number; encoder: string; timing: string }> {
  const format: FormatSpec = { kind: 'horizontal', w: job.width, h: job.height }
  const c = await createContext(job, format)
  const fps = job.fps
  try {
    const { derived, project } = c
    const total = outputFrameCount(derived.outputDurationMs, fps)
    if (total === 0) throw new Error('Não há nada para exportar: todos os trechos foram cortados.')

    const codec = avcCodecString(format.w, format.h, fps)
    let encoderNote = codec
    const makeOutput = (hardware: 'prefer-hardware' | 'no-preference'): { output: Output; source: CanvasSource } => {
      const writable = new WritableStream<StreamTargetChunk>({
        async write(chunk) {
          await io.write(chunk.position, chunk.data)
        }
      })
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: false }),
        target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 })
      })
      const source = new CanvasSource(c.canvas, {
        codec: 'avc',
        bitrate: job.bitrate,
        keyFrameInterval: 1,
        fullCodecString: codec,
        hardwareAcceleration: hardware,
        latencyMode: 'quality',
        onEncoderConfig: (config) => {
          encoderNote = `${config.codec} ${config.width}×${config.height} ${hardware}`
        }
      })
      output.addVideoTrack(source, { frameRate: fps })
      return { output, source }
    }

    // O encoder por hardware nem sempre aceita a configuração pedida (nesta máquina recusa 1440p e 4K a 60 qps; o
    // Chromium só descobre no PRIMEIRO quadro, e a exportação inteira falharia). Pergunta antes e escolhe.
    const acceleration = await pickAcceleration(codec, format.w, format.h, fps, job.bitrate)
    let { output, source } = makeOutput(acceleration)
    try {
      await output.start()
    } catch (err) {
      // sem encoder por hardware: tenta o que o navegador oferecer (pode ser software)
      encoderNote = `sem hardware (${messageOf(err)})`
      ;({ output, source } = makeOutput('no-preference'))
      await output.start()
    }

    const times = (offset: number) =>
      (async function* () {
        for (let i = 0; i < total; i++) yield fileTimeSeconds(sourceTimeOfFrame(i, fps, derived.kept), offset)
      })()
    const screenIter = c.screen ? c.screen.sink.samplesAtTimestamps(times(c.screen.offsetMs)) : null
    const cameraIter = c.camera ? c.camera.sink.samplesAtTimestamps(times(c.camera.offsetMs)) : null
    const screenHold = new FrameHold()
    const cameraHold = new FrameHold()

    const next = async (iter: AsyncGenerator<VideoSample | null, void, unknown> | null): Promise<VideoSample | null> => {
      if (!iter) return null
      const r = await iter.next()
      return r.done ? null : r.value
    }
    // decodifica o quadro i + 1 enquanto o i é desenhado e codificado
    let pending = Promise.all([next(screenIter), next(cameraIter)])
    const meter = new FpsMeter()
    let lastReport = 0
    // onde o tempo vai (ms acumulados): esperar a decodificação, copiar o quadro, desenhar, esperar o encoder
    const spent = { decode: 0, hold: 0, draw: 0, encode: 0 }
    const startedAt = performance.now()

    for (let i = 0; i < total; i++) {
      if (io.signal?.aborted) {
        await output.cancel()
        throw new Error('Exportação cancelada.')
      }
      let t0 = performance.now()
      const [s, cam] = await pending
      spent.decode += performance.now() - t0
      if (i + 1 < total) pending = Promise.all([next(screenIter), next(cameraIter)])
      t0 = performance.now()
      screenHold.update(s)
      cameraHold.update(cam)
      spent.hold += performance.now() - t0
      t0 = performance.now()

      const scene = evaluateScene(project, derived, sourceTimeOfFrame(i, fps, derived.kept), format)
      const frames: FrameSet = { screen: screenHold.source(), camera: cameraHold.source() }
      renderFrame(c.ctx, scene, frames, c.cache)
      spent.draw += performance.now() - t0
      t0 = performance.now()
      await source.add(i / fps, 1 / fps)
      spent.encode += performance.now() - t0

      const now = performance.now()
      if (now - lastReport > 250 || i === total - 1) {
        lastReport = now
        io.onProgress?.(i + 1, meter.tick(i + 1))
      }
    }
    screenHold.close()
    cameraHold.close()
    const tFinal = performance.now()
    await output.finalize()
    const finalizeMs = performance.now() - tFinal
    const wall = performance.now() - startedAt
    const per = (ms: number): string => (ms / total).toFixed(2)
    const timing =
      `por quadro (ms): espera da decodificação ${per(spent.decode)}, cópia ${per(spent.hold)}, desenho ${per(spent.draw)}, espera do encoder ${per(spent.encode)}; ` +
      `total ${(wall / total).toFixed(2)} (${((total / wall) * 1000).toFixed(1)} qps), fechar o arquivo ${finalizeMs.toFixed(0)} ms`
    return { frames: total, encoder: encoderNote, timing }
  } finally {
    c.close()
  }
}

// ---------------------------------------------------------------------------
// Quadros avulsos (goldens e comparação prévia × exportação)

export type StillRequest = {
  projectId: string
  project: Project
  format: FormatSpec
  /** Instantes de ORIGEM (ms). */
  times: number[]
  screenUrl: string | null
  cameraUrl: string | null
  eventUrls: ExportJob['eventUrls']
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(s)
}

/** Renderiza quadros nos instantes pedidos (mesmo caminho da exportação) e devolve PNGs em base64. */
export async function renderStills(req: StillRequest): Promise<string[]> {
  const c = await createContext(req, req.format)
  try {
    const out: string[] = []
    for (const t of req.times) {
      const frames: FrameSet = {}
      const hold: FrameHold[] = []
      for (const [key, track] of [
        ['screen', c.screen],
        ['camera', c.camera]
      ] as const) {
        if (!track) continue
        const sample = await track.sink.getSample(fileTimeSeconds(t, track.offsetMs))
        const h = new FrameHold()
        h.update(sample)
        hold.push(h)
        frames[key] = h.source()
      }
      const scene = evaluateScene(c.project, c.derived, t, req.format)
      renderFrame(c.ctx, scene, frames, c.cache)
      const blob = await c.canvas.convertToBlob({ type: 'image/png' })
      out.push(toBase64(new Uint8Array(await blob.arrayBuffer())))
      for (const h of hold) h.close()
    }
    return out
  } finally {
    c.close()
  }
}

/**
 * Mede o custo por quadro da sombra da tela cheia: sprite em cache (9 fatias) × `shadowBlur` a cada
 * quadro. Só para o relatório e para os testes ("nunca shadowBlur por quadro: meça").
 */
export function measureShadowCost(width = 1920, height = 1080, frames = 120): { spriteMs: number; blurMs: number; builds: number } {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: false }) as unknown as Ctx2D
  const cache = createRenderCache(canvasFactory)
  const rect = { x: 65, y: 65, w: width - 130, h: height - 130 }
  const spec = { blur: 40, opacity: 0.45, offsetY: 16 }
  const clear = (): void => {
    ctx.fillStyle = '#202830'
    ctx.fillRect(0, 0, width, height)
  }
  clear()
  drawShadow(ctx, cache, rect, 18, spec) // aquecimento: cria o sprite
  const builds = cache.stats.shadowBuilds
  let t0 = performance.now()
  for (let i = 0; i < frames; i++) {
    clear()
    drawShadow(ctx, cache, rect, 18, spec)
  }
  ctx.getImageData(0, 0, 1, 1) // força a GPU a terminar antes de parar o relógio
  const spriteMs = (performance.now() - t0) / frames
  t0 = performance.now()
  for (let i = 0; i < frames; i++) {
    clear()
    ctx.save()
    ctx.shadowColor = `rgba(0,0,0,${spec.opacity})`
    ctx.shadowBlur = spec.blur
    ctx.shadowOffsetY = spec.offsetY
    ctx.fillStyle = '#000'
    roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 18)
    ctx.fill()
    ctx.restore()
  }
  ctx.getImageData(0, 0, 1, 1)
  const blurMs = (performance.now() - t0) / frames
  return { spriteMs, blurMs, builds }
}

// ---------------------------------------------------------------------------
// Ponto de entrada da janela escondida

declare global {
  interface Window {
    /** Ganchos de teste: disponíveis nas janelas `#export:*` e `#export-lab`. */
    tomadaExport?: { renderStills: typeof renderStills; measureShadowCost: typeof measureShadowCost }
  }
}

/** A janela `#export:<id>`: pede o job ao main, renderiza e avisa. Nunca deixa a falha calar. */
export async function runExporterWindow(exportId: string): Promise<void> {
  window.tomadaExport = { renderStills, measureShadowCost }
  const api = window.tomada.exportWorker
  const controller = new AbortController()
  try {
    const job = await api.job(exportId)
    const result = await renderVideoJob(job, {
      signal: controller.signal,
      write: (position, data) => api.write(exportId, position, data),
      onProgress: (frame, fps) => void api.progress(exportId, frame, fps).catch(() => undefined)
    })
    await api.finish(exportId, { ok: true, frames: result.frames, encoder: result.encoder, timing: result.timing })
  } catch (err) {
    window.tomada.log({ level: 'error', message: 'A exportação do vídeo falhou', detail: err instanceof Error ? (err.stack ?? err.message) : String(err) })
    await api.finish(exportId, { ok: false, message: `Não consegui renderizar o vídeo: ${messageOf(err)}` }).catch(() => undefined)
  }
}

/** A janela `#export-lab`: só expõe os ganchos de teste (nada é exportado). */
export function runExportLab(): void {
  window.tomadaExport = { renderStills, measureShadowCost }
}
