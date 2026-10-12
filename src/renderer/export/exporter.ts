/**
 * Renderização do vídeo (roda na janela ESCONDIDA de exportação, num processo próprio).
 *
 * mediabunny lê `media/screen.mp4`, `media/camera.mp4` e (só no layout Apresentador) `media/camera-matte.mp4` por `tomada-media://` (Range) e entrega os
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
import { dissolveSnapFrames } from '@shared/punch-in'
import { cameraVideoOffsetMs } from '@shared/camera-sync'
import { eventsFromText } from '@shared/events'
import { parseFaceTrack, type FaceTrack } from '@shared/face'
import type { ExportJob } from '@shared/ipc'
import { assertMediaUrl, mediaUrl } from '@shared/media-url'
import {
  createRenderCache,
  drawDissolve,
  drawShadow,
  renderFrame,
  roundedRectPath,
  type CanvasFactory,
  type Ctx2D,
  type FrameSet,
  type FrameSource,
  type RenderCache
} from '@shared/render'
import { applyScreenCrop, deriveProject, evaluateScene, prepareEvents, type Derived, type FormatSpec } from '@shared/scene'
import type { Project, Word } from '@shared/types'
import { ensureVertical, pinVerticalLayout, projectForFormat } from '@shared/vertical'
import { captionFontsLoaded, ensureCaptionFonts } from '../fonts'
import { samplesInBatches } from './bounded-samples'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function fetchText(url: string | null): Promise<string | undefined> {
  if (!url) return undefined
  const response = await fetch(assertMediaUrl(url)) // só arquivo do projeto, pelo protocolo do app
  if (!response.ok) throw new Error(`Não consegui ler ${url} (${response.status}).`)
  return response.text()
}

/** Uma fonte de vídeo aberta: o arquivo e o sink de amostras por timestamp. */
type Track = { input: Input; sink: VideoSampleSink; offsetMs: number }

async function openTrack(url: string | null, offsetMs: number): Promise<Track | null> {
  if (!url) return null
  const input = new Input({ source: new UrlSource(assertMediaUrl(url)), formats: ALL_FORMATS })
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

/** Um canvas do tamanho do quadro para guardar o último quadro de um trecho (dissolve de emenda). */
function createSnapshotCanvas(format: FormatSpec): { canvas: OffscreenCanvas; ctx: Ctx2D } {
  const canvas = new OffscreenCanvas(format.w, format.h)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Não consegui criar o canvas do dissolve de emenda.')
  return { canvas, ctx: ctx as unknown as Ctx2D }
}

/** Pré-carrega a imagem de fundo (se o estilo usa uma) para o cache do render. */
export async function loadBackgroundImage(project: Project, projectId: string, cache: RenderCache): Promise<void> {
  const bg = project.style.background
  if (bg.type !== 'image' || cache.images.has(bg.path)) return
  // só arquivo do PRÓPRIO projeto: o caminho é relativo e validado (http:, https:, file:, data:, `..` e absoluto lançam)
  const response = await fetch(assertMediaUrl(mediaUrl(projectId, bg.path)))
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
  /** O vídeo do recorte do fundo (máscara), só quando algum trecho usa o apresentador recortado. */
  matte: Track | null
  close(): void
}

async function createContext(
  job: Pick<ExportJob, 'projectId' | 'project' | 'screenUrl' | 'cameraUrl' | 'eventUrls' | 'clipLayout'> & { words?: Word[] | null; faceUrl?: string | null; matteUrl?: string | null },
  format: FormatSpec
): Promise<Context> {
  const [cursor, clicks, keys, contentRect, contentMap, faceText] = await Promise.all([
    fetchText(job.eventUrls.cursor),
    fetchText(job.eventUrls.clicks),
    fetchText(job.eventUrls.keys),
    fetchText(job.eventUrls.contentRect),
    fetchText(job.eventUrls.contentMap ?? null),
    fetchText(job.faceUrl ?? null)
  ])
  // A análise do rosto enquadra a câmera. Arquivo que existe e não abre é erro VISÍVEL (o enquadramento sairia diferente da prévia).
  let face: FaceTrack | null = null
  if (faceText !== undefined) {
    try {
      face = parseFaceTrack(faceText)
    } catch (err) {
      throw new Error(`Não consegui ler a análise do rosto da câmera (apague media/camera-face.json do projeto ou analise de novo): ${messageOf(err)}`)
    }
  }
  const events = eventsFromText({ cursor, clicks, keys, contentRect, contentMap })
  const doc = job.project
  const durationMs = Math.max(doc.sources.screen?.durationMs ?? 0, doc.sources.camera?.durationMs ?? 0, doc.sources.voice?.durationMs ?? 0, doc.sources.system?.durationMs ?? 0)
  const data = prepareEvents(events, durationMs)
  // As fontes das legendas ANTES do primeiro quadro: o canvas não espera fonte nem corrige depois (falha aqui = erro visível)
  await ensureCaptionFonts()
  // O vertical nunca editado ganha os zooms (Intenso) e os layouts por atividade, como o editor faria ao entrar no 9:16;
  // depois, a visão do formato: é sobre ela que a cena é calculada (a mesma coisa que a prévia faz)
  const ensured = format.kind === 'vertical' ? ensureVertical(doc, applyScreenCrop(data, doc), { durationMs, words: job.words, hasCursorEvents: Boolean(job.eventUrls.cursor), hasMatte: Boolean(job.matteUrl) }) : doc
  // Um corte vertical com layout fixo (V-A, V-B, V-C ou só câmera) o usa no corte todo; o automático segue a atividade (depois do ensure)
  const edited = format.kind === 'vertical' && job.clipLayout ? pinVerticalLayout(ensured, job.clipLayout) : ensured
  const project = projectForFormat(edited, format.kind)
  const derived = deriveProject(project, data, format, job.words, face)

  const canvas = new OffscreenCanvas(format.w, format.h)
  const raw = canvas.getContext('2d', { alpha: false })
  if (!raw) throw new Error('Não consegui criar o canvas de exportação.')
  const cache = createRenderCache(canvasFactory)
  await loadBackgroundImage(project, job.projectId, cache)

  // O apresentador recortado desenha a câmera pela máscara: sem ela o vídeo sairia com o fundo da webcam onde a prévia mostra a pessoa
  // recortada. Falha AQUI, com o que fazer, em vez de exportar um vídeo diferente do que a pessoa viu.
  if (derived.needsMatte && !job.matteUrl) {
    throw new Error(
      'O layout Apresentador precisa do recorte do fundo da câmera, e ele ainda não existe (ou é de outra gravação). Abra o projeto, espere o recorte terminar na aba Câmera e exporte de novo.'
    )
  }
  const screen = await openTrack(job.screenUrl, project.sync.screenOffsetMs)
  const camera = await openTrack(job.cameraUrl, cameraVideoOffsetMs(project))
  // o recorte do fundo nasce da câmera: o mesmo deslocamento (inclusive a correção de sincronia da imagem)
  const matte = derived.needsMatte ? await openTrack(job.matteUrl ?? null, cameraVideoOffsetMs(project)) : null
  return {
    project,
    format,
    derived,
    cache,
    canvas,
    ctx: raw as unknown as Ctx2D,
    screen,
    camera,
    matte,
    close() {
      closeTrack(screen)
      closeTrack(camera)
      closeTrack(matte)
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
  const format: FormatSpec = { kind: job.format ?? 'horizontal', w: job.width, h: job.height }
  const c = await createContext(job, format)
  const fps = job.fps
  let activeOutput: Output | null = null
  let finalized = false
  let screenIter: AsyncGenerator<VideoSample | null, void, unknown> | null = null
  let cameraIter: AsyncGenerator<VideoSample | null, void, unknown> | null = null
  let matteIter: AsyncGenerator<VideoSample | null, void, unknown> | null = null
  const screenHold = new FrameHold()
  const cameraHold = new FrameHold()
  const matteHold = new FrameHold()
  type Samples = [VideoSample | null, VideoSample | null, VideoSample | null]
  let pending: Promise<Samples> | null = null
  try {
    const { derived, project } = c
    const total = outputFrameCount(derived.outputDurationMs, fps)
    if (total === 0) throw new Error('Não há nada para exportar: todos os trechos foram cortados.')
    // cópia do último quadro antes de cada emenda que dissolve (só existe se alguma emenda dissolve)
    const snapFrames = dissolveSnapFrames(derived.seams, derived.dissolves, fps)
    let snapReady = false
    const snap = snapFrames.size > 0 ? createSnapshotCanvas(format) : null

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
    let acceleration = await pickAcceleration(codec, format.w, format.h, fps, job.bitrate)
    let { output, source } = makeOutput(acceleration)
    activeOutput = output
    try {
      await output.start()
    } catch (err) {
      // sem encoder por hardware: tenta o que o navegador oferecer (pode ser software)
      if (acceleration === 'no-preference') throw err
      await output.cancel().catch(() => undefined)
      acceleration = 'no-preference'
      encoderNote = `sem hardware (${messageOf(err)})`
      ;({ output, source } = makeOutput(acceleration))
      activeOutput = output
      await output.start()
    }

    const times = (offset: number) =>
      (async function* () {
        for (let i = 0; i < total; i++) yield fileTimeSeconds(sourceTimeOfFrame(i, fps, derived.kept), offset)
      })()
    // O pump do sink all-intra pode consumir todos os timestamps em paralelo
    // sem limitar seu primeiro pacote. Lotes finitos forçam flush e limitam
    // as amostras nativas a 32 por trilha, também em gravações longas.
    const screenTrack = c.screen, cameraTrack = c.camera, matteTrack = c.matte
    screenIter = screenTrack ? samplesInBatches(times(screenTrack.offsetMs), (batch) => screenTrack.sink.samplesAtTimestamps(batch)) : null
    cameraIter = cameraTrack ? samplesInBatches(times(cameraTrack.offsetMs), (batch) => cameraTrack.sink.samplesAtTimestamps(batch)) : null
    // a máscara anda nos MESMOS instantes da câmera (mesmo deslocamento, mesmos quadros)
    matteIter = matteTrack ? samplesInBatches(times(matteTrack.offsetMs), (batch) => matteTrack.sink.samplesAtTimestamps(batch)) : null

    const next = async (iter: AsyncGenerator<VideoSample | null, void, unknown> | null): Promise<VideoSample | null> => {
      if (!iter) return null
      const r = await iter.next()
      return r.done ? null : r.value
    }
    // decodifica o quadro i + 1 enquanto o i é desenhado e codificado
    const prefetch = (): Promise<Samples> => {
      const p = Promise.allSettled([next(screenIter), next(cameraIter), next(matteIter)]).then<Samples>((results) => {
        const failed = results.find((r) => r.status === 'rejected')
        if (failed) {
          // As outras trilhas podem já ter decodificado: não perca as amostras
          // quando só uma rejeita, como aconteceria com Promise.all.
          for (const r of results) if (r.status === 'fulfilled') r.value?.close()
          throw (failed as PromiseRejectedResult).reason
        }
        return results.map((r) => (r as PromiseFulfilledResult<VideoSample | null>).value) as Samples
      })
      // O encoder pode falhar antes do próximo await: observa já a rejeição,
      // mas mantém o erro no próprio promise para a iteração/limpeza.
      void p.catch(() => undefined)
      return p
    }
    pending = prefetch()
    const meter = new FpsMeter()
    let lastReport = 0
    // onde o tempo vai (ms acumulados): esperar a decodificação, copiar o quadro, desenhar, esperar o encoder
    const spent = { decode: 0, hold: 0, draw: 0, encode: 0 }
    const startedAt = performance.now()

    for (let i = 0; i < total; i++) {
      if (io.signal?.aborted) {
        throw new Error('Exportação cancelada.')
      }
      let t0 = performance.now()
      if (!pending) throw new Error('Não consegui obter o próximo quadro da exportação.')
      const [s, cam, mat] = await pending
      pending = null
      spent.decode += performance.now() - t0
      if (i + 1 < total) pending = prefetch()
      t0 = performance.now()
      screenHold.update(s)
      cameraHold.update(cam)
      matteHold.update(mat)
      spent.hold += performance.now() - t0
      t0 = performance.now()

      const scene = evaluateScene(project, derived, sourceTimeOfFrame(i, fps, derived.kept), format)
      const frames: FrameSet = { screen: screenHold.source(), camera: cameraHold.source(), matte: matteHold.source() }
      renderFrame(c.ctx, scene, frames, c.cache)
      // Dissolve de emenda (F1): o último quadro do trecho anterior se desfaz sobre o novo (só quando o cortado tem ≥ 1 s e a tela mudou)
      if (snap) {
        if (scene.dissolve > 0 && snapReady) drawDissolve(c.ctx, snap.canvas, scene.dissolve)
        if (snapFrames.has(i)) {
          snap.ctx.drawImage(c.canvas, 0, 0)
          snapReady = true
        }
      }
      spent.draw += performance.now() - t0
      t0 = performance.now()
      try {
        await source.add(i / fps, 1 / fps)
      } catch (err) {
        // mediabunny cria o encoder no PRIMEIRO add, não em output.start().
        // Ainda não há quadros gravados: pode repetir o mesmo canvas/timestamp.
        if (i !== 0 || acceleration !== 'prefer-hardware') throw err
        await output.cancel().catch(() => undefined)
        acceleration = 'no-preference'
        encoderNote = `sem hardware (${messageOf(err)})`
        ;({ output, source } = makeOutput(acceleration))
        activeOutput = output
        await output.start()
        await source.add(i / fps, 1 / fps)
      }
      spent.encode += performance.now() - t0

      const now = performance.now()
      if (now - lastReport > 250 || i === total - 1) {
        lastReport = now
        io.onProgress?.(i + 1, meter.tick(i + 1))
      }
    }
    const tFinal = performance.now()
    await output.finalize()
    finalized = true
    const finalizeMs = performance.now() - tFinal
    const wall = performance.now() - startedAt
    const per = (ms: number): string => (ms / total).toFixed(2)
    const timing =
      `por quadro (ms): espera da decodificação ${per(spent.decode)}, cópia ${per(spent.hold)}, desenho ${per(spent.draw)}, espera do encoder ${per(spent.encode)}; ` +
      `total ${(wall / total).toFixed(2)} (${((total / wall) * 1000).toFixed(1)} qps), fechar o arquivo ${finalizeMs.toFixed(0)} ms`
    return { frames: total, encoder: encoderNote, timing }
  } finally {
    screenHold.close()
    cameraHold.close()
    matteHold.close()
    c.close()
    if (activeOutput && !finalized) await activeOutput.cancel().catch(() => undefined)
    if (pending) await pending.then(([s, cam, mat]) => { s?.close(); cam?.close(); mat?.close() }, () => undefined)
    await Promise.allSettled([screenIter?.return(), cameraIter?.return(), matteIter?.return()])
  }
}

// ---------------------------------------------------------------------------
// Quadros avulsos (goldens e comparação prévia × exportação)

export type StillRequest = {
  projectId: string
  project: Project
  format: FormatSpec
  /** As palavras da transcrição (legendas), se a cena as usa. */
  words?: Word[] | null
  /** Instantes de ORIGEM (ms). */
  times: number[]
  screenUrl: string | null
  cameraUrl: string | null
  eventUrls: ExportJob['eventUrls']
  /** A análise do rosto (enquadramento da câmera), se existe. */
  faceUrl?: string | null
  /** O vídeo do recorte do fundo (a máscara), se o layout Apresentador é usado. */
  matteUrl?: string | null
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
        ['camera', c.camera],
        ['matte', c.matte]
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
    tomadaExport?: { renderStills: typeof renderStills; measureShadowCost: typeof measureShadowCost; captionFontsLoaded: typeof captionFontsLoaded; ensureCaptionFonts: typeof ensureCaptionFonts }
  }
}

/** A janela `#export:<id>`: pede o job ao main, renderiza e avisa. Nunca deixa a falha calar. */
export async function runExporterWindow(exportId: string): Promise<void> {
  window.tomadaExport = { renderStills, measureShadowCost, captionFontsLoaded, ensureCaptionFonts }
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
  window.tomadaExport = { renderStills, measureShadowCost, captionFontsLoaded, ensureCaptionFonts }
}
