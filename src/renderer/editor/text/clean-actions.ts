/**
 * Ligação entre o painel Limpeza (e a limpeza automática) e o documento: monta a entrada da conta (palavras, nível
 * do áudio, recomeços) e aplica o resultado como UMA mudança do documento, que o Ctrl+Z desfaz inteira.
 */
import { computeClean, type CleanInput, type CleanOptions, type Levels } from '@shared/clean'
import { planClean, type CleanPlan } from '@shared/clean-plan'
import type { EditorStore } from '@shared/editor-store'
import type { RetakeSpan } from '@shared/transcription'
import type { Project, Range, Transcript } from '@shared/types'

/** O que a limpeza lê além do texto e do nível: a tela ativa e os cortes que ela não decide (F1). */
export type CleanExtras = { screenActive?: readonly Range[]; fixedCuts?: readonly Range[] }

export function buildCleanInput(transcript: Transcript, levels: Levels | null, durationMs: number, retakes?: readonly RetakeSpan[], extras: CleanExtras = {}): CleanInput {
  return {
    words: transcript.words,
    durationMs,
    vad: transcript.vad,
    levels,
    ...(retakes ? { retakes } : {}),
    ...(extras.screenActive && extras.screenActive.length > 0 ? { screenActive: extras.screenActive } : {}),
    ...(extras.fixedCuts && extras.fixedCuts.length > 0 ? { fixedCuts: extras.fixedCuts } : {})
  }
}

export type ApplyOutcome = { applied: boolean; plan: CleanPlan }

/**
 * Aplica a limpeza ao documento. `mark` (opcional) vai junto na MESMA mudança (ex.: marcar `autoCleaned`).
 * Devolve se o documento mudou e o plano que valeu (para o aviso "sai 2:14").
 */
export function applyClean(store: EditorStore, input: CleanInput, options: CleanOptions, durationMs: number, mark?: (p: Project) => Project): ApplyOutcome {
  const result = computeClean(input, options)
  const box: { plan: CleanPlan | null } = { plan: null }
  const applied = store.getState().change((project) => {
    const plan = planClean(project, result, options, durationMs)
    box.plan = plan
    if (!plan.changed) return project
    const next: Project = { ...project, cuts: plan.cuts }
    if (plan.mutes.length > 0) next.mutes = plan.mutes
    else delete next.mutes
    return mark ? mark(next) : next
  })
  // `change` só chama a função uma vez; se por qualquer razão não chamou, devolve um plano vazio
  const plan: CleanPlan = box.plan ?? { cuts: store.getState().project.cuts, mutes: store.getState().project.mutes ?? [], changed: false, fromMs: durationMs, toMs: durationMs, deltaMs: 0 }
  return { applied, plan }
}
