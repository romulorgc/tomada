import { SCRIPT_SYSTEM, scriptPrompt, videoScriptSchema, type VideoScript } from '@shared/script'
import type { LlmProvider } from './provider'

/** Só o assunto textual atravessa o provedor; nenhum arquivo, imagem ou áudio. */
export function generateScript(provider: LlmProvider, topic: string): Promise<VideoScript> {
  return provider.complete({ task: 'script', system: SCRIPT_SYSTEM, prompt: scriptPrompt(topic), schema: videoScriptSchema })
}
