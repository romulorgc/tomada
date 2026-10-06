/** Trocas contextuais da transcrição. O original nunca sai de transcript.json. */
import { z } from 'zod'
import { normalizeDictionary } from './dictionary'
import type { Project, Word } from './types'

export const DICTIONARY_CONFIDENCE_MIN = .9
export const dictionaryCorrectionSchema = z.object({ id: z.string().max(80).optional(), i: z.number().int().nonnegative(), last: z.number().int().nonnegative().optional(), before: z.string().max(1000), after: z.string().max(160), confidence: z.number().min(0).max(1), undone: z.boolean().optional() })
export type DictionaryCorrection = z.infer<typeof dictionaryCorrectionSchema>
export const dictionaryResponseSchema = z.object({ corrections: z.array(z.unknown()) })
const candidateSchema = z.object({ i: z.number().int().nonnegative(), last: z.number().int().nonnegative().optional(), before: z.string(), term: z.string(), confidence: z.number().min(0).max(1), context: z.enum(['product', 'common', 'uncertain']) })

export function correctedTranscriptWords(words: readonly Word[], fixes: Project['wordFixes'], corrections?: readonly DictionaryCorrection[]): Word[] {
  const active = corrections?.filter((c) => !c.undone && fixes?.[String(c.i)] === c.after && !Object.keys(fixes ?? {}).some((i) => Number(i) > c.i && Number(i) <= (c.last ?? c.i))) ?? []
  return words.filter((w) => !active.some((c) => c.i < w.i && w.i <= (c.last ?? c.i))).map((w) => {
    const span = active.find((c) => c.i === w.i && c.last !== undefined)
    const last = span ? words.find((word) => word.i === span.last) : undefined
    return { ...w, text: fixes?.[String(w.i)]?.trim() || w.text, end: last?.end ?? w.end }
  })
}

/** Confiança alta, grafia exata da lista e índice/texto originais conferidos; correção manual e desfazer ganham sempre. */
export function applyDictionaryCorrections(project: Project, words: readonly Word[], raw: readonly unknown[], dictionary: readonly string[]): Project {
  const terms = new Set(normalizeDictionary([...dictionary]))
  const fixes = { ...project.wordFixes }
  const records = [...(project.review?.dictionaryCorrections ?? [])]
  for (const candidate of raw) {
    const parsed = candidateSchema.safeParse(candidate)
    if (!parsed.success) continue
    const c = parsed.data
    const last = c.last ?? c.i
    const span = words.filter((word) => word.i >= c.i && word.i <= last)
    if (c.context !== 'product' || c.confidence < DICTIONARY_CONFIDENCE_MIN || !terms.has(c.term) || last < c.i || last-c.i > 7 || span.length !== last-c.i+1 || span.some((w) => w.kind !== 'word' || Object.hasOwn(fixes, String(w.i))) || span.map((w) => w.text).join(' ') !== c.before || records.some((r) => r.i <= last && (r.last ?? r.i) >= c.i)) continue
    const punctuation = span.at(-1)?.text.match(/[.,;:!?…]+["'”’)]*$/u)?.[0] ?? ''
    const after = c.term + punctuation
    if (c.before === after) continue
    fixes[String(c.i)] = after
    // O id permite à escrita de três fotografias preservar trocas que terminem durante um desfazer na Revisão.
    records.push({ id: `dictionary-word-${c.i}`, i: c.i, ...(last > c.i ? { last } : {}), before: c.before, after, confidence: c.confidence })
  }
  if (records.length === (project.review?.dictionaryCorrections?.length ?? 0)) return project
  return { ...project, wordFixes: fixes, review: { ...project.review, items: project.review?.items ?? {}, dictionaryCorrections: records } }
}

/** Desfaz só o valor automático ainda presente; uma edição posterior do usuário continua intacta. */
export function undoDictionaryCorrection(project: Project, i: number): Project {
  const correction = project.review?.dictionaryCorrections?.find((c) => c.i === i && !c.undone)
  if (!correction) return project
  const remove = (current: Project['wordFixes']) => {
    const fixes = { ...current }
    if (fixes[String(i)] === correction.after) delete fixes[String(i)]
    return fixes
  }
  const items = Object.fromEntries(Object.entries(project.review?.items ?? {}).map(([id, item]) => [id, item.edits ? { ...item, edits: { ...item.edits, wordFixes: remove(item.edits.wordFixes) } } : item]))
  const dictionaryCorrections = project.review?.dictionaryCorrections?.map((c) => c.i === i ? { ...c, undone: true } : c)
  return { ...project, wordFixes: remove(project.wordFixes), review: { ...project.review, items, dictionaryCorrections } }
}
