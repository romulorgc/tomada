import { defineConfig } from '@playwright/test'

/**
 * Captura REAL (`npm run test:real`): grava uma janela e uma tela de verdade enquanto o
 * teste move o mouse e clica com `SendInput`. Fica fora do `test:e2e` porque mexe no mouse
 * desta máquina. Um app Electron por vez.
 */
export default defineConfig({
  testDir: 'tests/real',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/artifacts-real',
  globalSetup: './tests/setup/fixtures-e2e.ts'
})
