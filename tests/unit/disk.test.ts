import { describe, expect, it } from 'vitest'
import { diskEstimate, estimateExportBytes, estimateRecordingBytes } from '../../src/shared/disk'

describe('espaço estimado', () => {
  it('estima gravação por trilhas, duração e cópias da normalização', () => {
    const one = estimateRecordingBytes({ durationMs: 60_000, screenBitrate: 8_000_000, cameraBitrate: 0, audioTracks: 0 })
    const hour = estimateRecordingBytes({ durationMs: 3_600_000, screenBitrate: 8_000_000, cameraBitrate: 0, audioTracks: 0 })
    expect(one).toBeGreaterThan(180_000_000)
    expect(hour).toBeGreaterThan(10_800_000_000)
    expect(estimateRecordingBytes({ durationMs: 60_000, screenBitrate: 8_000_000, cameraBitrate: 4_000_000, audioTracks: 1 })).toBeGreaterThan(one)
  })
  it('exportar reserva vídeo, mux, áudio e margem, sem depender da memória', () => {
    expect(estimateExportBytes(3_600_000, 8_000_000, 384_000)).toBeGreaterThan(7_545_600_000)
    expect(estimateExportBytes(30_000, 8_000_000, 384_000)).toBeLessThan(400_000_000)
  })
  it('aviso compara estimativa ao livre, incluindo motivo e medição indisponível', () => {
    expect(diskEstimate(100, 200, 60_000, 'normalização')).toMatchObject({ status: 'low', freeBytes: 100, estimatedBytes: 200, reason: 'normalização' })
    expect(diskEstimate(200, 200, 60_000, 'normalização').status).toBe('ok')
    expect(diskEstimate(null, 200, 60_000, 'normalização').status).toBe('unknown')
  })
})
