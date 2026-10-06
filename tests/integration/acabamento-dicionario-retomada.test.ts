import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMockProvider } from '../../src/main/llm/mock'
import { newPipeline } from '../../src/shared/autopilot'
import { createProject } from '../../src/shared/project'
import type { ExportProgress } from '../../src/shared/ipc'
import { pilotWorld } from '../helpers/autopilot-acabamento'

describe('grafia nova na retomada de projeto já exportado', () => {
  it('reexporta YouTube e o corte afetado antes da publicação, conservando o ajuste manual e o corte de outro trecho', async () => {
    const doc = createProject({ id: 'acabamento', title: 'Nome do usuário' })
    doc.sources.screen = { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: 108_000 }
    doc.autopilot = newPipeline('acabamento')
    doc.autopilot.steps = doc.autopilot.steps.filter((s) => s.id !== 'dictionary').map((s) => ({ ...s, status: ['publish','notify'].includes(s.id) ? 'pending' : 'done' }))
    doc.captions.enabled = true
    doc.clips = [
      { id: 'clip-1', title: 'Título manual', hook: 'Gancho do usuário', ranges: [{ start: 0, end: 3000 }], score: 80, reason: 'Manual', format: 'vertical', layoutV: 'auto', source: 'manual' },
      { id: 'clip-2', title: 'Outro trecho', hook: 'Outro gancho', ranges: [{ start: 9000, end: 11000 }], score: 80, reason: 'Manual', format: 'vertical', layoutV: 'auto', source: 'manual' }
    ]
    doc.review = { items: { youtube: { origin: 'manual', decision: 'approved', phase: 'ready', exportPath: 'exports/antigo-youtube.mp4', title: 'Título manual YouTube' }, 'clip-1': { origin: 'manual', decision: 'approved', phase: 'ready', exportPath: 'exports/antigo-corte.mp4', hook: 'Gancho manual preservado' }, 'clip-2': { origin: 'manual', decision: 'approved', phase: 'ready', exportPath: 'exports/outro-corte.mp4' } } }
    const order: string[] = []
    const provider = createMockProvider({ onAsk: (r) => order.push(r.task), recorded: [
      { task: 'dictionary', match: '', response: { corrections: [{ i: 1, before: 'sintoma.', term: 'Sintomax', context: 'product', confidence: .99 }] } },
      { task: 'publish', match: '', response: { titles: ['Sintomax pronto'], description: 'Demonstração.', tags: [], chapters: [], clips: [] } }
    ] })
    let state: ExportProgress | null = null
    let n = 0
    const w = await pilotWorld({ provider, initial: doc, vocabulary: ['Sintomax'], steps: ['dictionary','youtube','clipExports','publish','notify'], words: [
      { i: 0, text: 'No', start: 500, end: 1000, prob: .9, kind: 'word' }, { i: 1, text: 'sintoma.', start: 1100, end: 2000, prob: .9, kind: 'word' }
    ], exporter: (dir) => ({ idle: async () => {}, status: () => state, start: async (request) => {
      const exportId = `novo-${++n}`
      order.push(request.clipId ?? 'youtube')
      state = { exportId, projectId: 'acabamento', phase: 'done', fraction: 1, frame: 1, totalFrames: 1, renderFps: null, etaMs: 0, audioReady: true, outputPath: join(dir, 'exports', `${exportId}.mp4`) }
      return { exportId }
    } }) })
    w.prefs.mode = 'everything'
    await w.service.resume()
    await w.service.idle()
    const next = w.project()
    expect(order).toEqual(['dictionary','youtube','clip-1','publish'])
    expect(next.review?.items.youtube).toMatchObject({ origin: 'manual', decision: 'approved', title: 'Título manual YouTube', phase: 'ready', exportPath: 'exports/novo-1.mp4' })
    expect(next.review?.items['clip-1']).toMatchObject({ origin: 'manual', decision: 'approved', hook: 'Gancho manual preservado', phase: 'ready', exportPath: 'exports/novo-2.mp4' })
    expect(next.review?.items['clip-2']?.exportPath).toBe('exports/outro-corte.mp4')
  })

  it.each(['prepare', 'exports-off'] as const)('a grafia invalida os arquivos antigos sem exportar em %s, e o pedido explícito ainda exporta', async (setting) => {
    const doc = createProject({ id: 'acabamento', title: 'Nome do usuário', sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: 108_000 } } })
    doc.autopilot = newPipeline('acabamento')
    doc.autopilot.steps = doc.autopilot.steps.filter((s) => s.id !== 'dictionary').map((s) => ({ ...s, status: s.id === 'notify' ? 'pending' : 'done' }))
    doc.clips = [{ id: 'clip-1', title: 'Manual', hook: 'Gancho manual', ranges: [{ start: 0, end: 3000 }], score: 80, reason: 'Manual', format: 'vertical', layoutV: 'auto', source: 'manual' }]
    doc.review = { items: { youtube: { origin: 'manual', decision: 'approved', phase: 'ready', exportPath: 'exports/antigo-youtube.mp4', title: 'Título manual' }, 'clip-1': { origin: 'manual', decision: 'approved', phase: 'ready', exportPath: 'exports/antigo-corte.mp4', hook: 'Gancho manual' } } }
    const provider = createMockProvider({ recorded: [{ task: 'dictionary', match: '', response: { corrections: [{ i: 1, before: 'sintoma.', term: 'Sintomax', context: 'product', confidence: .99 }] } }] })
    const exported: string[] = []
    let state: ExportProgress | null = null
    const w = await pilotWorld({ provider, initial: doc, vocabulary: ['Sintomax'], steps: ['dictionary','youtube','clipExports','notify'], words: [
      { i: 0, text: 'No', start: 500, end: 1000, prob: .9, kind: 'word' }, { i: 1, text: 'sintoma.', start: 1100, end: 2000, prob: .9, kind: 'word' }
    ], exporter: (dir) => ({ idle: async () => {}, status: () => state, start: async (request) => {
      exported.push(request.clipId ?? 'youtube')
      const exportId = `novo-${exported.length}`
      state = { exportId, projectId: 'acabamento', phase: 'done', fraction: 1, frame: 1, totalFrames: 1, renderFps: null, etaMs: 0, audioReady: true, outputPath: join(dir, 'exports', `${exportId}.mp4`) }
      return { exportId }
    } }) })
    w.prefs.mode = setting === 'prepare' ? 'prepare' : 'everything'
    if (setting === 'exports-off') { w.prefs.steps.youtube = false; w.prefs.steps.clipExports = false }
    await w.service.resume(); await w.service.idle()
    expect(exported).toEqual([])
    expect(w.project().wordFixes?.['1']).toBe('Sintomax.')
    for (const item of Object.values(w.project().review!.items)) {
      expect(item.phase).toBeUndefined()
      expect(item.exportPath).toBeUndefined()
    }
    expect(w.project().review?.items.youtube?.title).toBe('Título manual')
    expect(w.project().review?.items['clip-1']?.hook).toBe('Gancho manual')
    await w.service.reexport('acabamento', 'youtube')
    await w.service.reexport('acabamento', 'clip-1')
    expect(exported).toEqual(['youtube', 'clip-1'])
    expect(w.project().review?.items.youtube?.phase).toBe('ready')
    expect(w.project().review?.items['clip-1']?.phase).toBe('ready')
  })

  it.each(['prepare', 'exports-off'] as const)('a retomada também respeita %s numa fila de exportação já gravada', async (setting) => {
    const doc = createProject({ id: 'acabamento', title: 'Retomada' })
    doc.autopilot = newPipeline('acabamento'); doc.autopilot.status = 'done'
    doc.review = { items: { youtube: { origin: 'manual', decision: 'approved', phase: 'queued', exportPath: 'exports/antigo.mp4' } } }
    const exported: string[] = []
    const w = await pilotWorld({ initial: doc, steps: ['youtube','clipExports'], exporter: () => ({ idle: async () => {}, status: () => null, start: async () => { exported.push('youtube'); throw new Error('Não deveria exportar') } }) })
    w.prefs.mode = setting === 'prepare' ? 'prepare' : 'everything'
    if (setting === 'exports-off') { w.prefs.steps.youtube = false; w.prefs.steps.clipExports = false }
    await w.service.resume(); await w.service.idle()
    expect(exported).toEqual([])
    expect(w.project().review?.items.youtube?.phase).toBeUndefined()
    expect(w.project().review?.items.youtube?.exportPath).toBeUndefined()
  })
})
