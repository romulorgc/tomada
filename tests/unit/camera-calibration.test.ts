import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCameraCalibration, MAX_CALIBRATION_BYTES } from '../../src/main/camera-calibration'

describe('calibração por captura limitada, sem caminho vindo do renderer', () => {
  it('salva só medição confiável e limpa a captura temporária', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'tomada-cal-'))
    const saved: unknown[] = []
    let captured = ''
    const service = createCameraCalibration({ scratchDir: temp, detector: { detect: async () => { throw new Error('não usado') }, clap: async (path) => { captured = path; expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3])); return { offsetMs: 80, confidence: 5 } } }, save: async (value) => { saved.push(value) } })
    try {
      const result = await service.run({ cameraId: 'cam', micId: 'mic', data: new Uint8Array([1, 2, 3]) })
      expect(result.offsetMs).toBe(80)
      expect(saved).toHaveLength(1)
      await expect(readFile(captured)).rejects.toThrow()
      await expect(service.run({ cameraId: 'cam', micId: 'mic', data: new Uint8Array(MAX_CALIBRATION_BYTES + 1) })).rejects.toThrow('limite')
      await expect(service.run({ cameraId: '', micId: 'mic', data: new Uint8Array([1]) })).rejects.toThrow()
    } finally { await rm(temp, { recursive: true, force: true }) }
  })
  it('erro do detector não grava calibração nem deixa a mídia no disco', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'tomada-cal-'))
    let captured = ''
    let count = 0
    const service = createCameraCalibration({ scratchDir: temp, detector: { detect: async () => { throw new Error('não usado') }, clap: async (path) => { captured = path; throw new Error('Sem palma.') } }, save: async () => { count++ } })
    try {
      await expect(service.run({ cameraId: 'cam', micId: 'mic', data: new Uint8Array([1]) })).rejects.toThrow('Sem palma')
      expect(count).toBe(0)
      await expect(readFile(captured)).rejects.toThrow()
    } finally { await rm(temp, { recursive: true, force: true }) }
  })
})
