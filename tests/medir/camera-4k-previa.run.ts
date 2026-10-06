/**
 * Prévia do editor tocando com a câmera em 4K × a mesma câmera em 1080p (tela de 1080p + câmera em bolha): mede quantos quadros a
 * prévia desenha por segundo (`requestAnimationFrame`) e quantos quadros o `<video>` da câmera deixou cair (`getVideoPlaybackQuality`)
 * em 10 s tocando. A janela principal fica ESCONDIDA (nada pisca); o decodificador e o desenho seguem como com a janela à vista
 * (`backgroundThrottling: false`). Usa o `media/camera.mp4` 4K de `tests/medir/camera-4k.run.ts` (rosto do usuário: só nesta máquina).
 *   node scripts/fila-pesada.mjs npx vitest run -c vitest.medir.config.ts tests/medir/camera-4k-previa.run.ts
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProject, serializeProject } from '../../src/shared/project'
import { openEditor } from '../e2e/editor-helpers'
import { launchTomada } from '../e2e/helpers'
import { FIXTURES_DIR } from '../helpers/fs'

const BASE = 'C:\\tmp\\tomada-camera-medicao'
const CAMERA_4K = join(BASE, 'pipeline-4k', 'media', 'camera.mp4')
const ff = (args: string[]): void => void execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 64 << 20 })

it('toca a prévia do editor com a câmera em 4K e em 1080p e mede os quadros desenhados e os que caíram', async () => {
  expect(existsSync(CAMERA_4K), 'rode antes tests/medir/camera-4k.run.ts').toBe(true)
  const report: Record<string, unknown> = {}
  for (const variant of ['4k', '1080p'] as const) {
    const session = await launchTomada({ seed: false })
    try {
      await session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()))
      const dir = join(session.projects, `2026-10-06 1200 Camera ${variant}`)
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
          screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: 60_000 },
          camera: { path: 'media/camera.mp4', ...size, fps: 30, durationMs: 60_000 },
          voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs: 60_000 }
        },
        capture: { kind: 'screen', boundsPx: { x: 0, y: 0, w: 1920, h: 1080 }, scale: 1 }
      })
      project.style.defaultLayout = 'bubble'
      project.zoomPreset = 'off'
      writeFileSync(join(dir, 'project.json'), serializeProject(project))
      await session.page.reload()
      await openEditor(session)
      await session.page.getByTestId('play-toggle').click()
      await new Promise((r) => setTimeout(r, 1500)) // arranque do decodificador
      const measured = await session.page.evaluate(async () => {
        const cameraVideo = document.querySelector<HTMLVideoElement>('[data-testid="video-camera"]')
        const screenVideo = document.querySelector<HTMLVideoElement>('[data-testid="video-screen"]')
        const quality = (v: HTMLVideoElement | null) => v?.getVideoPlaybackQuality?.() ?? null
        const before = { camera: quality(cameraVideo), screen: quality(screenVideo) }
        let frames = 0
        let longest = 0
        let last = performance.now()
        const t0 = last
        await new Promise<void>((resolve) => {
          const tick = (now: number): void => {
            frames++
            longest = Math.max(longest, now - last)
            last = now
            if (now - t0 < 10_000) requestAnimationFrame(tick)
            else resolve()
          }
          requestAnimationFrame(tick)
        })
        const after = { camera: quality(cameraVideo), screen: quality(screenVideo) }
        const diff = (a: VideoPlaybackQuality | null, b: VideoPlaybackQuality | null) => (a && b ? { total: b.totalVideoFrames - a.totalVideoFrames, dropped: b.droppedVideoFrames - a.droppedVideoFrames } : null)
        return { rafFps: +((frames * 1000) / (last - t0)).toFixed(1), rafMaiorIntervaloMs: +longest.toFixed(1), camera: diff(before.camera, after.camera), tela: diff(before.screen, after.screen), cameraTocando: cameraVideo ? !cameraVideo.paused : null }
      })
      report[variant] = measured
      console.log(`[prévia câmera ${variant}] ${JSON.stringify(measured)}`)
    } finally {
      await session.close()
    }
  }
  writeFileSync(join(BASE, 'camera-4k-previa.json'), JSON.stringify(report, null, 2))
}, 1_800_000)
