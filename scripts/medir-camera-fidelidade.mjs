#!/usr/bin/env node
/**
 * Fidelidade do codificador da câmera, SEM a luz do quarto no meio: copia alguns segundos do MJPEG que a câmera
 * REAL manda (ffmpeg dshow, `-c copy`: os mesmos bytes), entrega esse arquivo ao Chromium como câmera falsa
 * (`--use-file-for-fake-video-capture`) e grava pelo mesmo caminho do app (MediaRecorder, mesmo bitrate). Depois acha, para
 * cada quadro gravado, o quadro de origem IGUAL e compara os dois: PSNR, SSIM e nitidez (variância do Laplaciano do recorte
 * central), no tamanho nativo. Assim "nitidez ≥ 90% da captura direta" é medido em quadros idênticos, não em duas gravações
 * com ruído de sensor e exposição diferentes.
 *
 *   node scripts/fila-pesada.mjs node scripts/medir-camera-fidelidade.mjs [--size 3840x2160] [--seconds 3] [--bps 45000000,16000000]
 *
 * Os arquivos ficam em C:\tmp\tomada-camera-medicao\ (rosto do usuário: só nesta máquina; docs/LIXO.md).
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { laplacianVariance, probeFile } from './medir-camera/analise.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const size = opt('size', '3840x2160')
const [W, H] = size.split('x').map(Number)
const seconds = Number(opt('seconds', 3))
const bitrates = opt('bps', '45000000').split(',').map(Number)
// --long 60: grava também 60 s no tamanho cheio com a tela junto (entrada das medições de processamento 4K)
const longSeconds = Number(opt('long', 0))
const cameraName = opt('camera', 'EMEET')
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const out = path.resolve(opt('out', `C:\\tmp\\tomada-camera-medicao\\${stamp}-fidelidade`))
fs.mkdirSync(out, { recursive: true })
const ffmpeg = process.env.FFMPEG || 'ffmpeg'

// 1. o MJPEG da câmera, byte a byte
const dshow = String(spawnSync(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8' }).stderr ?? '')
const dshowName = [...dshow.matchAll(/"([^"]+)" \(video\)/g)].map((m) => m[1]).find((n) => n.toLowerCase().includes(cameraName.toLowerCase()))
if (!dshowName) throw new Error(`câmera "${cameraName}" não achada no dshow`)
const clip = path.join(out, 'origem.mjpeg')
const cap = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'dshow', '-video_size', size, '-framerate', '30', '-vcodec', 'mjpeg', '-i', `video=${dshowName}`, '-t', String(seconds), '-c:v', 'copy', '-f', 'mjpeg', clip], { encoding: 'utf8' })
if (cap.status !== 0 || !fs.existsSync(clip)) throw new Error(`a cópia do MJPEG falhou: ${cap.stderr}`)
const clipFrames = Number(spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', clip], { encoding: 'utf8' }).stdout.trim())
console.log(`origem: ${clipFrames} quadros MJPEG ${size} (${(fs.statSync(clip).size / 1e6).toFixed(1)} MB)`)

// 2. grava pelo caminho do app com a câmera falsa
const base = { seconds: seconds + 2, camera: 'fake_device', mic: 'fake', withScreen: false, width: W, height: H, countTrack: false }
const scenarios = bitrates.flatMap((bps) => [
  { id: `mr-${Math.round(bps / 1e6)}m`, scenario: 'raw', ...base, videoBps: bps },
  // a tela gravando ao mesmo tempo (a carga que o usuário tem de verdade)
  { id: `mr-${Math.round(bps / 1e6)}m-tela`, scenario: 'raw', ...base, withScreen: true, fps: 30, videoBps: bps }
])
if (longSeconds > 0) scenarios.push({ id: 'longa-tela', scenario: 'raw', ...base, seconds: longSeconds, withScreen: true, fps: 30, videoBps: bitrates[0] })
const scenariosFile = path.join(out, 'cenarios.json')
fs.writeFileSync(scenariosFile, JSON.stringify(scenarios))
const switches = ['use-fake-device-for-media-stream', 'use-fake-ui-for-media-stream', `use-file-for-fake-video-capture=${clip}`].join(';')
const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE
const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'medir-camera.mjs'), 'custom', '--scenarios', scenariosFile, '--switches', switches, '--out', path.join(out, 'gravacoes'), '--camera', 'fake_device', '--mic', 'fake'], { encoding: 'utf8', env: cleanEnv, maxBuffer: 64 << 20 })
if (run.status !== 0) throw new Error(`a gravação falhou:\n${run.stdout}\n${run.stderr}`)

// 3. compara quadro a quadro
const grayFrames = (file, vf, count, w, h) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-vf', vf, '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(String(r.stderr))
  const frames = []
  const n = w * h
  for (let off = 0; off + n <= r.stdout.length; off += n) frames.push(r.stdout.subarray(off, off + n))
  return frames
}
const SW = 480
const SH = Math.round((SW * H) / W)
const small = (file, count) => grayFrames(file, `scale=${SW}:${SH}:flags=area`, count, SW, SH)
const mse = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    s += d * d
  }
  return s / a.length
}
const cropFilter = 'crop=iw/2:ih/2:iw/4:ih/4'
const nativeCrop = (file, index, isMjpeg) => {
  const sel = `select=eq(n\\,${index}),${cropFilter}`
  const [cw, ch] = [W / 2, H / 2]
  const frames = grayFrames(file, sel, 1, cw, ch)
  return { frame: frames[0], cw, ch, isMjpeg }
}
const lumaOf = (f) => f.reduce((a, v) => a + v, 0) / f.length
const psnrSsim = (a, b, w, h) => {
  // PSNR e SSIM pelo ffmpeg, a partir de dois quadros cinza crus
  const fa = path.join(out, '_a.gray')
  const fb = path.join(out, '_b.gray')
  fs.writeFileSync(fa, a)
  fs.writeFileSync(fb, b)
  const r = spawnSync(ffmpeg, ['-hide_banner', '-v', 'info', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-i', fa, '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-i', fb, '-lavfi', '[0:v][1:v]psnr;[0:v][1:v]ssim', '-f', 'null', '-'], { encoding: 'utf8' })
  const text = String(r.stderr)
  return { psnr: Number(/average:([\d.]+)/.exec(text)?.[1]), ssim: Number(/SSIM[^\n]*All:([\d.]+)/.exec(text)?.[1]) }
}

const srcSmall = small(clip, clipFrames)
const results = []
const execucao = JSON.parse(fs.readFileSync(path.join(out, 'gravacoes', 'execucao.json'), 'utf8'))
for (const r of execucao.results) {
  if (r.id.startsWith('longa')) continue
  const file = path.join(out, 'gravacoes', r.id, 'camera.webm')
  const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'json', file], { encoding: 'utf8' }).stdout).streams[0]
  const total = Number(probe.nb_read_frames)
  const bytes = fs.statSync(file).size
  const outSmall = small(file, total)
  const picks = []
  for (let i = 12; i < total - 2 && picks.length < 8; i += Math.max(1, Math.floor((total - 14) / 8))) picks.push(i)
  const rows = []
  for (const k of picks) {
    let best = -1
    let bestMse = Infinity
    let second = Infinity
    for (let j = 0; j < srcSmall.length; j++) {
      const m = mse(outSmall[k], srcSmall[j])
      if (m < bestMse) {
        second = bestMse
        bestMse = m
        best = j
      } else if (m < second) second = m
    }
    const a = nativeCrop(file, k, false)
    const b = nativeCrop(clip, best, true)
    const q = psnrSsim(a.frame, b.frame, a.cw, a.ch)
    rows.push({ outFrame: k, srcFrame: best, matchRatio: +(second / Math.max(bestMse, 1e-9)).toFixed(2), psnr: q.psnr, ssim: q.ssim, sharpOut: laplacianVariance(a.frame, a.cw, a.ch), sharpSrc: laplacianVariance(b.frame, b.cw, b.ch), lumaOut: lumaOf(a.frame), lumaSrc: lumaOf(b.frame) })
  }
  const med = (key) => {
    const v = rows.map((x) => x[key]).sort((x, y) => x - y)
    return v[v.length >> 1]
  }
  const summary = {
    id: r.id,
    resolucao: `${probe.width}x${probe.height}`,
    quadrosGravados: total,
    qps: +probeFile('ffprobe', file).fpsEffective.toFixed(2),
    cpuSistemaPct: r.cpuSystemPct,
    cpuGpuCodificadorPct: r.gpuUse?.gpuEncoderAvgPct ?? null,
    mbps: +((bytes * 8) / (seconds + 2) / 1e6).toFixed(1),
    psnrDb: +med('psnr').toFixed(2),
    ssim: +med('ssim').toFixed(4),
    nitidezSaida: +med('sharpOut').toFixed(1),
    nitidezOrigem: +med('sharpSrc').toFixed(1),
    nitidezPct: +(100 * (med('sharpOut') / med('sharpSrc'))).toFixed(1),
    lumaSaida: +med('lumaOut').toFixed(1),
    lumaOrigem: +med('lumaSrc').toFixed(1),
    casamentoMin: Math.min(...rows.map((x) => x.matchRatio))
  }
  results.push({ summary, rows })
  console.log(JSON.stringify(summary))
}
fs.writeFileSync(path.join(out, 'fidelidade.json'), JSON.stringify(results, null, 2))
console.log(`\nResultado: ${path.join(out, 'fidelidade.json')}`)
