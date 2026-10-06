/**
 * Análise de um arquivo de vídeo gravado: quadros, taxa efetiva, intervalos, taxa de bits do VÍDEO e
 * nitidez (variância do Laplaciano numa região central). Usada pela medição da câmera
 * (`scripts/medir-camera.mjs`) e testada em `tests/unit/camera-analise.test.ts`.
 */
import { execFileSync, spawn } from 'node:child_process'

/** Variância do Laplaciano 3x3 (kernel 0 1 0 / 1 -4 1 / 0 1 0) de uma imagem em tons de cinza. */
export function laplacianVariance(gray, w, h) {
  let n = 0
  let sum = 0
  let sumSq = 0
  for (let y = 1; y < h - 1; y++) {
    const row = y * w
    for (let x = 1; x < w - 1; x++) {
      const i = row + x
      const v = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i]
      sum += v
      sumSq += v * v
      n++
    }
  }
  if (n === 0) return 0
  const mean = sum / n
  return sumSq / n - mean * mean
}

/** Luma média (0..255) de uma imagem em tons de cinza. */
export function meanLuma(gray) {
  let sum = 0
  for (let i = 0; i < gray.length; i++) sum += gray[i]
  return gray.length ? sum / gray.length : 0
}

const median = (values) => {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/** Estatística dos intervalos entre quadros (ms) a partir dos pts (s). */
export function gapStats(ptsSeconds) {
  const pts = [...ptsSeconds].sort((a, b) => a - b)
  const gaps = pts.slice(1).map((v, i) => (v - pts[i]) * 1000)
  const sorted = [...gaps].sort((a, b) => a - b)
  const first = pts[0] ?? 0
  const last = pts[pts.length - 1] ?? 0
  const gapMedianMs = median(gaps)
  const spanS = last - first + gapMedianMs / 1000
  return {
    frames: pts.length,
    spanS,
    // quadros por segundo efetivos: o que o espectador vê (inclui os buracos)
    fpsEffective: spanS > 0 ? pts.length / spanS : 0,
    gapMedianMs,
    gapP99Ms: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
    gapMaxMs: sorted[sorted.length - 1] ?? 0,
    over50ms: gaps.filter((g) => g > 50).length,
    over100ms: gaps.filter((g) => g > 100).length
  }
}

export function probeFile(ffprobe, file) {
  const stream = JSON.parse(
    execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name,avg_frame_rate,r_frame_rate', '-of', 'json', file], { encoding: 'utf8', maxBuffer: 64 << 20 })
  ).streams[0]
  const packets = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,size', '-of', 'csv=p=0', file], { encoding: 'utf8', maxBuffer: 256 << 20 })
    .split(/\r?\n/)
    .map((l) => l.split(','))
    .filter((p) => p.length >= 2 && Number.isFinite(Number(p[0])))
    .map((p) => ({ pts: Number(p[0]), size: Number(p[1]) }))
  const stats = gapStats(packets.map((p) => p.pts))
  const bytes = packets.reduce((a, p) => a + p.size, 0)
  return {
    codec: stream?.codec_name,
    width: stream?.width,
    height: stream?.height,
    ...stats,
    videoMbps: stats.spanS > 0 ? (bytes * 8) / stats.spanS / 1e6 : 0,
    firstPtsS: Math.min(...packets.map((p) => p.pts))
  }
}

/**
 * Nitidez: variância do Laplaciano do recorte central (metade da largura e da altura) de ~`count`
 * quadros espaçados depois do primeiro segundo. Tudo é levado a 1920x1080 antes (lanczos), para que
 * uma imagem de menor resolução pague pelo detalhe que não tem. Devolve a mediana.
 */
export function sharpness(ffmpeg, file, { count = 24, skipS = 1, width = 1920, height = 1080 } = {}) {
  const cw = width / 2
  const ch = height / 2
  const frameBytes = cw * ch
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ['-hide_banner', '-v', 'error', '-ss', String(skipS), '-i', file, '-vf', `fps=3,scale=${width}:${height}:flags=lanczos,crop=${cw}:${ch}:${width / 4}:${height / 4},format=gray`, '-frames:v', String(count), '-f', 'rawvideo', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
    const chunks = []
    let err = ''
    child.stdout.on('data', (d) => chunks.push(d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg ${code}: ${err}`))
      const all = Buffer.concat(chunks)
      const values = []
      const lumas = []
      for (let off = 0; off + frameBytes <= all.length; off += frameBytes) {
        const frame = all.subarray(off, off + frameBytes)
        values.push(laplacianVariance(frame, cw, ch))
        lumas.push(meanLuma(frame))
      }
      resolve({ frames: values.length, median: median(values), mean: values.reduce((a, v) => a + v, 0) / Math.max(1, values.length), meanLuma: median(lumas), values })
    })
  })
}
