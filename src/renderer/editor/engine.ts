/**
 * Motor da PRÉVIA do editor: um RELÓGIO ÚNICO (tempo de origem, em ms) e três mídias que o seguem - o vídeo
 * da tela, o vídeo da câmera e o áudio (a voz tratada). A cada quadro desenha no canvas com as MESMAS
 * `evaluateScene` + `renderFrame` da exportação (prévia = exportação por construção).
 *
 *  - O relógio é do motor, não de um `<video>`: avança com o tempo real, PULA os trechos cortados e SEGURA
 *    (não avança) enquanto uma mídia está buscando ou ainda não começou, para a imagem nunca correr à frente
 *    do que já foi decodificado.
 *  - Cada mídia é comparada com o relógio a cada quadro. Até 1,5 quadro de diferença é tolerado; acima, a
 *    velocidade da mídia é ajustada (6%) para alcançá-lo sem pular; acima de 400 ms, busca direto.
 *  - Nos cortes cada vídeo tem uma SEGUNDA cópia parada no início do próximo trecho (pré-busca, 700 ms
 *    antes da emenda): na emenda as cópias trocam de papel, sem esperar busca nenhuma.
 *  - J/K/L: para a frente a 1×, 2×, 4× (velocidade das mídias); para trás o relógio anda e as mídias são
 *    buscadas a cada ~90 ms (um `<video>` não toca ao contrário).
 *
 * Tudo que é regra (avanço, deriva, pré-busca) está em `@shared/playback` e tem teste de unidade.
 */
import { createRenderCache, renderFrame, type CanvasFactory, type Ctx2D, type FrameSource, type RenderCache } from '@shared/render'
import { evaluateScene, type Derived, type FormatSpec, type Scene } from '@shared/scene'
import {
  DRIFT_SETTLE_FRAMES,
  advanceClock,
  driftFix,
  frameDurationMs,
  prefetchTarget,
  shuttleRate,
  stepOutputMs
} from '@shared/playback'
import { outputToSource, rangesLength, sourceToOutput } from '@shared/timeline'
import type { Project } from '@shared/types'
import { cameraVideoOffsetMs } from '@shared/camera-sync'
import { captionFontsLoaded, ensureCaptionFonts } from '../fonts'
import type { PlaybackStore } from './playback-store'

const canvasFactory: CanvasFactory = (w, h) => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c as unknown as ReturnType<CanvasFactory>
}

/** Quanto antes da emenda a segunda cópia do vídeo é posicionada. */
const PREFETCH_LEAD_MS = 700
/** O relógio espera as mídias começarem a tocar por, no máximo, isto. */
const START_HOLD_MAX_MS = 900
/** Andando para trás, as mídias são buscadas a cada tanto. */
const REVERSE_SEEK_MS = 90
/** O áudio alcança o relógio com um ajuste maior que o do vídeo (a deriva dele é a que se ouve). */
const AUDIO_NUDGE = 0.08

/** `matte` = o vídeo do recorte do fundo da câmera (M4c): anda junto da câmera, no mesmo relógio e com o mesmo deslocamento. */
type MediaKind = 'screen' | 'camera' | 'matte'

/** Uma fonte de vídeo: o elemento que está no ar e, quando há cortes, a cópia que espera a emenda. */
class VideoTrack {
  active: HTMLVideoElement
  private spare: HTMLVideoElement | null = null
  nudging = false

  constructor(
    readonly kind: MediaKind,
    readonly url: string,
    private readonly host: HTMLElement,
    private readonly onEvent: () => void,
    private readonly onError: (kind: MediaKind, element: HTMLVideoElement) => void
  ) {
    this.active = this.make('active')
  }

  private make(role: 'active' | 'standby'): HTMLVideoElement {
    const v = document.createElement('video')
    // O protocolo local já responde CORS: a prévia precisa de pixels legíveis
    // para a proteção destrutiva, inclusive no vídeo de espera da emenda.
    v.crossOrigin = 'anonymous'
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.className = 'preview-source'
    v.dataset.role = role
    v.dataset.testid = role === 'active' ? `video-${this.kind}` : `video-${this.kind}-standby`
    for (const ev of ['seeked', 'loadeddata', 'canplay', 'playing'] as const) v.addEventListener(ev, this.onEvent)
    v.addEventListener('error', () => this.onError(this.kind, v))
    v.src = this.url
    this.host.appendChild(v)
    return v
  }

  /** A cópia de espera (criada só quando o primeiro corte chega perto). */
  get standby(): HTMLVideoElement {
    if (!this.spare) this.spare = this.make('standby')
    return this.spare
  }

  get hasStandby(): boolean {
    return this.spare !== null
  }

  swap(): void {
    if (!this.spare) return
    const old = this.active
    this.active = this.spare
    this.spare = old
    this.active.dataset.role = 'active'
    this.active.dataset.testid = `video-${this.kind}`
    old.dataset.role = 'standby'
    old.dataset.testid = `video-${this.kind}-standby`
  }

  dispose(): void {
    for (const v of [this.active, this.spare]) {
      if (!v) continue
      v.pause()
      v.removeAttribute('src')
      v.load()
      v.remove()
    }
    this.spare = null
  }
}

export type EngineOptions = {
  canvas: HTMLCanvasElement
  /** Onde os elementos de mídia (invisíveis) ficam na página. */
  host: HTMLElement
  screenUrl: string | null
  cameraUrl: string | null
  playback: PlaybackStore
  /** Falha de mídia (arquivo que não abre, play recusado): o motivo vai para a tela. */
  onError(message: string): void
  onAudioError(message: string | null): void
  /** As fontes das legendas não carregaram: a legenda não aparece, e a pessoa precisa saber por quê. */
  onFontsError?(message: string): void
}

export class PreviewEngine {
  private readonly o: EngineOptions
  private ctx: Ctx2D
  private cache: RenderCache
  private project: Project | null = null
  private derived: Derived | null = null
  private readonly tracks: VideoTrack[] = []
  private audio: HTMLAudioElement | null = null
  private audioOffsetMs = 0
  private audioNudging = false
  /** Trechos em que a voz fica muda (muletas silenciadas): ordenados, só os ligados. */
  private mutes: { start: number; end: number }[] = []

  private raf = 0
  private lastNow = 0
  private dirty = true
  /** O erro mostrado agora veio do vídeo do recorte do fundo: trocar ou tirar a máscara (`setMatte`) o resolve. */
  private matteFailed = false
  private destroyed = false
  private frames = 0
  private lastScene: Scene | null = null

  /** O relógio: instante de ORIGEM (ms). */
  private sourceMs = 0
  private playing = false
  private rate = 0
  /** Depois de tocar/buscar o relógio espera as mídias começarem a andar. */
  private waiting: { since: number; marks: Map<HTMLMediaElement, number> } | null = null
  private prefetched: { index: number; start: number } | null = null
  private lastReverseSeek = 0
  private lastPublished = ''

  constructor(options: EngineOptions) {
    this.o = options
    const ctx = options.canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Não consegui criar o canvas da prévia.')
    this.ctx = ctx as unknown as Ctx2D
    this.cache = createRenderCache(canvasFactory)
    // a legenda só é desenhada com as fontes carregadas (nunca com a fonte errada)
    this.cache.fontsReady = captionFontsLoaded()
    if (!this.cache.fontsReady) {
      void ensureCaptionFonts().then(
        () => {
          this.cache.fontsReady = true
          this.dirty = true
        },
        (err: unknown) => options.onFontsError?.(err instanceof Error ? err.message : String(err))
      )
    }
    const mark = (): void => {
      this.dirty = true
    }
    if (options.screenUrl) this.tracks.push(new VideoTrack('screen', options.screenUrl, options.host, mark, (k, el) => this.mediaFailed(k, el)))
    if (options.cameraUrl) this.tracks.push(new VideoTrack('camera', options.cameraUrl, options.host, mark, (k, el) => this.mediaFailed(k, el)))
    this.lastNow = performance.now()
    this.raf = requestAnimationFrame(this.tick)
  }

  // --- configuração -----------------------------------------------------------------------------------
  /**
   * O recorte do fundo da câmera (o vídeo da máscara): liga ou troca a trilha, que passa a andar com a câmera. `null` desliga.
   * Sem a máscara o layout Apresentador mostra a janela da câmera inteira (o motivo está na aba Câmera).
   */
  setMatte(url: string | null): void {
    const old = this.tracks.findIndex((t) => t.kind === 'matte')
    if (old >= 0) {
      if (url !== null && this.tracks[old]!.url === url) return
      this.tracks[old]!.dispose()
      this.tracks.splice(old, 1)
    }
    if (this.matteFailed) {
      // a máscara que não abria saiu (layout que não a usa, ou "Recortar de novo" gerou outra): o erro dela não vale mais
      this.matteFailed = false
      this.setError(null)
    }
    if (url) {
      const track = new VideoTrack('matte', url, this.o.host, () => (this.dirty = true), (k, el) => this.mediaFailed(k, el))
      this.tracks.push(track)
      const want = this.fileSeconds('matte', track.active, this.sourceMs)
      track.active.currentTime = want
      if (this.playing && this.rate > 0) {
        track.active.playbackRate = this.rate
        void track.active.play().catch(() => undefined)
      }
    }
    this.dirty = true
  }

  setScene(project: Project, derived: Derived): void {
    const oldCameraOffset = this.project ? cameraVideoOffsetMs(this.project) : null
    this.project = project
    this.derived = derived
    this.mutes = (project.mutes ?? []).filter((m) => m.enabled && m.end > m.start).map((m) => ({ start: m.start, end: m.end })).sort((a, b) => a.start - b.start)
    this.dirty = true
    // cortes novos mudam a emenda: a pré-busca antiga pode apontar para o lugar errado
    this.prefetched = null
    // Mesmo pausada, a câmera deve buscar o quadro novo quando o usuário corrige a sincronia.
    if (oldCameraOffset !== cameraVideoOffsetMs(project)) {
      for (const track of this.tracks) {
        if (track.kind !== 'camera') continue
        track.active.currentTime = this.fileSeconds('camera', track.active, this.sourceMs)
      }
    }
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

  setBackgroundImage(path: string, image: FrameSource): void {
    this.cache.images.set(path, image)
    this.cache.backgrounds.clear()
    this.dirty = true
  }

  /**
   * O áudio da prévia. `offsetMs` é o instante do relógio da gravação em que o tempo 0 do ARQUIVO acontece
   * (voz crua: `sync.cameraOffsetMs`; voz tratada: 0, ela já nasce alinhada ao relógio).
   */
  setAudio(url: string | null, offsetMs: number, treated: boolean): void {
    const wasPlaying = this.playing && this.rate > 0
    if (!url) {
      if (this.audio) {
        this.audio.pause()
        this.audio.remove()
        this.audio = null
      }
      return
    }
    if (!this.audio) {
      const a = document.createElement('audio')
      a.preload = 'auto'
      a.preservesPitch = true
      a.dataset.testid = 'preview-audio'
      a.addEventListener('error', () => {
        const code = a.error ? `${a.error.code}: ${a.error.message}` : 'erro desconhecido'
        this.o.onAudioError(`O áudio da prévia não abriu (${code}).`)
      })
      this.o.host.appendChild(a)
      this.audio = a
    }
    this.audioOffsetMs = offsetMs
    this.audioNudging = false
    this.o.onAudioError(null)
    this.audio.src = url
    this.audio.dataset.treated = String(treated)
    this.audio.load()
    this.audio.currentTime = this.audioSeconds(this.sourceMs)
    this.o.playback.setState({ audioTreated: treated })
    if (wasPlaying) {
      this.audio.muted = this.rate !== 1
      this.audio.playbackRate = this.rate
      void this.audio.play().catch((err: unknown) => this.o.onAudioError(`O áudio da prévia não tocou (${err instanceof Error ? err.message : String(err)}).`))
    }
  }

  // --- leitura -----------------------------------------------------------------------------------------
  get isPlaying(): boolean {
    return this.playing
  }

  get currentRate(): number {
    return this.playing ? this.rate : 0
  }

  get canvas(): HTMLCanvasElement {
    return this.o.canvas
  }

  /** Tempo atual em ms de SAÍDA. */
  get outputMs(): number {
    return this.derived ? sourceToOutput(this.sourceMs, this.derived.kept) : 0
  }

  get sourceTimeMs(): number {
    return this.sourceMs
  }

  /** A cena do último quadro desenhado (para acertar cliques na prévia). */
  get scene(): Scene | null {
    return this.lastScene
  }

  // --- conversões ------------------------------------------------------------------------------------
  private offsetOf(kind: MediaKind): number {
    if (!this.project) return 0
    // o recorte do fundo nasce da câmera: o mesmo deslocamento (e a mesma correção de sincronia da imagem)
    return kind === 'screen' ? this.project.sync.screenOffsetMs : cameraVideoOffsetMs(this.project)
  }

  private fileSeconds(kind: MediaKind, el: HTMLVideoElement, sourceMs: number): number {
    const s = Math.max(0, (sourceMs - this.offsetOf(kind)) / 1000)
    return Number.isFinite(el.duration) ? Math.min(s, el.duration) : s
  }

  private audioSeconds(sourceMs: number): number {
    const s = Math.max(0, (sourceMs - this.audioOffsetMs) / 1000)
    const d = this.audio?.duration
    return d !== undefined && Number.isFinite(d) ? Math.min(s, d) : s
  }

  private frameMs(): number {
    return frameDurationMs(this.project?.sources.screen?.fps ?? this.project?.sources.camera?.fps)
  }

  // --- transporte ------------------------------------------------------------------------------------
  /**
   * Toca para a frente (ou para trás, com taxa negativa). `source` diz DE ONDE veio o pedido (`key:Space`, `key:KeyL`, `button`…):
   * fica em `data-play-source` do canvas, com a contagem em `data-play-count`. A prévia nunca começa sozinha, só por um destes
   * pedidos; se alguma vez tocar "sem ninguém pedir" (era o sintoma de um teste intermitente), o canvas diz quem pediu.
   */
  play(rate = 1, source = 'api'): void {
    const d = this.derived
    if (!d || d.kept.length === 0) return
    this.o.canvas.dataset.playSource = source
    this.o.canvas.dataset.playCount = String(Number(this.o.canvas.dataset.playCount ?? '0') + 1)
    this.setError(null)
    if (rate > 0 && this.outputMs >= rangesLength(d.kept) - 40) this.seekSource(outputToSource(0, d.kept))
    this.rate = rate
    this.playing = true
    this.prefetched = null
    this.seekMedia(this.sourceMs)
    if (rate > 0) {
      const marks = new Map<HTMLMediaElement, number>()
      for (const t of this.tracks) {
        const v = t.active
        v.playbackRate = rate
        marks.set(v, v.currentTime)
        void v.play().catch((err: unknown) => this.fail(`Não consegui reproduzir o vídeo (${err instanceof Error ? err.message : String(err)}).`))
      }
      const a = this.audio
      if (a) {
        a.muted = rate !== 1
        a.playbackRate = rate
        marks.set(a, a.currentTime)
        void a.play().catch((err: unknown) => this.o.onAudioError(`O áudio da prévia não tocou (${err instanceof Error ? err.message : String(err)}).`))
      }
      this.waiting = { since: performance.now(), marks }
    } else {
      this.waiting = null
      for (const t of this.tracks) t.active.pause()
      this.audio?.pause()
    }
    this.lastNow = performance.now()
    this.publish(true)
  }

  pause(): void {
    const was = this.playing
    this.playing = false
    this.rate = 0
    this.waiting = null
    this.prefetched = null
    for (const t of this.tracks) {
      t.active.pause()
      t.active.playbackRate = 1
      t.nudging = false
      if (t.hasStandby) t.standby.pause()
    }
    if (this.audio) {
      this.audio.pause()
      this.audio.playbackRate = 1
      this.audio.muted = false
    }
    // a imagem parada é exatamente a do relógio (a deriva de uma pausa não vira "pulo")
    if (was) this.seekMedia(this.sourceMs)
    this.dirty = true
    this.publish(true)
  }

  toggle(source = 'api'): void {
    if (this.playing) this.pause()
    else this.play(1, source)
  }

  /** J/K/L estilo ilha de edição. */
  shuttle(key: 'J' | 'K' | 'L', source = 'api'): void {
    const next = shuttleRate(this.currentRate, key)
    if (next === 0) this.pause()
    else this.play(next, source)
  }

  seekSource(ms: number): void {
    const d = this.derived
    const max = d ? d.durationMs : Number.POSITIVE_INFINITY
    this.sourceMs = Math.min(max, Math.max(0, ms))
    this.prefetched = null
    this.seekMedia(this.sourceMs)
    if (this.playing && this.rate > 0) this.hold()
    this.dirty = true
    this.publish(true)
  }

  seekOutput(outMs: number): void {
    const d = this.derived
    if (!d) return
    this.seekSource(outputToSource(Math.max(0, outMs), d.kept))
  }

  /** Anda `frames` quadros no tempo de SAÍDA (←/→). */
  stepFrames(frames: number): void {
    const d = this.derived
    if (!d) return
    if (this.playing) this.pause()
    const total = rangesLength(d.kept)
    this.seekOutput(stepOutputMs(this.outputMs, frames, this.project?.sources.screen?.fps ?? this.project?.sources.camera?.fps, total))
  }

  /** Salta `seconds` segundos no tempo de SAÍDA (Shift+←/→). */
  stepSeconds(seconds: number): void {
    const d = this.derived
    if (!d) return
    const total = rangesLength(d.kept)
    this.seekOutput(Math.min(total, Math.max(0, this.outputMs + seconds * 1000)))
  }

  /** Vai para o começo (Home) ou o fim (End) do vídeo de saída. */
  jumpTo(where: 'start' | 'end'): void {
    const d = this.derived
    if (!d) return
    if (this.playing) this.pause()
    this.seekOutput(where === 'start' ? 0 : Math.max(0, rangesLength(d.kept) - 1))
  }

  private hold(): void {
    const marks = new Map<HTMLMediaElement, number>()
    for (const t of this.tracks) marks.set(t.active, t.active.currentTime)
    if (this.audio) marks.set(this.audio, this.audio.currentTime)
    this.waiting = { since: performance.now(), marks }
  }

  // --- mídias ------------------------------------------------------------------------------------------
  private seekMedia(sourceMs: number): void {
    for (const t of this.tracks) {
      const v = t.active
      const want = this.fileSeconds(t.kind, v, sourceMs)
      if (Math.abs(v.currentTime - want) > 0.0005) v.currentTime = want
    }
    if (this.audio) {
      const want = this.audioSeconds(sourceMs)
      if (Math.abs(this.audio.currentTime - want) > 0.0005) this.audio.currentTime = want
    }
  }

  private mediaBusy(): boolean {
    for (const t of this.tracks) {
      const v = t.active
      if (v.error) continue
      if (v.seeking || v.readyState < 2) return true
    }
    return false
  }

  /** As mídias já começaram a andar? (o `currentTime` saiu do lugar, ou terminou, ou deu erro) */
  private started(): boolean {
    const w = this.waiting
    if (!w) return true
    for (const [el, t0] of w.marks) {
      if (el.error || el.ended) continue
      if (el.seeking) return false
      if (el.currentTime === t0) return false
    }
    return true
  }

  /** Mantém cada mídia junto do relógio: tolera 1,5 quadro, ajusta a velocidade até 400 ms, busca acima. */
  private syncMedia(): void {
    const frame = this.frameMs()
    const rate = this.rate
    for (const t of this.tracks) {
      const v = t.active
      if (v.error || v.seeking || v.ended) continue
      if (v.paused && rate > 0) void v.play().catch(() => undefined)
      const want = this.fileSeconds(t.kind, v, this.sourceMs)
      const fix = driftFix((v.currentTime - want) * 1000, frame, rate, t.nudging ? { toleranceFrames: DRIFT_SETTLE_FRAMES } : {})
      if (fix.kind === 'seek') {
        v.currentTime = want
        t.nudging = false
      } else {
        t.nudging = fix.kind === 'nudge'
        if (Math.abs(v.playbackRate - fix.rate) > 1e-6) v.playbackRate = fix.rate
      }
    }
    const a = this.audio
    // muleta silenciada: a voz fica muda enquanto o relógio está dentro do trecho (a imagem e o tempo seguem)
    if (a) {
      const wantVolume = this.mutes.some((m) => this.sourceMs >= m.start && this.sourceMs < m.end) ? 0 : 1
      if (a.volume !== wantVolume) a.volume = wantVolume
    }
    if (a && !a.error && !a.seeking && !a.ended && a.readyState >= 1) {
      const want = this.audioSeconds(this.sourceMs)
      const fix = driftFix((a.currentTime - want) * 1000, frame, rate, {
        nudge: AUDIO_NUDGE,
        ...(this.audioNudging ? { toleranceFrames: DRIFT_SETTLE_FRAMES } : {})
      })
      if (fix.kind === 'seek') {
        a.currentTime = want
        this.audioNudging = false
      } else {
        this.audioNudging = fix.kind === 'nudge'
        if (Math.abs(a.playbackRate - fix.rate) > 1e-6) a.playbackRate = fix.rate
      }
    }
  }

  /** Perto da emenda de um corte: deixa a segunda cópia de cada vídeo parada no início do próximo trecho. */
  private prefetch(): void {
    const d = this.derived
    if (!d || this.rate <= 0) return
    const target = prefetchTarget(d.kept, this.sourceMs, PREFETCH_LEAD_MS * this.rate)
    if (!target || this.prefetched?.index === target.index) return
    this.prefetched = target
    for (const t of this.tracks) {
      if (t.active.error) continue
      const s = t.standby
      s.pause()
      s.playbackRate = this.rate
      s.currentTime = this.fileSeconds(t.kind, s, target.start)
    }
  }

  /** O relógio caiu num corte e pulou para `to`: usa a cópia pré-posicionada, ou busca. */
  private jumpClock(to: number): void {
    const pre = this.prefetched
    this.prefetched = null
    for (const t of this.tracks) {
      const v = t.active
      if (pre && pre.start === to && t.hasStandby) {
        const s = t.standby
        const want = this.fileSeconds(t.kind, s, to)
        if (!s.seeking && s.readyState >= 2 && Math.abs(s.currentTime - want) < 0.25) {
          s.playbackRate = this.rate
          void s.play().catch(() => undefined)
          v.pause()
          t.swap()
          t.nudging = false
          continue
        }
      }
      v.currentTime = this.fileSeconds(t.kind, v, to)
    }
    if (this.audio) this.audio.currentTime = this.audioSeconds(to)
  }

  private mediaFailed(kind: MediaKind, el: HTMLVideoElement): void {
    if (el.dataset.role !== 'active') return
    const code = el.error ? `${el.error.code}: ${el.error.message}` : 'erro desconhecido'
    if (kind === 'matte') this.matteFailed = true
    this.fail(`O vídeo ${kind === 'screen' ? 'da tela' : kind === 'camera' ? 'da câmera' : 'do recorte do fundo (abra a aba Câmera e clique em "Recortar de novo")'} não abriu (${code}).`)
  }

  private fail(message: string): void {
    if (this.playing) this.pause()
    this.setError(message)
    this.o.onError(message)
  }

  private setError(message: string | null): void {
    if (this.o.playback.getState().error !== message) this.o.playback.setState({ error: message })
  }

  // --- laço ----------------------------------------------------------------------------------------
  private tick = (now: number): void => {
    if (this.destroyed) return
    this.raf = requestAnimationFrame(this.tick)
    const dt = Math.min(100, Math.max(0, now - this.lastNow))
    this.lastNow = now
    const d = this.derived
    if (!d || !this.project) return

    if (this.playing) this.advance(dt, now, d)

    const busy = this.mediaBusy()
    if (this.dirty || this.playing || busy) {
      this.draw(busy)
      if (!this.playing && !busy) this.dirty = false
    }
    this.publish(false, busy)
  }

  private advance(dt: number, now: number, d: Derived): void {
    if (this.rate > 0) {
      // segura o relógio enquanto uma mídia busca ou ainda não começou (no máximo START_HOLD_MAX_MS);
      // o áudio espera junto, para não correr à frente da imagem e precisar voltar (estalo)
      if (this.mediaBusy()) {
        if (!this.waiting) this.hold()
        this.audio?.pause()
        return
      }
      const a = this.audio
      if (a && a.paused && !a.ended && !a.error) void a.play().catch(() => undefined)
      if (this.waiting) {
        if (this.started() || now - this.waiting.since > START_HOLD_MAX_MS) this.waiting = null
        else return
      }
    } else if (now - this.lastReverseSeek >= REVERSE_SEEK_MS) {
      this.lastReverseSeek = now
      this.seekMedia(this.sourceMs)
    }

    const step = advanceClock(this.sourceMs, dt, this.rate, d.kept)
    this.sourceMs = step.t
    if (step.ended) {
      const forward = this.rate > 0
      this.pause()
      const last = d.kept[d.kept.length - 1]
      const first = d.kept[0]
      this.seekSource(forward ? Math.max(0, (last?.end ?? 1) - 1) : (first?.start ?? 0))
      return
    }
    if (step.jump) {
      if (this.rate > 0) this.jumpClock(step.jump.to)
      else this.seekMedia(step.jump.to)
    } else if (this.rate > 0) {
      this.prefetch()
    }
    if (this.rate > 0) this.syncMedia()
  }

  private source(v: HTMLVideoElement | undefined): FrameSource | null {
    if (!v || v.readyState < 2 || !(v.videoWidth > 0)) return null
    return { image: v, w: v.videoWidth, h: v.videoHeight }
  }

  private draw(busy: boolean): void {
    const d = this.derived
    const project = this.project
    if (!d || !project) return
    const canvas = this.o.canvas
    const format: FormatSpec = { kind: d.format.kind, w: canvas.width, h: canvas.height }
    const scene = evaluateScene(project, d, this.sourceMs, format)
    const screen = this.tracks.find((t) => t.kind === 'screen')?.active
    const camera = this.tracks.find((t) => t.kind === 'camera')?.active
    const matte = this.source(this.tracks.find((t) => t.kind === 'matte')?.active)
    renderFrame(this.ctx, scene, { screen: this.source(screen), camera: this.source(camera), matte }, this.cache)
    this.lastScene = scene
    this.frames++
    canvas.dataset.sourceMs = this.sourceMs.toFixed(1)
    // Diagnóstico (e testes): onde a câmera está no quadro e qual recorte da imagem dela aparece (frações, 4 casas).
    const cam = scene.camera
    if (cam) {
      canvas.dataset.cameraSrc = [cam.src.x, cam.src.y, cam.src.w, cam.src.h].map((v) => v.toFixed(4)).join(',')
      canvas.dataset.cameraDest = [cam.dest.x, cam.dest.y, cam.dest.w, cam.dest.h].map((v) => Math.round(v)).join(',')
      // o apresentador recortado: quanto dele está no ar e se o quadro da máscara chegou (sem ele sai a janela da câmera inteira)
      if (cam.cutout) canvas.dataset.cutout = `${cam.cutout.weight.toFixed(3)}|${matte ? 'matte' : 'sem-matte'}`
      else delete canvas.dataset.cutout
    } else {
      delete canvas.dataset.cameraSrc
      delete canvas.dataset.cameraDest
      delete canvas.dataset.cutout
    }
    canvas.dataset.frames = String(this.frames)
    canvas.dataset.ready = busy ? 'false' : 'true'
  }

  private publish(force: boolean, busy = this.mediaBusy()): void {
    const d = this.derived
    const outMs = d ? sourceToOutput(this.sourceMs, d.kept) : 0
    const key = `${Math.round(this.sourceMs * 2)}|${this.playing ? this.rate : 0}|${busy ? 0 : 1}`
    if (!force && key === this.lastPublished) return
    this.lastPublished = key
    this.o.playback.setState({ sourceMs: this.sourceMs, outMs, playing: this.playing, rate: this.playing ? this.rate : 0, ready: !busy })
  }

  destroy(): void {
    this.destroyed = true
    cancelAnimationFrame(this.raf)
    this.playing = false
    for (const t of this.tracks) t.dispose()
    this.tracks.length = 0
    if (this.audio) {
      this.audio.pause()
      this.audio.removeAttribute('src')
      this.audio.load()
      this.audio.remove()
      this.audio = null
    }
  }
}
