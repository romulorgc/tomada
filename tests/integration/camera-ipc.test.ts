/**
 * O canal `camera:analyze` ponta a ponta no processo principal (handlers + serviço + motor de teste): o pedido EXPLÍCITO de refazer
 * (`force`, do botão "Recortar de novo") passa pelo IPC com o booleano VALIDADO e refaz a máscara; sem ele o cache é devolvido.
 * O que vem da interface não é confiável: `force` que não é booleano é recusado.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MATTE_FILE, MATTE_PARTIAL_FILE } from '@shared/matte'
import { createHandlers, type HandlerDeps } from '../../src/main/handlers'
import { createCameraService } from '../../src/main/camera/service'
import { createMockCamera } from '../../src/main/camera/mock-engine'
import type { CameraEngine } from '../../src/main/camera/types'
import { createLlmManager } from '../../src/main/llm/manager'
import { createMemoryLogger } from '../../src/main/logger'
import { ENV_PROJECTS_DIR } from '../../src/main/paths'
import { createOutputDirs } from '../../src/main/path-guard'
import { createProjectStore } from '../../src/main/projects'
import { createAppState } from '../../src/main/state'
import { createMockTranscriber } from '../../src/main/transcription/mock'
import { createTranscriptionService } from '../../src/main/transcription/service'
import { copyTree, FIX, useTmpDir } from '../helpers/env'
import { fakeVault } from '../helpers/handler-extras'
import { createIdleExportService, createIdleRecordingService } from '../helpers/recording'

const tmp = useTmpDir()

async function build() {
  const base = tmp()
  const root = join(base, 'projetos')
  copyTree(FIX.exemplo, join(root, 'p1'))
  const logger = createMemoryLogger()
  const env: NodeJS.ProcessEnv = { ...process.env, [ENV_PROJECTS_DIR]: root, TOMADA_LLM: 'mock' }
  const state = await createAppState({ file: join(base, 'settings.json'), env, logger })
  const store = createProjectStore({ root: () => state.projectsRoot(), logger, trash: async () => undefined, openFolder: async () => undefined })
  const transcription = createTranscriptionService({ logger, engine: createMockTranscriber({ ready: true }), read: (id) => store.read(id), vocabulary: () => [], emit: () => undefined })
  const llm = createLlmManager({ env, getPrefs: () => state.llmPrefs(), savePrefs: (patch) => state.updateLlmPrefs(patch), vault: fakeVault, scratchDir: '', logger })
  const mock = createMockCamera({ ready: true })
  const calls = { matte: 0 }
  const engine: CameraEngine = {
    ...mock,
    makeMatte: (o) => {
      calls.matte++
      return mock.makeMatte(o)
    }
  }
  const camera = createCameraService({ logger, engine, read: (id) => store.read(id), emit: () => undefined })
  const previews: boolean[] = []
  const deps: HandlerDeps = {
    previewActive: (active) => previews.push(active),
    info: { name: 'Tomada', version: '0.0.0', platform: 'win32', electron: '40', userDataDir: base, logsDir: base },
    state,
    store,
    logger,
    pickFolder: async () => null,
    pickFfmpeg: async () => null,
    recording: createIdleRecordingService(),
    exporter: createIdleExportService(),
    derived: { peaks: async () => null, previewAudio: async () => null, thumbs: async () => null, levels: async () => null, cropSuggest: async () => null, idle: async () => undefined, shutdown: () => undefined },
    transcription,
    camera,
    llm,
    outputDirs: createOutputDirs(),
    pickExportDir: async () => null,
    pickImage: async () => null,
    openPath: async () => undefined,
    revealPath: async () => undefined,
    copyText: () => undefined,
    finishCountdown: () => undefined,
    clock: () => 0
  }
  return { handlers: createHandlers(deps), camera, calls, previews, root, logger }
}

describe('camera:analyze: pedido explícito de refazer (force) pelo IPC', () => {
  it('sem `force` o recorte guardado volta na hora; com `force: true` a máscara é REFEITA', async () => {
    const { handlers, camera, calls } = await build()
    const first = await handlers['camera:analyze']('p1', 'matte')
    expect(['queued', 'running']).toContain(first.state)
    await camera.idle()
    expect(calls.matte).toBe(1)

    const cached = await handlers['camera:analyze']('p1', 'matte')
    expect(cached.state).toBe('done')
    expect(calls.matte).toBe(1)
    const cachedFalse = await handlers['camera:analyze']('p1', 'matte', false)
    expect(cachedFalse.state).toBe('done')
    expect(calls.matte).toBe(1)

    const redo = await handlers['camera:analyze']('p1', 'matte', true)
    expect(['queued', 'running']).toContain(redo.state)
    await camera.idle()
    expect(calls.matte, '"Recortar de novo" devolveu o cache em vez de refazer').toBe(2)
  })

  it('`force` que não é booleano é recusado e nada roda (a interface não é confiável)', async () => {
    const { handlers, camera, calls } = await build()
    for (const bad of ['true', 1, 0, null, {}, [true]]) {
      await expect(handlers['camera:analyze']('p1', 'matte', bad as unknown as boolean), `aceitou ${JSON.stringify(bad)}`).rejects.toThrow(/inválido/)
    }
    await camera.idle()
    expect(calls.matte).toBe(0)
  })

  it('o tipo continua um conjunto fechado, com ou sem `force`', async () => {
    const { handlers } = await build()
    await expect(handlers['camera:analyze']('p1', 'qualquer-coisa' as never, true)).rejects.toThrow(/inválido/)
  })
})

describe('R1: abrir o projeto retoma o recorte; a prévia avisa que está tocando', () => {
  it('abrir um projeto com o `.partial.mp4` de antes dos pedaços refaz o recorte sozinho (e apaga o parcial)', async () => {
    const { handlers, camera, calls, root, logger } = await build()
    const partial = join(root, 'p1', MATTE_PARTIAL_FILE)
    writeFileSync(partial, Buffer.alloc(200_000, 3))
    await handlers['projects:get']('p1')
    // a retomada corre em segundo plano (abrir o projeto não espera por ela): espera o motor ser chamado e depois a fila esvaziar
    await vi.waitFor(() => expect(calls.matte).toBe(1))
    await camera.idle()
    expect(existsSync(partial)).toBe(false)
    expect(existsSync(join(root, 'p1', MATTE_FILE))).toBe(true)
    expect(logger.entries.some((e) => e.message.includes('sobrou um recorte parcial antigo'))).toBe(true)
  })

  it('abrir um projeto sem nada pendente não dispara recorte nenhum', async () => {
    const { handlers, camera, calls } = await build()
    await handlers['projects:get']('p1')
    await new Promise((r) => setTimeout(r, 100))
    await camera.idle()
    expect(calls.matte).toBe(0)
  })

  it('`camera:preview-active` só aceita booleano e repassa para a porta da placa', async () => {
    const { handlers, previews } = await build()
    await handlers['camera:preview-active'](true)
    await handlers['camera:preview-active'](false)
    expect(previews).toEqual([true, false])
    for (const bad of ['true', 1, null, undefined, {}]) {
      await expect(handlers['camera:preview-active'](bad as unknown as boolean), `aceitou ${JSON.stringify(bad)}`).rejects.toThrow(/inválido/)
    }
    expect(previews).toEqual([true, false])
  })
})
