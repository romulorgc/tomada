/**
 * Análise de quadros da gravação real com o ffmpeg do PATH: cor média de um trecho do
 * quadro ao longo do tempo (para medir a sincronia), um quadro inteiro em RGB (para achar
 * botões pela cor) e recortes ampliados em PNG (para olhar).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Rgb = { r: number; g: number; b: number }
export type Box = { x: number; y: number; w: number; h: number }

export const hex = (c: string): Rgb => ({ r: parseInt(c.slice(1, 3), 16), g: parseInt(c.slice(3, 5), 16), b: parseInt(c.slice(5, 7), 16) })
export const dist = (a: Rgb, b: Rgb): number => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b)

function ffmpegBuffer(args: string[], maxMb = 64): Buffer {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: maxMb * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`ffmpeg falhou (${r.status}): ${r.stderr.toString().split('\n').slice(-6).join('\n')}`)
  return r.stdout
}

/** Cor média do trecho `box` (pixels do quadro) em CADA quadro do vídeo, em ordem. */
export function averageColorPerFrame(video: string, box: Box): Rgb[] {
  const out = ffmpegBuffer([
    '-i',
    video,
    '-vf',
    `crop=${box.w}:${box.h}:${box.x}:${box.y},scale=1:1:flags=area`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1'
  ])
  const frames: Rgb[] = []
  for (let i = 0; i + 2 < out.length; i += 3) frames.push({ r: out[i]!, g: out[i + 1]!, b: out[i + 2]! })
  return frames
}

/** Um quadro inteiro em RGB (w×h×3). `atS` em segundos do arquivo. */
export function frameRgb(video: string, atS: number, w: number, h: number): Buffer {
  const buf = ffmpegBuffer(['-ss', atS.toFixed(3), '-i', video, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
  if (buf.length !== w * h * 3) throw new Error(`Quadro com ${buf.length} bytes; esperava ${w}×${h}×3 = ${w * h * 3}.`)
  return buf
}

/** Caixa delimitadora dos pixels de cor `target` (±`tol`) dentro de `region`. null se não houver. */
export function findColorBox(rgb: Buffer, w: number, region: Box, target: Rgb, tol = 28): { box: Box; count: number } | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  let count = 0
  for (let y = Math.max(0, region.y); y < region.y + region.h; y++) {
    for (let x = Math.max(0, region.x); x < region.x + region.w; x++) {
      const i = (y * w + x) * 3
      if (dist({ r: rgb[i]!, g: rgb[i + 1]!, b: rgb[i + 2]! }, target) <= tol) {
        count++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return count === 0 ? null : { box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, count }
}

/** Quantos pixels do recorte `box` fogem da cor `base` (>`tol`): mede a presença de cursor sobre um botão liso. */
export function countOffColor(rgb: Buffer, w: number, box: Box, base: Rgb, tol = 60): number {
  let n = 0
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * w + x) * 3
      if (dist({ r: rgb[i]!, g: rgb[i + 1]!, b: rgb[i + 2]! }, base) > tol) n++
    }
  }
  return n
}

/** Recorte ampliado (vizinho mais próximo) de um quadro, como PNG, para conferir a olho. */
export function saveCropPng(video: string, atS: number, box: Box, scale: number, out: string): void {
  mkdirSync(dirname(out), { recursive: true })
  ffmpegBuffer([
    '-ss',
    atS.toFixed(3),
    '-i',
    video,
    '-frames:v',
    '1',
    '-vf',
    `crop=${box.w}:${box.h}:${box.x}:${box.y},scale=${box.w * scale}:${box.h * scale}:flags=neighbor`,
    '-y',
    out
  ])
}
