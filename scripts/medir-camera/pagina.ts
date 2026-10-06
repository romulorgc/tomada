/**
 * Página da medição da câmera (roda numa janela ESCONDIDA do Electron; ver `principal.cjs`).
 *
 * Cenários:
 *  - `probe`:  só abre a câmera e conta os quadros que a trilha entrega (sem gravar nada);
 *  - `raw`:    MediaRecorder cru, com mime/bitrate/constraints à escolha (exploração);
 *  - `engine`: o CaptureEngine de VERDADE (`src/renderer/recording/capture.ts`), o mesmo código
 *              da gravação do app, com ou sem a tela gravando ao mesmo tempo.
 *
 * Os pedaços vão para o disco pelo processo principal (`window.tomada.record.chunk`), como no app.
 */
import { CaptureEngine } from '../../src/renderer/recording/capture'
import { deviceCaptureConstraints } from '@shared/capture-devices'
import { pickRecorderMime } from '@shared/recording'
import type { RecordRequest } from '@shared/recording'

type Cfg = {
  scenario: string
  seconds: number
  camera: string
  mic: string
  withScreen: boolean
  fps?: 30 | 60
  // raw
  mime?: string
  videoBps?: number
  width?: number
  height?: number
  frameRate?: number
  noFrameRateMax?: boolean
  timeslice?: number
  // engine
  /** Abre antes a prévia da tela Gravar (640x360) e a bolha (640x640) na mesma câmera, como no app. */
  withPreviews?: boolean | 'fecha-antes'
  /** Simula câmera lenta (pouca luz): exposição manual longa ANTES de abrir o engine (o driver guarda). Sempre desfeita no fim. */
  slowExposure?: number
  quality?: 'max' | 'high'
  engineOptions?: Record<string, unknown>
  /** `applyConstraints` na trilha da câmera logo depois de abrir (experimentos de exposição). */
  apply?: Record<string, unknown>
  // sweep
  sweep?: SweepItem[]
  // todos: conta os quadros que a trilha entrega durante a gravação
  countTrack?: boolean
}

type SweepItem = { width: number; height: number; frameRate: number; max?: boolean; exact?: boolean; extra?: Record<string, unknown>; apply?: Record<string, unknown> }

type TrackStats = { frames: number; seconds: number; fps: number; gapMedianMs: number; gapP99Ms: number; gapMaxMs: number; over50ms: number }

declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<any> }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const api = (): { record: { chunk(kind: string, data: ArrayBuffer): Promise<void> } } => (window as unknown as { tomada: { record: { chunk(kind: string, data: ArrayBuffer): Promise<void> } } }).tomada

async function findDevices(cameraName: string, micName: string): Promise<{ cameraId: string; micId: string; cameras: string[]; mics: string[] }> {
  const unlock = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
  unlock.getTracks().forEach((t) => t.stop())
  const devices = await navigator.mediaDevices.enumerateDevices()
  const cameras = devices.filter((d) => d.kind === 'videoinput')
  const mics = devices.filter((d) => d.kind === 'audioinput')
  const cam = cameras.find((d) => d.label.toLowerCase().includes(cameraName.toLowerCase()))
  const named = mics.filter((d) => d.label.toLowerCase().includes(micName.toLowerCase()))
  const mic = named.find((d) => d.deviceId !== 'default' && d.deviceId !== 'communications') ?? named[0]
  if (!cam) throw new Error(`Câmera "${cameraName}" não encontrada. Há: ${cameras.map((c) => c.label).join(' | ')}`)
  if (!mic) throw new Error(`Microfone "${micName}" não encontrado. Há: ${mics.map((c) => c.label).join(' | ')}`)
  return { cameraId: cam.deviceId, micId: mic.deviceId, cameras: cameras.map((c) => c.label), mics: mics.map((c) => c.label) }
}

/** Conta os quadros que uma trilha entrega (clone, para não mexer na trilha gravada). */
function countTrack(track: MediaStreamTrack): { stop(): Promise<TrackStats> } {
  const clone = track.clone()
  const processor = new MediaStreamTrackProcessor({ track: clone })
  const reader = processor.readable.getReader()
  const stamps: number[] = []
  let running = true
  const loop = (async () => {
    while (running) {
      const { value, done } = await reader.read()
      if (done || !value) break
      stamps.push(performance.now())
      value.close()
    }
  })()
  return {
    async stop() {
      running = false
      await reader.cancel().catch(() => undefined)
      await loop.catch(() => undefined)
      clone.stop()
      const gaps = stamps.slice(1).map((v, i) => v - stamps[i]!).sort((a, b) => a - b)
      const seconds = stamps.length > 1 ? (stamps[stamps.length - 1]! - stamps[0]!) / 1000 : 0
      return {
        frames: stamps.length,
        seconds,
        fps: seconds > 0 ? (stamps.length - 1) / seconds : 0,
        gapMedianMs: gaps[gaps.length >> 1] ?? 0,
        gapP99Ms: gaps[Math.floor(gaps.length * 0.99)] ?? 0,
        gapMaxMs: gaps[gaps.length - 1] ?? 0,
        over50ms: gaps.filter((g) => g > 50).length
      }
    }
  }
}

/** O que se aplica na câmera FICA nela (o driver guarda): todo experimento devolve a exposição ao automático. */
const restoreExposure = async (track: MediaStreamTrack | undefined, snapshot?: Record<string, unknown>): Promise<void> => {
  if (!track) return
  try {
    const adv: Record<string, unknown> = { exposureMode: 'continuous' }
    for (const key of ['brightness', 'contrast', 'saturation', 'sharpness', 'colorTemperature', 'exposureCompensation', 'zoom']) if (snapshot && snapshot[key] !== undefined) adv[key] = snapshot[key]
    if (snapshot?.whiteBalanceMode) adv.whiteBalanceMode = snapshot.whiteBalanceMode
    if (snapshot?.focusMode) adv.focusMode = snapshot.focusMode
    await track.applyConstraints({ advanced: [adv] } as MediaTrackConstraints)
  } catch { /* sem controle de exposição */ }
}

const settingsOf = (track: MediaStreamTrack | undefined): Record<string, unknown> => (track ? { ...track.getSettings() } : {})

async function probe(cfg: Cfg): Promise<Record<string, unknown>> {
  const dev = await findDevices(cfg.camera, cfg.mic)
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: dev.cameraId }, width: { ideal: cfg.width ?? 1920 }, height: { ideal: cfg.height ?? 1080 }, frameRate: cfg.noFrameRateMax ? { ideal: cfg.frameRate ?? 30 } : { ideal: cfg.frameRate ?? 30, max: cfg.frameRate ?? 30 } }
  })
  const track = stream.getVideoTracks()[0]!
  const counter = countTrack(track)
  await sleep(cfg.seconds * 1000)
  const stats = await counter.stop()
  const out = { devices: { cameras: dev.cameras, mics: dev.mics }, settings: settingsOf(track), capabilities: track.getCapabilities?.() ?? null, trackStats: stats }
  stream.getTracks().forEach((t) => t.stop())
  return out
}

async function sweep(cfg: Cfg): Promise<Record<string, unknown>> {
  const dev = await findDevices(cfg.camera, cfg.mic)
  const rows: Record<string, unknown>[] = []
  for (const item of cfg.sweep ?? []) {
    const fr = item.max ? { ideal: item.frameRate, max: item.frameRate } : item.exact ? { exact: item.frameRate } : { ideal: item.frameRate }
    let row: Record<string, unknown> = { item }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: dev.cameraId }, width: { ideal: item.width }, height: { ideal: item.height }, frameRate: fr, ...(item.extra ?? {}) } })
      const track = stream.getVideoTracks()[0]!
      const snapshot = settingsOf(track)
      if (item.apply) { await track.applyConstraints(item.apply as MediaTrackConstraints); await sleep(1500) }
      const counter = countTrack(track)
      await sleep(cfg.seconds * 1000)
      const stats = await counter.stop()
      const s = track.getSettings()
      if (item.apply) await restoreExposure(track, snapshot)
      row = { item, got: `${s.width}x${s.height}@${s.frameRate}`, fps: +stats.fps.toFixed(2), gapMedianMs: +stats.gapMedianMs.toFixed(1), exposureTime: (s as Record<string, unknown>).exposureTime, exposureMode: (s as Record<string, unknown>).exposureMode }
      stream.getTracks().forEach((t) => t.stop())
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err)
    }
    console.log('VARREDURA ' + JSON.stringify(row))
    rows.push(row)
    await sleep(1200)
  }
  return { rows }
}

/** Relógios: o que o VideoFrame/AudioData dizem × performance.now() × o que o MediaRecorder grava (comparado depois com o arquivo). */
async function stamps(cfg: Cfg): Promise<Record<string, unknown>> {
  const dev = await findDevices(cfg.camera, cfg.mic)
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: dev.cameraId }, width: { ideal: cfg.width ?? 1920 }, height: { ideal: cfg.height ?? 1080 }, frameRate: { ideal: cfg.frameRate ?? 30 } },
    audio: { deviceId: { exact: dev.micId }, autoGainControl: false, echoCancellation: false, noiseSuppression: false }
  })
  if (cfg.apply) { await stream.getVideoTracks()[0]!.applyConstraints(cfg.apply as MediaTrackConstraints); await sleep(1200) }
  const vt = stream.getVideoTracks()[0]!
  const at = stream.getAudioTracks()[0]!
  const vProc = new MediaStreamTrackProcessor({ track: vt.clone() }).readable.getReader()
  const aProc = new MediaStreamTrackProcessor({ track: at.clone() }).readable.getReader()
  const vLog: unknown[] = []
  const aLog: unknown[] = []
  let running = true
  const vLoop = (async () => {
    while (running) {
      const { value, done } = await vProc.read()
      if (done || !value) break
      if (vLog.length < 12) vLog.push({ ts: value.timestamp, nowMs: +performance.now().toFixed(2), meta: (value.metadata?.() ?? null) })
      value.close()
    }
  })()
  const aLoop = (async () => {
    while (running) {
      const { value, done } = await aProc.read()
      if (done || !value) break
      if (aLog.length < 12) aLog.push({ ts: value.timestamp, n: value.numberOfFrames, sr: value.sampleRate, nowMs: +performance.now().toFixed(2) })
      value.close()
    }
  })()
  const mime = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m), { video: true, audio: true })!
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000, audioBitsPerSecond: 128_000 })
  let chain: Promise<void> = Promise.resolve()
  rec.ondataavailable = (e) => { if (e.data.size) chain = chain.then(async () => api().record.chunk('camera', await e.data.arrayBuffer())) }
  const callPerf = performance.now()
  rec.start(1000)
  const startEvent = await new Promise<number>((resolve) => { rec.onstart = () => resolve(performance.now()) })
  await sleep(cfg.seconds * 1000)
  running = false
  await new Promise<void>((resolve) => { rec.onstop = () => resolve(); rec.stop() })
  await chain
  await vProc.cancel().catch(() => undefined)
  await aProc.cancel().catch(() => undefined)
  await Promise.all([vLoop, aLoop]).catch(() => undefined)
  if (cfg.apply) await restoreExposure(vt)
  stream.getTracks().forEach((t) => t.stop())
  return { callPerf, startEvent, timeOrigin: performance.timeOrigin, vLog, aLog }
}

/**
 * Fidelidade do codificador: grava pelo MediaRecorder do app e, DA MESMA TRILHA, guarda o plano de luma (Y) de alguns quadros
 * exatamente como o codificador os recebe. O script compara depois o arquivo gravado com esses quadros (PSNR, SSIM, nitidez):
 * a perda é só do codificador, sem câmera, luz ou conversão de cor de outro programa no meio.
 */
async function fidelity(cfg: Cfg): Promise<Record<string, unknown>> {
  const dev = await findDevices(cfg.camera, cfg.mic)
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: dev.cameraId }, width: { ideal: cfg.width ?? 1920 }, height: { ideal: cfg.height ?? 1080 }, frameRate: { ideal: cfg.frameRate ?? 30, max: cfg.frameRate ?? 30 } }
  })
  const track = stream.getVideoTracks()[0]!
  let screen: MediaStream | null = null
  if (cfg.withScreen) screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } } as MediaTrackConstraints, audio: false })
  const reader = new MediaStreamTrackProcessor({ track: track.clone() }).readable.getReader()
  const mk = (kind: string, s: MediaStream, bps: number): { rec: MediaRecorder; done: () => Promise<void> } => {
    const rec = new MediaRecorder(s, { mimeType: 'video/webm;codecs=h264', videoBitsPerSecond: bps })
    let chain: Promise<void> = Promise.resolve()
    rec.ondataavailable = (e) => { if (e.data.size) chain = chain.then(async () => api().record.chunk(kind, await e.data.arrayBuffer())) }
    return { rec, done: () => chain }
  }
  const cam = mk('camera', stream, cfg.videoBps ?? 45_000_000)
  const scr = screen ? mk('screen', screen, 16_000_000) : null
  const grabAt = [2, 3, 4, 5, 6, 7].map((s) => s * 1000).filter((ms) => ms < cfg.seconds * 1000 - 500)
  const grabs: { index: number; width: number; height: number; format: string; at: number }[] = []
  const startedAt = performance.now()
  cam.rec.start(1000)
  scr?.rec.start(1000)
  let running = true
  let next = 0
  const loop = (async () => {
    while (running) {
      const { value, done } = await reader.read()
      if (done || !value) break
      const elapsed = performance.now() - startedAt
      if (next < grabAt.length && elapsed >= grabAt[next]!) {
        const w = value.visibleRect?.width ?? value.codedWidth
        const h = value.visibleRect?.height ?? value.codedHeight
        const buf = new Uint8Array(value.allocationSize())
        const layout = await value.copyTo(buf)
        const y = layout[0]!
        const plane = new Uint8Array(w * h)
        for (let row = 0; row < h; row++) plane.set(buf.subarray(y.offset + row * y.stride, y.offset + row * y.stride + w), row * w)
        await api().record.chunk('yplane' + next, plane.buffer)
        grabs.push({ index: next, width: w, height: h, format: String(value.format), at: Math.round(elapsed) })
        next++
      }
      value.close()
    }
  })()
  await sleep(cfg.seconds * 1000)
  running = false
  await reader.cancel().catch(() => undefined)
  await loop.catch(() => undefined)
  await Promise.all([cam, scr].filter(Boolean).map((r) => new Promise<void>((resolve) => { r!.rec.onstop = () => resolve(); r!.rec.stop() })))
  await Promise.all([cam.done(), scr?.done()])
  const out = { settings: settingsOf(track), grabs }
  stream.getTracks().forEach((t) => t.stop())
  screen?.getTracks().forEach((t) => t.stop())
  return out
}

async function codecs(): Promise<Record<string, unknown>> {
  const rows: Record<string, unknown>[] = []
  const list: { codec: string; name: string }[] = [
    { codec: 'avc1.640034', name: 'h264-high-5.2' },
    { codec: 'avc1.640033', name: 'h264-high-5.1' },
    { codec: 'avc1.64002A', name: 'h264-high-4.2' },
    { codec: 'hvc1.1.6.L153.B0', name: 'hevc-main-5.1' },
    { codec: 'hev1.1.6.L153.B0', name: 'hev1-main-5.1' },
    { codec: 'vp09.00.51.08', name: 'vp9-5.1' },
    { codec: 'av01.0.13M.08', name: 'av1-5.1' }
  ]
  for (const [w, h, fps] of [[3840, 2160, 30], [2560, 1440, 30], [1920, 1080, 30], [3840, 2160, 60]] as const) {
    for (const c of list) {
      for (const hw of ['prefer-hardware', 'prefer-software'] as const) {
        for (const latencyMode of ['quality', 'realtime'] as const) {
          let supported: unknown = null
          try {
            const r = await VideoEncoder.isConfigSupported({ codec: c.codec, width: w, height: h, framerate: fps, bitrate: 45_000_000, hardwareAcceleration: hw, latencyMode, ...(c.codec.startsWith('avc1') ? { avc: { format: 'annexb' as const } } : {}) })
            supported = r.supported
          } catch (e) {
            supported = String(e)
          }
          rows.push({ res: `${w}x${h}@${fps}`, codec: c.name, hw, latencyMode, supported })
        }
      }
    }
  }
  const mr = ['video/webm;codecs=h264', 'video/webm;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm;codecs=av1', 'video/mp4;codecs=avc1', 'video/mp4;codecs=hvc1', 'video/webm;codecs=hevc'].map((m) => [m, MediaRecorder.isTypeSupported(m)])
  return { rows, mediaRecorder: mr }
}

async function raw(cfg: Cfg): Promise<Record<string, unknown>> {
  const dev = await findDevices(cfg.camera, cfg.mic)
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: dev.cameraId }, width: { ideal: cfg.width ?? 1920 }, height: { ideal: cfg.height ?? 1080 }, frameRate: cfg.noFrameRateMax ? { ideal: cfg.frameRate ?? 30 } : { ideal: cfg.frameRate ?? 30, max: cfg.frameRate ?? 30 } },
    audio: { deviceId: { exact: dev.micId }, autoGainControl: false, echoCancellation: false, noiseSuppression: false }
  })
  if (cfg.apply) { await stream.getVideoTracks()[0]!.applyConstraints(cfg.apply as MediaTrackConstraints); await sleep(1500) }
  let screen: MediaStream | null = null
  if (cfg.withScreen) {
    screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: cfg.fps ?? 30, max: cfg.fps ?? 30 } } as MediaTrackConstraints, audio: false })
    screen.getVideoTracks()[0]!.contentHint = 'detail'
  }
  const mime = cfg.mime ?? pickRecorderMime((m) => MediaRecorder.isTypeSupported(m), { video: true, audio: true })!
  const track = stream.getVideoTracks()[0]!
  const recorders: { kind: string; rec: MediaRecorder; chain: Promise<void> }[] = []
  const mk = (kind: string, s: MediaStream, m: string, bps: { video?: number; audio?: number }): void => {
    const rec = new MediaRecorder(s, { mimeType: m, ...(bps.video ? { videoBitsPerSecond: bps.video } : {}), ...(bps.audio ? { audioBitsPerSecond: bps.audio } : {}) })
    const slot = { kind, rec, chain: Promise.resolve() }
    rec.ondataavailable = (e) => {
      if (e.data.size === 0) return
      slot.chain = slot.chain.then(async () => api().record.chunk(kind, await e.data.arrayBuffer()))
    }
    recorders.push(slot)
  }
  if (screen) mk('screen', screen, pickRecorderMime((m) => MediaRecorder.isTypeSupported(m), { video: true, audio: false })!, { video: 16_000_000 })
  mk('camera', stream, mime, { video: cfg.videoBps, audio: 128_000 })
  const counter = cfg.countTrack === false ? null : countTrack(track)
  for (const r of recorders) r.rec.start(cfg.timeslice ?? 1000)
  await sleep(cfg.seconds * 1000)
  const trackStats = counter ? await counter.stop() : null
  await Promise.all(recorders.map((r) => new Promise<void>((resolve) => { r.rec.onstop = () => resolve(); r.rec.stop() })))
  await Promise.all(recorders.map((r) => r.chain))
  if (cfg.apply) await restoreExposure(track)
  const out = { mime, settings: settingsOf(track), trackStats }
  stream.getTracks().forEach((t) => t.stop())
  screen?.getTracks().forEach((t) => t.stop())
  return out
}

/** Põe (ou tira) a exposição manual da câmera e fecha: o driver guarda o que se aplica. */
async function setExposure(cameraId: string, exposureTime: number | null): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cameraId }, width: { ideal: 1280 }, height: { ideal: 720 } } })
  try {
    const track = stream.getVideoTracks()[0]!
    await track.applyConstraints({ advanced: [exposureTime === null ? { exposureMode: 'continuous' } : { exposureMode: 'manual', exposureTime }] } as MediaTrackConstraints)
    await sleep(800)
  } finally {
    stream.getTracks().forEach((t) => t.stop())
  }
  await sleep(800)
}

async function engine(cfg: Cfg): Promise<Record<string, unknown>> {
  const dev = await findDevices(cfg.camera, cfg.mic)
  if (cfg.slowExposure) {
    await setExposure(dev.cameraId, cfg.slowExposure)
    try { return await engineRun(cfg, dev) } finally { await setExposure(dev.cameraId, null) }
  }
  return engineRun(cfg, dev)
}

async function engineRun(cfg: Cfg, dev: { cameraId: string; micId: string }): Promise<Record<string, unknown>> {
  const previews: MediaStream[] = []
  if (cfg.withPreviews) {
    previews.push(await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: dev.cameraId }, width: { ideal: 640 }, height: { ideal: 360 } } }))
    previews.push(await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: dev.cameraId }, width: { ideal: 640 }, height: { ideal: 640 } } }))
    await sleep(500)
    // Como o app faz: a tela Gravar para as prévias quando a gravação começa, e a abertura vem logo depois.
    if (cfg.withPreviews === 'fecha-antes') {
      previews.splice(0).forEach((p) => p.getTracks().forEach((t) => t.stop()))
      await sleep(30)
    }
  }
  const request: RecordRequest = {
    mode: cfg.withScreen ? 'screen-camera' : 'camera',
    sourceId: cfg.withScreen ? 'bench' : null,
    fps: cfg.fps ?? 30,
    cameraId: dev.cameraId,
    micId: dev.micId,
    systemAudio: false,
    showBubble: false,
    hideCursor: false,
    ...(cfg.quality ? { cameraQuality: cfg.quality } : {})
  }
  const eng = await CaptureEngine.open({
    request,
    prepared: { sessionId: 'bench', folder: 'bench', kind: cfg.withScreen ? 'screen' : null, sourceName: 'bench', nativeSize: cfg.withScreen ? { w: 1920, h: 1080 } : null, scale: 1 },
    prefs: { noiseSuppression: false, echoCancellation: false },
    callbacks: {
      onSourceEnded: () => undefined,
      onCameraLost: (m) => console.warn(m),
      onWriteError: (e) => console.warn(e.message),
      onRecorderError: (e) => console.warn(e.message)
    },
    ...(cfg.engineOptions ? { options: cfg.engineOptions } : {})
  } as Parameters<typeof CaptureEngine.open>[0])
  const track = (eng as unknown as { deviceStream: MediaStream | null }).deviceStream?.getVideoTracks()[0]
  if (cfg.apply && track) { await track.applyConstraints(cfg.apply as MediaTrackConstraints); await sleep(1500) }
  const counter = track && cfg.countTrack !== false ? countTrack(track) : null
  const started = await eng.start()
  await sleep(cfg.seconds * 1000)
  const trackStats = counter ? await counter.stop() : null
  if (cfg.apply) await restoreExposure(track)
  const stopped = await eng.stop('user')
  previews.forEach((p) => p.getTracks().forEach((t) => t.stop()))
  return { started, stopped, trackStats, cameraSettings: settingsOf(track) }
}

;(window as unknown as { __bench: unknown }).__bench = {
  async run(cfg: Cfg): Promise<Record<string, unknown>> {
    try {
      if (cfg.scenario === 'probe') return await probe(cfg)
      if (cfg.scenario === 'restore') { const dev = await findDevices(cfg.camera, cfg.mic); await setExposure(dev.cameraId, null); return { restored: true } }
      if (cfg.scenario === 'fidelity') return await fidelity(cfg)
      if (cfg.scenario === 'stamps') return await stamps(cfg)
      if (cfg.scenario === 'codecs') return await codecs()
      if (cfg.scenario === 'sweep') return await sweep(cfg)
      if (cfg.scenario === 'raw') return await raw(cfg)
      if (cfg.scenario === 'engine') return await engine(cfg)
      throw new Error(`cenário desconhecido: ${cfg.scenario}`)
    } catch (err) {
      return { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
    }
  },
  deviceConstraints: deviceCaptureConstraints
}
