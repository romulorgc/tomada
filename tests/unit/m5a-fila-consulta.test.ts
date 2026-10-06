import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import { hasTestRunner } from '../../scripts/fila-processos.mjs'

it('fila registra a causa uma vez e libera o comando após consultas persistentemente falhas', async () => {
  // Executa o wrapper real com SO controlado: nenhuma trava/processo real é criado.
  const source = (await readFile('scripts/fila-pesada.mjs', 'utf8')).replace(/^import .*\r?\n/gm, '')
  let queries = 0, sleeps = 0, spawned = 0, locked = false
  const warnings: string[] = []
  const fs = { mkdirSync: (p: string) => { if (p.endsWith('.lock')) { if (locked) throw new Error('ocupado'); locked = true } }, writeFileSync: () => undefined,
    rmSync: () => { locked = false }, readFileSync: () => '123\n' }
  const process = { argv: ['node', 'fila-pesada.mjs', 'npm', 'run', 'test:e2e'], pid: 123, cwd: () => 'C:\\tmp\\teste', kill: () => undefined, on: () => undefined, exit: () => undefined }
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)('spawn', 'execFileSync', 'fs', 'path', 'hasTestRunner', 'process', 'console', 'setTimeout', source)
  await execute(() => { spawned++; return { on: (_name: string, cb: (n: number) => void) => cb(0) } }, () => { queries++; throw new Error('CIM indisponível') }, fs, path.win32, hasTestRunner, process,
    { log: () => undefined, error: (v: string) => warnings.push(v), warn: (v: string) => warnings.push(v) }, (cb: () => void) => { if (++sleeps > 12) throw new Error('a fila continua presa'); cb() }).catch(() => undefined)
  expect(spawned).toBe(1)
  expect(queries).toBe(8)
  expect(warnings.filter(w => w.includes('CIM indisponível'))).toHaveLength(1)
  expect(warnings.some(w => /seguindo|prosseguindo/.test(w))).toBe(true)
})
