/**
 * Projeto sintético LONGO (3 min, 1080p30, com 30 cortes, cursor a 120 Hz e um clique a cada 4 s)
 * para medir a velocidade da exportação. Gerado sob demanda em `tests/fixtures/projeto-3min`
 * (fora do git); a mídia segue a receita da normalização (H.264, fps constante, GOP de 1 s).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProject, serializeProject } from '../../src/shared/project'
import { FIXTURES_DIR } from './fs'

export const LONG_FOLDER = '2026-10-05 1300 Projeto de 3 minutos'
export const LONG_MS = 180_000
export const LONG_CUT_COUNT = 30
export const LONG_CUT_MS = 500

const ffmpeg = (args: string[]): void => {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
}

/** Cria (uma vez) a pasta do projeto longo e devolve o caminho dela. */
export function ensureLongProject(): string {
  const dir = join(FIXTURES_DIR, 'projeto-3min')
  const marker = join(dir, '.ok')
  if (existsSync(marker)) return dir
  mkdirSync(join(dir, 'media'), { recursive: true })
  mkdirSync(join(dir, 'events'), { recursive: true })
  const d = LONG_MS / 1000

  ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=30:d=${d}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '27', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(dir, 'media', 'screen.mp4')
  ])
  ffmpeg(['-stream_loop', '-1', '-i', join(FIXTURES_DIR, 'voz.wav'), '-t', String(d), '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', join(dir, 'media', 'voice.wav')])
  ffmpeg([
    '-f', 'lavfi', '-i', `testsrc=s=640x360:r=30:d=${d}`,
    '-i', join(dir, 'media', 'voice.wav'),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-t', String(d), join(dir, 'media', 'camera.mp4')
  ])

  // cursor a 120 Hz (passeia pela tela), um clique a cada 4 s e rajadas de teclas
  const cursor: string[] = []
  for (let t = 0; t <= LONG_MS; t += 1000 / 120) {
    const x = 0.5 + 0.38 * Math.sin(t / 3100) * Math.cos(t / 7300)
    const y = 0.5 + 0.34 * Math.sin(t / 2300 + 1)
    cursor.push(JSON.stringify({ t: Math.round(t * 10) / 10, x: +x.toFixed(5), y: +y.toFixed(5) }))
  }
  writeFileSync(join(dir, 'events', 'cursor.jsonl'), `${cursor.join('\n')}\n`)
  const clicks: string[] = []
  for (let t = 3000; t < LONG_MS - 2000; t += 4000) {
    const x = 0.5 + 0.38 * Math.sin(t / 3100) * Math.cos(t / 7300)
    const y = 0.5 + 0.34 * Math.sin(t / 2300 + 1)
    clicks.push(JSON.stringify({ t, x: +x.toFixed(5), y: +y.toFixed(5), button: 'left', upT: t + 80 }))
  }
  writeFileSync(join(dir, 'events', 'clicks.jsonl'), `${clicks.join('\n')}\n`)
  const keys: string[] = []
  for (let t = 50_000; t < LONG_MS; t += 30_000) for (let k = 0; k < 8; k++) keys.push(JSON.stringify({ t: t + k * 140 }))
  writeFileSync(join(dir, 'events', 'keys.jsonl'), `${keys.join('\n')}\n`)

  const p = createProject({
    id: 'longo-0001',
    title: 'Projeto de 3 minutos',
    createdAt: '2026-10-05T16:00:00.000Z',
    sources: {
      screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: LONG_MS },
      camera: { path: 'media/camera.mp4', w: 640, h: 360, fps: 30, durationMs: LONG_MS },
      voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs: LONG_MS }
    },
    capture: { kind: 'screen', boundsPx: { x: 0, y: 0, w: 1920, h: 1080 }, scale: 1 }
  })
  p.cuts = Array.from({ length: LONG_CUT_COUNT }, (_, i) => {
    const start = 2500 + i * 5800
    return { id: `c${i}`, start, end: start + LONG_CUT_MS, reason: 'silence' as const, enabled: true }
  })
  writeFileSync(join(dir, 'project.json'), serializeProject(p))
  writeFileSync(marker, 'ok\n')
  return dir
}
