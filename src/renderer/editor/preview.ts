/**
 * Motor da PRÉVIA: toca os `<video>` (tela e câmera) e, a cada quadro da tela, desenha no canvas com as
 * MESMAS `evaluateScene` + `renderFrame` da exportação (prévia = exportação por construção). Pula os
 * trechos cortados, mantém a câmera alinhada com a tela e expõe o tempo em tempo de SAÍDA.
 */
import { createRenderCache, renderFrame, type CanvasFactory, type Ctx2D, type FrameSource, type RenderCache } from '@shared/render'
import { evaluateScene, type Derived, type FormatSpec } from '@shared/scene'
import { outputToSource, rangesLength, sourceToOutput } from '@shared/timeline'
import type { Project } from '@shared/types'

export type PreviewOptions = {
  canvas: HTMLCanvasElement
  screen: HTMLVideoElement | null
  camera: HTMLVideoElement | null
  /** Chamado ~20×/s com o tempo de saída (ms) e se está tocando. */
  onTime(outputMs: number, playing: boolean): void
  /** Falha ao tocar (o motivo vai para a tela). */
  onError(message: string): void
}

const canvasFactory: CanvasFactory = (w, h) => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c as unknown as ReturnType<CanvasFactory>
}

/** Câmera mais de 150 ms fora do lugar em relação à tela é realinhada. */
const DRIFT_SECONDS = 0.15

export class PreviewEngine {
  private readonly o: PreviewOptions
  private ctx: Ctx2D
  private cache: RenderCache
  private project: Project | null = null
  private derived: Derived | null = null
  private raf = 0
  private dirty = true
  private playing = false
  /** Instante de origem mostrado quando está parado (e alvo do último seek). */
  private sourceMs = 0
  private lastReport = 0
  private frames = 0
  private destroyed = false
  private readonly unsubscribe: (() => void)[] = []

  constructor(options: PreviewOptions) {
    this.o = options
    const ctx = options.canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Não consegui criar o canvas da prévia.')
    this.ctx = ctx as unknown as Ctx2D
    this.cache = createRenderCache(canvasFactory)
    for (const v of [options.screen, options.camera]) {
      if (!v) continue
      for (const ev of ['seeked', 'loadeddata', 'canplay', 'playing'] as const) {
        const h = (): void => {
          this.dirty = true
        }
        v.addEventListener(ev, h)
        this.unsubscribe.push(() => v.removeEventListener(ev, h))
      }
    }
    this.raf = requestAnimationFrame(this.tick)
  }

  // --- estado ------------------------------------------------------------------------------------
  setScene(project: Project, derived: Derived): void {
    this.project = project
    this.derived = derived
    this.dirty = true
  }

  /** Redimensiona o canvas (px reais) e refaz o quadro. */
  setSize(w: number, h: number): void {
    const cw = Math.max(2, Math.round(w / 2) * 2)
    const ch = Math.max(2, Math.round(h / 2) * 2)
    if (this.o.canvas.width !== cw || this.o.canvas.height !== ch) {
      this.o.canvas.width = cw
      this.o.canvas.height = ch
      const ctx = this.o.canvas.getContext('2d', { alpha: false })
      if (ctx) this.ctx = ctx as unknown as Ctx2D
      this.dirty = true
    }
  }

  /** Pré-carrega a imagem de fundo do estilo (a primeira vez). */
  setBackgroundImage(path: string, image: FrameSource): void {
    this.cache.images.set(path, image)
    this.cache.backgrounds.clear()
    this.dirty = true
  }

  get isPlaying(): boolean {
    return this.playing
  }

  /** Tempo atual em ms de SAÍDA. */
  get outputMs(): number {
    if (!this.derived) return 0
    return sourceToOutput(this.currentSourceMs(), this.derived.kept)
  }

  // --- relógio -----------------------------------------------------------------------------------
  private master(): HTMLVideoElement | null {
    return this.o.screen ?? this.o.camera
  }

  private offsetOf(v: HTMLVideoElement | null): number {
    if (!v || !this.project) return 0
    return v === this.o.screen ? this.project.sync.screenOffsetMs : this.project.sync.cameraOffsetMs
  }

  /** Instante de origem (ms): o do vídeo principal enquanto toca; o do último seek parado. */
  private currentSourceMs(): number {
    const m = this.master()
    if (this.playing && m) return m.currentTime * 1000 + this.offsetOf(m)
    return this.sourceMs
  }

  private seekSource(ms: number): void {
    this.sourceMs = ms
    for (const v of [this.o.screen, this.o.camera]) {
      if (!v) continue
      const file = Math.max(0, (ms - this.offsetOf(v)) / 1000)
      const dur = Number.isFinite(v.duration) ? v.duration : file
      v.currentTime = Math.min(file, dur)
    }
    this.dirty = true
  }

  seekOutput(outMs: number): void {
    if (!this.derived) return
    this.seekSource(outputToSource(Math.max(0, outMs), this.derived.kept))
  }

  async play(): Promise<void> {
    const d = this.derived
    if (!d || d.kept.length === 0) return
    // no fim: recomeça
    const total = rangesLength(d.kept)
    if (this.outputMs >= total - 40) this.seekOutput(0)
    const videos = [this.o.screen, this.o.camera].filter((v): v is HTMLVideoElement => v !== null)
    try {
      this.playing = true
      await Promise.all(videos.map((v) => v.play()))
    } catch (err) {
      this.playing = false
      for (const v of videos) v.pause()
      this.o.onError(err instanceof Error ? err.message : String(err))
    }
    this.o.onTime(this.outputMs, this.playing)
  }

  pause(): void {
    if (this.playing) this.sourceMs = this.currentSourceMs()
    this.playing = false
    for (const v of [this.o.screen, this.o.camera]) v?.pause()
    this.dirty = true
    this.o.onTime(this.outputMs, false)
  }

  // --- laço --------------------------------------------------------------------------------------
  private tick = (): void => {
    if (this.destroyed) return
    this.raf = requestAnimationFrame(this.tick)
    const d = this.derived
    const project = this.project
    if (!d || !project) return

    const master = this.master()
    if (this.playing && master) {
      const t = master.currentTime * 1000 + this.offsetOf(master)
      // pula os trechos cortados
      const inKept = d.kept.some((r) => t >= r.start && t < r.end)
      if (!inKept) {
        const next = d.kept.find((r) => r.start > t)
        if (next) this.seekSource(next.start)
        else {
          this.pause()
          const last = d.kept[d.kept.length - 1]
          if (last) this.seekSource(Math.max(0, last.end - 1))
        }
      } else if (master.ended) {
        this.pause()
      } else {
        // a câmera acompanha a tela
        const cam = this.o.camera
        if (cam && cam !== master) {
          const want = Math.max(0, (t - this.offsetOf(cam)) / 1000)
          if (Math.abs(cam.currentTime - want) > DRIFT_SECONDS) cam.currentTime = want
        }
      }
      this.dirty = true
    }

    const busy = [this.o.screen, this.o.camera].some((v) => v && (v.seeking || v.readyState < 2))
    if (!this.dirty && !busy) return
    this.draw()
    if (!busy && !this.playing) this.dirty = false

    const now = performance.now()
    if (now - this.lastReport > 50) {
      this.lastReport = now
      this.o.onTime(this.outputMs, this.playing)
    }
  }

  private source(v: HTMLVideoElement | null): FrameSource | null {
    if (!v || v.readyState < 2 || !(v.videoWidth > 0)) return null
    return { image: v, w: v.videoWidth, h: v.videoHeight }
  }

  private draw(): void {
    const d = this.derived
    const project = this.project
    if (!d || !project) return
    const canvas = this.o.canvas
    const format: FormatSpec = { kind: 'horizontal', w: canvas.width, h: canvas.height }
    const t = this.currentSourceMs()
    const scene = evaluateScene(project, d, t, format)
    renderFrame(this.ctx, scene, { screen: this.source(this.o.screen), camera: this.source(this.o.camera) }, this.cache)
    this.frames++
    const busy = [this.o.screen, this.o.camera].some((v) => v && (v.seeking || v.readyState < 2))
    canvas.dataset.sourceMs = t.toFixed(1)
    canvas.dataset.frames = String(this.frames)
    canvas.dataset.ready = busy ? 'false' : 'true'
  }

  destroy(): void {
    this.destroyed = true
    cancelAnimationFrame(this.raf)
    for (const u of this.unsubscribe) u()
    this.pause()
  }
}
