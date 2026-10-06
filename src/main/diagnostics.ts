import { mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildDiagnosticSnapshot, type DiagnosticSnapshot, type MediaPermissions } from '@shared/diagnostics'
import type { RecordingShortcuts } from '@shared/shortcuts-config'
import { locateFfmpeg } from './ffmpeg'
import { runProcess } from './process-runner'
import { getFfmpegStatus } from './ffmpeg-status'
import type { Logger } from './logger'
import type { AppState } from './state'
import type { TranscriptionService } from './transcription/service'
import type { LlmManager } from './llm/manager'

export type DiagnosticSystem = { gpuInfo(): Promise<{ devices: string[]; hardwareAcceleration: boolean }>; mediaAccess(): MediaPermissions; checkShortcuts?(prefs: RecordingShortcuts): Promise<void> }
export function createDiagnostics(deps: { state: AppState; logger: Logger; transcription: TranscriptionService; llm: LlmManager; system?: DiagnosticSystem }) {
  let confirmedPermissions: Partial<MediaPermissions> = {}
  return {
    confirmPermissions(permissions: MediaPermissions): void { confirmedPermissions = { ...permissions } },
    async snapshot(): Promise<DiagnosticSnapshot> {
      const options = deps.state.ffmpegLocateOptions()
      const [ffmpeg, transcription, gpu] = await Promise.all([getFfmpegStatus(options, deps.logger), deps.transcription.view(), deps.system?.gpuInfo().catch((err: unknown) => { deps.logger.warn('Não consegui identificar a placa de vídeo.', err); return { devices: [], hardwareAcceleration: false } }) ?? Promise.resolve({ devices: [], hardwareAcceleration: false })])
      const paths = locateFfmpeg(options)
      let nvenc: boolean | null = null
      if (paths && !ffmpeg.error) {
        try { const result = await runProcess(paths.ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 10_000, maxOutput: 1024 * 1024 }); nvenc = /\bh264_nvenc\b/.test(result.stdout) }
        catch (err) { deps.logger.warn('Não consegui conferir o NVENC disponível no ffmpeg.', err) }
      }
      const path = deps.state.projectsRoot()
      let error: string | null = null
      const probe = join(path, `.tomada-write-${randomUUID()}.tmp`)
      try { await mkdir(path, { recursive: true }); const handle = await open(probe, 'wx'); await handle.close(); await unlink(probe) }
      catch (err) { error = `Não consegui gravar na pasta dos projetos: ${err instanceof Error ? err.message : String(err)}`; await unlink(probe).catch(() => undefined) }
      const snapshot = buildDiagnosticSnapshot({ ffmpeg, gpu: { ...gpu, nvenc }, transcription, ai: deps.llm.status(), permissions: { camera: 'unknown', microphone: 'unknown', ...deps.system?.mediaAccess(), ...confirmedPermissions }, projects: { path, writable: error === null, error } }, deps.state.settings().onboarding ?? {})
      // Os fluxos convencionais de teste começam na biblioteca; specs do guia o ligam explicitamente.
      if (process.env.TOMADA_PROJECTS_DIR && process.env.TOMADA_TEST_ONBOARDING !== '1') snapshot.shouldGuide = false
      return snapshot
    }
  }
}
