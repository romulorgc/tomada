/**
 * Exportação com a câmera em 4K (a que a qualidade "Máxima" grava) × a mesma câmera em 1080p, no código do app: 1 min de tela
 * (o exemplo dos fixtures repetido) com a câmera em bolha, exportado em 1080p a 30 qps. Mede o tempo da exportação (qps) e o pico de
 * memória dos processos do app durante ela. A câmera 4K é o `media/camera.mp4` que `tests/medir/camera-4k.run.ts` deixa em
 * `C:\tmp\tomada-camera-medicao\pipeline-4k\` (rosto do usuário: só nesta máquina). A janela principal é escondida logo na abertura.
 *   node scripts/fila-pesada.mjs npx vitest run -c vitest.medir.config.ts tests/medir/camera-4k-exportacao.run.ts
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProject, serializeProject } from '../../src/shared/project'
import { exportProject } from '../e2e/export-helpers'
import { launchTomada } from '../e2e/helpers'
import { FIXTURES_DIR } from '../helpers/fs'

const BASE = 'C:\\tmp\\tomada-camera-medicao'
const CAMERA_4K = join(BASE, 'pipeline-4k', 'media', 'camera.mp4')
const ff = (args: string[]): void => void execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 64 << 20 })

it('exporta 1 min com a câmera em 4K e em 1080p e mede tempo e memória', async () => {
  expect(existsSync(CAMERA_4K), 'rode antes tests/medir/camera-4k.run.ts (ele deixa a câmera 4K normalizada)').toBe(true)
  const session = await launchTomada({ seed: false })
  const report: Record<string, unknown> = {}
  try {
    // some a janela principal já (nada pisca nem rouba o foco)
    await session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()))
    const durationMs = 60_000
    for (const variant of ['4k', '1080p'] as const) {
      const folder = `2026-10-06 1200 Camera ${variant}`
      const dir = join(session.projects, folder)
      mkdirSync(join(dir, 'media'), { recursive: true })
      ff(['-stream_loop', '3', '-i', join(FIXTURES_DIR, 'projeto-exemplo', 'media', 'screen.mp4'), '-t', '60', '-an', '-c:v', 'copy', join(dir, 'media', 'screen.mp4')])
      ff(['-stream_loop', '3', '-i', join(FIXTURES_DIR, 'projeto-exemplo', 'media', 'voice.wav'), '-t', '60', '-c:a', 'pcm_s16le', join(dir, 'media', 'voice.wav')])
      if (variant === '4k') copyFileSync(CAMERA_4K, join(dir, 'media', 'camera.mp4'))
      else ff(['-i', CAMERA_4K, '-vf', 'scale=1920:1080:flags=lanczos', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-g', '30', '-pix_fmt', 'yuv420p', join(dir, 'media', 'camera.mp4')])
      const size = variant === '4k' ? { w: 3840, h: 2160 } : { w: 1920, h: 1080 }
      const project = createProject({
        id: `camera-${variant}`,
        title: `Câmera ${variant}`,
        createdAt: '2026-10-06T15:00:00.000Z',
        sources: {
          screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs },
          camera: { path: 'media/camera.mp4', ...size, fps: 30, durationMs },
          voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs }
        },
        capture: { kind: 'screen', boundsPx: { x: 0, y: 0, w: 1920, h: 1080 }, scale: 1 }
      })
      project.style.defaultLayout = 'bubble'
      project.zoomPreset = 'off'
      writeFileSync(join(dir, 'project.json'), serializeProject(project))

      let peakMB = 0
      let sampling = true
      const sampler = (async () => {
        while (sampling) {
          const mb = await session.app.evaluate(({ app }) => app.getAppMetrics().reduce((a, p) => a + p.memory.workingSetSize, 0) / 1024).catch(() => 0)
          peakMB = Math.max(peakMB, mb)
          await new Promise((r) => setTimeout(r, 1000))
        }
      })()
      const t0 = performance.now()
      const result = await exportProject(session.page, folder, { resolution: '1080p', fps: 30 })
      const seconds = (performance.now() - t0) / 1000
      sampling = false
      await sampler
      expect(result.phase, result.message).toBe('done')
      report[variant] = { segundos: +seconds.toFixed(1), qps: +((durationMs / 1000) * 30 / seconds).toFixed(1), vezesTempoReal: +(60 / seconds).toFixed(2), picoMemoriaAppMB: Math.round(peakMB), saidaMB: +(statSync(result.outputPath!).size / 1e6).toFixed(1) }
      console.log(`[exportação câmera ${variant}] ${JSON.stringify(report[variant])}`)
    }
  } finally {
    await session.close()
  }
  writeFileSync(join(BASE, 'camera-4k-exportacao.json'), JSON.stringify(report, null, 2))
}, 1_800_000)
