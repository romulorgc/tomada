/**
 * Prepara os motores de transcrição NESTE computador, pelo mesmo código que a interface usa
 * (`npm run preparar:transcricao`). Mostra o progresso real; retomável.
 *   ENGINE=faster-whisper | whisper-cpp | todos   (padrão: todos)
 */
import { join } from 'node:path'
import { it } from 'vitest'
import { createFasterWhisper } from '../../src/main/transcription/faster-whisper'
import { createPrepareTracker } from '../../src/main/transcription/prepare-tracker'
import { ensureToolsDir, toolPaths } from '../../src/main/transcription/tools-dir'
import type { Transcriber } from '../../src/main/transcription/types'
import { createLogger } from '../../src/main/logger'
import { ROOT } from '../helpers/fs'

const logger = createLogger(join(ensureToolsDir(), 'logs'), { echo: true })

async function prepare(engine: Transcriber, ids: ('python' | 'packages' | 'binary' | 'model' | 'check')[]): Promise<void> {
  let last = ''
  const tracker = createPrepareTracker(
    engine.id,
    ids.map((id) => ({ id, weight: 1 })),
    (snap) => {
      const line = `[${engine.id}] ${(snap.fraction * 100).toFixed(1)}% ${snap.steps.map((s) => `${s.id}:${s.status}`).join(' ')} ${snap.steps.find((s) => s.status === 'running')?.detail ?? ''}`
      if (line !== last && Math.random() < 0.15) console.log(line)
      last = line
    }
  )
  const ctl = new AbortController()
  await engine.prepare(tracker, ctl.signal)
  console.log(`[${engine.id}] pronto`, JSON.stringify(await engine.check()))
}

it('prepara os motores', async () => {
  const tools = toolPaths(ensureToolsDir())
  const which = process.env.ENGINE ?? 'todos'
  if (which === 'faster-whisper' || which === 'todos') {
    await prepare(createFasterWhisper({ tools, scriptPath: join(ROOT, 'resources', 'transcribe.py'), logger }), ['python', 'packages', 'model', 'check'])
  }
  if (which === 'whisper-cpp' || which === 'todos') {
    const { createWhisperCpp } = await import('../../src/main/transcription/whisper-cpp')
    await prepare(createWhisperCpp({ tools, logger }), ['binary', 'model', 'check'])
  }
})
