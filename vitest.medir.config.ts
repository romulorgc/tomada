import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Scripts de medição e de preparação que usam o mesmo código do app (`npm run medir:transcricao`).
 * Ficam fora do `npm test`: baixam gigabytes e usam a placa de vídeo.
 */
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    environment: 'node',
    include: ['tests/medir/**/*.run.ts'],
    testTimeout: 4 * 60 * 60 * 1000,
    hookTimeout: 120_000,
    fileParallelism: false
  }
})
