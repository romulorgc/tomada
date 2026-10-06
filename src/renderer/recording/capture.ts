/**
 * Motor de captura (renderer): tela por `getDisplayMedia`, câmera + microfone num stream,
 * DOIS `MediaRecorder` disparados no mesmo tique com `timeslice` de 1000 ms. Cada pedaço
 * vai por IPC e é anexado em disco na hora (queda de energia não perde a gravação).
 *
 * Tempo: `t0` = o primeiro `start`, em `performance.timeOrigin + performance.now()`.
 * A diferença entre os `start` vira `project.sync`. A diferença entre este relógio e o do
 * processo principal é medida por ida e volta (ver `estimateClockOffset`).
 */
import type { ChunkKind, PrepareResult, StartedInfo, StopInfo, StopReason } from '@shared/ipc'
import {
  estimateClockOffset,
  levelToMeter,
  peakFromBytes,
  pickRecorderMime,
  screenBitrate,
  smoothMeter,
  type ClockPing,
  type RecordPrefs,
  type RecordRequest
} from '@shared/recording'
import type { Size } from '@shared/types'
import { explainMediaError } from './media-errors'
import { deviceCaptureConstraints, physicalDeviceId } from '@shared/capture-devices'
import { cameraRecordBitrate, DEFAULT_CAMERA_QUALITY, type CameraCaptureInfo, type CameraProfile } from '@shared/camera-quality'
import { selectCameraProfile } from './camera-probe'
import { PcmRecorder } from './pcm-recorder'

export const nowMs = (): number => performance.timeOrigin + performance.now()

export type EngineCallbacks = {
  /** A tela ou janela gravada sumiu (fechou, desconectou). */
  onSourceEnded(): void
  /** A câmera desconectou; a gravação segue só com o resto. */
  onCameraLost(message: string): void
  /** Falha ao gravar em disco (disco cheio, permissão…). Chamado uma vez. */
  onWriteError(error: Error): void
  /** Erro do próprio MediaRecorder. */
  onRecorderError(error: Error): void
  /** Nível do microfone 0..1 (já na escala do medidor). */
  onLevel?(level: number): void
}

export type EngineParams = {
  request: RecordRequest
  prepared: PrepareResult
  prefs: Pick<RecordPrefs, 'noiseSuppression' | 'echoCancellation'>
  callbacks: EngineCallbacks
}

type Slot = {
  kind: ChunkKind
  rec: MediaRecorder
  /** Instante da chamada de `start()`. */
  callAt: number | null
  /** Instante em que o evento `start` chegou. */
  eventAt: number | null
  chain: Promise<void>
}

const api = (): Window['tomada'] => window.tomada

/** Mede o relógio do processo principal (menor ida e volta de vários pings). */
export async function syncClock(pings = 7): Promise<{ offsetMs: number; rttMs: number }> {
  const samples: ClockPing[] = []
  for (let i = 0; i < pings; i++) {
    const sentAt = nowMs()
    const remoteNow = await api().record.clock()
    samples.push({ sentAt, receivedAt: nowMs(), remoteNow })
  }
  return estimateClockOffset(samples)
}

/** Tamanho REAL do quadro de um stream (`track.getSettings` mente para tela: lê do <video>). */
async function openProbe(stream: MediaStream): Promise<{ video: HTMLVideoElement; size: Size }> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('O vídeo da captura não entregou nenhum quadro em 5 s.')), 5000)
    video.onloadedmetadata = () => {
      window.clearTimeout(timer)
      resolve()
    }
  })
  await video.play().catch(() => undefined)
  return { video, size: { w: video.videoWidth, h: video.videoHeight } }
}

export class CaptureEngine {
  private slots: Slot[] = []
  private notes: string[] = []
  private dropping = false
  private ended = false
  private writeFailed = false
  private sourceEndedFired = false
  private audioCtx: AudioContext | null = null
  private levelTimer: number | null = null
  private meter = 0
  private lastLevelAt = 0
  private probe: { video: HTMLVideoElement; size: Size } | null = null
  private startedInfo: StartedInfo | null = null
  private pcm: PcmRecorder | null = null

  private constructor(
    private readonly params: EngineParams,
    private readonly screenStream: MediaStream | null,
    private readonly deviceStream: MediaStream | null,
    private readonly cameraSelection: { profile: CameraProfile; info: CameraCaptureInfo } | null = null
  ) {}

  /** Abre a tela e os dispositivos. Lança `Error` com mensagem pronta para mostrar. */
  static async open(params: EngineParams): Promise<CaptureEngine> {
    const { request, prepared, prefs } = params
    let deviceStream: MediaStream | null = null
    let screenStream: MediaStream | null = null
    try {
      const wantVideo = request.mode !== 'screen' && Boolean(request.cameraId)
      const wantAudio = Boolean(request.micId)
      // Câmera no máximo que a luz de agora sustenta: 4K só se a trilha provar 30 qps (ver `@shared/camera-quality`).
      const selection = wantVideo ? await selectCameraProfile(request.cameraId!, request.cameraQuality ?? DEFAULT_CAMERA_QUALITY).catch((err: unknown) => { throw new Error(explainMediaError(err, 'camera')) }) : null
      if (selection) api().log({ level: 'info', message: `Câmera: degrau ${selection.info.profile} (${selection.info.width}×${selection.info.height}), ${selection.info.probeFps.toFixed(1)} qps medidos na abertura`, detail: JSON.stringify(selection.info.attempts) })
      if (wantVideo || wantAudio) {
        const constraints: MediaStreamConstraints = deviceCaptureConstraints(wantVideo ? request.cameraId : null, request.micId, prefs, selection?.profile)
        try {
          deviceStream = await navigator.mediaDevices.getUserMedia(constraints)
        } catch (err) {
          // Combinado falhou: descobre quem foi para a mensagem apontar o dispositivo certo.
          if (wantVideo && wantAudio) {
            const micOk = await navigator.mediaDevices
              .getUserMedia({ audio: constraints.audio as MediaTrackConstraints })
              .then((s) => {
                s.getTracks().forEach((t) => t.stop())
                return true
              })
              .catch(() => false)
            throw new Error(explainMediaError(err, micOk ? 'camera' : 'microphone'))
          }
          throw new Error(explainMediaError(err, wantVideo ? 'camera' : 'microphone'))
        }
      }

      if (request.mode !== 'camera') {
        const native = prepared.nativeSize
        // Tela: resolução nativa pedida de forma explícita (igual ao monitor, então nada é reduzido).
        // Janela: SEM restrição de tamanho (qualquer "ideal" menor que a moldura faz o Chromium encolher o quadro).
        const sizeConstraint = prepared.kind === 'screen' && native ? { width: { ideal: native.w }, height: { ideal: native.h } } : {}
        try {
          screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              ...sizeConstraint,
              frameRate: { ideal: request.fps, max: request.fps },
              // O Chromium (Electron 40) ignora; a trilha informa o que valeu.
              ...(request.hideCursor ? { cursor: 'never' } : {})
            } as MediaTrackConstraints,
            audio: request.systemAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false
          })
        } catch (err) {
          throw new Error(explainMediaError(err, 'screen'))
        }
        const track = screenStream.getVideoTracks()[0]
        if (track) track.contentHint = 'detail' // texto nítido vale mais que fluidez
      }

      const engine = new CaptureEngine(params, screenStream, deviceStream, selection)
      if (screenStream) engine.probe = await openProbe(screenStream)
      engine.attachTrackListeners()
      engine.startLevelMeter()
      // Ponto único de troca do MICROFONE: o vídeo da câmera conserva seu gravador.
      if (deviceStream?.getAudioTracks().length) {
        try {
          engine.pcm = await PcmRecorder.open(deviceStream, data => api().record.chunk('mic', data), err => {
            if (engine.writeFailed || engine.dropping) return
            engine.writeFailed = true
            engine.notes.push(err.message)
            params.callbacks.onRecorderError(err)
          })
        } catch (err) { engine.abort(); throw err }
      }
      return engine
    } catch (err) {
      deviceStream?.getTracks().forEach((t) => t.stop())
      screenStream?.getTracks().forEach((t) => t.stop())
      throw err
    }
  }

  /** A trilha de tela informa que o cursor do sistema não é desenhado? (`getSettings().cursor === 'never'`) */
  private cursorIsHidden(): boolean {
    const track = this.screenStream?.getVideoTracks()[0]
    return (track?.getSettings() as { cursor?: string } | undefined)?.cursor === 'never'
  }

  /** Tamanho atual do quadro da tela (null se não há tela). */
  frameSize(): Size | null {
    const v = this.probe?.video
    return v ? { w: v.videoWidth, h: v.videoHeight } : (this.probe?.size ?? null)
  }

  private attachTrackListeners(): void {
    const screenTrack = this.screenStream?.getVideoTracks()[0]
    screenTrack?.addEventListener('ended', () => {
      if (this.ended || this.sourceEndedFired) return
      this.sourceEndedFired = true
      this.params.callbacks.onSourceEnded()
    })
    const camTrack = this.deviceStream?.getVideoTracks()[0]
    camTrack?.addEventListener('ended', () => {
      if (this.ended) return
      const message = 'A câmera foi desconectada. A gravação segue só com a tela e o som.'
      this.notes.push(message)
      this.params.callbacks.onCameraLost(message)
    })
    const micTrack = this.deviceStream?.getAudioTracks()[0]
    micTrack?.addEventListener('ended', () => {
      if (this.ended) return
      this.notes.push('O microfone foi desconectado durante a gravação.')
      this.params.callbacks.onCameraLost('O microfone foi desconectado. A gravação segue sem o som da voz.')
    })
  }

  /** Medidor do microfone: leitura a ~15 Hz, repassada à barra flutuante. */
  private startLevelMeter(): void {
    const audio = this.deviceStream?.getAudioTracks()
    if (!audio || audio.length === 0) return
    try {
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(new MediaStream(audio))
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser) // sem ligar ao destino: nada de eco nos alto-falantes
      const bytes = new Uint8Array(analyser.fftSize)
      this.audioCtx = ctx
      this.lastLevelAt = performance.now()
      this.levelTimer = window.setInterval(() => {
        analyser.getByteTimeDomainData(bytes)
        const now = performance.now()
        this.meter = smoothMeter(this.meter, levelToMeter(peakFromBytes(bytes)), now - this.lastLevelAt)
        this.lastLevelAt = now
        this.params.callbacks.onLevel?.(this.meter)
        api().record.level(this.meter)
      }, 66)
    } catch (err) {
      api().log({ level: 'warn', message: 'Medidor do microfone indisponível', detail: err instanceof Error ? err.message : String(err) })
    }
  }

  private makeSlot(kind: ChunkKind, stream: MediaStream, mime: string, bps: { video?: number; audio?: number }): Slot {
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      ...(bps.video ? { videoBitsPerSecond: bps.video } : {}),
      ...(bps.audio ? { audioBitsPerSecond: bps.audio } : {})
    })
    const slot: Slot = { kind, rec, callAt: null, eventAt: null, chain: Promise.resolve() }
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data.size === 0) return
      slot.chain = slot.chain
        .then(async () => {
          if (this.dropping) return
          await api().record.chunk(kind, await e.data.arrayBuffer())
        })
        .catch((err: unknown) => {
          if (this.dropping || this.writeFailed) return
          this.writeFailed = true
          this.params.callbacks.onWriteError(err instanceof Error ? err : new Error(String(err)))
        })
    }
    rec.onerror = (e: Event) => {
      const inner = (e as Event & { error?: DOMException }).error
      this.params.callbacks.onRecorderError(new Error(`Erro no gravador de ${kind}: ${inner?.message ?? 'desconhecido'}`))
    }
    return slot
  }

  /** Cria os dois gravadores, mede o relógio e dispara os dois no mesmo tique. */
  async start(): Promise<StartedInfo> {
    const { request } = this.params
    const supports = (m: string): boolean => MediaRecorder.isTypeSupported(m)

    let screenMime: string | null = null
    let screenHasAudio = false
    if (this.screenStream) {
      screenHasAudio = this.screenStream.getAudioTracks().length > 0
      screenMime = pickRecorderMime(supports, { video: true, audio: screenHasAudio })
      if (!screenMime) throw new Error('Este computador não tem um formato de gravação de vídeo compatível.')
      const frame = this.frameSize() ?? { w: 1920, h: 1080 }
      this.slots.push(
        this.makeSlot('screen', this.screenStream, screenMime, {
          video: screenBitrate(frame, request.fps),
          ...(screenHasAudio ? { audio: 192_000 } : {})
        })
      )
    }

    let cameraMime: string | null = null
    const camVideo = this.deviceStream?.getVideoTracks()[0]
    const camAudio = this.deviceStream?.getAudioTracks()[0]
    const cameraSize: Size | null = camVideo ? { w: camVideo.getSettings().width ?? 0, h: camVideo.getSettings().height ?? 0 } : null
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
    const cameraDeviceId = camVideo ? physicalDeviceId(camVideo.getSettings(), devices, 'videoinput') : null
    const micDeviceId = camAudio ? physicalDeviceId(camAudio.getSettings(), devices, 'audioinput') : null
    if (this.deviceStream && camVideo) {
      cameraMime = pickRecorderMime(supports, { video: Boolean(camVideo), audio: Boolean(camAudio) })
      if (!cameraMime) throw new Error('Este computador não tem um formato de gravação de câmera compatível.')
      this.slots.push(
        this.makeSlot(this.deviceStream.getVideoTracks().length > 0 ? 'camera' : 'mic', this.deviceStream, cameraMime, {
          ...(camVideo ? { video: cameraRecordBitrate(cameraSize ?? { w: 1280, h: 720 }, this.cameraSelection?.profile.requestFps ?? 30) } : {}),
          ...(camAudio ? { audio: 128_000 } : {})
        })
      )
    }
    if (this.slots.length === 0 && !this.pcm) throw new Error('Não há nada para gravar (sem tela, câmera nem microfone).')

    const clock = await syncClock()

    const started = this.slots.map(
      (slot) =>
        new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error(`O gravador de ${slot.kind} não começou em 5 s.`)), 5000)
          slot.rec.onstart = () => {
            slot.eventAt = nowMs()
            window.clearTimeout(timer)
            resolve()
          }
        })
    )
    // Mesmo tique: nenhum `await` entre os dois `start()`. O tempo 0 de cada arquivo é o da CHAMADA
    // (o evento `start` chega 150-215 ms depois no gravador de tela; medido na captura real).
    for (const slot of this.slots) {
      slot.callAt = nowMs()
      slot.rec.start(1000)
    }
    // PCM nasce no MESMO instante da voz anterior (start da câmera), que já é a referência
    // usada por project.sync. Sem câmera, seu próprio start ocupa esse contrato.
    const micStartAt = this.pcm ? this.slots.find(s => s.kind === 'camera')?.callAt ?? nowMs() : null
    if (micStartAt !== null) this.pcm!.start(micStartAt)
    await Promise.all(started)

    const calls = [...this.slots.map((s) => s.callAt!), ...(micStartAt === null ? [] : [micStartAt])]
    const t0 = Math.min(...calls)
    const find = (kind: ChunkKind): Slot | undefined => this.slots.find((s) => s.kind === kind)
    const at = (kind: ChunkKind): number | null => find(kind)?.callAt ?? null
    const lag = (kind: ChunkKind): number | null => {
      const s = find(kind)
      return s && s.eventAt !== null && s.callAt !== null ? s.eventAt - s.callAt : null
    }
    const info: StartedInfo = {
      t0,
      screenStartAt: at('screen'),
      cameraStartAt: at('camera') ?? micStartAt,
      startEventLagMs: { screen: lag('screen'), camera: lag('camera') ?? lag('mic') },
      frame: this.frameSize(),
      clockOffsetMs: clock.offsetMs,
      clockRttMs: clock.rttMs,
      screenMime,
      cameraMime,
      screenHasAudio,
      cursorHidden: this.cursorIsHidden(),
      cameraHasVideo: Boolean(camVideo),
      cameraHasAudio: Boolean(camAudio),
      cameraSize,
      cameraDeviceId,
      micDeviceId,
      micPcm: Boolean(this.pcm),
      ...(this.cameraSelection ? { cameraCapture: { ...this.cameraSelection.info, width: cameraSize?.w ?? this.cameraSelection.info.width, height: cameraSize?.h ?? this.cameraSelection.info.height } } : {})
    }
    this.startedInfo = info
    return info
  }

  /** Pausa os dois gravadores. Devolve o instante (antes das chamadas). */
  pause(): number {
    const at = nowMs()
    for (const s of this.slots) if (s.rec.state === 'recording') s.rec.pause()
    this.pcm?.pause(at)
    return at
  }

  /** Retoma os dois. Devolve o instante (depois das chamadas). */
  resume(): number {
    for (const s of this.slots) if (s.rec.state === 'paused') s.rec.resume()
    // O mesmo instante que o manifesto guarda como fim da pausa: se o PCM voltasse antes (no começo desta chamada),
    // a voz entraria na linha do tempo com o atraso da própria chamada (medido: 11 ms) em relação à tela e à câmera.
    const at = nowMs()
    this.pcm?.resume(at)
    return at
  }

  /** Para tudo, espera o último pedaço chegar ao disco e devolve o resumo. */
  async stop(reason: StopReason): Promise<StopInfo> {
    const endedAt = nowMs()
    this.ended = true
    const stopped = await Promise.allSettled([
      this.pcm?.stop(endedAt),
      ...this.slots.map(
        (s) =>
          new Promise<void>((resolve) => {
            if (s.rec.state === 'inactive') return resolve()
            s.rec.onstop = () => resolve()
            s.rec.stop()
          })
      )
    ])
    await Promise.all(this.slots.map((s) => s.chain))
    for (const result of stopped) if (result.status === 'rejected') {
      const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason))
      this.notes.push(`O último pedaço do microfone não pôde ser confirmado: ${error.message}. Confira o fim da gravação.`)
      this.params.callbacks.onRecorderError(error)
    }
    const frame = this.frameSize()
    this.release()
    return { endedAt, reason, frame, notes: [...this.notes] }
  }

  /** Descarta: para tudo sem esperar dados. */
  abort(): void {
    this.dropping = true
    this.ended = true
    for (const s of this.slots) {
      try {
        if (s.rec.state !== 'inactive') s.rec.stop()
      } catch {
        // já parado
      }
    }
    this.release()
  }

  get started(): StartedInfo | null {
    return this.startedInfo
  }

  private release(): void {
    this.pcm?.release()
    this.pcm = null
    if (this.levelTimer !== null) window.clearInterval(this.levelTimer)
    this.levelTimer = null
    void this.audioCtx?.close().catch(() => undefined)
    this.audioCtx = null
    if (this.probe) {
      this.probe.video.pause()
      this.probe.video.srcObject = null
    }
    this.screenStream?.getTracks().forEach((t) => t.stop())
    this.deviceStream?.getTracks().forEach((t) => t.stop())
  }
}
