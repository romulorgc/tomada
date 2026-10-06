/**
 * Cortes verticais pela IA: manda a transcrição em FRASES (texto, tempo e um resumo da atividade de tela; nunca áudio,
 * vídeo, caminho nem qual tecla) e confere tudo o que ela devolve contra a transcrição (`validateClips`): índices que
 * existem, começo e fim em borda de frase, duração, sem repetir. O que não passa é descartado COM o motivo.
 */
import { CLIPS_SYSTEM, buildClipPrompts, clipCountRange, clipsSchema, validateClips, type ClipValidation } from '@shared/clips'
import { buildSentences } from '@shared/sentences'
import { keptRanges, rangesLength } from '@shared/timeline'
import type { Clip, Cut, Word } from '@shared/types'
import type { LlmProvider } from './provider'
import type { VideoScript } from '@shared/script'

export type SuggestClipsArgs = {
  provider: LlmProvider
  script?: VideoScript
  /** Quantidade configurada no piloto; no editor vale a faixa proporcional à duração. */
  count?: number
  words: readonly Word[]
  durationMs: number
  cuts: readonly Cut[]
  /** Instantes (ms) de cliques e de teclas. */
  clicks: readonly number[]
  keys: readonly number[]
  existing?: readonly Pick<Clip, 'ranges' | 'title'>[]
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

export async function suggestClips(args: SuggestClipsArgs): Promise<ClipValidation> {
  const sentences = buildSentences(args.words, { clicks: args.clicks, keys: args.keys })
  const outputMs = rangesLength(keptRanges(args.durationMs, args.cuts))
  const prompts = buildClipPrompts(sentences, { durationMs: args.durationMs, outputMs, count: args.count })
  const raw: unknown[] = []
  let done = 0
  for (const p of prompts) {
    const script = args.script ? `Roteiro planejado (use só o que foi realmente dito): ${JSON.stringify(args.script)}\n\n` : ''
    const r = await args.provider.complete({ task: 'clips', system: CLIPS_SYSTEM, prompt: script + p.prompt, schema: clipsSchema, ...(args.signal ? { signal: args.signal } : {}) })
    raw.push(...r.clips)
    args.onProgress?.(++done, prompts.length)
  }
  return validateClips(raw, {
    words: args.words,
    sentences,
    durationMs: args.durationMs,
    cuts: args.cuts,
    max: args.count ?? clipCountRange(outputMs).max,
    source: 'ai',
    ...(args.existing ? { existing: args.existing } : {})
  })
}
