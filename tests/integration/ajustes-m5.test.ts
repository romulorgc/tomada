import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_DICTIONARY } from '@shared/dictionary'
import { createAppState } from '../../src/main/state'
import { createMemoryLogger } from '../../src/main/logger'
import { useTmpDir } from '../helpers/env'
import { readdirSync, writeFileSync } from 'node:fs'
import { createDiagnostics } from '../../src/main/diagnostics'
import { createHandlers } from '../../src/main/handlers'
import { createProjectStore } from '../../src/main/projects'
import { createOutputDirs } from '../../src/main/path-guard'
import { createIdleExportService, createIdleRecordingService } from '../helpers/recording'
import { transcriptionDeps } from '../helpers/handler-extras'
import { defaultCaptions, defaultStyle } from '@shared/project'
import { DEFAULT_AUTOPILOT } from '@shared/autopilot'
import type { Settings } from '@shared/ipc'
import { DEFAULT_RECORDING_SHORTCUTS } from '@shared/shortcuts-config'
import type { RecordRequest } from '@shared/recording'

const tmp = useTmpDir('tomada-m5-settings-')
describe('ajustes completos persistidos', () => {
  it('dicionário ausente usa o especificação, e uma lista vazia escolhida continua vazia ao reabrir', async () => {
    const file = join(tmp(), 'settings.json')
    const state = await createAppState({ file, env: {}, logger: createMemoryLogger() })
    expect(state.dictionary()).toEqual(DEFAULT_DICTIONARY)
    await state.setDictionary([])
    const again = await createAppState({ file, env: {}, logger: createMemoryLogger() })
    expect(again.dictionary()).toEqual([])
  })
  it('persiste atalhos, exportação, legenda por formato e primeira execução sem apagar o dicionário', async () => {
    const file = join(tmp(), 'settings.json')
    const state = await createAppState({ file, env: {}, logger: createMemoryLogger() })
    await state.setDictionary(['Termo pessoal'])
    await state.update({ shortcuts: { recordStop: 'Ctrl+Alt+R', pause: 'Ctrl+Alt+P' }, exportDefaults: { horizontal: { resolution: '1440p', fps: 60 }, vertical: { fps: 30 } }, ownerZoomPreset: 'off', onboarding: { dismissedFingerprint: 'falta:transcription', completedAt: '2026-10-05T12:00:00Z' } })
    const again = await createAppState({ file, env: {}, logger: createMemoryLogger() })
    expect(again.recordingShortcuts()).toEqual({ recordStop: 'Ctrl+Alt+R', pause: 'Ctrl+Alt+P' })
    expect(again.view().settings).toMatchObject({ exportDefaults: { horizontal: { resolution: '1440p', fps: 60 } }, ownerZoomPreset: 'off', onboarding: { dismissedFingerprint: 'falta:transcription' } })
    expect(again.dictionary()).toEqual(['Termo pessoal'])
  })
  it('recusa conflitos sem guardar e também recusa trocar Errei para um atalho ocupado', async () => {
    const state = await createAppState({ file: join(tmp(), 'settings.json'), env: {}, logger: createMemoryLogger() })
    await expect(state.update({ shortcuts: { recordStop: 'Ctrl+Shift+R', pause: 'Ctrl+Shift+R' } })).rejects.toThrow()
    await state.update({ shortcuts: { recordStop: 'Ctrl+Alt+X', pause: 'Ctrl+Shift+P' } })
    await expect(state.updateRecordPrefs({ retakeShortcut: 'Ctrl+Alt+X' })).rejects.toThrow(/Errei/)
    expect(state.recordPrefs().retakeShortcut).toBe('Ctrl+Alt+Z')
  })
  it('abre com atalhos padrão quando um arquivo antigo guarda combinações conflitantes', async () => {
    const file = join(tmp(), 'settings.json')
    writeFileSync(file, JSON.stringify({ shortcuts: { recordStop: 'Ctrl+Alt+X', pause: 'Ctrl+Alt+X' }, dictionary: ['Termo guardado'] }))
    const state = await createAppState({ file, env: {}, logger: createMemoryLogger() })
    expect(state.recordingShortcuts()).toEqual(DEFAULT_RECORDING_SHORTCUTS)
    expect(state.dictionary()).toEqual(['Termo guardado'])
  })
  it('troca o motor por seu método específico e não redefine estilo ao salvar outra seção', async () => {
    const file = join(tmp(), 'settings.json')
    const state = await createAppState({ file, env: {}, logger: createMemoryLogger() })
    await state.update({ ownerStyle: { ...defaultStyle(), padding: 0.02, camera: { ...defaultStyle().camera, shape: 'rounded' } } })
    await state.setTranscriptionEngine('whisper-cpp')
    await state.update({ onboarding: { withoutAi: true } })
    const again = await createAppState({ file, env: {}, logger: createMemoryLogger() })
    expect(again.transcriptionEngine()).toBe('whisper-cpp')
    expect(again.settings().ownerStyle).toMatchObject({ padding: 0.02, camera: { shape: 'rounded' } })
  })
  it('as opções de legenda no piloto e no estilo têm uma escolha coerente por formato', async () => {
    const state = await createAppState({ file: join(tmp(), 'settings.json'), env: {}, logger: createMemoryLogger() })
    await state.update({ autopilot: { ...DEFAULT_AUTOPILOT, mode: 'nothing' } })
    await state.update({ ownerCaptionsHorizontal: { ...defaultCaptions(), enabled: true }, ownerCaptionsVertical: { ...defaultCaptions(), wordsPerLine: 2, enabled: false } })
    expect(state.settings().autopilot).toMatchObject({ mode: 'nothing', captionsHorizontal: true, captionsVertical: false })
    await state.update({ autopilot: { ...state.settings().autopilot!, captionsHorizontal: false, captionsVertical: true } })
    expect(state.settings().ownerCaptionsHorizontal?.enabled).toBe(false)
    expect(state.settings().ownerCaptionsVertical?.enabled).toBe(true)
  })
  it('uma mudança parcial de modo do piloto preserva legenda e opções anteriores', async () => {
    const state = await createAppState({ file: join(tmp(), 'settings.json'), env: {}, logger: createMemoryLogger() })
    await state.update({ autopilot: { ...DEFAULT_AUTOPILOT, maxClips: 5, steps: { clean: false } }, ownerCaptionsHorizontal: { ...defaultCaptions(), enabled: true }, ownerCaptionsVertical: { ...defaultCaptions(), wordsPerLine: 2, enabled: false } })
    // O IPC é desserializado em tempo de execução e também aceita um patch de uma só opção.
    await state.update({ autopilot: { mode: 'nothing' } as Settings['autopilot'] })
    expect(state.settings().autopilot).toMatchObject({ mode: 'nothing', maxClips: 5, steps: { clean: false }, captionsHorizontal: true, captionsVertical: false })
    expect(state.settings().ownerCaptionsHorizontal?.enabled).toBe(true)
    expect(state.settings().ownerCaptionsVertical?.enabled).toBe(false)
  })
})

async function build(checkShortcuts?: () => Promise<void>) {
  const dir = tmp()
  const logger = createMemoryLogger()
  const state = await createAppState({ file: join(dir, 'settings.json'), env: { ...process.env, TOMADA_PROJECTS_DIR: join(dir, 'projetos') }, logger })
  const store = createProjectStore({ root: () => state.projectsRoot(), logger, trash: async () => undefined, openFolder: async () => undefined })
  const extras = transcriptionDeps({ state, store, logger })
  const system = { gpuInfo: async () => ({ devices: ['Placa de teste'], hardwareAcceleration: true }), mediaAccess: () => ({ camera: 'granted' as const, microphone: 'unknown' as const }), ...(checkShortcuts ? { checkShortcuts } : {}) }
  const recording = createIdleRecordingService()
  const handlers = createHandlers({
    info: { name: 'Tomada', version: '0', platform: 'win32', electron: '40', userDataDir: dir, logsDir: dir }, state, store, logger,
    ...extras, diagnostics: system, recording, exporter: createIdleExportService(),
    derived: { peaks: async () => null, previewAudio: async () => null, thumbs: async () => null, levels: async () => null, idle: async () => undefined, shutdown: () => undefined },
    pickFolder: async () => null, pickFfmpeg: async () => null, pickExportDir: async () => null, outputDirs: createOutputDirs(), pickImage: async () => null,
    openPath: async () => undefined, revealPath: async () => undefined, copyText: () => undefined, finishCountdown: () => undefined, clock: () => 0
  })
  return { dir, state, handlers, recording, diagnostics: createDiagnostics({ state, logger, transcription: extras.transcription, llm: extras.llm, system }) }
}

describe('diagnóstico e fronteiras de ajustes por IPC', () => {
  it('confere ffmpeg sem codificar, usa permissões atuais e prova escrita sem deixar arquivo de teste', async () => {
    const { diagnostics, state } = await build()
    const view = await diagnostics.snapshot()
    expect(view.ffmpeg.found).toBe(true)
    expect(view.gpu.devices).toEqual(['Placa de teste'])
    expect(view.gpu.nvenc).not.toBeNull()
    expect(view.projects.writable).toBe(true)
    expect(view.permissions).toEqual({ camera: 'granted', microphone: 'unknown' })
    expect(readdirSync(state.projectsRoot())).toEqual([])
    diagnostics.confirmPermissions({ camera: 'granted', microphone: 'granted' })
    expect((await diagnostics.snapshot()).items.find((item) => item.id === 'permissions')?.status).toBe('ok')
  })
  it('um conflito do sistema não grava o atalho, e um atalho livre persiste pelo canal conferido', async () => {
    const blocked = await build(async () => { throw new Error('Atalho ocupado por outro programa.') })
    await expect(blocked.handlers['settings:set-shortcuts']({ recordStop: 'Ctrl+Alt+R', pause: 'Ctrl+Alt+P' })).rejects.toThrow(/outro programa/)
    expect(blocked.state.settings().shortcuts).toBeUndefined()
    const free = await build(async () => undefined)
    await free.handlers['settings:set-shortcuts']({ recordStop: 'Ctrl+Alt+R', pause: 'Ctrl+Alt+P' })
    expect(free.state.recordingShortcuts()).toEqual({ recordStop: 'Ctrl+Alt+R', pause: 'Ctrl+Alt+P' })
    await expect(free.handlers['settings:update']({ shortcuts: { recordStop: 'Ctrl+Shift+R', pause: 'Ctrl+Shift+P' } })).rejects.toThrow(/Atalhos/)
  })
  it('não permite guardar imagem fora do diálogo nem permissões inventadas', async () => {
    const { handlers } = await build()
    await expect(handlers['settings:update']({ ownerStyle: { ...defaultStyle(), background: { type: 'image', path: '../../arquivo' } } })).rejects.toThrow(/Escolher imagem/)
    await expect(handlers['diagnostics:permissions']({ camera: 'inventado', microphone: 'granted' } as never)).rejects.toThrow()
  })
  it('preparar rejeita um pedido direto com Errei conflitante antes de iniciar a gravação', async () => {
    const { handlers, state, recording } = await build()
    await state.update({ shortcuts: { recordStop: 'Ctrl+Alt+X', pause: 'Ctrl+Alt+P' } })
    const prepare = vi.spyOn(recording, 'prepare').mockResolvedValue({ sessionId: 'sessao', folder: 'pasta', kind: 'screen', sourceName: 'Tela', nativeSize: null, scale: 1 })
    const request: RecordRequest = { mode: 'screen', sourceId: 'screen:1:0', fps: 30, cameraId: null, micId: null, systemAudio: false, showBubble: false, hideCursor: true, retakeShortcut: 'Ctrl+Alt+X' }
    await expect(handlers['record:prefs-set']({ retakeShortcut: request.retakeShortcut! })).rejects.toThrow(/Errei/)
    await expect(handlers['record:prepare'](request)).rejects.toThrow(/Errei/)
    expect(prepare).not.toHaveBeenCalled()
    await expect(handlers['record:prepare']({ ...request, retakeShortcut: 'Ctrl+Alt+Z' })).resolves.toMatchObject({ sessionId: 'sessao' })
    expect(prepare).toHaveBeenCalledTimes(1)
  })
})
