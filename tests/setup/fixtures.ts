/**
 * Gera os fixtures sob demanda antes dos testes (vitest e Playwright).
 * Se já existem, não faz nada; `npm run fixtures -- --force` refaz tudo.
 */
import { ensureFixtures } from '../../scripts/fixtures.mjs'

export default async function globalSetup(): Promise<void> {
  await ensureFixtures({ quiet: false })
}
