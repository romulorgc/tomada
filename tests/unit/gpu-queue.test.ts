import { expect, it } from 'vitest'
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
