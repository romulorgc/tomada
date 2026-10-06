import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAutopilot } from '../../src/main/autopilot'
import { createHandlers, type HandlerDeps } from '../../src/main/handlers'
import { ProjectNotFoundError, type ProjectStore } from '../../src/main/projects'
import type { ExportService } from '../../src/main/export-service'
import type { TranscriptionService } from '../../src/main/transcription/service'
import type { LlmManager } from '../../src/main/llm/manager'
import { createMemoryLogger } from '../../src/main/logger'
import { createMockProvider } from '../../src/main/llm/mock'
import type { LlmProvider } from '../../src/main/llm/provider'
import { DEFAULT_AUTOPILOT, newPipeline } from '../../src/shared/autopilot'
import { MANIFEST_PATH, type RecordingManifest } from '../../src/main/manifest'
import { createProject } from '../../src/shared/project'
import { itemOf, reviewDocument, type ReviewItem } from '../../src/shared/review'
import { defaultVerticalEdit, projectForFormat } from '../../src/shared/vertical'
import type { ExportProgress, ExportRequest } from '../../src/shared/ipc'
import type { Project, Transcript } from '../../src/shared/types'
import { useTmpDir } from '../helpers/env'

const tmp = useTmpDir()
const id = 'piloto-regressao'
const transcript: Transcript = {
  engine: 'teste', model: 'simulado', language: 'pt', durationMs: 20_000,
  words: [{ i: 0, text: 'Veja', start: 500, end: 1000, prob: 1, kind: 'word' }, { i: 1, text: 'a agenda.', start: 1100, end: 2000, prob: 1, kind: 'word' }],
  segments: [], vad: [{ start: 500, end: 2000 }], createdAt: '2026-10-05T12:00:00Z'
}

function baseProject(): Project {
  return createProject({ id, title: 'Agenda de teste', sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: 20_000 } } })
}
function finishedPipeline(doc: Project, interrupted = false): void {
  doc.autopilot = newPipeline(id)
  doc.autopilot.status = interrupted ? 'running' : 'done'
  for (const step of doc.autopilot.steps) step.status = 'done'
}
function addClip(doc: Project): void {
  doc.clips = [{ id: 'clip-1', title: 'Agenda', hook: 'Organize agora', ranges: [{ start: 0, end: 20_000 }], score: 80, reason: 'Demonstração sintética', format: 'vertical', layoutV: 'auto', source: 'manual' }]
}

async function world(initial: Project, options: { gate?: Promise<void>; transcript?: Transcript; camera?: ReturnType<typeof makeCamera>; provider?: LlmProvider | null } = {}) {
  const dir = tmp()
  await Promise.all(['media', 'events', 'exports'].map((folder) => mkdir(join(dir, folder), { recursive: true })))
  let stored = structuredClone(initial)
  const read = vi.fn(async () => ({ project: structuredClone(stored), dir }))
  const write = vi.fn(async (_id: string, project: Project) => {
    // Simula uma escrita assíncrona: duas alterações simultâneas não podem usar a mesma fotografia antiga.
    await Promise.resolve()
    stored = structuredClone(project)
  })
  const store = { read, write, dirOf: () => dir, list: async () => [{ id, title: stored.title, createdAt: stored.createdAt, durationMs: 20_000, thumbPath: null, thumbVersion: 0, hasScreen: true, hasCamera: false }],rename:async (_id:string,title:string) => {
    const {project} = await read()
    await write(id,{...project,title,review:{...project.review,items:project.review?.items ?? {},titleOrigin:'manual'}})
    return {id,title:stored.title,createdAt:stored.createdAt,durationMs:20_000,thumbPath:null,thumbVersion:0,hasScreen:true,hasCamera:false}
  } } satisfies Pick<ProjectStore, 'read' | 'write' | 'dirOf' | 'list' | 'rename'>
  let exportState: ExportProgress | null = null
  let exportCount = 0
  const rendered: Project[] = []
  const start = vi.fn(async (request: ExportRequest) => {
    const exportId = `export-${++exportCount}`
    rendered.push(projectForFormat(reviewDocument(stored, request.clipId ?? 'youtube'), request.format ?? 'horizontal'))
    exportState = { exportId, projectId: id, phase: 'done', fraction: 1, frame: 600, totalFrames: 600, renderFps: null, etaMs: 0, audioReady: true, outputPath: join(dir, 'exports', `${exportId}.mp4`) }
    return { exportId }
  })
  const exporter = { start, idle: vi.fn(async () => { if (options.gate && exportCount === 1) await options.gate }), status: () => exportState } satisfies Pick<ExportService, 'start' | 'idle' | 'status'>
  const transcription = { getTranscript: vi.fn(async () => structuredClone(options.transcript ?? transcript)), idle: vi.fn(async () => undefined), start: vi.fn(async () => undefined) } satisfies Pick<TranscriptionService, 'getTranscript' | 'idle' | 'start'>
  const prefs = structuredClone(DEFAULT_AUTOPILOT)
  const ready = vi.fn()
  const service = createAutopilot({
    store: store as unknown as ProjectStore,
    exporter: exporter as unknown as ExportService,
    transcription: transcription as unknown as TranscriptionService,
    derived: { levels: async () => null, peaks: async () => null, previewAudio: async () => null, thumbs: async () => null, idle: async () => undefined, shutdown: () => undefined },
    llm: { provider: () => options.provider ?? null } as unknown as LlmManager,
    ...(options.camera ? { camera: options.camera as unknown as NonNullable<Parameters<typeof createAutopilot>[0]['camera']> } : {}),
    logger: createMemoryLogger(), prefs: () => prefs, emit: vi.fn(), ready
  })
  return { service, dir, start, rendered, ready, prefs, read, write, camera: options.camera, project: () => structuredClone(stored) }
}

describe('integração dos ajustes e da retomada do piloto automático', () => {
  it('sem título da IA, publicação usa o título que o usuário já deu', async () => {
    const doc = baseProject()
    doc.title = 'Título escolhido pelo usuário'
    const w = await world(doc)
    w.prefs.mode = 'prepare'
    for (const key of Object.keys(w.prefs.steps) as (keyof typeof w.prefs.steps)[]) w.prefs.steps[key] = key === 'publish'
    await w.service.start(id)
    expect(w.project().meta?.youtube?.titles?.[0]).toBe('Título escolhido pelo usuário')
    expect(w.project().title).toBe('Título escolhido pelo usuário')
  })
  it.each([['', 'Veja a agenda.'], ['Título do usuário', 'Título do usuário']])('fallback de publicação respeita título %s ou usa a transcrição', async (title, expected) => {
    const doc = baseProject(); doc.title = title
    const w = await world(doc)
    w.prefs.mode = 'prepare'; w.prefs.steps = Object.fromEntries(['transcribe','clean','zooms','layouts','captions','youtube','clips','clipExports','notify'].map(k => [k, false]))
    await w.service.start(id)
    expect(w.project().title).toBe(expected)
  })
  it('título da publicação recebido da IA precede título provisório de projeto e roteiro', async () => {
    const doc = baseProject()
    doc.script = { title: 'Roteiro provisório', hook: 'Teste', topics: ['Um','Dois','Três'], closing: 'Fim' }
    const w = await world(doc, { provider: createMockProvider() })
    w.prefs.mode = 'prepare'; w.prefs.steps = Object.fromEntries(['transcribe','clean','zooms','layouts','captions','youtube','clips','clipExports','notify'].map(k => [k, false]))
    await w.service.start(id)
    expect(w.project().title).toBe('Título de teste')
  })
  it('desligar a etapa de zoom remove segmentos automáticos dos dois formatos e conserva os manuais', async () => {
    const doc = baseProject()
    const auto = {id:'auto',start:1000,end:3000,scale:1.4,focus:'auto' as const,origin:'auto' as const}
    const manual = {...auto,id:'manual',start:6000,end:8000,origin:'manual' as const}
    doc.zooms = [auto,manual]
    doc.vertical = {...defaultVerticalEdit(),zoomPreset:'intense',zooms:[{...auto,id:'auto-v'},{...manual,id:'manual-v'}]}
    const w = await world(doc)
    w.prefs.mode = 'nothing'
    w.prefs.steps.zooms = false
    await w.service.start(id)
    expect(w.project().zoomPreset).toBe('off')
    expect(w.project().vertical?.zoomPreset).toBe('off')
    expect(w.project().zooms).toEqual([manual])
    expect(w.project().vertical?.zooms).toEqual([{...manual,id:'manual-v'}])
  })
  it('desfoque vindo do editor de um corte salva no comum sem copiar cortes do item e invalida arquivos anteriores', async () => {
    const base = baseProject(); addClip(base)
    base.review = {items:{youtube:{decision:'approved',origin:'manual',phase:'ready',exportPath:'exports/antigo.mp4'},'clip-1':{decision:'approved',origin:'manual',phase:'ready',exportPath:'exports/corte-antigo.mp4'}}}
    const w = await world(base)
    const opened = reviewDocument(base,'clip-1')
    const regions = [{id:'b1',start:0,end:20000,rect:{x:.3,y:.3,w:.4,h:.2},mode:'blur' as const}]
    await w.service.saveProject(id,{...opened,blurRegions:regions},opened)
    expect(w.project().cuts).toEqual(base.cuts)
    expect(w.project().title).toBe(base.title)
    for (const item of ['youtube','clip-1']) {
      expect(reviewDocument(w.project(),item).blurRegions).toEqual(regions)
      expect(itemOf(w.project(),item).exportPath).toBeUndefined()
      expect(itemOf(w.project(),item).error).toContain('proteção')
    }
  })
  it('tentar salvar de novo recupera o documento aberto se só o project.json sumiu',async () => {
    const base = baseProject()
    const w = await world(base)
    w.read.mockRejectedValueOnce(new ProjectNotFoundError('O projeto não tem project.json.'))
    const edited = {...base,style:{...base.style,radius:31}}
    await w.service.saveProject(id,edited,base)
    expect(w.project().style.radius).toBe(31)
    await mkdir(join(w.dir,'project.json'))
    w.read.mockRejectedValueOnce(new ProjectNotFoundError('O projeto não tem project.json.'))
    await expect(w.service.saveProject(id,edited,base)).rejects.toThrow(ProjectNotFoundError)
  })
  it('renomear na Biblioteca e ajustar a Revisão ao mesmo tempo conserva ambas as alterações',async () => {
    const w = await world(baseProject())
    await Promise.all([w.service.renameProject(id,'Título do usuário'),w.service.updateItem(id,'youtube',{decision:'approved'},false)])
    expect(w.project().title).toBe('Título do usuário')
    expect(w.project().review?.titleOrigin).toBe('manual')
    expect(itemOf(w.project(),'youtube').decision).toBe('approved')
  })
  it('ajuste pelo IPC conserva aprovação e descarte se a decisão não veio na alteração',async () => {
    const doc = baseProject()
    doc.review = {items:{youtube:{decision:'approved',origin:'manual'}}}
    const w = await world(doc)
    const handlers = createHandlers({autopilot:w.service} as HandlerDeps)
    await handlers['review:update'](id,'youtube',{title:'Título ajustado'},false)
    expect(itemOf(w.project(),'youtube').decision).toBe('approved')
    await handlers['review:update'](id,'youtube',{decision:'discarded'},false)
    await handlers['review:update'](id,'youtube',{captionsEnabled:false},false)
    expect(itemOf(w.project(),'youtube').decision).toBe('discarded')
  })
  it('salvar fotografia antiga do editor preserva corte automático que chegou depois e a alteração de raio', async () => {
    const base = baseProject()
    const edited = structuredClone(base)
    edited.style.radius = 42
    const current = structuredClone(base)
    current.cuts = [{ id: 'corte-que-chegou', start: 2000, end: 3000, reason: 'silence', enabled: true, origin: 'auto' }]
    finishedPipeline(current)
    const w = await world(current)
    const result = await w.service.saveProject(id, edited, base)
    expect(result.style.radius).toBe(42)
    expect(result.cuts).toEqual(current.cuts)
    expect(result.autopilot).toEqual(current.autopilot)
    expect(w.project()).toEqual(result)
    expect(base.cuts).toEqual([])
    expect(base.style.radius).not.toBe(42)
  })

  it('pasta para postar e restauração do texto usam metadados e tempos da edição do item', async () => {
    const doc = baseProject()
    doc.sources.screen!.durationMs = 60_000
    doc.meta = { youtube: { titles: ['Título global antigo'], description: 'Descrição global antiga', tags: ['global'] } }
    const edits: NonNullable<ReviewItem['edits']> = {
      cuts: [{ id: 'aparar-item', start: 0, end: 10_000, reason: 'manual', enabled: true, origin: 'manual' }],
      zooms: [], layouts: [], captions: doc.captions, style: doc.style,
      meta: { youtube: { titles: ['Título local do item', 'Alternativa local'], description: 'Descrição revisada deste vídeo.', tags: ['agenda-local'], chapters: [{ start: 0, title: 'Introdução local' }, { start: 30_000, title: 'Agenda local' }, { start: 45_000, title: 'Resultado local' }] } }
    }
    doc.review = { items: { youtube: { origin: 'manual', decision: 'approved', phase: 'ready', exportPath: 'exports/youtube.mp4', textPath: 'exports/youtube.txt', edits } } }
    const w = await world(doc)
    await writeFile(join(w.dir, 'exports/youtube.mp4'), 'arquivo sintético para testar cópia')
    await writeFile(join(w.dir, 'exports/youtube.txt'), 'Texto anterior')
    const folder = await w.service.postingFolder(id)
    const automatic = await readFile(join(folder, 'YouTube.txt'), 'utf8')
    expect(automatic).toContain('1. Título local do item')
    expect(automatic).toContain('2. Alternativa local')
    expect(automatic).toContain('Descrição revisada deste vídeo.')
    expect(automatic).toContain('agenda-local')
    expect(automatic).toContain('00:20 Agenda local')
    expect(automatic).toContain('00:35 Resultado local')
    expect(automatic).not.toContain('global antigo')
    expect(automatic).not.toContain('00:30 Agenda local')
    // o manifesto guarda o caminho e o que o app viu ao gravar (tamanho e data), para só apagar o que continua intacto
    const outputs = (JSON.parse(await readFile(join(folder, 'arquivos.json'), 'utf8')) as { path: string; size: number; mtimeMs: number }[]).map((entry) => entry.path)
    const mp4 = outputs.find((path) => path.endsWith('.mp4'))!
    expect(await readFile(join(w.dir, mp4), 'utf8')).toBe('arquivo sintético para testar cópia')
    await w.service.updateItem(id, 'youtube', { text: 'Texto manual temporário' }, false)
    expect(await readFile(join(w.dir, 'exports/youtube.txt'), 'utf8')).toBe('Texto manual temporário')
    await w.service.updateItem(id, 'youtube', { text: undefined }, false)
    expect(itemOf(w.project(), 'youtube').text).toBeUndefined()
    expect(await readFile(join(w.dir, 'exports/youtube.txt'), 'utf8')).toBe(automatic)
    expect(w.start).not.toHaveBeenCalled()
  })

  it('alterações simultâneas de legenda e título preservam ambos os ajustes', async () => {
    const w = await world(baseProject())
    await Promise.all([
      w.service.updateItem(id, 'youtube', { captionsEnabled: false }, false),
      w.service.updateItem(id, 'youtube', { title: 'Agenda revisada' }, false)
    ])
    expect(itemOf(w.project(), 'youtube')).toMatchObject({ captionsEnabled: false, title: 'Agenda revisada', origin: 'manual' })
    expect(w.write).toHaveBeenCalledTimes(2)
    expect(w.start).not.toHaveBeenCalled()
  })

  it('retoma notificação interrompida e também exporta item que ficou na fila', async () => {
    const doc = baseProject()
    addClip(doc); finishedPipeline(doc, true)
    doc.autopilot!.steps.find((step) => step.id === 'notify')!.status = 'running'
    doc.review = { items: { 'clip-1': { origin: 'manual', decision: 'pending', phase: 'queued' } } }
    const w = await world(doc)
    await w.service.resume()
    await w.service.idle()
    expect(w.ready).toHaveBeenCalledOnce()
    expect(w.project().autopilot).toMatchObject({ status: 'done' })
    expect(w.project().autopilot!.steps.find((step) => step.id === 'notify')?.status).toBe('done')
    expect(w.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: id, clipId: 'clip-1', format: 'vertical' }))
    expect(itemOf(w.project(), 'clip-1')).toMatchObject({ phase: 'ready', exportPath: 'exports/export-1.mp4' })
  })

  it('refazer zooms atualiza a edição e reexporta automaticamente o vídeo pronto', async () => {
    const doc = baseProject()
    finishedPipeline(doc)
    doc.zooms = [{ id: 'auto-antigo', start: 500, end: 1500, scale: 1.2, focus: 'auto', origin: 'auto' }, { id: 'manual', start: 10_000, end: 11_000, scale: 1.3, focus: 'auto', origin: 'manual' }]
    doc.review = { items: { youtube: { origin: 'auto', decision: 'pending', phase: 'ready', exportPath: 'exports/antigo.mp4' } } }
    const w = await world(doc)
    await writeFile(join(w.dir, 'events/clicks.jsonl'), `${JSON.stringify({ t: 3000, x: 0.5, y: 0.5, button: 'left' })}\n`)
    await w.service.retry(id, 'zooms')
    expect(w.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: id, format: 'horizontal' }))
    expect(w.rendered[0]!.zooms.some((zoom) => zoom.origin === 'auto' && zoom.id !== 'auto-antigo')).toBe(true)
    expect(w.rendered[0]!.zooms).toContainEqual(doc.zooms[1])
    expect(itemOf(w.project(), 'youtube')).toMatchObject({ phase: 'ready', exportPath: 'exports/export-1.mp4' })
    expect(itemOf(w.project(), 'youtube').exportPath).not.toBe('exports/antigo.mp4')
  })

  it('fotografia editada do vertical consome o modificador de zoom e preserva estilo e correções de palavras', async () => {
    const doc = baseProject()
    addClip(doc)
    doc.vertical = { ...defaultVerticalEdit(), zooms: [{ id: 'zoom-v', start: 1000, end: 4000, scale: 1.4, focus: 'auto', origin: 'auto' }] }
    doc.review = { items: { 'clip-1': { decision: 'pending', origin: 'manual', zoom: 'stronger', captionsEnabled: false } } }
    const effective = projectForFormat(reviewDocument(doc, 'clip-1'), 'vertical')
    const edits: NonNullable<ReviewItem['edits']> = {
      cuts: effective.cuts, zooms: effective.zooms, layouts: effective.layouts, captions: effective.captions,
      style: { ...effective.style, defaultLayout: 'camera', camera: { ...effective.style.camera, size: 0.36, corner: 'bottom-left' } },
      wordFixes: { '1': 'agenda corrigida' }, zoomPreset: 'intense'
    }
    const w = await world(doc)
    await w.service.updateItem(id, 'clip-1', { edits }, false)
    const stored = w.project(), item = itemOf(stored, 'clip-1')
    expect(item.zoom).toBeUndefined()
    expect(item.captionsEnabled).toBeUndefined()
    const result = projectForFormat(reviewDocument(stored, 'clip-1'), 'vertical')
    expect(result.zooms[0]!.scale).toBeCloseTo(1.56)
    expect(result.zooms).toEqual(edits.zooms)
    expect(result.style.defaultLayout).toBe('camera')
    expect(result.style.camera).toMatchObject({ size: 0.36, corner: 'bottom-left' })
    expect(result.wordFixes).toEqual({ '1': 'agenda corrigida' })
    expect(result.zoomPreset).toBe('intense')
    expect(result.captions.enabled).toBe(false)
    expect(stored.style.camera).toEqual(doc.style.camera)
    expect(w.start).not.toHaveBeenCalled()
  })
})

describe('consertos da revisão independente da M4d', () => {
  // --- 1. Abrir pasta para postar nunca sobrescreve o que não é saída comprovada do app -------------------------
  async function approvedWorld() {
    const doc = baseProject()
    doc.review = { items: { youtube: { origin: 'manual', decision: 'approved', phase: 'ready', exportPath: 'exports/youtube.mp4', textPath: 'exports/youtube.txt' } } }
    const w = await world(doc)
    await writeFile(join(w.dir, 'exports/youtube.mp4'), 'vídeo gerado pelo app')
    await writeFile(join(w.dir, 'exports/youtube.txt'), 'texto')
    await mkdir(join(w.dir, 'exports/postar'), { recursive: true })
    return w
  }
  it('pasta para postar não substitui o YouTube.txt nem o MP4 que o usuário já tinha na pasta', async () => {
    const w = await approvedWorld()
    const folder = join(w.dir, 'exports/postar')
    const stem = 'youtube - Agenda de teste'
    await writeFile(join(folder, 'YouTube.txt'), 'texto escrito pelo usuário')
    await writeFile(join(folder, `${stem}.mp4`), 'vídeo do usuário com o mesmo nome')
    await w.service.postingFolder(id)
    expect(await readFile(join(folder, 'YouTube.txt'), 'utf8')).toBe('texto escrito pelo usuário')
    expect(await readFile(join(folder, `${stem}.mp4`), 'utf8')).toBe('vídeo do usuário com o mesmo nome')
    const names = await readdir(folder)
    expect(names).toContain('YouTube (2).txt')
    expect(names).toContain(`${stem} (2).mp4`)
    expect(await readFile(join(folder, `${stem} (2).mp4`), 'utf8')).toBe('vídeo gerado pelo app')
  })
  it('pasta para postar refaz só as saídas do app e preserva o que o usuário editou depois', async () => {
    const w = await approvedWorld()
    const folder = join(w.dir, 'exports/postar')
    await w.service.postingFolder(id)
    const first = (await readdir(folder)).filter((name) => name !== 'arquivos.json').sort()
    expect(first).toEqual(['YouTube.txt', 'youtube - Agenda de teste.mp4'])
    // chamar de novo substitui as saídas intactas do app, sem acumular cópias
    await w.service.postingFolder(id)
    expect((await readdir(folder)).filter((name) => name !== 'arquivos.json').sort()).toEqual(first)
    // o usuário ajusta o texto gerado: a próxima montagem o guarda e escreve o dela ao lado
    await writeFile(join(folder, 'YouTube.txt'), 'meu ajuste no texto')
    await w.service.postingFolder(id)
    expect(await readFile(join(folder, 'YouTube.txt'), 'utf8')).toBe('meu ajuste no texto')
    expect((await readdir(folder)).filter((name) => name !== 'arquivos.json')).toContain('YouTube (2).txt')
  })

  // --- 2. A intenção de rodar o piloto sobrevive ao fechamento do app ------------------------------------------
  async function writePendingManifest(dir: string, pending: boolean): Promise<void> {
    await mkdir(join(dir, 'raw'), { recursive: true })
    const manifest = { version: 1, sessionId: id, folder: 'raw', title: 'Gravação', createdAt: '2026-10-05T11:00:00Z', pauses: [], notes: [], processedAt: '2026-10-05T12:00:00Z', ...(pending ? { autopilotPending: true } : {}) } as unknown as RecordingManifest
    await writeFile(join(dir, MANIFEST_PATH), JSON.stringify(manifest))
  }
  it('reabrir o app depois do processamento e antes do start retoma o piloto que ainda não tinha estado', async () => {
    const w = await world(baseProject())
    await writePendingManifest(w.dir, true)
    expect(w.project().autopilot).toBeUndefined()
    await w.service.resume()
    await w.service.idle()
    expect(w.project().autopilot).toMatchObject({ status: 'done' })
    expect(w.ready).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(join(w.dir, MANIFEST_PATH), 'utf8')).autopilotPending).toBeUndefined()
    // já assentado: uma nova reabertura não recomeça nada
    w.ready.mockClear()
    await w.service.resume()
    await w.service.idle()
    expect(w.ready).not.toHaveBeenCalled()
  })
  it('gravação sem intenção pendente continua sem piloto ao reabrir (projeto antigo ou piloto em "Nada")', async () => {
    const w = await world(baseProject())
    await writePendingManifest(w.dir, false)
    await w.service.resume()
    await w.service.idle()
    expect(w.project().autopilot).toBeUndefined()
    expect(w.ready).not.toHaveBeenCalled()
  })
  it('no modo Nada o start assenta a intenção para a reabertura não reaplicar o estilo do usuário', async () => {
    const w = await world(baseProject())
    w.prefs.mode = 'nothing'
    await writePendingManifest(w.dir, true)
    await w.service.start(id)
    expect(w.project().autopilot).toBeUndefined()
    expect(JSON.parse(await readFile(join(w.dir, MANIFEST_PATH), 'utf8')).autopilotPending).toBeUndefined()
  })

  // --- 3. Uma exportação antiga não apaga a pendência da reexportação mais nova --------------------------------
  it('exportação antiga que termina depois de um ajuste não marca o item como pronto', async () => {
    const doc = baseProject()
    finishedPipeline(doc)
    doc.review = { items: { youtube: { origin: 'auto', decision: 'pending', phase: 'ready', exportPath: 'exports/antigo.mp4' } } }
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const w = await world(doc, { gate })
    const first = w.service.reexport(id, 'youtube')
    await vi.waitFor(() => expect(w.start).toHaveBeenCalledTimes(1))
    await w.service.updateItem(id, 'youtube', { captionsEnabled: true }, true)
    expect(itemOf(w.project(), 'youtube').phase).toBe('queued')
    release()
    await first
    await w.service.idle()
    // nenhum instante gravado apontou o item como pronto com o vídeo da exportação antiga (o app podia fechar ali)
    expect(w.write.mock.calls.some(([, saved]) => { const item = itemOf(saved as Project, 'youtube'); return item.phase === 'ready' && item.exportPath === 'exports/export-1.mp4' })).toBe(false)
    expect(w.start).toHaveBeenCalledTimes(2)
    expect(w.rendered[1]!.captions.enabled).toBe(true)
    expect(itemOf(w.project(), 'youtube')).toMatchObject({ phase: 'ready', exportPath: 'exports/export-2.mp4' })
  })
  it('exportação antiga que falha depois de um ajuste também não troca a pendência por erro', async () => {
    const doc = baseProject()
    finishedPipeline(doc)
    doc.review = { items: { youtube: { origin: 'auto', decision: 'pending', phase: 'ready', exportPath: 'exports/antigo.mp4' } } }
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const w = await world(doc, { gate })
    w.start.mockImplementationOnce(async () => { await gate; throw new Error('falha da exportação antiga') })
    const first = w.service.reexport(id, 'youtube').catch(() => undefined)
    await vi.waitFor(() => expect(w.start).toHaveBeenCalledTimes(1))
    await w.service.updateItem(id, 'youtube', { captionsEnabled: true }, true)
    release()
    await first
    await w.service.idle()
    expect(w.write.mock.calls.some(([, saved]) => itemOf(saved as Project, 'youtube').phase === 'error')).toBe(false)
    expect(itemOf(w.project(), 'youtube')).toMatchObject({ phase: 'ready' })
  })

  // --- 4. A fotografia do item acompanha a regeneração e guarda só as decisões do usuário --------------------------
  it('refazer zooms atualiza os automáticos da fotografia do item e conserva o zoom manual', async () => {
    const doc = baseProject()
    finishedPipeline(doc)
    const antigo = { id: 'auto-antigo', start: 500, end: 1500, scale: 1.2, focus: 'auto' as const, origin: 'auto' as const }
    const manual = { id: 'manual', start: 10_000, end: 11_000, scale: 1.3, focus: 'auto' as const, origin: 'manual' as const }
    doc.zooms = [antigo, manual]
    doc.review = { items: { youtube: { origin: 'manual', decision: 'pending', phase: 'ready', exportPath: 'exports/antigo.mp4', title: 'Só mudei o título', edits: { cuts: [], zooms: [antigo, manual], layouts: [], captions: doc.captions, style: doc.style } } } }
    const w = await world(doc)
    await writeFile(join(w.dir, 'events/clicks.jsonl'), `${JSON.stringify({ t: 3000, x: 0.5, y: 0.5, button: 'left' })}\n`)
    await w.service.retry(id, 'zooms')
    expect(w.rendered[0]!.zooms.some((zoom) => zoom.id === 'auto-antigo')).toBe(false)
    expect(w.rendered[0]!.zooms.some((zoom) => zoom.origin === 'auto')).toBe(true)
    expect(w.rendered[0]!.zooms).toContainEqual(manual)
    expect(w.rendered[0]!.title).toBe('Só mudei o título')
  })

  // --- 5. Os identificadores dos cortes não se repetem depois de limpar de novo ----------------------------------
  it('limpar de novo com um corte manual "cut-1" não repete o identificador nos automáticos', async () => {
    const doc = baseProject()
    finishedPipeline(doc)
    doc.cuts = [{ id: 'cut-1', start: 10_000, end: 11_000, reason: 'manual', enabled: true, origin: 'manual' }]
    const w = await world(doc)
    await w.service.retry(id, 'clean')
    const cuts = w.project().cuts
    expect(new Set(cuts.map((cut) => cut.id)).size).toBe(cuts.length)
    expect(cuts.filter((cut) => cut.origin === 'auto').length).toBeGreaterThan(0)
    expect(cuts.find((cut) => cut.id === 'cut-1')).toMatchObject({ start: 10_000, end: 11_000, origin: 'manual', reason: 'manual' })
  })
})

/** O serviço da câmera (M4c) como o piloto o enxerga: espera da fila, o recorte que já vale, o pedido de análise e o estado dos trabalhos. */
function makeCamera(opts: { matte?: boolean; hold?: Promise<void>; analyzeError?: string; jobError?: string } = {}) {
  return {
    idle: vi.fn(async () => { await opts.hold }),
    result: vi.fn(async (_id: string, kind: string) => (opts.matte && kind === 'matte' ? 'tomada-media://p/media/camera-matte.mp4' : null)),
    analyze: vi.fn(async () => { if (opts.analyzeError) throw new Error(opts.analyzeError); return { id: 'trabalho' } }),
    view: vi.fn(async () => ({ jobs: opts.jobError ? [{ projectId: id, kind: 'matte', state: 'error', fraction: 0, error: opts.jobError }] : [] }))
  }
}

describe('piloto automático × estilo da câmera escolhido antes de gravar (M4c)', () => {
  const withCamera = (doc: Project, style?: 'side-by-side' | 'presenter'): Project => {
    doc.sources.camera = { path: 'media/camera.mp4', w: 1280, h: 720, fps: 30, durationMs: 20_000 }
    if (style) doc.cameraStyle = style
    return doc
  }
  /** Fala corrida de 1 s a 12 s, sem nada acontecendo na tela: o automático escolhe o layout com a câmera. */
  const talk: Transcript = { ...transcript, words: Array.from({ length: 36 }, (_, i) => ({ i, text: `p${i}`, start: 1000 + i * 300, end: 1000 + i * 300 + 280, prob: 1, kind: 'word' as const })), vad: [{ start: 1000, end: 12_000 }] }
  const layoutsOf = (p: Project) => ({ horizontal: new Set(p.layouts.map((l) => l.layout)), vertical: new Set(p.vertical!.layouts.map((l) => l.layout)) })
  const detailOf = (p: Project) => p.autopilot!.steps.find((step) => step.id === 'layouts')!.detail ?? ''

  it('Apresentador: pede o recorte do fundo ao começar, espera, e a fala sem atividade vira Apresentador (16:9) e V-D (9:16)', async () => {
    const doc = withCamera(baseProject(), 'presenter')
    const w = await world(doc, { transcript: talk, camera: makeCamera({ matte: true }) })
    await w.service.start(id)
    expect(w.camera!.analyze).toHaveBeenCalledWith(id, 'matte')
    expect(w.camera!.idle).toHaveBeenCalled()
    const { horizontal, vertical } = layoutsOf(w.project())
    expect([...horizontal]).toEqual(['presenter'])
    expect([...vertical]).toEqual(['presenter'])
    expect(detailOf(w.project())).not.toMatch(/recorte do fundo falhou/)
  })
  it('Quadro ao lado: lado a lado no 16:9 e V-B no 9:16, e nunca pede o recorte nem escolhe Apresentador, mesmo com um recorte antigo pronto', async () => {
    const doc = withCamera(baseProject(), 'side-by-side')
    const w = await world(doc, { transcript: talk, camera: makeCamera({ matte: true }) })
    await w.service.start(id)
    expect(w.camera!.analyze).not.toHaveBeenCalledWith(id, 'matte')
    const { horizontal, vertical } = layoutsOf(w.project())
    expect([...horizontal]).toEqual(['side-by-side'])
    expect([...vertical]).toEqual(['stack'])
  })
  it('projeto antigo, sem o campo do estilo, é Quadro ao lado', async () => {
    const doc = withCamera(baseProject())
    expect(doc.cameraStyle).toBeUndefined()
    const w = await world(doc, { transcript: talk, camera: makeCamera({ matte: true }) })
    await w.service.start(id)
    expect(w.camera!.analyze).not.toHaveBeenCalledWith(id, 'matte')
    const { horizontal, vertical } = layoutsOf(w.project())
    expect([...horizontal]).toEqual(['side-by-side'])
    expect([...vertical]).toEqual(['stack'])
  })
  it('Apresentador com o motor do recorte sem preparo: cai no quadro ao lado e V-B e a Revisão mostra o motivo e o caminho', async () => {
    const doc = withCamera(baseProject(), 'presenter')
    const w = await world(doc, { transcript: talk, camera: makeCamera({ analyzeError: 'O recorte do fundo ainda não foi preparado neste computador.' }) })
    await w.service.start(id)
    const { horizontal, vertical } = layoutsOf(w.project())
    expect([...horizontal]).toEqual(['side-by-side'])
    expect([...vertical]).toEqual(['stack'])
    const detail = detailOf(w.project())
    expect(detail).toContain('O recorte do fundo falhou; usei o quadro ao lado.')
    expect(detail).toContain('ainda não foi preparado')
    expect(detail).toContain('Câmera → Recortar de novo')
    expect(w.project().autopilot!.steps.find((step) => step.id === 'layouts')!.status).toBe('done')
  })
  it('Apresentador com o recorte que falhou no meio: o erro do trabalho aparece no motivo', async () => {
    const doc = withCamera(baseProject(), 'presenter')
    const w = await world(doc, { transcript: talk, camera: makeCamera({ jobError: 'A placa de vídeo ficou sem memória.' }) })
    await w.service.start(id)
    const detail = detailOf(w.project())
    expect(detail).toContain('O recorte do fundo falhou; usei o quadro ao lado.')
    expect(detail).toContain('A placa de vídeo ficou sem memória.')
    expect([...layoutsOf(w.project()).vertical]).toEqual(['stack'])
  })
  it('as escolhas manuais de layout do usuário continuam preservadas nos dois estilos', async () => {
    for (const style of ['presenter', 'side-by-side'] as const) {
      const doc = withCamera(baseProject(), style)
      doc.layouts = [{ id: 'meu-layout', start: 1000, end: 4000, layout: 'screen', origin: 'manual' }]
      const w = await world(doc, { transcript: talk, camera: makeCamera({ matte: true }) })
      await w.service.start(id)
      expect(w.project().layouts.find((l) => l.id === 'meu-layout')).toMatchObject({ layout: 'screen', origin: 'manual' })
    }
  })
  it('a Revisão aceita escolher o Apresentador por item e pede o recorte do fundo ao serviço da câmera', async () => {
    const doc = withCamera(baseProject())
    addClip(doc)
    const w = await world(doc, { camera: makeCamera() })
    const handlers = createHandlers({ autopilot: w.service } as HandlerDeps)
    await handlers['review:update'](id, 'clip-1', { layout: 'presenter' }, false)
    expect(itemOf(w.project(), 'clip-1').layout).toBe('presenter')
    expect(w.camera!.analyze).toHaveBeenCalledWith(id, 'matte')
    w.camera!.analyze.mockClear()
    await handlers['review:update'](id, 'clip-1', { layout: 'stack' }, false)
    expect(w.camera!.analyze).not.toHaveBeenCalled()
  })
  it('a exportação do piloto espera a análise da câmera (rosto e recorte) terminar antes de começar', async () => {
    const doc = withCamera(baseProject())
    finishedPipeline(doc)
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const w = await world(doc, { camera: makeCamera({ hold }) })
    const exporting = w.service.reexport(id, 'youtube')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(w.start).not.toHaveBeenCalled()
    release()
    await exporting
    expect(w.start).toHaveBeenCalledOnce()
  })
})
