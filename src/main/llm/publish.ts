/**
 * Textos de publicação pela IA: três títulos, descrição, tags, capítulos e, por corte vertical, legenda e hashtags de
 * TikTok, Reels e Shorts. Vai SÓ texto (a transcrição em frases com o tempo do vídeo final e o título e o gancho dos
 * cortes). O que volta é conferido por `validatePublish` (capítulos válidos pelas regras do YouTube, hashtags limpas, ids
 * de corte que existem). Nada é publicado.
 */
import { LlmError } from '@shared/llm-json'
import { PUBLISH_SYSTEM, buildPublishPrompt, publishSchema, validatePublish, type PublishResult } from '@shared/publish'
import type { Clip, Project, Word } from '@shared/types'
import type { LlmProvider } from './provider'
import { normalizeDictionary } from '@shared/dictionary'
import { correctedTranscriptWords } from '@shared/dictionary-corrections'

export type GeneratePublishArgs = {
  provider: LlmProvider
  project: Project
  words: readonly Word[]
  durationMs: number
  clips: readonly Clip[]
  dictionary?: readonly string[]
  signal?: AbortSignal
}

export async function generatePublish(args: GeneratePublishArgs): Promise<PublishResult> {
  const words = correctedTranscriptWords(args.words, args.project.wordFixes, args.project.review?.dictionaryCorrections)
  const raw = await args.provider.complete({
    task: 'publish',
    system: PUBLISH_SYSTEM,
    prompt: buildPublishPrompt({ project: args.project, words, durationMs: args.durationMs, clips: args.clips, dictionary: normalizeDictionary([...(args.dictionary ?? [])]) }),
    schema: publishSchema,
    ...(args.signal ? { signal: args.signal } : {})
  })
  try {
    return validatePublish(raw, { words, durationMs: args.durationMs, cuts: args.project.cuts, clips: args.clips })
  } catch (err) {
    throw new LlmError(`${err instanceof Error ? err.message : String(err)} Tente de novo.`, true)
  }
}
