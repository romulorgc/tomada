import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    environment: 'node',
    // Os motores reais compartilham uma GPU; ffmpeg e rastreador também medem tempo real.
    // Um arquivo por vez evita disputar hardware e produzir falhas falsas por carga
    // (vale para os dois projetos abaixo: `extends: true` herda esta opção).
    fileParallelism: false,
    globalSetup: ['tests/setup/fixtures.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Medir a placa só depois dos ffmpegs/testes paralelos: a velocidade deve ser a do motor,
    // sem disputar CPU/disco com a própria bateria. Mantém todos os testes e limites existentes.
    projects: [
      { extends:true,test:{name:'gerais',include:['tests/unit/**/*.test.ts','tests/integration/**/*.test.ts'],exclude:[...configDefaults.exclude,'tests/integration/transcricao-motor.test.ts'],sequence:{groupOrder:0}} },
      { extends:true,test:{name:'motores',include:['tests/integration/transcricao-motor.test.ts'],fileParallelism:false,sequence:{groupOrder:1}} }
    ]
  }
})
