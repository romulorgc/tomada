/**
 * A EXIGÊNCIA de velocidade dos motores de transcrição: mais rápido que o tempo real (`npm run medir:velocidade`).
 *
 * Ela morava em `tests/integration/transcricao-motor.test.ts`, mas a velocidade depende de a placa de vídeo estar livre: com outra
 * bateria disputando a GPU o mesmo motor media 0,52-0,97× e o teste caía sem que o motor tivesse mudado. Lá ficam a monotonia do
 * progresso e a origem dos números; aqui, a medição, que roda pela fila (`node scripts/fila-pesada.mjs npm run medir:velocidade`),
 * com a máquina para ela. Os pisos são os ORIGINAIS da M3 (não foram afrouxados): 1× na voz sintética de gabarito e 1,5× numa
 * gravação com voz.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFfmpeg, locateFfmpeg } from '../../src/main/ffmpeg'
import { createMemoryLogger } from '../../src/main/logger'
import { createFasterWhisper } from '../../src/main/transcription/faster-whisper'
import { ensureToolsDir, toolPaths } from '../../src/main/transcription/tools-dir'
import type { RunStats, Transcriber } from '../../src/main/transcription/types'
import { createWhisperCpp } from '../../src/main/transcription/whisper-cpp'
import { FIX } from '../helpers/env'
import { ROOT } from '../helpers/fs'

/** Os pisos da M3: o motor tem de transcrever mais rápido que o tempo real. */
export const MIN_SPEED_SYNTHETIC = 1
export const MIN_SPEED_RECORDING = 1.5

const tools = toolPaths(ensureToolsDir())
const logger = createMemoryLogger()
const engines: Record<string, Transcriber> = {
  'faster-whisper': createFasterWhisper({ tools, scriptPath: join(ROOT, 'resources', 'transcribe.py'), logger }),
  'whisper-cpp': createWhisperCpp({ tools, logger })
}

const OWNER_RECORDING = join(ROOT, 'gravacoes', '2026-07-26-13-57-59', 'camera.mp4')
const CAPTURED = join(ROOT, 'test-results', 'm4d-gravacao', 'youtube.mp4')
/** Gravação com voz: a do usuário nesta máquina (só mede; nunca se copia), a saída sintética capturada pelo app ou a câmera de fixture. */
const RECORDING = existsSync(OWNER_RECORDING) ? OWNER_RECORDING : existsSync(CAPTURED) ? CAPTURED : FIX.camera

for (const [id, engine] of Object.entries(engines)) {
  describe(`velocidade do motor ${id}`, () => {
    it(`transcreve a voz de gabarito (22,7 s) a mais de ${MIN_SPEED_SYNTHETIC}× o tempo real`, async () => {
      const check = await engine.check()
      expect(check.state, `${id} não está preparado (${check.detail ?? 'sem detalhe'}). Rode: npm run preparar:transcricao`).toBe('ready')
      let stats: RunStats | null = null
      await engine.transcribe(FIX.voz, { audioMs: 22_693, onStats: (s) => (stats = s) })
      const s = stats as RunStats | null
      console.log(`[velocidade] ${id} sintético: áudio ${s?.audioMs} ms, execução ${s?.wallMs} ms, speedX=${s?.speedX}`)
      expect(s?.speedX ?? 0, `${id} sintético a ${s?.speedX?.toFixed(2)}× o tempo real (a placa estava livre?)`).toBeGreaterThan(MIN_SPEED_SYNTHETIC)
    })

    it(`transcreve uma gravação com voz a mais de ${MIN_SPEED_RECORDING}× o tempo real`, async () => {
      const check = await engine.check()
      expect(check.state, `${id} não está preparado (${check.detail ?? 'sem detalhe'}). Rode: npm run preparar:transcricao`).toBe('ready')
      const ff = createFfmpeg(locateFfmpeg()!)
      mkdirSync(tools.tmp, { recursive: true })
      const wav = join(tools.tmp, `velocidade-${id}.wav`)
      try {
        await ff.run(['-y', '-i', RECORDING, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wav])
        const ms = (await ff.probe(wav)).durationMs
        let stats: RunStats | null = null
        await engine.transcribe(wav, { audioMs: ms, onStats: (s) => (stats = s) })
        const s = stats as RunStats | null
        console.log(`[velocidade] ${id} gravação: áudio ${s?.audioMs} ms, execução ${s?.wallMs} ms, speedX=${s?.speedX}`)
        expect(s?.speedX ?? 0, `${id} na gravação a ${s?.speedX?.toFixed(2)}× o tempo real (a placa estava livre?)`).toBeGreaterThan(MIN_SPEED_RECORDING)
      } finally {
        await rm(wav, { force: true, maxRetries: 10, retryDelay: 200 })
      }
    })
  })
}
