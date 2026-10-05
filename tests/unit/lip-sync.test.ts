import { describe, expect, it, vi } from 'vitest'
import { createLipSyncDetector, lipSyncFailureDiagnostic, parseLipSyncResult } from '../../src/main/lip-sync'
import { ProcessError, runProcess } from '../../src/main/process-runner'
import { access } from 'node:fs/promises'
import type { Logger } from '../../src/main/logger'
import { calibrationForPair } from '@shared/camera-sync'

vi.mock('node:fs/promises', () => ({ access: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/main/process-runner', async (original) => ({ ...await original<typeof import('../../src/main/process-runner')>(), runProcess: vi.fn() }))

describe('resultado local de sincronia labial', () => {
  it('calibração distingue dependência ausente e timeout, registra a causa segura e mostra mensagem acionável', async () => {
    const warn = vi.fn()
    const detector = createLipSyncDetector({ toolsDir: 'C:/tools', scriptPath: 'C:/tools/sync.py', ffmpeg: () => 'C:/tools/ffmpeg.exe', logger: { warn } as unknown as Logger })
    vi.mocked(access).mockRejectedValueOnce(new Error('C:/privado/dado'))
    await expect(detector.clap('C:/tools/calib.webm')).rejects.toThrow('não está preparado')
    expect(warn).toHaveBeenLastCalledWith(expect.any(String), { category: 'unavailable-runtime', component: 'python' })
    vi.mocked(runProcess).mockRejectedValueOnce(new ProcessError('dado pessoal', 'timeout', null, '', ''))
    await expect(detector.clap('C:/tools/calib.webm')).rejects.toThrow('tempo limite')
    expect(warn).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ reason: 'timeout' }))
  })
  it('o diagnóstico técnico registra saída e módulo sem conteúdo ou caminhos pessoais', () => {
    const error = new ProcessError('erro em C:/privado/rosto.mp4', 'exit', 1, 'fala pessoal', "ModuleNotFoundError: No module named 'onnxruntime'; C:/privado/rosto.mp4")
    const detail = lipSyncFailureDiagnostic(error)
    expect(detail).toMatchObject({ reason: 'exit', exitCode: 1, component: 'onnxruntime' })
    expect(JSON.stringify(detail)).not.toMatch(/privado|rosto|pessoal/)
    expect(lipSyncFailureDiagnostic(new ProcessError('segredo', 'timeout', null, '', ''))).toMatchObject({ reason: 'timeout', exitCode: null })
  })
  it('usa os trechos concordantes, sem confiar no agregado devolvido pelo processo', () => {
    const result = parseLipSyncResult(JSON.stringify({ detector: 'syncnet', segments: [80, 100, 90].map((offsetMs) => ({ startMs: 1000, durationMs: 3000, offsetMs, confidence: 6 })), offsetMs: -500, confidence: 8 }))
    expect(result.offsetMs).toBe(90)
    expect(result.accepted).toBe(3)
  })
  it('sem confiança suficiente retorna indisponível e nunca uma falsa correção', () => {
    expect(parseLipSyncResult(JSON.stringify({ detector: 'syncnet', segments: [], offsetMs: 50, confidence: 0, reason: 'Sem rosto falando.' })).offsetMs).toBeNull()
    expect(() => parseLipSyncResult('{"segments":[{"offsetMs":"80"}]}')).toThrow()
  })
  it('calibração pertence ao par exato e não migra para outro microfone', () => {
    const c = { cameraId: 'cam', micId: 'mic', offsetMs: 80, confidence: 5, calibratedAt: '2026-10-05' }
    expect(calibrationForPair([c], 'cam', 'mic')).toEqual(c)
    expect(calibrationForPair([c], 'cam', 'other')).toBeUndefined()
    expect(calibrationForPair([c], null, 'mic')).toBeUndefined()
  })
})
