/**
 * Os serviços da M3 que `createHandlers` exige (transcrição e IA), montados com o motor e a IA de TESTE: os testes
 * que só querem o contrato de IPC completo não precisam do Python nem da rede.
 */
import { createLlmManager, type KeyVault } from '../../src/main/llm/manager'
import type { Logger } from '../../src/main/logger'
import type { ProjectStore } from '../../src/main/projects'
import type { AppState } from '../../src/main/state'
import { createMockTranscriber } from '../../src/main/transcription/mock'
import { createTranscriptionService, type TranscriptionService } from '../../src/main/transcription/service'

/** Cofre de mentira: "cifra" invertendo o texto (basta para provar que a chave nunca volta em claro). */
export const fakeVault: KeyVault = {
  available: () => true,
  encrypt: (plain) => `cifrado:${[...plain].reverse().join('')}`,
  decrypt: (enc) => [...enc.replace(/^cifrado:/, '')].reverse().join('')
}

export function transcriptionDeps(args: { state: AppState; store: ProjectStore; logger: Logger; ready?: boolean }): { transcription: TranscriptionService; llm: ReturnType<typeof createLlmManager> } {
  const transcription = createTranscriptionService({
    logger: args.logger,
    engine: createMockTranscriber({ ready: args.ready ?? true }),
    read: (id) => args.store.read(id),
    vocabulary: () => args.state.dictionary(),
    emit: () => undefined
  })
  const llm = createLlmManager({
    env: { TOMADA_LLM: 'mock' },
    getPrefs: () => args.state.llmPrefs(),
    savePrefs: (patch) => args.state.updateLlmPrefs(patch),
    vault: fakeVault,
    scratchDir: '',
    logger: args.logger
  })
  return { transcription, llm }
}
