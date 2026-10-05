/**
 * Utilidades comuns dos testes: pasta temporária SEM acento, caminhos dos fixtures
 * e o ffmpeg do PATH.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { createFfmpeg, locateFfmpeg, type Ffmpeg } from '../../src/main/ffmpeg'

import { copyTree, FIXTURES_DIR } from './fs'

export { copyTree }

export const FIX = {
  dir: FIXTURES_DIR,
  voz: join(FIXTURES_DIR, 'voz.wav'),
  vozJson: join(FIXTURES_DIR, 'voz.json'),
  telaVfr: join(FIXTURES_DIR, 'tela-vfr.webm'),
  camera: join(FIXTURES_DIR, 'camera.webm'),
  flashBipe: join(FIXTURES_DIR, 'flash-bipe.mp4'),
  fakeCamera: join(FIXTURES_DIR, 'fake-camera.y4m'),
  exemplo: join(FIXTURES_DIR, 'projeto-exemplo')
}

/** Pasta temporária (em %TEMP%, que aqui não tem acento) removida ao fim do arquivo de teste. */
export function useTmpDir(prefix = 'tomada-t-'): () => string {
  const created: string[] = []
  afterAll(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return () => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    created.push(dir)
    return dir
  }
}

/** O ffmpeg do PATH. Os testes de mídia exigem: sem ele, falham com mensagem clara. */
export function requireFfmpeg(): Ffmpeg {
  const paths = locateFfmpeg()
  if (!paths) throw new Error('ffmpeg/ffprobe não encontrados no PATH: os testes de mídia precisam deles.')
  return createFfmpeg(paths)
}
