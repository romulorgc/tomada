import { describe, expect, it, vi } from 'vitest'
import { createGpuQueue } from '../../src/main/gpu-queue'
it('um pedido manual espera a transcrição terminar; falha libera a próxima tarefa',async () => {
  const queue = createGpuQueue(), calls:string[] = []
  let finish!: () => void
  const running = new Promise<void>((resolve) => {finish=resolve})
  const transcription = queue.start(async () => {calls.push('transcrever');return 't'},() => running)
  const exportation = queue.start(async () => {calls.push('exportar');throw new Error('falha de render')},async () => {})
  const next = queue.start(async () => {calls.push('exportar próximo');return 'e'},async () => {})
  const failedStart = expect(exportation.started).rejects.toThrow('falha de render')
  const failedDone = expect(exportation.done).rejects.toThrow('falha de render')
  expect(await transcription.started).toBe('t')
  expect(calls).toEqual(['transcrever'])
  finish();await transcription.done;await failedStart;await failedDone
  expect(await next.started).toBe('e');await next.done
  expect(calls).toEqual(['transcrever','exportar','exportar próximo'])
})

describe('a porta da placa (gate): o recorte de fundo dá lugar a exportação, transcrição e prévia', () => {
  it('livre sem nada na fila; ocupado enquanto há exportação ou transcrição, mesmo que falhe', async () => {
    const queue = createGpuQueue()
    expect(queue.gate.busy()).toBeNull()
    let finish!: () => void
    const running = new Promise<void>((resolve) => { finish = resolve })
    const exported = queue.start(async () => 'ok', () => running)
    expect(queue.gate.busy()).toBe('work')
    finish()
    await exported.done
    expect(queue.gate.busy()).toBeNull()

    const failing = queue.start(async () => { throw new Error('render caiu') }, async () => {})
    await expect(failing.done).rejects.toThrow('render caiu')
    await expect(failing.started).rejects.toThrow('render caiu')
    expect(queue.gate.busy()).toBeNull()
  })

  it('whenIdle espera a fila inteira esvaziar (várias tarefas) e resolve de uma vez', async () => {
    const queue = createGpuQueue()
    let finishA!: () => void
    let finishB!: () => void
    const a = queue.start(async () => 1, () => new Promise<void>((r) => { finishA = r }))
    const b = queue.start(async () => 2, () => new Promise<void>((r) => { finishB = r }))
    let freed = false
    void queue.gate.whenIdle(new AbortController().signal).then(() => { freed = true })
    await a.started
    finishA()
    await a.done
    await Promise.resolve()
    expect(freed).toBe(false) // a segunda ainda está na fila
    await b.started
    finishB()
    await b.done
    await new Promise((r) => setTimeout(r, 0))
    expect(freed).toBe(true)
  })

  it('whenIdle já resolve se a placa está livre, e rejeita se quem espera for cancelado', async () => {
    const queue = createGpuQueue()
    await expect(queue.gate.whenIdle(new AbortController().signal)).resolves.toBeUndefined()
    let finish!: () => void
    queue.start(async () => 1, () => new Promise<void>((r) => { finish = r }))
    const ctl = new AbortController()
    const waiting = queue.gate.whenIdle(ctl.signal)
    ctl.abort()
    await expect(waiting).rejects.toThrow(/Cancelado/)
    finish()
  })

  it('onBusy avisa na virada de livre para ocupado (uma vez), não a cada tarefa; e some quando cancelado', async () => {
    const queue = createGpuQueue()
    const heard = vi.fn()
    const off = queue.gate.onBusy(heard)
    let finish!: () => void
    const first = queue.start(async () => 1, () => new Promise<void>((r) => { finish = r }))
    const second = queue.start(async () => 2, async () => {})
    expect(heard).toHaveBeenCalledTimes(1)
    await first.started
    finish()
    await first.done
    await second.done
    await new Promise((r) => setTimeout(r, 0))
    queue.start(async () => 3, async () => {})
    expect(heard).toHaveBeenCalledTimes(2)
    off()
    await new Promise((r) => setTimeout(r, 0))
    queue.start(async () => 4, async () => {})
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('a prévia tocando ocupa a placa; depois de parar, só libera passado o silêncio (pausar e tocar de novo não derruba o recorte)', () => {
    vi.useFakeTimers()
    try {
      let clock = 1_000_000
      const queue = createGpuQueue({ previewQuietMs: 2500, previewTtlMs: 15_000, now: () => clock })
      const heard = vi.fn()
      queue.gate.onBusy(heard)
      expect(queue.gate.busy()).toBeNull()
      queue.setPreviewActive(true)
      expect(queue.gate.busy()).toBe('preview')
      expect(heard).toHaveBeenCalledTimes(1)
      clock += 5000
      queue.setPreviewActive(true) // o editor repete o aviso enquanto toca: não avisa de novo
      expect(heard).toHaveBeenCalledTimes(1)
      queue.setPreviewActive(false)
      clock += 1000
      expect(queue.gate.busy()).toBe('preview') // pausou há 1 s
      queue.setPreviewActive(true) // tocou de novo
      queue.setPreviewActive(false)
      clock += 2600
      expect(queue.gate.busy()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('se o editor some sem avisar que parou, a prévia deixa de contar sozinha (TTL)', () => {
    let clock = 5_000
    const queue = createGpuQueue({ previewQuietMs: 2500, previewTtlMs: 15_000, now: () => clock })
    queue.setPreviewActive(true)
    clock += 14_000
    expect(queue.gate.busy()).toBe('preview')
    clock += 2_000
    expect(queue.gate.busy()).toBeNull()
  })

  it('whenIdle com a prévia: resolve quando o silêncio passa', async () => {
    vi.useFakeTimers()
    try {
      let clock = 1000
      const queue = createGpuQueue({ previewQuietMs: 2500, previewTtlMs: 15_000, now: () => clock })
      queue.setPreviewActive(true)
      queue.setPreviewActive(false)
      let freed = false
      void queue.gate.whenIdle(new AbortController().signal).then(() => { freed = true })
      await vi.advanceTimersByTimeAsync(2000)
      expect(freed).toBe(false)
      clock += 2600
      await vi.advanceTimersByTimeAsync(700)
      expect(freed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
