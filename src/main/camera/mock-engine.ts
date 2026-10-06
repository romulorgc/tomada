/**
 * Motor de TESTE da análise da câmera (`TOMADA_CAMERA=mock`): devolve um rosto sintético e determinístico sem tocar no Python, na
 * placa nem na rede. `mock-unprepared` começa "sem preparar" e simula a preparação (com falha opcional num passo, uma vez, por
 * `TOMADA_TEST_PREPARE_FAIL`). `off` é o padrão dos testes que não querem a análise: o motor diz que não está preparado.
 */
import { FACE_TRACK_VERSION, type FaceBox, type FaceTrack } from '@shared/face'
import type { PrepareTracker } from '../transcription/prepare-tracker'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runProcess } from '../process-runner'
import type { CameraEngine, CameraCheck, DetectFacesOptions, MakeMatteOptions, MatteResult } from './types'

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
  /** O ffmpeg: com ele a máscara de teste é um VÍDEO de verdade (a silhueta de uma pessoa); sem ele, um arquivo qualquer. */
  ffmpeg?: () => string | null
  /** A máscara de teste falha uma vez (prova a mensagem e o "tentar de novo"). */
  failMatte?: boolean
  /** O fps e o tamanho da máscara de teste (o da câmera do projeto de exemplo: 30 qps, 640×360). */
  matteFps?: number
  matteSize?: { w: number; h: number }
}

/**
 * A silhueta de teste: uma cabeça (elipse) sobre ombros e tronco (elipse maior que passa da borda de baixo), em branco sobre preto, com a
 * borda suavizada. Determinística: é a máscara "conhecida" dos goldens e dos testes de pixel.
 */
export const MOCK_SILHOUETTE = {
  head: { cx: 0.5, cy: 0.3, rx: 0.09, ry: 0.2 },
  body: { cx: 0.5, cy: 1.1, rx: 0.3, ry: 0.7 }
} as const

export function silhouetteFilter(w: number, fps = 30): string {
  const s = MOCK_SILHOUETTE
  const e = (o: { cx: number; cy: number; rx: number; ry: number }): string => `lte(pow((X-W*${o.cx})/(W*${o.rx}),2)+pow((Y-H*${o.cy})/(H*${o.ry}),2),1)`
  // um quadro só (a silhueta não muda) repetido pelo filtro loop: o geq por pixel em todos os quadros levaria dezenas de segundos
  return `geq=lum='255*max(${e(s.head)},${e(s.body)})':cb=128:cr=128,gblur=sigma=${Math.max(1, (w / 640) * 1.4).toFixed(2)},format=yuv420p,loop=loop=-1:size=1:start=0,fps=${fps}`
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
  let matteFailed = false
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
    },
    async makeMatte(o: MakeMatteOptions): Promise<MatteResult> {
      const fps = opts.matteFps ?? 30
      const size = opts.matteSize ?? { w: 640, h: 360 }
      const seconds = Math.max(0.1, o.durationMs / 1000)
      if (opts.delayMs) {
        const steps = 5
        for (let i = 1; i <= steps; i++) {
          if (o.signal?.aborted) throw new Error('Cancelado.')
          await new Promise((r) => setTimeout(r, opts.delayMs! / steps))
          o.onProgress?.(i / (steps + 1))
        }
      }
      if (opts.failMatte && !matteFailed) {
        matteFailed = true
        throw new Error('Falha simulada no recorte do fundo (TOMADA_TEST_MATTE_FAIL).')
      }
      await mkdir(dirname(o.out), { recursive: true })
      const ffmpeg = opts.ffmpeg?.() ?? null
      if (ffmpeg) {
        const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${size.w}x${size.h}:r=${fps}:d=${(1 / fps).toFixed(4)}`, '-vf', silhouetteFilter(size.w, fps), '-t', seconds.toFixed(3)]
        args.push('-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-g', String(fps), '-movflags', '+faststart', o.out)
        await runProcess(ffmpeg, args, { timeoutMs: 120_000, ...(o.signal ? { signal: o.signal } : {}) })
      } else {
        await writeFile(o.out, 'mascara de teste (sem ffmpeg)')
      }
      o.onProgress?.(1)
      return { engine: 'teste', device: 'teste', frames: Math.round(seconds * fps), fps, frame: size, seconds: 0, msPerFrame: 0 }
    }
  }
}
