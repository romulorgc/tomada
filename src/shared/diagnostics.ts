import type { FfmpegStatus } from './ipc'
import type { OnboardingPrefs } from './settings-defaults'
import type { LlmStatus, TranscriptionView } from './transcription'

export type MediaPermission = 'granted' | 'denied' | 'unknown'
export type MediaPermissions = { camera: MediaPermission; microphone: MediaPermission }
export type DiagnosticItem = { id: 'ffmpeg' | 'gpu' | 'transcription' | 'ai' | 'permissions' | 'projects'; status: 'ok' | 'missing' | 'warning' | 'skipped'; detail: string; action: 'ffmpeg' | 'test-gpu' | 'prepare' | 'ai' | 'permissions' | 'projects' }
export type DiagnosticInput = { ffmpeg: FfmpegStatus; gpu: { devices: string[]; hardwareAcceleration: boolean; nvenc: boolean | null }; transcription: TranscriptionView; ai: LlmStatus; permissions: MediaPermissions; projects: { path: string; writable: boolean; error: string | null } }
export type DiagnosticSnapshot = DiagnosticInput & { items: DiagnosticItem[]; fingerprint: string; shouldGuide: boolean }

/** Pular não esconde uma dependência que faltar depois. */
export function buildDiagnosticSnapshot(input: DiagnosticInput, prefs: OnboardingPrefs): DiagnosticSnapshot {
  const ffmpegOk = input.ffmpeg.found && !input.ffmpeg.error
  const items: DiagnosticItem[] = [
    { id: 'ffmpeg', status: ffmpegOk ? 'ok' : 'missing', detail: ffmpegOk ? `ffmpeg ${input.ffmpeg.version ?? ''} e ffprobe disponíveis.` : input.ffmpeg.error ?? 'Escolha o ffmpeg instalado neste computador.', action: 'ffmpeg' },
    { id: 'gpu', status: input.gpu.hardwareAcceleration && input.gpu.nvenc === true ? 'ok' : 'warning', detail: `${input.gpu.devices.join(', ') || 'Placa de vídeo não identificada'}. ${input.gpu.nvenc === true ? 'NVENC disponível no ffmpeg; use o teste para conferir a codificação.' : input.gpu.nvenc === false ? 'Sem NVENC: a normalização usa H.264 por software.' : 'Escolha o ffmpeg para conferir o NVENC.'}`, action: 'test-gpu' },
    { id: 'transcription', status: input.transcription.state === 'ready' ? 'ok' : 'missing', detail: input.transcription.state === 'ready' ? `${input.transcription.engine} pronto${input.transcription.device ? ` · ${input.transcription.device}` : ''}.` : input.transcription.detail ?? 'Prepare a transcrição local: download de aproximadamente 3 GB.', action: 'prepare' },
    { id: 'ai', status: input.ai.available ? 'ok' : prefs.withoutAi ? 'skipped' : 'missing', detail: input.ai.available ? input.ai.cliFound && input.ai.provider === 'cli' ? 'Programa da IA detectado neste computador.' : 'IA configurada neste computador.' : prefs.withoutAi ? 'Você escolheu seguir sem IA. Pode ligar pelos Ajustes.' : input.ai.detail ?? 'Use o programa da IA instalado, guarde uma chave ou siga sem IA.', action: 'ai' },
    { id: 'permissions', status: input.permissions.camera === 'granted' && input.permissions.microphone === 'granted' ? 'ok' : 'missing', detail: input.permissions.camera === 'granted' && input.permissions.microphone === 'granted' ? 'Câmera e microfone autorizados.' : 'Confira o acesso à câmera e ao microfone. Você pode gravar só a tela.', action: 'permissions' },
    { id: 'projects', status: input.projects.writable ? 'ok' : 'missing', detail: input.projects.error ?? input.projects.path, action: 'projects' }
  ]
  const fingerprint = items.filter((i) => i.status === 'missing').map((i) => `${i.id}:${i.id === 'projects' ? input.projects.path : i.id === 'transcription' ? input.transcription.engine : ''}`).join('|') || 'ready'
  const dismissed = prefs.dismissedFingerprint === fingerprint
  return { ...input, items, fingerprint, shouldGuide: !dismissed && (!prefs.completedAt || items.some((i) => i.status === 'missing')) }
}
