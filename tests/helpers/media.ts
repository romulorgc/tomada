/**
 * Ajudantes de mídia para os testes de exportação: ffprobe, série de luminância por quadro,
 * PCM do áudio e extração de um quadro em RGB. Usam o ffmpeg/ffprobe do PATH.
 */
import { execFileSync, spawnSync } from 'node:child_process'

export type ProbeStream = {
  codec_type: string
  codec_name: string
  profile?: string
  width?: number
  height?: number
  pix_fmt?: string
  r_frame_rate?: string
  avg_frame_rate?: string
  nb_frames?: string
  duration?: string
  sample_rate?: string
  channels?: number
  color_space?: string
  color_transfer?: string
  color_primaries?: string
  color_range?: string
  bit_rate?: string
}

export type ProbeJson = { streams: ProbeStream[]; format: { format_name: string; duration: string; size: string; bit_rate?: string } }

export function probeJson(file: string): ProbeJson {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(out) as ProbeJson
}

export function run(bin: string, args: string[]): Buffer {
  const r = spawnSync(bin, args, { maxBuffer: 1024 * 1024 * 1024, windowsHide: true })
  if (r.status !== 0) throw new Error(`${bin} saiu com ${r.status}: ${r.stderr?.toString().split(/\r?\n/).slice(-8).join('\n')}`)
  return r.stdout
}

/** Luminância média (0..255) de uma região de CADA quadro do vídeo (1 byte por quadro). */
export function lumaSeries(file: string, crop: { x: number; y: number; w: number; h: number }): number[] {
  const buf = run('ffmpeg', [
    '-v',
    'error',
    '-i',
    file,
    '-vf',
    `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=1:1:flags=area,format=gray`,
    '-f',
    'rawvideo',
    '-'
  ])
  return [...buf]
}

/** Áudio decodificado como PCM de 16 bits, mono, na taxa pedida. */
export function audioPcm(file: string, sampleRate = 48_000): Int16Array {
  const buf = run('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-'])
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2))
}

/** Quadro de índice `n` do vídeo, reduzido para `w × h`, em RGB (3 bytes por pixel). */
export function frameRgb(file: string, n: number, w: number, h: number): Uint8Array {
  const buf = run('ffmpeg', [
    '-v',
    'error',
    '-i',
    file,
    '-vf',
    `select=eq(n\\,${n}),scale=${w}:${h}:flags=area:in_color_matrix=bt709:out_color_matrix=bt709`,
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-'
  ])
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/** Um PNG (ou JPEG) em memória, reduzido para `w × h` com média de área, em RGB (3 bytes por pixel). */
export function imageToRgb(image: Buffer, w: number, h: number): Uint8Array {
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', 'pipe:0', '-vf', `scale=${w}:${h}:flags=area`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
    { input: image, maxBuffer: 256 * 1024 * 1024, windowsHide: true }
  )
  if (r.status !== 0) throw new Error(`ffmpeg saiu com ${r.status}: ${r.stderr?.toString().split(/\r?\n/).slice(-6).join('\n')}`)
  return new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength)
}

/** Diferença entre dois quadros RGB: média absoluta normalizada e fração de pixels que mudam muito. */
export function rgbDiff(a: Uint8Array, b: Uint8Array, strong = 48): { mean: number; strongRatio: number } {
  if (a.length !== b.length) throw new Error(`quadros de tamanhos diferentes: ${a.length} × ${b.length}`)
  let sum = 0
  let strongPx = 0
  const px = a.length / 3
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!)
    sum += d
    if (Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)) > strong) strongPx++
  }
  return { mean: sum / (a.length * 255), strongRatio: strongPx / px }
}

/**
 * Início (ms) de cada trecho sonoro de um PCM: janelas de 2 ms, limiar relativo ao pico e
 * "silêncio" de pelo menos `quietMs` antes de cada início.
 */
export function onsets(pcm: Int16Array, sampleRate = 48_000, opts: { relative?: number; quietMs?: number } = {}): number[] {
  const win = Math.round(sampleRate * 0.002)
  const rms: number[] = []
  let peak = 0
  for (let i = 0; i + win <= pcm.length; i += win) {
    let s = 0
    for (let k = 0; k < win; k++) s += pcm[i + k]! * pcm[i + k]!
    const v = Math.sqrt(s / win)
    rms.push(v)
    if (v > peak) peak = v
  }
  const thr = peak * (opts.relative ?? 0.25)
  const quietWins = Math.round((opts.quietMs ?? 300) / 2)
  const out: number[] = []
  let quiet = quietWins // começa "em silêncio": um som no instante 0 conta
  for (let i = 0; i < rms.length; i++) {
    if (rms[i]! >= thr) {
      if (quiet >= quietWins) out.push(i * 2)
      quiet = 0
    } else quiet++
  }
  return out
}
