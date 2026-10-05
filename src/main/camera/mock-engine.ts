/**
 * Motor de TESTE da análise da câmera (`TOMADA_CAMERA=mock`): devolve um rosto sintético e determinístico sem tocar no Python, na
 * placa nem na rede. `mock-unprepared` começa "sem preparar" e simula a preparação (com falha opcional num passo, uma vez, por
 * `TOMADA_TEST_PREPARE_FAIL`). `off` é o padrão dos testes que não querem a análise: o motor diz que não está preparado.
 */
import { FACE_TRACK_VERSION, type FaceBox, type FaceTrack } from '@shared/face'
import type { PrepareTracker } from '../transcription/prepare-tracker'
import type { CameraEngine, CameraCheck, DetectFacesOptions } from './types'

export type MockCameraOptions = {
  ready: boolean
  /** Quanto a análise demora (ms): deixa ver o andamento. */
  delayMs?: number
  stepMs?: number
  failStep?: string
  /** Centro do rosto sintético no início e no fim da gravação (fração da imagem). Padrão: 0,32 → 0,68, para o recorte andar. */
  from?: number
  to?: number
  /** O rosto sintético some (nenhuma detecção): prova a mensagem "não achei um rosto". */
  noFace?: boolean
}

export const MOCK_FACE = { w: 0.14, h: 0.3, cy: 0.42, sampleMs: 200 } as const

/** O rosto sintético: vai do `from` ao `to` em linha reta, olhado a cada 200 ms. */
export function syntheticFaceTrack(durationMs: number, from = 0.32, to = 0.68, noFace = false): FaceTrack {
  const boxes: FaceBox[] = []
  if (!noFace) {
    for (let t = 0; t <= durationMs; t += MOCK_FACE.sampleMs) {
      const u = durationMs > 0 ? t / durationMs : 0
      const cx = from + (to - from) * u
      boxes.push({ t, x: cx - MOCK_FACE.w / 2, y: MOCK_FACE.cy - MOCK_FACE.h / 2, w: MOCK_FACE.w, h: MOCK_FACE.h, score: 0.99 })
    }
  }
  return { version: FACE_TRACK_VERSION, engine: 'teste', frame: { w: 1280, h: 720 }, sampleMs: MOCK_FACE.sampleMs, durationMs, boxes, createdAt: new Date().toISOString() }
}

export function createMockCamera(opts: MockCameraOptions): CameraEngine {
  let ready = opts.ready
  let failed = false
  const missing = 'A análise da câmera ainda não foi preparada neste computador.'
  return {
    id: 'mock',
    prepareSteps: [
      { id: 'packages', weight: 1 },
      { id: 'model', weight: 1 },
      { id: 'check', weight: 1 }
    ],
    async check(): Promise<CameraCheck> {
      const state = ready ? ({ state: 'ready', detail: null } as const) : ({ state: 'missing', detail: missing } as const)
      return { face: state, matte: state, device: ready ? 'Placa de teste' : null }
    },
    async prepare(tracker: PrepareTracker, signal: AbortSignal): Promise<void> {
      for (const id of ['packages', 'model', 'check'] as const) {
        tracker.begin(id, 'Simulando…')
        const ticks = 4
        for (let t = 1; t <= ticks; t++) {
          if (signal.aborted) {
            tracker.cancelled()
            throw new Error('Cancelado.')
          }
          await new Promise((r) => setTimeout(r, (opts.stepMs ?? 120) / ticks))
          tracker.progress(id, t / ticks, `Passo ${id} (${t}/${ticks})`)
        }
        if (opts.failStep === id && !failed) {
          failed = true
          const message = `Falha simulada no passo "${id}" (TOMADA_TEST_PREPARE_FAIL).`
          tracker.fail(id, message)
          throw new Error(message)
        }
        tracker.done(id, 'ok')
      }
      ready = true
    },
    async detectFaces(o: DetectFacesOptions): Promise<FaceTrack> {
      if (opts.delayMs) {
        const steps = 5
        for (let i = 1; i <= steps; i++) {
          if (o.signal?.aborted) throw new Error('Cancelado.')
          await new Promise((r) => setTimeout(r, opts.delayMs! / steps))
          o.onProgress?.(i / steps)
        }
      }
      o.onProgress?.(1)
      return syntheticFaceTrack(o.durationMs, opts.from, opts.to, opts.noFace)
    }
  }
}
