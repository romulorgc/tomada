import { defineConfig } from '@playwright/test'

// Fora da bateria comum: a medição física precisa de silêncio ambiente por 3 × 10 s.
export default defineConfig({
  testDir: '.',
  testMatch: 'audio-prova.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '../../test-results/audio/artifacts'
})
