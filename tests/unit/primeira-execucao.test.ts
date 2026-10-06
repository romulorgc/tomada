import { describe, expect, it } from 'vitest'
import { buildDiagnosticSnapshot } from '@shared/diagnostics'

const ready = {
  ffmpeg: { found: true, source: 'path' as const, ffmpegPath: 'C:\\ffmpeg.exe', ffprobePath: 'C:\\ffprobe.exe', version: '8', ffprobeVersion: '8', error: null },
  gpu: { devices: ['NVIDIA RTX'], hardwareAcceleration: true, nvenc: true },
  transcription: { engine: 'faster-whisper' as const, state: 'ready' as const, detail: null, device: 'NVIDIA RTX', prepare: null, jobs: [] },
  ai: { available: true, provider: 'cli' as const, cliFound: true, hasKey: false, preference: 'auto' as const, detail: null },
  permissions: { camera: 'granted' as const, microphone: 'granted' as const }, projects: { path: 'C:\\Videos\\Tomada', writable: true, error: null }
}
describe('primeira execução guiada', () => {
  it('mostra os seis itens e abre na primeira execução mesmo quando já está pronto', () => {
    const view = buildDiagnosticSnapshot(ready, {})
    expect(view.items.map((i) => i.id)).toEqual(['ffmpeg', 'gpu', 'transcription', 'ai', 'permissions', 'projects'])
    expect(view.items.every((i) => i.status === 'ok')).toBe(true)
    expect(view.shouldGuide).toBe(true)
  })
  it('pular guarda o diagnóstico atual, mas uma falta nova volta a orientar', () => {
    const missing = { ...ready, transcription: { ...ready.transcription, state: 'missing' as const } }
    const first = buildDiagnosticSnapshot(missing, {})
    expect(buildDiagnosticSnapshot(missing, { dismissedFingerprint: first.fingerprint }).shouldGuide).toBe(false)
    const other = buildDiagnosticSnapshot({ ...missing, projects: { ...ready.projects, writable: false, error: 'Pasta sem acesso' } }, { dismissedFingerprint: first.fingerprint })
    expect(other.shouldGuide).toBe(true)
    expect(other.items.find((i) => i.id === 'projects')).toMatchObject({ status: 'missing', detail: 'Pasta sem acesso' })
  })
  it('seguir sem IA é uma escolha explícita e sem NVENC oferece software', () => {
    const view = buildDiagnosticSnapshot({ ...ready, ai: { ...ready.ai, available: false }, gpu: { ...ready.gpu, nvenc: false } }, { withoutAi: true, completedAt: '2026-10-05T12:00:00Z' })
    expect(view.items.find((i) => i.id === 'ai')?.status).toBe('skipped')
    expect(view.items.find((i) => i.id === 'gpu')?.status).toBe('warning')
    expect(view.shouldGuide).toBe(false)
  })
  it('permissão desconhecida e motor com erro mostram a ação e o motivo', () => {
    const view = buildDiagnosticSnapshot({ ...ready, permissions: { camera: 'unknown', microphone: 'denied' }, transcription: { ...ready.transcription, state: 'error', detail: 'Modelo incompleto' } }, {})
    expect(view.items.find((i) => i.id === 'permissions')).toMatchObject({ status: 'missing', action: 'permissions' })
    expect(view.items.find((i) => i.id === 'transcription')).toMatchObject({ status: 'missing', detail: 'Modelo incompleto', action: 'prepare' })
  })
})
