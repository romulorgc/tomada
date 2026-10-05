/**
 * Utilidades de arquivo para testes, sem importar o script ESM de fixtures
 * (o Playwright carrega os .ts como CommonJS e não consegue importar .mjs).
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const ROOT = resolve(__dirname, '..', '..')
export const FIXTURES_DIR = join(ROOT, 'tests', 'fixtures')

/**
 * Copia uma pasta inteira. Não usa fs.cpSync: com caminho acentuado ("José")
 * ele falha com EIO no Windows.
 */
export function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dst)
    else copyFileSync(src, dst)
  }
}
