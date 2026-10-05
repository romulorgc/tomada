import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { CameraCalibration } from '@shared/camera-sync'
import type { LipSyncDetector } from './lip-sync'
import { isPhysicalDeviceId } from '@shared/capture-devices'

export const MAX_CALIBRATION_BYTES = 32 * 1024 * 1024
export type CalibrationCapture = { cameraId: string; micId: string; data: ArrayBuffer | Uint8Array }
export interface CameraCalibrationService { run(capture: CalibrationCapture): Promise<CameraCalibration> }

/** O backend escolhe o destino; renderer só fornece bytes de cinco segundos e IDs do aparelho. */
export function createCameraCalibration(args: { scratchDir: string; detector: LipSyncDetector; save: (value: CameraCalibration) => Promise<void> }): CameraCalibrationService {
  let busy = false
  return {
    async run(capture) {
      if (busy) throw new Error('Uma calibração já está em andamento.')
      const pair = z.object({ cameraId: z.string().min(1).max(500), micId: z.string().min(1).max(500) }).parse(capture)
      if (!isPhysicalDeviceId(pair.cameraId) || !isPhysicalDeviceId(pair.micId)) throw new Error('Escolha os aparelhos físicos para calibrar; o dispositivo padrão pode mudar.')
      if (!(capture.data instanceof ArrayBuffer) && !(capture.data instanceof Uint8Array)) throw new Error('Captura de calibração inválida.')
      if (capture.data.byteLength < 1 || capture.data.byteLength > MAX_CALIBRATION_BYTES) throw new Error('A captura ultrapassa o limite de 32 MB ou está vazia. Grave novamente.')
      busy = true
      let dir: string | undefined
      try {
        await mkdir(args.scratchDir, { recursive: true })
        dir = await mkdtemp(join(args.scratchDir, 'captura-'))
        const path = join(dir, 'camera.webm')
        await writeFile(path, Buffer.from(capture.data instanceof Uint8Array ? capture.data : new Uint8Array(capture.data)))
        const measured = await args.detector.clap(path)
        if (!Number.isFinite(measured.offsetMs) || Math.abs(measured.offsetMs) > 300 || !Number.isFinite(measured.confidence) || measured.confidence < 3) throw new Error('A palma não produziu uma medição confiável. Tente novamente.')
        const result: CameraCalibration = { ...pair, ...measured, calibratedAt: new Date().toISOString() }
        await args.save(result)
        return result
      } finally {
        try { if (dir) await rm(dir, { recursive: true, force: true }) }
        finally { busy = false }
      }
    }
  }
}
