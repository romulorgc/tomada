import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Testes com a IA DE VERDADE (`npm run test:ia`): chamam o programa de linha de comando da IA deste computador, que
 * consome a assinatura de quem roda. Ficam fora do `npm test` e usam só texto sintético (nada de gravação real).
 */
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    environment: 'node',
    include: ['tests/ia/**/*.ia.ts'],
    // o relatório do teste (títulos, durações e notas dos cortes) aparece mesmo com o teste verde
    reporters: ['verbose'],
    testTimeout: 6 * 60_000,
    hookTimeout: 60_000,
    fileParallelism: false
  }
})
