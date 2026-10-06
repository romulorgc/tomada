/**
 * Prepara a análise da câmera NESTE computador (pacotes do OpenCV e o detector de rosto), pelo mesmo código que a interface usa
 * (`npm run preparar:camera`). Mostra o progresso real; retomável. O `pip` mexe no venv COMPARTILHADO: rode pela fila
 * (`node scripts/fila-pesada.mjs npm run preparar:camera`).
 */
import { join } from 'node:path'
import { it } from 'vitest'
import { createPythonCamera } from '../../src/main/camera/python-engine'
import { createLogger } from '../../src/main/logger'
import { createPrepareTracker } from '../../src/main/transcription/prepare-tracker'
import { ensureToolsDir, toolPaths } from '../../src/main/transcription/tools-dir'
import { ROOT } from '../helpers/fs'

const logger = createLogger(join(ensureToolsDir(), 'logs'), { echo: true })

it('prepara a análise da câmera', async () => {
  const tools = toolPaths(ensureToolsDir())
  const engine = createPythonCamera({ tools, scriptPath: join(ROOT, 'resources', 'camera_tools.py'), logger })
  let last = ''
  const tracker = createPrepareTracker('camera', engine.prepareSteps, (snap) => {
    const line = `[camera] ${(snap.fraction * 100).toFixed(1)}% ${snap.steps.map((s) => `${s.id}:${s.status}`).join(' ')} ${snap.steps.find((s) => s.status === 'running')?.detail ?? ''}`
    if (line !== last) console.log(line)
    last = line
  })
  await engine.prepare(tracker, new AbortController().signal)
  tracker.finish()
  console.log('[camera] pronto', JSON.stringify(await engine.check()))
})
