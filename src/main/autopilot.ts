/** Conecta os serviços existentes numa fila persistente; nunca há duas exportações do piloto em paralelo. */
import { existsSync } from 'node:fs'
import { mkdir, readFile, copyFile, rm, open, stat } from 'node:fs/promises'
import { relative, join } from 'node:path'
import { newPipeline, runPipeline, type AutopilotPrefs, type PipelineState, type PipelineStepId } from '@shared/autopilot'
import { computeClean, DEFAULT_CLEAN } from '@shared/clean'
import { protectionFingerprint, PROTECTION_CHANGED_MESSAGE } from '@shared/blur'
import { planClean } from '@shared/clean-plan'
import { heuristicClips, heuristicClipLabels, mergeSuggestedClips, titleFromText, type ClipDraft } from '@shared/clips'
import { eventsFromText, EVENT_FILES } from '@shared/events'
import { applyScreenCrop, prepareEvents } from '@shared/scene'
import { sanitizeFileName } from '@shared/export'
import { uniqueName } from '@shared/recording'
import { projectDurationMs } from '@shared/project'
import { buildClipText, buildYoutubeText, fallbackClipMeta, heuristicChapters, keywordsOf } from '@shared/publish'
import { itemOf, updateReviewItem, reviewDocument, refreshReviewSnapshots, type ReviewItem } from '@shared/review'
import { keptRanges, outputDuration } from '@shared/timeline'
import type { Project, ProjectSummary, Transcript } from '@shared/types'
import { autoVerticalLayouts, defaultVerticalEdit, speechRanges } from '@shared/vertical'
import { generateAutoZooms, zoomPresetFor } from '@shared/zoom'
import { deriveRetakeCuts } from '@shared/retake-marker'
import type { CameraService } from './camera/service'
import type { DerivedMedia } from './derived-media'
import type { ExportService } from './export-service'
import { pathExists, writeFileAtomic } from './fs-utils'
import { readActivity } from './activity'
import { mergeEditorProject } from '@shared/project-merge'
import { suggestClips } from './llm/clips'
import { generatePublish } from './llm/publish'
import { detectRetakes } from './llm/retakes'
import { detectDictionaryCorrections } from './llm/dictionary'
import { applyDictionaryCorrections, correctedTranscriptWords } from '@shared/dictionary-corrections'
import type { LlmManager } from './llm/manager'
import type { Logger } from './logger'
import { MANIFEST_PATH, readManifest, writeManifest } from './manifest'
import { resolveProjectFile, assertDocumentPaths } from './project-files'
import { ProjectNotFoundError, type ProjectStore } from './projects'
import type { TranscriptionService } from './transcription/service'
import { applyOwnerEditingDefaults, type OwnerEditingDefaults } from '@shared/settings-defaults'

export interface AutopilotService {
  start(id: string, startedAt?: number): Promise<void>
  retry(id: string, step: PipelineStepId): Promise<void>
  updateItem(id: string, itemId: string, patch: Partial<ReviewItem>, reexport?: boolean): Promise<Project>
  reexport(id: string, itemId: string): Promise<void>
  postingFolder(id: string): Promise<string>
  resume(): Promise<void>
  idle(): Promise<void>
  shutdown(): void
  saveProject(id:string,project:Project,base?:Project):Promise<Project>
  renameProject(id:string,title:string):Promise<ProjectSummary>
}
export type AutopilotDeps = {
  store: ProjectStore; transcription: TranscriptionService; derived: DerivedMedia; exporter: ExportService; llm: LlmManager; logger: Logger
  prefs(): AutopilotPrefs; ownerStyle?(): Project['style'] | undefined
  vocabulary?(): readonly string[]
  ownerBackground?(): Promise<string | undefined>
  /** O serviço da câmera (M4c): o piloto espera a análise do rosto e do recorte do fundo e escolhe o Apresentador quando o recorte já existe. */
  camera?: Pick<CameraService, 'idle' | 'result' | 'analyze' | 'view'>
  ownerEditingDefaults?(): OwnerEditingDefaults
  emit(state: PipelineState): void; ready(id: string, clips: number,youtube?:boolean): void
}
/** Saída que o app gravou em exports/postar, com o que ele viu ao gravar (para provar depois que continua intacta). */
type PostedFile = { path: string; size?: number; mtimeMs?: number }
async function readPostedManifest(file: string): Promise<PostedFile[]> {
  if (!(await pathExists(file))) return []
  try {
    const old = JSON.parse(await readFile(file,'utf8')) as unknown
    if (!Array.isArray(old)) return []
    // Formato antigo (só o caminho) não prova que o arquivo continua o do app: entra sem tamanho e nunca é apagado.
    return old.flatMap((entry): PostedFile[] => typeof entry === 'string' ? [{ path: entry }] : entry && typeof entry === 'object' && typeof (entry as PostedFile).path === 'string' ? [entry as PostedFile] : [])
  } catch { return [] }
}
export function createAutopilot(deps: AutopilotDeps): AutopilotService {
  let queue: Promise<unknown> = Promise.resolve()
  let writes: Promise<unknown> = Promise.resolve()
  let stopped = false
  const active = new Set<string>()
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const next = queue.then(job, job)
    queue = next.catch((err) => deps.logger.error('Piloto automático: tarefa falhou.', err))
    return next
  }
  const change = (id: string, fn: (p: Project) => Project, missingBase?:Project): Promise<Project> => {
    const task = writes.then(async () => {
      let detail: {project:Project;dir:string}
      try { detail = await deps.store.read(id) }
      catch(error) {
        if(!missingBase || !(error instanceof ProjectNotFoundError)) throw error
        const dir = deps.store.dirOf(id)
        // Recupera só o documento ausente de uma pasta existente; não recria projeto apagado
        // nem cobre um arquivo/pasta que esteja impedindo a escrita.
        if(!await pathExists(dir) || await pathExists(await resolveProjectFile(dir,'project.json'))) throw error
        detail = {project:missingBase,dir}
      }
      const {project,dir} = detail
      const next = fn(project)
      await assertDocumentPaths(dir, next)
      // Síncrono antes de escrever: a exportação não pode publicar a fotografia anterior
      // enquanto a escrita atômica desta proteção ainda está em andamento.
      if (protectionFingerprint(project) !== protectionFingerprint(next)) deps.exporter.protectionChanged?.(id)
      await deps.store.write(id, next)
      return next
    })
    writes = task.catch(() => undefined)
    return task
  }
  /** Regenerar decisões automáticas também atualiza as cópias automáticas guardadas nas edições dos itens (o manual fica). */
  const regenerate = (id: string, fn: (p: Project) => Project): Promise<Project> => change(id, (p) => refreshReviewSnapshots(p, fn(p)))
  const transcript = async (id: string): Promise<Transcript> => {
    const t = await deps.transcription.getTranscript(id)
    if (!t || t.words.length === 0) throw new Error('Sem transcrição com fala. Prepare a transcrição nos Ajustes e tente de novo.')
    const { project } = await deps.store.read(id)
    return { ...t, words: correctedTranscriptWords(t.words, project.wordFixes, project.review?.dictionaryCorrections) }
  }
  const textOf = (project:Project,itemId:string,words:Transcript['words'] | null):string => {
    const item = itemOf(project,itemId)
    if(item.text !== undefined) return item.text
    const p = reviewDocument(project,itemId)
    const clip = project.clips.find((c) => c.id === itemId)
    if(clip) return buildClipText({...clip,title:item.title ?? clip.title,hook:item.hook ?? clip.hook},p.meta?.perClip?.[itemId] ?? fallbackClipMeta(clip,words))
    return buildYoutubeText({title:p.title,titles:item.title ? [item.title,...(p.meta?.youtube?.titles ?? []).filter((t) => t !== item.title)].slice(0,3) : p.meta?.youtube?.titles ?? [],description:p.meta?.youtube?.description ?? '',tags:p.meta?.youtube?.tags ?? [],chapters:p.meta?.youtube?.chapters ?? [],kept:keptRanges(projectDurationMs(p),p.cuts)})
  }
  const events = async (dir: string, durationMs: number, project: Pick<Project, 'screenCrop' | 'sources'>) => {
    const texts: Record<string, string> = {}
    for (const [key, rel] of Object.entries(EVENT_FILES)) {
      const file = await resolveProjectFile(dir, rel)
      if (await pathExists(file)) texts[key] = await readFile(file, 'utf8')
    }
    // O recorte da tela (C1) muda o espaço de coordenadas: zooms e layouts nascem do que o recorte mostra, como no editor (o cursor e os
    // cliques no espaço dele; um clique fora do recorte, na barra de abas, não abre zoom e o foco de um zoom é lido dentro do recorte).
    return applyScreenCrop(prepareEvents(eventsFromText(texts), durationMs), project)
  }
  async function exportItem(id: string, itemId: string): Promise<void> {
    // Cada exportação nasce de uma revisão da edição do item. Se o usuário ajustar durante a exportação (updateItem sobe a revisão
    // e deixa o item "queued"), o fim da exportação antiga não pode apagar essa pendência: a reexportação ainda precisa rodar.
    let revision = 0
    await change(id, (p) => { revision = itemOf(p, itemId).revision ?? 0; return updateReviewItem(p, itemId, { phase: 'exporting', error: undefined }, false) })
    const settle = (p: Project, patch: Partial<ReviewItem>): Project => (itemOf(p, itemId).revision ?? 0) === revision ? updateReviewItem(p, itemId, patch, false) : p
    try {
      // Transcrição e exportação compartilham GPU; também esperamos a exportação manual que já estiver em voo.
      await deps.transcription.idle()
      // O enquadramento do rosto e o recorte do fundo (M4c) entram no vídeo: a exportação só começa com a análise pronta.
      await deps.camera?.idle()
      await deps.exporter.idle()
      const protection = protectionFingerprint((await deps.store.read(id)).project)
      const { exportId } = await deps.exporter.start({ projectId: id, format: itemId === 'youtube' ? 'horizontal' : 'vertical', resolution: '1080p', fps: 30, ...(itemId === 'youtube' ? {} : { clipId: itemId }) })
      await deps.exporter.idle()
      const done = deps.exporter.status(exportId)
      if (done?.exportId !== exportId || done.phase !== 'done' || !done.outputPath) throw new Error(done?.message ?? 'A exportação não terminou.')
      const { dir } = await deps.store.read(id)
      const path = relative(dir, done.outputPath).replaceAll('\\', '/')
      await resolveProjectFile(dir, path)
      const textPath = done.textPath ? relative(dir, done.textPath).replaceAll('\\', '/') : undefined
      if (textPath) await resolveProjectFile(dir, textPath)
      await change(id, (p) => {
        if (protectionFingerprint(p) !== protection) throw new Error(PROTECTION_CHANGED_MESSAGE)
        return settle(p, { phase: 'ready', exportPath: path, textPath })
      })
      if (done.message) throw new Error(done.message)
    } catch (err) {
      await change(id, (p) => settle(p, { phase: 'error', exportPath: undefined, textPath: undefined, error: err instanceof Error ? err.message : String(err) }))
      throw err
    }
  }
  async function runStep(id: string, step: PipelineStepId): Promise<string | void> {
    const { project, dir } = await deps.store.read(id)
    const duration = projectDurationMs(project)
    const prefs = deps.prefs()
    switch (step) {
      case 'transcribe': {
        if (await deps.transcription.getTranscript(id)) return 'Transcrição já disponível.'
        await deps.exporter.idle()
        // A placa é uma só: o recorte do fundo (Apresentador), se foi pedido logo depois de gravar, termina antes da transcrição.
        await deps.camera?.idle()
        await deps.transcription.start(id)
        await deps.transcription.idle()
        const t = await transcript(id)
        return `${t.words.length} palavras transcritas localmente.`
      }
      case 'dictionary': {
        const provider = deps.llm.provider()
        if (!provider) return 'Sem IA: mantive a transcrição e as correções do usuário.'
        const dictionary = deps.vocabulary?.() ?? []
        if (!dictionary.length) return 'Dicionário vazio: mantive a transcrição.'
        const t = await deps.transcription.getTranscript(id)
        if (!t?.words.length) return 'Sem transcrição: nenhuma grafia foi alterada.'
        const raw = await detectDictionaryCorrections({ provider, words: t.words, dictionary })
        let count = 0
        await regenerate(id, (p) => {
          const next = applyDictionaryCorrections(p, t.words, raw, dictionary)
          count = (next.review?.dictionaryCorrections?.length ?? 0) - (p.review?.dictionaryCorrections?.length ?? 0)
          return next
        })
        return `${count} ${count === 1 ? 'troca de grafia' : 'trocas de grafia'} em nomes de produtos com confiança alta; veja e desfaça em “O que o automático fez”.`
      }
      case 'clean': {
        const t = await transcript(id)
        const levels = await deps.derived.levels(id)
        const marker = deriveRetakeCuts({ words: t.words, marks: project.retakeMarks ?? [], durationMs: duration })
        let retakes = [] as Awaited<ReturnType<typeof detectRetakes>>['retakes']
        let notice = ''
        const provider = deps.llm.provider()
        if (provider) {
          try { retakes = (await detectRetakes({ provider, words: t.words })).retakes }
          catch (err) { notice = `Recomeços pela IA indisponíveis: ${err instanceof Error ? err.message : String(err)}. ` }
        } else notice = 'Sem IA: recomeços automáticos ficaram de fora; apliquei a heurística e as marcas de errei. '
        const options = { ...DEFAULT_CLEAN, retakes: true }
        const result = computeClean({ words: t.words, durationMs: duration, vad: t.vad, levels, retakes }, options)
        await regenerate(id, (p) => {
          const manual = p.cuts.filter((c) => c.origin === 'manual')
          // planClean recebe TODOS os cortes: ele já preserva os manuais e conta os identificadores deles ao numerar os novos.
          const plan = planClean(p, result, options, duration)
          const markerCuts = marker.cuts.filter((c) => !p.cuts.some((old) => old.id === c.id && (old.origin === 'manual' || !old.enabled)))
          return { ...p, cuts: [...plan.cuts.filter((c) => c.origin === 'manual' || !manual.some((m) => m.reason === c.reason && m.start < c.end && m.end > c.start)).map((c) => ({ ...c, origin: c.origin ?? 'auto' as const })), ...markerCuts], mutes: plan.mutes, autoCleaned: true }
        })
        const fallback = marker.decisions.filter((d) => d.fallback).length
        return `${notice}${result.items.length} decisões de limpeza; ${marker.cuts.length} marca(s) de errei.${fallback ? ` ${fallback} marca(s) sem fronteira: últimos 6 s, confira na Revisão.` : ''}`
      }
      case 'zooms': {
        const e = await events(dir, duration, project)
        await regenerate(id, (p) => {
          const v = p.vertical ?? defaultVerticalEdit()
          const make = (kind: 'horizontal' | 'vertical', current: Project['zooms'], preset: Project['zoomPreset'], excluded?:string[]) => [...current.filter((z) => z.origin === 'manual'), ...(preset === 'off' ? [] : generateAutoZooms({ clicks: e.clicks, keys: e.keys, cursor: e.grid, duration, preset: zoomPresetFor(kind, preset ?? 'moderate') }).filter((z) => !excluded?.includes(z.id) && !current.some((m) => m.origin === 'manual' && m.start < z.end && m.end > z.start)))]
          return { ...p, zooms: make('horizontal', p.zooms, p.zoomPreset,p.autoExclusions?.zooms), vertical: { ...v, zooms: make('vertical', v.zooms, v.zoomPreset,v.autoExclusions?.zooms) } }
        })
        return 'Zooms conforme os padrões de cada formato; ajustes manuais preservados.'
      }
      case 'layouts': {
        const t = await deps.transcription.getTranscript(id)
        const e = await events(dir, duration, project)
        // Quem decide é o ESTILO da câmera escolhido ao gravar, nunca a existência do recorte: Apresentador pede o recorte do fundo e a
        // fala sem atividade vira Apresentador (16:9) e V-D (9:16); Quadro ao lado (e projeto antigo) fica no lado a lado e no V-B.
        let hasMatte = false
        let notice = ''
        if (project.cameraStyle === 'presenter' && project.sources.camera) {
          const matte = await ensureMatte(id)
          hasMatte = matte.ok
          if (!matte.ok) notice = `O recorte do fundo falhou; usei o quadro ao lado. Motivo: ${matte.reason.replace(/[.\s]+$/, '')}. No editor: Câmera → Recortar de novo. `
        }
        const automatic = autoVerticalLayouts({ ...(hasMatte ? { hasMatte } : {}), durationMs: duration, hasCamera: !!project.sources.camera && !project.style.camera.hidden, clicks: e.clicks, keys: e.keys, cursor: e.grid, speech: speechRanges(t?.words), kept: keptRanges(duration, project.cuts) })
        await regenerate(id, (p) => {
          const v = p.vertical ?? defaultVerticalEdit()
          const fit = (generated: typeof automatic, manual: typeof automatic) => [...manual, ...generated.filter((a) => !manual.some((m) => m.start < a.end && m.end > a.start)).map((s) => ({ ...s, origin: 'auto' as const }))].sort((a,b) => a.start-b.start)
          const h = automatic.map((s) => ({ ...s, id: `h-${s.id}`, layout: s.layout === 'presenter' ? 'presenter' as const : s.layout === 'stack' && p.sources.camera ? 'side-by-side' as const : 'bubble' as const }))
          return { ...p, layouts: fit(h.filter((s) => !p.autoExclusions?.layouts?.includes(s.id)), p.layouts.filter((s) => s.origin !== 'auto')), vertical: { ...v, layouts: fit(automatic.filter((s) => !v.autoExclusions?.layouts?.includes(s.id)), v.layouts.filter((s) => s.origin !== 'auto')) } }
        })
        return `${notice}Layouts escolhidos pela atividade da tela nos dois formatos.`
      }
      case 'captions': {
        await change(id, (p) => {
          const v = p.vertical ?? defaultVerticalEdit()
          return { ...p, captions: itemOf(p, 'youtube').origin === 'manual' ? p.captions : { ...p.captions, enabled: prefs.captionsHorizontal }, vertical: { ...v, captions: { ...v.captions, enabled: v.captions?.enabled ?? prefs.captionsVertical } } }
        })
        return `Legenda: YouTube ${prefs.captionsHorizontal ? 'ligada' : 'desligada'}; vertical ${prefs.captionsVertical ? 'ligada' : 'desligada'}. Você pode mudar em cada item.`
      }
      case 'youtube': return exportItem(id, 'youtube')
      case 'clips': {
        const t = await transcript(id)
        const activity = await readActivity(dir)
        const manual = project.clips.filter((c) => c.source === 'manual' || itemOf(project, c.id).origin === 'manual')
        const input = { words: t.words, durationMs: duration, cuts: project.cuts, clicks: activity.clicks, keys: activity.keys, existing: manual }
        let drafts: ClipDraft[] = []
        let notice = ''
        const provider = deps.llm.provider()
        if (provider) {
          // O mesmo pedido usado por “Tentar de novo” roda uma única vez a mais se a primeira resposta não basta.
          const suggest = () => suggestClips({ provider, ...input, script: project.script, count: prefs.maxClips })
          try {
            drafts = (await suggest()).clips
            if (drafts.filter((c) => c.score >= prefs.minScore).length < prefs.maxClips) {
              notice = 'Repeti a sugestão uma vez para buscar a quantidade pedida. '
              // mergeSuggestedClips preserva os melhores e elimina a repetição entre as duas respostas.
              try { drafts = mergeSuggestedClips([], [...drafts, ...(await suggest()).clips].sort((a,b) => b.score-a.score)).clips as ClipDraft[] }
              catch (err) { notice += `A segunda sugestão falhou: ${err instanceof Error ? err.message : String(err)}. ` }
            }
          }
          catch (err) { notice = `Sugestão pela IA falhou: ${err instanceof Error ? err.message : String(err)}. ` }
        } else notice = 'Sem IA: sugestões pela heurística. '
        if (drafts.length === 0) drafts = heuristicClips(input).clips
        // Gravações menores que a faixa de 25-65 s também têm uma versão vertical completa para revisar.
        if (drafts.length === 0 && duration < 25000 && t.words.length > 0 && outputDuration(duration, project.cuts) > 1000) {
          const text = t.words.filter((w) => !project.cuts.some((c) => c.enabled && w.start >= c.start && w.end <= c.end)).map((w) => w.text).join(' ')
          drafts = [{ ...heuristicClipLabels(text), ranges: [{ start: 0, end: duration }], score: 70, notes: { hook: 70, flow: 70, value: 70 }, reason: 'Versão vertical completa da gravação curta; nota heurística, confira o conteúdo.', source: 'heuristic' }]
          notice += 'Gravação curta: versão vertical completa, abaixo da faixa habitual de cortes. '
        }
        const ordered = [...drafts].sort((a,b) => b.score-a.score)
        const qualified = ordered.filter((c) => c.score >= prefs.minScore)
        const chosen = qualified.length >= 2 ? qualified.slice(0, prefs.maxClips) : ordered.filter((c) => c.score >= 50).slice(0, 2)
        const lowScore = chosen.some((c) => c.score < prefs.minScore)
        await regenerate(id, (p) => {
          const kept = p.clips.filter((c) => c.source === 'manual' || itemOf(p,c.id).origin === 'manual')
          const merged = mergeSuggestedClips(kept, chosen)
          const items = Object.fromEntries(Object.entries(p.review?.items ?? {}).filter(([id]) => id === 'youtube' || merged.clips.some((c) => c.id === id)))
          for (const clip of merged.added) items[clip.id] = { decision: 'pending', origin: 'auto', lowScore: clip.score < prefs.minScore }
          return { ...p, clips: merged.clips, review:{...p.review,items} }
        })
        return `${notice}${chosen.length} ${chosen.length === 1 ? 'corte' : 'cortes'} ${lowScore ? 'entre os melhores com nota ≥ 50. Nota baixa: revise antes de postar' : `com nota ≥ ${prefs.minScore}`}; máximo ${lowScore ? 2 : prefs.maxClips}.`
      }
      case 'clipExports': {
        const errors: string[] = []
        for (const c of project.clips) {
          if (stopped) return
          if (itemOf(project,c.id).decision === 'discarded' || itemOf(project,c.id).phase === 'ready') continue
          try { await exportItem(id, c.id) } catch (err) { errors.push(`${c.title}: ${err instanceof Error ? err.message : String(err)}`) }
        }
        if (errors.length) throw new Error(errors.join('\n'))
        return `${project.clips.length} ${project.clips.length === 1 ? 'corte exportado' : 'cortes exportados'} em fila.`
      }
      case 'publish': {
        const t = await transcript(id)
        const provider = deps.llm.provider()
        let meta: Project['meta']
        let notice = ''
        if (provider) {
          try { const result = await generatePublish({ provider, project, words: t.words, durationMs: duration, clips: project.clips, dictionary: deps.vocabulary?.() }); meta = { youtube: { titles: result.titles, description: result.description, chapters: result.chapters, tags: result.tags }, perClip: result.clips } }
          catch (err) { notice = `Textos pela IA falharam: ${err instanceof Error ? err.message : String(err)}. ` }
        } else notice = 'Sem IA: textos e capítulos gerados pela transcrição; confira antes de postar. '
        const body = t.words.filter((w) => !project.cuts.some((c) => c.enabled && c.start <= w.start && c.end >= w.end)).map((w) => w.text).join(' ')
        if (!meta) meta = { youtube: { titles: [project.title.trim() || titleFromText(body)], description: body.slice(0, 1200), tags: keywordsOf(body, 12), chapters: heuristicChapters(t.words, duration, project.cuts).chapters }, perClip: Object.fromEntries(project.clips.map((c) => [c.id, fallbackClipMeta(c,t.words)])) }
        const updated = await change(id, (p) => p.review?.metaOrigin === 'manual' ? p : { ...p, title: p.review?.titleOrigin === 'manual' ? p.title : meta?.youtube?.titles?.[0] || p.title.trim() || titleFromText(body), meta: { ...p.meta, ...meta, perClip: { ...p.meta?.perClip, ...meta?.perClip } }, review: { ...p.review, items: p.review?.items ?? {}, metaOrigin: 'auto' } })
        for (const [itemId,item] of Object.entries(updated.review?.items ?? {})) {
          if (!item.textPath) continue
          const file = await resolveProjectFile(dir,item.textPath)
          const text = textOf(updated,itemId,t.words)
          await writeFileAtomic(file,text)
        }
        return `${notice}Título, descrição e textos por plataforma prontos.`
      }
      case 'notify': {
        deps.ready(id, Object.entries(project.review?.items ?? {}).filter(([key,value]) => key !== 'youtube' && value.phase === 'ready').length,itemOf(project,'youtube').phase === 'ready')
        return 'Pronto para revisar e postar.'
      }
    }
  }
  /** O manifesto da gravação guarda "o piloto ainda precisa começar" desde antes de o processamento terminar. */
  type Intent = { dir: string; manifest: Awaited<ReturnType<typeof readManifest>> }
  /**
   * `null` = a pasta não tem manifesto (projeto antigo ou importado: nada a retomar). Manifesto que existe e não lê (JSON quebrado,
   * campo inválido, caminho fora da pasta) NUNCA some em silêncio: vai para o log e volta como `unreadable`, para quem chamou mostrar
   * ao usuário que o piloto não pôde retomar e por quê.
   */
  const readIntent = async (id: string): Promise<Intent | { unreadable: string } | null> => {
    try {
      const dir = deps.store.dirOf(id)
      if (!(await pathExists(await resolveProjectFile(dir, MANIFEST_PATH)))) return null
      return { dir, manifest: await readManifest(dir) }
    } catch (err) {
      deps.logger.warn(`Piloto automático: não consegui ler o manifesto da gravação ${id}; não sei se o piloto ainda precisava começar.`, err)
      return { unreadable: err instanceof Error ? err.message : String(err) }
    }
  }
  const readable = (found: Intent | { unreadable: string } | null): found is Intent => found !== null && 'manifest' in found
  /** O manifesto não lê e o projeto não tem piloto: o usuário vê na Biblioteca e na Revisão, com o motivo e o "Tentar de novo" que roda o piloto. */
  const reportUnreadable = async (id: string, reason: string): Promise<void> => {
    const notice = `O piloto automático não pôde retomar: não consegui ler o manifesto da gravação (${reason}). Não sei se ele ainda precisava rodar. Use "Tentar de novo" para rodar o piloto agora.`
    try {
      const saved = await change(id, (p) => {
        if (p.autopilot) return p
        const pipeline = newPipeline(id)
        return { ...p, autopilot: { ...pipeline, status: 'done', notice, steps: pipeline.steps.map((s) => (s.id === 'transcribe' ? { ...s, status: 'error' as const, detail: notice } : s)) } }
      })
      if (saved.autopilot?.notice === notice) deps.emit(structuredClone(saved.autopilot))
    } catch (err) { deps.logger.warn(`Piloto automático: não consegui registrar no projeto ${id} que o manifesto não lê.`, err) }
  }
  /** Assenta a intenção depois que o estado do piloto foi gravado no projeto (ou o modo "Nada" decidiu não rodar). */
  const settleIntent = async (id: string): Promise<void> => {
    const found = await readIntent(id)
    if (!readable(found) || !found.manifest.autopilotPending) return
    try {
      delete found.manifest.autopilotPending
      await writeManifest(found.dir, found.manifest)
    } catch (err) { deps.logger.warn('Piloto automático: não consegui assentar a intenção no manifesto; a retomada vai tentar de novo.', err) }
  }
  /** Pede o recorte do fundo (Apresentador), espera a fila da câmera e confere que ele existe; senão devolve o motivo. */
  async function ensureMatte(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!deps.camera) return { ok: false, reason: 'O serviço da câmera não está disponível.' }
    try {
      await deps.camera.analyze(id, 'matte')
      await deps.camera.idle()
    } catch (err) { return { ok: false, reason: err instanceof Error ? err.message : String(err) } }
    if (await deps.camera.result(id, 'matte').catch(() => null)) return { ok: true }
    const job = (await deps.camera.view().catch(() => null))?.jobs.find((j) => j.projectId === id && j.kind === 'matte')
    return { ok: false, reason: job?.error ?? 'o recorte não ficou pronto' }
  }
  async function run(id: string): Promise<void> {
    const { project } = await deps.store.read(id)
    const state = project.autopilot ?? newPipeline(id)
    const prefs = deps.prefs()
    await runPipeline(state, { stopped: () => stopped, enabled: (s) => prefs.steps[s] !== false && (prefs.mode !== 'prepare' || !['youtube','clipExports'].includes(s)), run: (s) => runStep(id,s), save: async (s) => { await change(id, (p) => ({ ...p, autopilot: structuredClone(s) })); deps.emit(structuredClone(s)) } })
  }
  const service: AutopilotService = {
    renameProject: (id,title) => {
      // A renomeação da Biblioteca participa da mesma fila de escrita das etapas e dos ajustes.
      const task = writes.then(() => deps.store.rename(id,title))
      writes = task.catch(() => undefined)
      return task
    },
    saveProject: (id,doc,base) => change(id,(current) => {
      const merged = base ? mergeEditorProject(base,doc,current) : doc
      const protectionChanged = protectionFingerprint(current) !== protectionFingerprint(merged)
      const items = Object.fromEntries(Object.entries({...current.review?.items,...merged.review?.items}).map(([itemId,item]) => {
        const fresh = current.review?.items[itemId]
        return [itemId,{...item,...(fresh ? {phase:fresh.phase,exportPath:fresh.exportPath,textPath:fresh.textPath,error:fresh.error,revision:fresh.revision} : {}), ...(protectionChanged && (fresh?.exportPath || item.exportPath || fresh?.phase === 'exporting' || item.phase === 'exporting') ? {phase:'error' as const, exportPath:undefined,textPath:undefined,error:PROTECTION_CHANGED_MESSAGE} : {})}]
      }))
      return {...merged,autopilot:current.autopilot,review:{...current.review,...merged.review,items}}
    },base ?? doc),
    async start(id, startedAt) {
      if (active.has(id)) return
      active.add(id)
      try {
        const prefs = deps.prefs()
        const before = (await deps.store.read(id)).project
        let style = deps.ownerStyle?.()
        if (!before.autopilot && style?.background.type === 'image') {
          const source = await deps.ownerBackground?.()
          if (source) style = {...style,background:{type:'image',path:await deps.store.importBackground(id,source)}}
          else style = {...style,background:before.style.background}
        }
        await change(id, (current) => {
          if (current.autopilot) return current
          const p = applyOwnerEditingDefaults(current, deps.ownerEditingDefaults?.() ?? {})
          const v = p.vertical ?? defaultVerticalEdit()
          const zoomsOff = prefs.steps.zooms === false
          return {
            ...p, ...(prefs.mode === 'nothing' ? {} : {autopilot:newPipeline(id,startedAt)}),
            style: { ...(style ?? p.style),cursor:{...(style?.cursor ?? p.style.cursor),mode:p.style.cursor.mode} },
            captions:{...p.captions,enabled:prefs.steps.captions === false ? false : prefs.captionsHorizontal},
            vertical:{...v,captions:{...v.captions,enabled:prefs.steps.captions === false ? false : prefs.captionsVertical},...(zoomsOff ? {zoomPreset:'off' as const,zooms:v.zooms.filter(z => z.origin !== 'auto')} : {})},
            ...(zoomsOff ? {zoomPreset:'off' as const,zooms:p.zooms.filter(z => z.origin !== 'auto')} : {})
          }
        })
        await settleIntent(id)
        if (prefs.mode === 'nothing') return
        // Apresentador: o recorte do fundo começa logo depois da gravação, na fila da câmera, atrás da análise do rosto.
        if (before.cameraStyle === 'presenter' && before.sources.camera) void deps.camera?.analyze(id, 'matte').catch(() => undefined)
        await enqueue(() => run(id))
      } finally { active.delete(id) }
    },
    async retry(id,step) {
      await enqueue(async () => {
        // tentar de novo resolve o aviso do piloto (o `notice` sai do estado)
        await change(id,(p) => { const { notice: _resolved, ...pipeline } = p.autopilot ?? newPipeline(id); return { ...p, autopilot: { ...pipeline, status: 'running', steps: pipeline.steps.map((s) => s.id === step ? { id: s.id, status: 'pending' } : s) } } })
        await run(id)
        if (deps.prefs().mode === 'everything' && ['dictionary','clean','zooms','layouts','captions','clips'].includes(step)) {
          const latest = (await deps.store.read(id)).project
          for (const itemId of ['youtube',...latest.clips.map((c) => c.id)]) {
            if (itemOf(latest,itemId).decision === 'discarded') continue
            if (itemId === 'youtube' && step === 'clips') continue
            if (deps.prefs().steps[itemId === 'youtube' ? 'youtube' : 'clipExports'] === false) continue
            try { await exportItem(id,itemId) } catch { /* exportItem registra o motivo na revisão. */ }
          }
        }
      })
    },
    async updateItem(id,itemId,patch,reexport = true) {
      const { project } = await deps.store.read(id)
      if (itemId !== 'youtube' && !project.clips.some((c) => c.id === itemId)) throw new Error('Esse corte não existe.')
      // O editor e o pedido devolvem uma fotografia já com os ajustes rápidos aplicados.
      // Consome os modificadores para que o próximo render não aplique zoom/aparo duas vezes.
      if (patch.edits) patch = {zoom:undefined,layout:undefined,trim:undefined,captionsEnabled:undefined,captionStyle:undefined,enabledReasons:undefined,enabledCutIds:undefined,disabledReasons:undefined,disabledCutIds:undefined,disabledZoomIds:undefined,disabledLayoutIds:undefined,keepFillers:undefined,keptFillerCutIds:undefined,restoreAutoZooms:undefined,restoreAutoLayouts:undefined,...patch}
      // A lista de muletas é uma preferência reversível, aplicada ao documento de exportação.
      if (patch.keepFillers !== undefined) {
        const t = await deps.transcription.getTranscript(id)
        const words = t?.words.filter((w) => patch.keepFillers?.includes(w.text.toLowerCase().replace(/[^\p{L}]/gu,''))) ?? []
        patch.keptFillerCutIds = (itemOf(project,itemId).edits?.cuts ?? project.cuts).filter((c) => c.reason === 'filler' && c.origin !== 'manual' && words.some((w) => w.start < c.end && w.end > c.start)).map((c) => c.id)
      }
      const result = await change(id,(p) => updateReviewItem(p,itemId,{ ...patch, ...(reexport ? { phase: 'queued', revision: (itemOf(p,itemId).revision ?? 0) + 1 } : {}) }))
      if (Object.hasOwn(patch,'text')) { const {dir} = await deps.store.read(id); const path = itemOf(result,itemId).textPath; if(path) await writeFileAtomic(await resolveProjectFile(dir,path),textOf(result,itemId,(await deps.transcription.getTranscript(id))?.words ?? null)) }
      // Escolher o Apresentador pede o recorte do fundo (o editor também pede); sem motor preparado a exportação diz o motivo.
      if (patch.layout === 'presenter' && deps.camera) await deps.camera.analyze(id, 'matte').catch((err) => deps.logger.warn('Piloto automático: não consegui pedir o recorte do fundo para o Apresentador.', err))
      if (reexport) void enqueue(() => exportItem(id,itemId))
      return result
    },
    async reexport(id,itemId) { await enqueue(() => exportItem(id,itemId)) },
    async postingFolder(id) {
      return enqueue(async () => {
        await writes
        const { project, dir } = await deps.store.read(id)
        const protection = protectionFingerprint(project)
        const ensureProtection = (): Promise<void> => {
          const check = writes.then(async () => {
            if (protectionFingerprint((await deps.store.read(id)).project) !== protection) throw new Error(PROTECTION_CHANGED_MESSAGE)
          })
          writes = check.catch(() => undefined)
          return check
        }
        const folder = await resolveProjectFile(dir,'exports/postar')
        await mkdir(folder,{ recursive: true })
        const manifest = await resolveProjectFile(dir,'exports/postar/arquivos.json')
        // Só some o que o app comprovadamente gerou (está no manifesto) e continua como ele gravou (tamanho e data).
        // O que o usuário criou ou editou na pasta nunca é apagado nem coberto.
        for (const entry of await readPostedManifest(manifest)) {
          if (!entry.path.startsWith('exports/postar/') || entry.size === undefined || entry.mtimeMs === undefined) continue
          try {
            const file = await resolveProjectFile(dir,entry.path)
            const now = await stat(file)
            if (now.isFile() && now.size === entry.size && Math.abs(now.mtimeMs - entry.mtimeMs) < 2) await rm(file,{ force: true })
          } catch { /* sumiu ou não resolve: nada a apagar */ }
        }
        const created: PostedFile[] = []
        const reserved: string[] = []
        let manifestWritten = false
        // Reserva somente nomes novos (criação exclusiva, "nome (2)"). A limpeza de uma tentativa invalidada nunca
        // remove um arquivo manual que já estava na pasta.
        const reserve = async (stem:string,extension:string):Promise<{rel:string;path:string}> => {
          for (let attempt=0;attempt<100;attempt++) {
            const name = uniqueName(stem,n => existsSync(join(folder,`${n}.${extension}`)))
            const rel = `exports/postar/${name}.${extension}`
            const path = await resolveProjectFile(dir,rel)
            let handle
            try {handle = await open(path,'wx')}
            catch(error) {if((error as NodeJS.ErrnoException).code === 'EEXIST') continue;throw error}
            reserved.push(rel)
            await handle.close()
            return {rel,path}
          }
          throw new Error('Não achei nome livre na pasta para postar.')
        }
        const record = async (rel:string,path:string):Promise<void> => { const made = await stat(path); created.push({ path: rel, size: made.size, mtimeMs: made.mtimeMs }) }
        try {
          const texts: Record<string,string[]> = { YouTube: [], TikTok: [], Reels: [], Shorts: [] }
          for (const [itemId,item] of Object.entries(project.review?.items ?? {})) {
            if (item.decision !== 'approved' || item.phase !== 'ready' || !item.exportPath) continue
            await ensureProtection()
            const c = project.clips.find((c) => c.id === itemId)
            const stem = `${sanitizeFileName(itemId)} - ${sanitizeFileName(item.title ?? c?.title ?? project.title)}`
            const output = await reserve(stem,'mp4')
            await copyFile(await resolveProjectFile(dir,item.exportPath),output.path)
            await record(output.rel,output.path)
            await ensureProtection()
            if (itemId === 'youtube') {
              const t = await transcript(id)
              texts.YouTube!.push(textOf(project,itemId,t.words))
            } else if (c) {
              const meta = reviewDocument(project,itemId).meta?.perClip?.[itemId] ?? fallbackClipMeta(c,null)
              for (const [platform,key] of [['TikTok','tiktok'],['Reels','reels'],['Shorts','shorts']] as const) texts[platform]!.push(item.text ?? `${item.title ?? c.title}\n${meta.caption ?? c.hook}\n${meta[key]?.join(' ') ?? ''}`)
            }
          }
          for (const [platform,blocks] of Object.entries(texts)) if (blocks.length) { const output = await reserve(platform,'txt'); await writeFileAtomic(output.path,blocks.join('\n\n')); await record(output.rel,output.path) }
          await ensureProtection()
          await writeFileAtomic(manifest,JSON.stringify(created))
          manifestWritten = true
          await ensureProtection()
          return folder
        } catch(error) {
          for (const rel of reserved) await rm(await resolveProjectFile(dir,rel),{force:true}).catch(() => undefined)
          if(manifestWritten) await rm(manifest,{force:true}).catch(() => undefined)
          throw error
        }
      })
    },
    async resume() {
      for (const entry of await deps.store.list()) {
        const { project } = await deps.store.read(entry.id)
        // Fechar o app entre o fim do processamento e o primeiro estado do piloto deixava a gravação sem piloto e sem aviso:
        // o processamento deixa a intenção no manifesto e a inicialização reconcilia aqui.
        const found = await readIntent(entry.id)
        if (found && !readable(found)) {
          if (!project.autopilot) await reportUnreadable(entry.id, found.unreadable)
        }
        const pending = readable(found) && found.manifest.autopilotPending === true
        if (project.autopilot?.status === 'running' || (pending && !project.autopilot)) await service.start(entry.id).catch(() => undefined)
        else if (pending) await settleIntent(entry.id)
        const latest = (await deps.store.read(entry.id)).project
        for (const [itemId,item] of Object.entries(latest.review?.items ?? {})) if (item.phase === 'queued' || item.phase === 'exporting') void enqueue(() => exportItem(entry.id,itemId))
      }
    },
    async idle() { await queue },
    shutdown() { stopped = true }
  }
  return service
}
