#!/usr/bin/env node
/**
 * Fidelidade do codificador da câmera, SEM a luz do quarto, a exposição nem a conversão de cor de outro programa no meio.
 * Grava pelo MediaRecorder do app (mesmo formato e taxa de bits) e, DA MESMA TRILHA, guarda o plano de luma (Y) de seis quadros
 * exatamente como o codificador os recebe (`VideoFrame.copyTo`). Depois acha, no arquivo gravado, o quadro correspondente
 * (casamento pelo ruído do sensor, no tamanho nativo) e compara os dois: PSNR, SSIM e nitidez (variância do Laplaciano do
 * recorte central), tudo em luma crua, sem mudança de faixa. Assim "nitidez ≥ 90% da origem" mede SÓ o que o codificador perdeu.
 *
 *   node scripts/fila-pesada.mjs node scripts/medir-camera-fidelidade.mjs [--size 3840x2160] [--seconds 8] [--bps 45000000,20000000] [--long 60]
 *   node scripts/medir-camera-fidelidade.mjs --reuse <pasta>      (só refaz a análise de uma rodada anterior)
 *
 * Cada tamanho/bitrate roda sem e com a tela gravando ao mesmo tempo. Os arquivos ficam em C:\tmp\tomada-camera-medicao\
 * (rosto do usuário: só nesta máquina; docs/LIXO.md). `--long N` grava também N segundos em tamanho cheio com a tela, para as
 * medições de processamento 4K (`tests/medir/camera-4k.run.ts`).
 */
import { spawnSync } from 'node:child_process'
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
const seconds = Number(opt('seconds', 8))
const bitrates = opt('bps', '45000000').split(',').map(Number)
const longSeconds = Number(opt('long', 0))
const cameraName = opt('camera', 'EMEET')
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const reuse = opt('reuse', null)
const out = path.resolve(reuse ?? opt('out', `C:\\tmp\\tomada-camera-medicao\\${stamp}-fidelidade`))
fs.mkdirSync(out, { recursive: true })
const ffmpeg = process.env.FFMPEG || 'ffmpeg'

// 1. grava (a menos que --reuse)
const recDir = path.join(out, 'gravacoes')
const skipRun = Boolean(reuse) && fs.existsSync(path.join(recDir, 'execucao.json'))
if (!skipRun) {
  const base = { scenario: 'fidelity', camera: cameraName, mic: cameraName, width: W, height: H, seconds }
  const scenarios = bitrates.flatMap((bps) => [
    { id: `mr-${Math.round(bps / 1e6)}m`, ...base, videoBps: bps, withScreen: false },
    // a tela gravando ao mesmo tempo (a carga que o usuário tem de verdade)
    { id: `mr-${Math.round(bps / 1e6)}m-tela`, ...base, videoBps: bps, withScreen: true }
  ])
  if (longSeconds > 0) scenarios.push({ id: 'longa-tela', scenario: 'raw', camera: cameraName, mic: cameraName, width: W, height: H, withScreen: true, fps: 30, videoBps: bitrates[0], seconds: longSeconds, countTrack: false })
  const scenariosFile = path.join(out, 'cenarios.json')
  fs.writeFileSync(scenariosFile, JSON.stringify(scenarios))
  const cleanEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'medir-camera.mjs'), 'custom', '--scenarios', scenariosFile, '--out', recDir, '--camera', cameraName, '--mic', cameraName], { encoding: 'utf8', env: cleanEnv, maxBuffer: 64 << 20 })
  if (run.status !== 0) throw new Error(`a gravação falhou:\n${run.stdout}\n${run.stderr}`)
}

// 2. compara
// Luma CRUA: pede yuv420p e fica só com o plano Y de cada quadro. Converter para "gray" faria o ffmpeg ESTICAR a faixa
// limitada (×1,164 na amplitude, ×1,36 na variância) e a nitidez da saída sairia ~40% "maior" que a da entrada.
const gray = (file, vf, count, w, h) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-vf', vf, '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(String(r.stderr))
  const frames = []
  const frameBytes = (w * h * 3) / 2
  for (let off = 0; off + frameBytes <= r.stdout.length; off += frameBytes) frames.push(r.stdout.subarray(off, off + w * h))
  return frames
}
const RAW = 'null'
const MW = 640
const MH = 360
// recorte central em coordenadas PARES (yuv420p exige)
const cropCenter = (w, h, cw, ch) => `crop=${cw}:${ch}:${Math.floor((w - cw) / 4) * 2}:${Math.floor((h - ch) / 4) * 2}`
const mse = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    s += d * d
  }
  return s / a.length
}
const cropOf = (plane, w, h, cw, ch) => {
  const x0 = Math.floor((w - cw) / 2)
  const y0 = Math.floor((h - ch) / 2)
  const o = Buffer.alloc(cw * ch)
  for (let y = 0; y < ch; y++) plane.copy(o, y * cw, (y0 + y) * w + x0, (y0 + y) * w + x0 + cw)
  return o
}
const psnrSsim = (a, b, w, h) => {
  const fa = path.join(out, '_a.gray')
  const fb = path.join(out, '_b.gray')
  fs.writeFileSync(fa, a)
  fs.writeFileSync(fb, b)
  const r = spawnSync(ffmpeg, ['-hide_banner', '-v', 'info', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-i', fa, '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-i', fb, '-lavfi', '[0:v][1:v]psnr;[0:v][1:v]ssim', '-f', 'null', '-'], { encoding: 'utf8' })
  const text = String(r.stderr)
  return { psnr: Number(/average:([\d.]+)/.exec(text)?.[1]), ssim: Number(/SSIM[^\n]*All:([\d.]+)/.exec(text)?.[1]) }
}
const median = (values) => {
  const v = [...values].sort((x, y) => x - y)
  return v[v.length >> 1]
}

const execucao = JSON.parse(fs.readFileSync(path.join(recDir, 'execucao.json'), 'utf8'))
const results = []
for (const r of execucao.results) {
  if (r.scenario !== 'fidelity') continue
  if (r.error) {
    console.log(JSON.stringify({ id: r.id, erro: r.error }))
    continue
  }
  const file = path.join(recDir, r.id, 'camera.webm')
  const info = probeFile('ffprobe', file)
  const sourceW = r.grabs[0].width
  const sourceH = r.grabs[0].height
  const cw = Math.min(1920, sourceW)
  const ch = Math.min(1080, sourceH)
  const total = info.frames
  const outCenters = gray(file, `${RAW},${cropCenter(info.width, info.height, MW, MH)}`, total, MW, MH)
  const rows = []
  for (const g of r.grabs) {
    const plane = fs.readFileSync(path.join(recDir, r.id, `yplane${g.index}.webm`))
    if (plane.length !== g.width * g.height) continue
    const key = cropOf(plane, g.width, g.height, MW, MH)
    let best = -1
    let bestMse = Infinity
    let second = Infinity
    for (let k = 0; k < outCenters.length; k++) {
      const m = mse(key, outCenters[k])
      if (m < bestMse) {
        second = bestMse
        bestMse = m
        best = k
      } else if (m < second) second = m
    }
    const [decoded] = gray(file, `${RAW},select='eq(n,${best})',${cropCenter(info.width, info.height, cw, ch)}`, 1, cw, ch)
    const original = cropOf(plane, g.width, g.height, cw, ch)
    const q = psnrSsim(decoded, original, cw, ch)
    rows.push({ grab: g.index, outFrame: best, matchRatio: +(second / Math.max(bestMse, 1e-9)).toFixed(2), psnr: q.psnr, ssim: q.ssim, sharpOut: laplacianVariance(decoded, cw, ch), sharpIn: laplacianVariance(original, cw, ch) })
  }
  const summary = {
    id: r.id,
    resolucao: `${info.width}x${info.height}`,
    quadros: info.frames,
    qps: +info.fpsEffective.toFixed(2),
    mbps: +info.videoMbps.toFixed(1),
    cpuSistemaPct: r.cpuSystemPct,
    gpuCodificadorPct: r.gpuUse?.gpuEncoderAvgPct ?? null,
    psnrDb: +median(rows.map((x) => x.psnr)).toFixed(2),
    ssim: +median(rows.map((x) => x.ssim)).toFixed(4),
    nitidezEntrada: +median(rows.map((x) => x.sharpIn)).toFixed(1),
    nitidezSaida: +median(rows.map((x) => x.sharpOut)).toFixed(1),
    nitidezPct: +median(rows.map((x) => (100 * x.sharpOut) / x.sharpIn)).toFixed(1),
    casamentoMin: Math.min(...rows.map((x) => x.matchRatio)),
    pares: rows.length
  }
  results.push({ summary, rows })
  console.log(JSON.stringify(summary))
}
fs.writeFileSync(path.join(out, 'fidelidade.json'), JSON.stringify(results, null, 2))
console.log(`\nResultado: ${path.join(out, 'fidelidade.json')}`)
