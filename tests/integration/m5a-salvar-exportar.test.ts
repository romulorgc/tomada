import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createEditorStore } from '../../src/shared/editor-store'
import { createClipQueue } from '../../src/shared/clip-queue'
import { createProject } from '../../src/shared/project'
import { useTmpDir } from '../helpers/env'

const tmp = useTmpDir('tomada-m5a-save-')
it('falha de save da proteção rejeita flush e impede qualquer arquivo na fila de cortes', async () => {
  const dir = tmp(); await mkdir(join(dir, 'exports'))
  const store = createEditorStore({ project: createProject({ title: 'Sintético' }), save: async () => { throw new Error('EPERM: disco bloqueado') } })
  store.getState().changeDoc(p => ({ ...p, blurRegions: [{ id: 'b', start: 0, end: 1000, rect: { x: .2, y: .2, w: .3, h: .3 }, mode: 'blur' }] }))
  let starts = 0
  const queue = createClipQueue({ projectId: 'teste', flush: () => store.getState().flush(), onProgress: () => () => undefined,
    startExport: async () => { starts++; await writeFile(join(dir, 'exports', 'vazou.mp4'), 'Simulação de saída sem proteção'); throw new Error('exportador foi iniciado') }, cancelExport: async () => undefined })
  try {
    await queue.getState().start([{ clipId: 'c', title: 'Corte', number: 1 }])
    expect(await readdir(join(dir, 'exports'))).toEqual([])
    expect(starts).toBe(0)
    expect(queue.getState().items[0]?.message).toContain('Não consegui salvar o projeto; nada foi exportado')
    await expect(store.getState().flush()).rejects.toThrow('EPERM')
  } finally { store.getState().dispose() }
})
