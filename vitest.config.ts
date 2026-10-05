import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    environment: 'node',
    // Os motores reais compartilham uma GPU; ffmpeg e rastreador também medem tempo real.
    // Um arquivo por vez evita disputar hardware e produzir falhas falsas por carga.
    fileParallelism: false,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    globalSetup: ['tests/setup/fixtures.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
