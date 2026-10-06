import { defineConfig } from '@playwright/test'

// Antes de criar qualquer processo Electron. As configurações real/prova não importam esta.
process.env.TOMADA_E2E_HIDDEN ??= '1'

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  // Um app Electron por vez: cada teste abre o seu, com pasta de dados própria.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  // Fora de test-results/ raiz: o Playwright limpa esta pasta a cada rodada e
  // as capturas de tela (test-results/screens) precisam sobreviver a isso.
  outputDir: 'test-results/artifacts',
  globalSetup: './tests/setup/fixtures-e2e.ts'
})
