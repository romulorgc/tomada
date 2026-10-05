/**
 * globalSetup do Playwright: gera os fixtures (se faltarem) rodando o script como
 * processo à parte. O Playwright carrega .ts como CommonJS e não importa o .mjs.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT } from '../helpers/fs'

export default async function globalSetup(): Promise<void> {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'fixtures.mjs')], { cwd: ROOT, env, stdio: 'inherit' })
}
