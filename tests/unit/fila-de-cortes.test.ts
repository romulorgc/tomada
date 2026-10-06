import { describe, expect, it } from 'vitest'
import { createClipQueue, queueSummary, type QueueDeps, type QueueItem } from '../../src/shared/clip-queue'
import type { ExportProgress } from '../../src/shared/ipc'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Script = 'ok' | 'fail' | 'hang' | 'throw' | 'ok-warning' | 'slow'

function harness(script: Record<string, Script>, over: Partial<QueueDeps> = {}) {
  const listeners = new Set<(p: ExportProgress) => void>()
  const calls: string[] = []
  const started: string[] = []
  const finished: QueueItem[][] = []
  let seq = 0
  let status: ExportProgress | null = null
  const progress = (e: string, clipId: string | undefined, phase: ExportProgress['phase'], extra: Partial<ExportProgress> = {}): ExportProgress => ({
    exportId: e,
    projectId: 'p1',
    ...(clipId ? { clipId } : {}),
    phase,
    fraction: 0,
    frame: 0,
    totalFrames: 100,
    renderFps: null,
    etaMs: null,
    audioReady: false,
    ...extra
  })
  const emit = (p: ExportProgress): void => {
    status = p
    for (const l of [...listeners]) l(p)
  }
  const cancelled = new Set<string>()
  const deps: QueueDeps = {
    projectId: 'p1',
    flush: async () => void calls.push('flush'),
    startExport: async (req) => {
      const clipId = req.clipId!
      calls.push(`start ${clipId}`)
      started.push(clipId)
      const mode = script[clipId] ?? 'ok'
      if (mode === 'throw') throw new Error('Já há uma exportação em andamento. Espere terminar ou cancele.')
      const id = `e${++seq}`
      emit(progress(id, clipId, 'preparing')) // o primeiro evento chega ANTES de a resposta voltar
      void (async () => {
        if (mode === 'hang') return
        await sleep(5)
        if (cancelled.has(id)) return
        emit(progress(id, clipId, 'rendering', { fraction: 0.5 }))
        await sleep(mode === 'slow' ? 60 : 5)
        if (cancelled.has(id)) {
          emit(progress(id, clipId, 'cancelled', { message: 'Exportação cancelada.' }))
          return
        }
        if (mode === 'fail') emit(progress(id, clipId, 'error', { message: `O encoder recusou o corte ${clipId}.` }))
        else emit(progress(id, clipId, 'done', { fraction: 1, outputPath: `C:\\x\\cortes\\${clipId}.mp4`, textPath: `C:\\x\\cortes\\${clipId}.txt`, ...(mode === 'ok-warning' ? { message: 'O vídeo foi exportado, mas o texto não.' } : {}) }))
      })()
      return { exportId: id }
    },
    cancelExport: async (id) => {
      calls.push(`cancel ${id}`)
      cancelled.add(id)
      const running = status
      if (running && running.exportId === id) {
        await sleep(2)
        emit(progress(id, running.clipId, 'cancelled', { message: 'Exportação cancelada.' }))
      }
    },
    onProgress: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    onFinished: (items) => finished.push([...items]),
    ...over
  }
  return { deps, calls, started, finished, emit, progress, listeners }
}

const entries = (...ids: string[]) => ids.map((id, k) => ({ clipId: id, title: `Corte ${id}`, number: k + 1 }))

describe('fila de exportação dos cortes', () => {
  it('exporta um por vez, na ordem, e cada item guarda o arquivo e o texto; confere save antes de cada corte', async () => {
    const h = harness({})
    const q = createClipQueue(h.deps)
    const seen: number[] = []
    q.subscribe((s) => seen.push(s.items.filter((i) => i.state === 'running').length))
    await q.getState().start(entries('a', 'b', 'c'))
    expect(h.calls).toEqual(['flush', 'flush', 'start a', 'flush', 'start b', 'flush', 'start c'])
    expect(Math.max(...seen)).toBe(1) // nunca dois ao mesmo tempo
    const s = q.getState()
    expect(s.running).toBe(false)
    expect(s.items.map((i) => [i.clipId, i.state, i.fraction, i.outputPath, i.textPath])).toEqual([
      ['a', 'done', 1, 'C:\\x\\cortes\\a.mp4', 'C:\\x\\cortes\\a.txt'],
      ['b', 'done', 1, 'C:\\x\\cortes\\b.mp4', 'C:\\x\\cortes\\b.txt'],
      ['c', 'done', 1, 'C:\\x\\cortes\\c.mp4', 'C:\\x\\cortes\\c.txt']
    ])
    expect(h.finished).toHaveLength(1)
    expect(queueSummary(s.items)).toEqual({ done: 3, failed: 0, cancelled: 0, total: 3 })
    expect(h.listeners.size).toBe(0) // soltou a assinatura
  })

  it('mostra o progresso do item que está rodando', async () => {
    const h = harness({ a: 'slow' })
    const q = createClipQueue(h.deps)
    const fractions: number[] = []
    q.subscribe((s) => {
      const a = s.items.find((i) => i.clipId === 'a')
      if (a?.state === 'running') fractions.push(a.fraction)
    })
    await q.getState().start(entries('a'))
    expect(Math.max(...fractions)).toBe(0.5)
  })

  it('um corte que falha NÃO para a fila: o motivo fica no item e o próximo é exportado', async () => {
    const h = harness({ b: 'fail' })
    const q = createClipQueue(h.deps)
    await q.getState().start(entries('a', 'b', 'c'))
    expect(h.started).toEqual(['a', 'b', 'c'])
    expect(q.getState().items.map((i) => [i.clipId, i.state, i.message])).toEqual([
      ['a', 'done', undefined],
      ['b', 'error', 'O encoder recusou o corte b.'],
      ['c', 'done', undefined]
    ])
    expect(queueSummary(q.getState().items)).toEqual({ done: 2, failed: 1, cancelled: 0, total: 3 })
  })

  it('"tentar de novo" exporta só os que falharam; os que já saíram ficam como estão', async () => {
    const script: Record<string, Script> = { b: 'fail' }
    const h = harness(script)
    const q = createClipQueue(h.deps)
    await q.getState().start(entries('a', 'b'))
    expect(q.getState().items[1]!.state).toBe('error')
    script.b = 'ok'
    h.started.length = 0
    await q.getState().retry()
    expect(h.started).toEqual(['b'])
    expect(q.getState().items.map((i) => i.state)).toEqual(['done', 'done'])
    expect(q.getState().items[1]!.message).toBeUndefined()
    await q.getState().retry() // nada a refazer
    expect(h.started).toEqual(['b'])
  })

  it('se o pedido de exportar é recusado (outra exportação em andamento), o item erra com o motivo e a fila segue', async () => {
    const h = harness({ a: 'throw' })
    const q = createClipQueue(h.deps)
    await q.getState().start(entries('a', 'b'))
    expect(q.getState().items.map((i) => i.state)).toEqual(['error', 'done'])
    expect(q.getState().items[0]!.message).toBe('Já há uma exportação em andamento. Espere terminar ou cancele.')
  })

  it('cancelar derruba o corte em andamento, tira os que esperam e mantém o que já saiu', async () => {
    const h = harness({ b: 'slow' })
    const q = createClipQueue(h.deps)
    const done = q.getState().start(entries('a', 'b', 'c'))
    for (let k = 0; k < 200 && q.getState().items[1]?.state !== 'running'; k++) await sleep(5)
    expect(q.getState().items.map((i) => i.state)).toEqual(['done', 'running', 'queued'])
    await q.getState().cancel()
    await done
    expect(q.getState().items.map((i) => i.state)).toEqual(['done', 'cancelled', 'cancelled'])
    expect(h.calls.filter((c) => c.startsWith('cancel'))).toHaveLength(1)
    expect(h.started).toEqual(['a', 'b']) // o terceiro nem começou
    expect(q.getState().items[2]!.message).toBe('Cancelado antes de começar.')
    expect(q.getState().running).toBe(false)
    // e dá para refazer o que não saiu
    h.started.length = 0
    await q.getState().retry()
    expect(h.started).toEqual(['b', 'c'])
    expect(q.getState().items.map((i) => i.state)).toEqual(['done', 'done', 'done'])
  })

  it('um evento que chega antes da resposta do pedido não se perde (o fim de um corte rápido)', async () => {
    const h = harness({})
    const racing: QueueDeps = {
      ...h.deps,
      startExport: async (req) => {
        const id = 'rapido'
        h.emit(h.progress(id, req.clipId, 'done', { fraction: 1, outputPath: 'C:\\x\\r.mp4' })) // acaba ANTES de responder
        return { exportId: id }
      }
    }
    const q = createClipQueue(racing)
    await q.getState().start(entries('a'))
    expect(q.getState().items[0]).toMatchObject({ state: 'done', outputPath: 'C:\\x\\r.mp4' })
  })

  it('se o evento final se perde, o estado do processo principal fecha a espera', async () => {
    const h = harness({})
    let last: ExportProgress | null = null
    const lost: QueueDeps = {
      ...h.deps,
      pollMs: 10,
      startExport: async (req) => {
        last = h.progress('perdido', req.clipId, 'done', { fraction: 1, outputPath: 'C:\\x\\p.mp4' }) // ninguém ouve
        return { exportId: 'perdido' }
      },
      pollStatus: async () => last
    }
    const q = createClipQueue(lost)
    await q.getState().start(entries('a'))
    expect(q.getState().items[0]).toMatchObject({ state: 'done', outputPath: 'C:\\x\\p.mp4' })
  })

  it('exportação que para de responder vira erro visível (não trava a fila)', async () => {
    const h = harness({ a: 'hang' })
    const q = createClipQueue({ ...h.deps, pollMs: 10, stallMs: 60, pollStatus: async () => null })
    await q.getState().start(entries('a', 'b'))
    expect(q.getState().items[0]).toMatchObject({ state: 'error', message: 'A exportação ficou 0 s sem responder.' })
    expect(q.getState().items[1]!.state).toBe('done')
  })

  it('não conseguir salvar o projeto antes: todos os itens erram com o motivo e nada é exportado', async () => {
    const h = harness({})
    const q = createClipQueue({ ...h.deps, flush: async () => { throw new Error('disco cheio') } })
    await q.getState().start(entries('a', 'b'))
    expect(h.started).toEqual([])
    expect(q.getState().items.map((i) => [i.state, i.message])).toEqual([
      ['error', 'Não consegui salvar o projeto; nada foi exportado. disco cheio'],
      ['error', 'Não consegui salvar o projeto; nada foi exportado. disco cheio']
    ])
  })

  it('o aviso de um corte que saiu mas cujo texto não foi gravado fica no item (que continua "pronto")', async () => {
    const h = harness({ a: 'ok-warning' })
    const q = createClipQueue(h.deps)
    await q.getState().start(entries('a'))
    expect(q.getState().items[0]).toMatchObject({ state: 'done', message: 'O vídeo foi exportado, mas o texto não.' })
  })

  it('só os eventos DESTA fila contam: outro projeto e a exportação do vídeo inteiro (sem corte) são ignorados', async () => {
    const h = harness({ a: 'slow' })
    const q = createClipQueue(h.deps)
    const done = q.getState().start(entries('a'))
    await sleep(10)
    h.emit({ ...h.progress('outro', 'a', 'error', { message: 'de outro projeto' }), projectId: 'p2' })
    h.emit(h.progress('inteiro', undefined, 'error', { message: 'do vídeo inteiro' }))
    await done
    expect(q.getState().items[0]).toMatchObject({ state: 'done' })
  })

  it('start e retry enquanto roda são ignorados; clear só esvazia quando nada roda', async () => {
    const h = harness({ a: 'slow' })
    const q = createClipQueue(h.deps)
    const first = q.getState().start(entries('a'))
    await q.getState().start(entries('x', 'y'))
    await q.getState().retry()
    q.getState().clear()
    expect(q.getState().items.map((i) => i.clipId)).toEqual(['a'])
    await first
    q.getState().clear()
    expect(q.getState().items).toEqual([])
    await q.getState().start([])
    expect(q.getState().items).toEqual([])
  })
})
