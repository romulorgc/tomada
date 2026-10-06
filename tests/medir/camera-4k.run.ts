/**
 * Quanto custa processar 1 min de câmera em 4K (o arquivo que a qualidade "Máxima" grava), com o código do app:
 * medida no bruto, normalização (NVENC), voz, miniatura, leitura do SyncNet (decodifica 6 s e reduz a 640×360),
 * análise do rosto (YuNet) e recorte do fundo (RVM na placa), cada uma com tempo e pico de memória do processo filho.
 * Entrada: o bruto 4K gravado por `scripts/medir-camera-fidelidade.mjs --long 60` (caminho em CAMERA_4K_RAW; rosto do usuário:
 * fica só em C:\tmp\tomada-camera-medicao\, nunca em tests/). Saída: `C:\tmp\tomada-camera-medicao\camera-4k-processamento.json`.
 *   node scripts/fila-pesada.mjs npx vitest run -c vitest.medir.config.ts tests/medir/camera-4k.run.ts
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createPythonCamera } from '../../src/main/camera/python-engine'
import { measureVideoFps } from '../../src/main/camera-fps'
import { createFfmpeg, locateFfmpeg } from '../../src/main/ffmpeg'
import { createMemoryLogger } from '../../src/main/logger'
import { extractAudio, makeThumbnail, normalizeVideo } from '../../src/main/normalize'
import { ensureToolsDir, toolPaths } from '../../src/main/transcription/tools-dir'
import { ROOT } from '../helpers/fs'

const BASE = 'C:\\tmp\\tomada-camera-medicao'

function findRaw(): string {
  if (process.env.CAMERA_4K_RAW) return process.env.CAMERA_4K_RAW
  const runs = readdirSync(BASE).filter((n) => n.endsWith('-fidelidade')).sort().reverse()
  for (const run of runs) {
    const file = join(BASE, run, 'gravacoes', 'longa-tela', 'camera.webm')
    if (existsSync(file)) return file
  }
  throw new Error('Sem bruto 4K de 1 min: rode `node scripts/fila-pesada.mjs node scripts/medir-camera-fidelidade.mjs --long 60` ou defina CAMERA_4K_RAW.')
}

/** Memória (MB) dos processos com este nome agora (tasklist: rápido e sem PowerShell). */
function memoryMB(image: string): number {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    return out
      .split(/\r?\n/)
      .map((l) => l.split('","').pop() ?? '')
      .map((cell) => Number(cell.replace(/[^\d]/g, '')) / 1024)
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => a + b, 0)
  } catch {
    return 0
  }
}

/** Roda `fn` amostrando o pico de memória de ffmpeg e python a cada segundo. */
async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; seconds: number; peakFfmpegMB: number; peakPythonMB: number }> {
  let peakFfmpegMB = 0
  let peakPythonMB = 0
  let running = true
  const sampler = (async () => {
    while (running) {
      peakFfmpegMB = Math.max(peakFfmpegMB, memoryMB('ffmpeg.exe'))
      peakPythonMB = Math.max(peakPythonMB, memoryMB('python.exe'))
      await new Promise((r) => setTimeout(r, 1000))
    }
  })()
  const t0 = performance.now()
  try {
    const result = await fn()
    return { result, seconds: (performance.now() - t0) / 1000, peakFfmpegMB: Math.round(peakFfmpegMB), peakPythonMB: Math.round(peakPythonMB) }
  } finally {
    running = false
    await sampler
  }
}

it('processa 1 min de câmera 4K sem estourar tempo nem memória', async () => {
  const raw = findRaw()
  const work = join(BASE, 'pipeline-4k')
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  mkdirSync(join(work, 'raw'), { recursive: true })
  mkdirSync(join(work, 'media'), { recursive: true })
  copyFileSync(raw, join(work, 'raw', 'camera.webm'))
  const ff = createFfmpeg(locateFfmpeg()!)
  const rawPath = join(work, 'raw', 'camera.webm')
  const report: Record<string, unknown> = { entrada: { arquivo: 'camera.webm', MB: +(statSync(rawPath).size / 1e6).toFixed(1) } }

  const measured = await timed(() => measureVideoFps(ff, rawPath))
  report.medirQuadrosNoBruto = { segundos: +measured.seconds.toFixed(2), fps: measured.result?.fps, resolucao: `${measured.result?.width}x${measured.result?.height}`, quadros: measured.result?.frames }
  const durationMs = Math.round(measured.result!.spanMs)

  const norm = await timed(() => normalizeVideo(ff, { input: rawPath, output: join(work, 'media', 'camera.mp4'), fps: 30, durationMs }))
  report.normalizar = { segundos: +norm.seconds.toFixed(1), vezesTempoReal: +(durationMs / 1000 / norm.seconds).toFixed(2), encoder: norm.result.encoder, resolucao: `${norm.result.probe.video?.width}x${norm.result.probe.video?.height}`, MB: +(statSync(join(work, 'media', 'camera.mp4')).size / 1e6).toFixed(1), picoFfmpegMB: norm.peakFfmpegMB }

  const voice = await timed(() => extractAudio(ff, { input: rawPath, output: join(work, 'media', 'voice.wav'), channels: 1, sampleRate: 48_000 }))
  report.voz = { segundos: +voice.seconds.toFixed(2) }
  const thumb = await timed(() => makeThumbnail(ff, { input: join(work, 'media', 'camera.mp4'), output: join(work, 'media', 'thumb.jpg'), atMs: 3000, width: 640 }))
  report.miniatura = { segundos: +thumb.seconds.toFixed(2) }

  // O SyncNet decodifica uma janela de 6 s e a reduz a 640×360 (resources/lip_sync.py, video_frames)
  const syncRead = await timed(async () => {
    execFileSync(ff.paths.ffmpeg, ['-v', 'error', '-ss', '20', '-i', join(work, 'media', 'camera.mp4'), '-t', '6', '-an', '-vf', 'fps=25:start_time=0,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2', '-pix_fmt', 'bgr24', '-f', 'rawvideo', '-y', join(work, 'sync.raw')], { stdio: 'pipe' })
  })
  report.leituraDoSyncNetPor6s = { segundos: +syncRead.seconds.toFixed(2), picoFfmpegMB: syncRead.peakFfmpegMB }

  const engine = createPythonCamera({ tools: toolPaths(ensureToolsDir()), scriptPath: join(ROOT, 'resources', 'camera_tools.py'), logger: createMemoryLogger(), ffmpeg: () => locateFfmpeg()?.ffmpeg ?? null })
  const check = await engine.check()
  expect(check.face.state, 'o motor do rosto precisa estar preparado: node scripts/fila-pesada.mjs npm run preparar:camera').toBe('ready')
  const faces = await timed(() => engine.detectFaces({ video: join(work, 'media', 'camera.mp4'), durationMs }))
  report.rosto = { segundos: +faces.seconds.toFixed(1), caixas: faces.result.boxes.length, quadro: faces.result.frame, picoPythonMB: faces.peakPythonMB }

  if (check.matte.state === 'ready') {
    const matte = await timed(() => engine.makeMatte({ video: join(work, 'media', 'camera.mp4'), out: join(work, 'media', 'camera-matte.mp4'), durationMs }))
    report.recorteDoFundo = { segundos: +matte.seconds.toFixed(1), dispositivo: matte.result.device, msPorQuadro: +matte.result.msPerFrame.toFixed(1), quadros: matte.result.frames, picoPythonMB: matte.peakPythonMB, picoFfmpegMB: matte.peakFfmpegMB }
  }

  report.recuperacao = { medirDuracaoDoBrutoSegundos: +measured.seconds.toFixed(2), observacao: 'a recuperação mede o bruto com `-c copy` (só demux), o mesmo passo medido acima' }
  writeFileSync(join(BASE, 'camera-4k-processamento.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  expect(norm.result.probe.video?.width).toBeGreaterThanOrEqual(1920)
}, 3_600_000)
