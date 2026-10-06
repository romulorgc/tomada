/**
 * Sondagem da câmera na abertura da gravação: conta os quadros que a TRILHA entrega (antes de qualquer
 * codificador) para descobrir se a câmera sustenta 30 qps com a luz de agora. Em pouca luz muita webcam reduz
 * sozinha a taxa (a EMEET C60E entregava 15 qps pedindo 30, ver `@shared/camera-quality`); o que decide o degrau
 * de qualidade é o número medido, nunca o que `getSettings().frameRate` diz (ele mentia: dizia 30 com 15 chegando).
 */
import { framesPerSecond, walkCameraLadder, cameraVideoConstraints, type CameraCaptureInfo, type CameraProfile, type CameraQuality } from '@shared/camera-quality'

type FrameReader = { read(): Promise<{ done: boolean; value?: VideoFrame }>; cancel(): Promise<void> }
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: { getReader(): FrameReader } }

const processorCtor = (): TrackProcessorCtor | null => (globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor ?? null

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

/**
 * Quadros por segundo da trilha entre `fromMs` e `toMs` depois de chamar. `null` = este Chromium não sabe contar
 * (quem chama aceita o degrau, e o aviso do fim da gravação ainda confere o arquivo).
 */
export async function measureTrackFps(track: MediaStreamTrack, window_ = { fromMs: 600, toMs: 1700 }): Promise<number | null> {
  const Processor = processorCtor()
  if (!Processor) return null
  const clone = track.clone()
  const reader = new Processor({ track: clone }).readable.getReader()
  const begin = performance.now()
  const stamps: number[] = []
  let running = true
  const loop = (async () => {
    while (running) {
      const next = await reader.read()
      if (next.done || !next.value) break
      const now = performance.now() - begin
      next.value.close()
      if (now >= window_.fromMs && now <= window_.toMs) stamps.push(now)
    }
  })()
  await sleep(window_.toMs + 50)
  running = false
  await reader.cancel().catch(() => undefined)
  await Promise.race([loop.catch(() => undefined), sleep(500)])
  clone.stop()
  if (stamps.length < 2) return 0
  return framesPerSecond(stamps.length, stamps[stamps.length - 1]! - stamps[0]!)
}

/** Aberturas seguidas se outra janela estiver segurando o aparelho num tamanho menor (a prévia da tela Gravar fecha em instantes). */
const CONTENTION_RETRIES = 3

/** Escolhe o degrau de qualidade abrindo a câmera sozinha, medindo e fechando; quem chama abre de verdade depois. */
export async function selectCameraProfile(cameraId: string, quality: CameraQuality): Promise<{ profile: CameraProfile; info: CameraCaptureInfo }> {
  return walkCameraLadder(quality, async (profile) => {
    let last: { width: number; height: number; fps: number | null; maxWidth?: number } = { width: 0, height: 0, fps: null }
    for (let attempt = 0; attempt <= CONTENTION_RETRIES; attempt++) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cameraId }, ...cameraVideoConstraints(profile) }, audio: false })
      let retry = false
      try {
        const track = stream.getVideoTracks()[0]!
        const settings = track.getSettings()
        const maxWidth = track.getCapabilities?.().width?.max
        const smaller = (settings.width ?? 0) < profile.width * 0.9 && (maxWidth ?? 0) >= profile.width
        const size = { width: settings.width ?? 0, height: settings.height ?? 0, ...(maxWidth ? { maxWidth } : {}) }
        // O Chromium divide o aparelho entre as janelas: com a prévia aberta a 640×360 o pedido de 4K volta em 640×360. Espera e tenta de novo.
        if (smaller && attempt < CONTENTION_RETRIES) {
          last = { ...size, fps: null }
          retry = true
        } else {
          return { ...size, fps: await measureTrackFps(track) }
        }
      } finally {
        stream.getTracks().forEach((t) => t.stop())
      }
      if (retry) await sleep(350)
    }
    return last
  })
}
