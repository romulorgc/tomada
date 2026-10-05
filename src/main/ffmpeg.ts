/**
 * ffmpeg/ffprobe: localizar, executar e inspecionar. Sem Electron: roda igual no
 * app e nos testes.
 *
 * Regra de ouro (armadilha da v1, legado/README.md): `run()` REJEITA quando o
 * código de saída não é 0, trazendo as últimas 10 linhas do stderr. Na v1 um
 * remux quebrado "passava por bom" e gerava arquivos de 264 bytes.
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

// ---------------------------------------------------------------------------
// Localizar

export type FfmpegSource = 'settings' | 'bundled' | 'path'

export type FfmpegPaths = {
  ffmpeg: string
  ffprobe: string
  source: FfmpegSource
}

export type LocateOptions = {
  /** Ajuste do usuário: pasta com os dois executáveis, ou o caminho do ffmpeg. */
  custom?: string
  /** Pasta empacotada com o instalador (build LGPL), se houver. */
  bundledDir?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

function exeName(base: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${base}.exe` : base
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function fromDir(dir: string, platform: NodeJS.Platform): { ffmpeg: string; ffprobe: string } | null {
  const ffmpeg = join(dir, exeName('ffmpeg', platform))
  const ffprobe = join(dir, exeName('ffprobe', platform))
  return isFile(ffmpeg) && isFile(ffprobe) ? { ffmpeg, ffprobe } : null
}

function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path')
  const raw = key ? env[key] : undefined
  if (!raw) return []
  const sep = platform === 'win32' ? ';' : delimiter
  return raw
    .split(sep)
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
}

/** Ajuste → pasta empacotada → PATH. `null` se não achar os DOIS executáveis. */
export function locateFfmpeg(opts: LocateOptions = {}): FfmpegPaths | null {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env

  if (opts.custom) {
    const custom = opts.custom
    if (isDir(custom)) {
      const found = fromDir(custom, platform)
      if (found) return { ...found, source: 'settings' }
    } else if (isFile(custom)) {
      const dir = join(custom, '..')
      const found = fromDir(dir, platform)
      if (found) return { ffmpeg: custom, ffprobe: found.ffprobe, source: 'settings' }
    }
    // Ajuste apontando para lugar nenhum: não cai no PATH em silêncio. Quem chamou decide.
    return null
  }

  if (opts.bundledDir) {
    const found = fromDir(opts.bundledDir, platform)
    if (found) return { ...found, source: 'bundled' }
  }

  let ffmpeg: string | null = null
  let ffprobe: string | null = null
  for (const dir of pathEntries(env, platform)) {
    const both = fromDir(dir, platform)
    if (both) return { ...both, source: 'path' }
    const a = join(dir, exeName('ffmpeg', platform))
    const b = join(dir, exeName('ffprobe', platform))
    if (!ffmpeg && existsSync(a)) ffmpeg = a
    if (!ffprobe && existsSync(b)) ffprobe = b
  }
  return ffmpeg && ffprobe ? { ffmpeg, ffprobe, source: 'path' } : null
}

// ---------------------------------------------------------------------------
// Executar

export class FfmpegError extends Error {
  override readonly name = 'FfmpegError'
  constructor(
    message: string,
    /** Código de saída, ou null se o processo nem chegou a sair (timeout, cancelado, não abriu). */
    readonly exitCode: number | null,
    /** Últimas linhas do stderr. */
    readonly stderrTail: string
  ) {
    super(message)
  }
}

export type FfmpegProgress = {
  /** Posição já processada da SAÍDA, em ms. */
  timeMs: number
  frame: number | null
  fps: number | null
  /** Velocidade relativa ao tempo real (2 = duas vezes mais rápido). */
  speed: number | null
}

export type RunOptions = {
  timeoutMs?: number
  onProgress?: (p: FfmpegProgress) => void
  signal?: AbortSignal
  cwd?: string
}

const TAIL_LINES = 10

/** Interpreta um bloco `-progress` (linhas chave=valor). Exportado para teste. */
export function parseProgressBlock(lines: string[]): FfmpegProgress | null {
  const kv: Record<string, string> = {}
  for (const line of lines) {
    const i = line.indexOf('=')
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  const us = Number(kv.out_time_us ?? kv.out_time_ms)
  if (!Number.isFinite(us) || us < 0) return null
  const num = (v: string | undefined): number | null => {
    const n = Number(v)
    return v !== undefined && Number.isFinite(n) ? n : null
  }
  const speedText = kv.speed?.replace('x', '')
  return {
    timeMs: Math.round(us / 1000),
    frame: num(kv.frame),
    fps: num(kv.fps),
    speed: speedText && speedText !== 'N/A' ? num(speedText) : null
  }
}

function lastLines(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-n)
    .join('\n')
}

/** Roda um executável do ffmpeg; rejeita com `FfmpegError` se não sair com código 0. */
export function runBinary(bin: string, args: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new FfmpegError('Operação cancelada.', null, ''))
      return
    }
    const child = spawn(bin, args, { cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    let progressLines: string[] = []
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => {
      child.kill()
      finish(() => reject(new FfmpegError('Operação cancelada.', null, lastLines(stderr, TAIL_LINES))))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill()
        finish(() =>
          reject(
            new FfmpegError(
              `O ffmpeg passou do tempo limite (${Math.round(opts.timeoutMs! / 1000)} s) e foi interrompido.`,
              null,
              lastLines(stderr, TAIL_LINES)
            )
          )
        )
      }, opts.timeoutMs)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (!opts.onProgress) {
        stdout += text
        return
      }
      // modo -progress: blocos terminados por "progress=continue|end"
      progressLines.push(...text.split(/\r?\n/))
      let idx = progressLines.findIndex((l) => l.startsWith('progress='))
      while (idx >= 0) {
        const block = progressLines.slice(0, idx + 1)
        progressLines = progressLines.slice(idx + 1)
        const parsed = parseProgressBlock(block)
        if (parsed) opts.onProgress(parsed)
        idx = progressLines.findIndex((l) => l.startsWith('progress='))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000) // só o rabo interessa
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          new FfmpegError(
            err.code === 'ENOENT'
              ? `Não consegui abrir o ffmpeg (${bin}): arquivo não encontrado.`
              : `Não consegui abrir o ffmpeg (${bin}): ${err.message}`,
            null,
            ''
          )
        )
      )
    })

    child.on('close', (code) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          const tail = lastLines(stderr, TAIL_LINES)
          reject(new FfmpegError(`O ffmpeg terminou com código ${code}.${tail ? `\n${tail}` : ''}`, code, tail))
        }
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Inspecionar (ffprobe)

export type ProbeStream = {
  index: number
  type: 'video' | 'audio' | 'other'
  codec: string
  width?: number
  height?: number
  /** Quadros por segundo médios (avg_frame_rate; r_frame_rate se faltar). */
  fps?: number
  /** `r_frame_rate` (a taxa base do fluxo): igual a `fps` quando a taxa é constante. */
  rFps?: number
  /** Perfil do codec (ex.: "High"), quando o ffprobe informa. */
  profile?: string
  sampleRate?: number
  channels?: number
  durationMs?: number
  nbFrames?: number
}

export type ProbeResult = {
  durationMs: number
  formatName: string
  sizeBytes: number
  video?: ProbeStream
  audio?: ProbeStream
  streams: ProbeStream[]
}

/** "30000/1001" → 29.97; "0/0" → undefined. */
export function parseFrameRate(text: string | undefined): number | undefined {
  if (!text) return undefined
  const [n, d] = text.split('/')
  const num = Number(n)
  const den = d === undefined ? 1 : Number(d)
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) return undefined
  return num / den
}

type RawStream = {
  index?: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  profile?: string
  sample_rate?: string
  channels?: number
  duration?: string
  nb_frames?: string
}
type RawProbe = { streams?: RawStream[]; format?: { duration?: string; format_name?: string; size?: string } }

const secondsToMs = (s: string | undefined): number | undefined => {
  const n = Number(s)
  return s !== undefined && Number.isFinite(n) ? Math.round(n * 1000) : undefined
}

export function parseProbe(raw: unknown): ProbeResult {
  const data = (raw ?? {}) as RawProbe
  const streams: ProbeStream[] = (data.streams ?? []).map((s, i) => {
    const type = s.codec_type === 'video' || s.codec_type === 'audio' ? s.codec_type : 'other'
    const stream: ProbeStream = { index: s.index ?? i, type, codec: s.codec_name ?? 'desconhecido' }
    if (s.width) stream.width = s.width
    if (s.height) stream.height = s.height
    const fps = parseFrameRate(s.avg_frame_rate) ?? parseFrameRate(s.r_frame_rate)
    if (type === 'video' && fps) stream.fps = fps
    const rFps = parseFrameRate(s.r_frame_rate)
    if (type === 'video' && rFps) stream.rFps = rFps
    if (s.profile) stream.profile = s.profile
    if (s.sample_rate) stream.sampleRate = Number(s.sample_rate)
    if (s.channels) stream.channels = s.channels
    const d = secondsToMs(s.duration)
    if (d !== undefined) stream.durationMs = d
    if (s.nb_frames && Number.isFinite(Number(s.nb_frames))) stream.nbFrames = Number(s.nb_frames)
    return stream
  })
  const video = streams.find((s) => s.type === 'video')
  const audio = streams.find((s) => s.type === 'audio')
  const formatMs = secondsToMs(data.format?.duration)
  const durationMs = formatMs ?? Math.max(0, ...streams.map((s) => s.durationMs ?? 0))
  return {
    durationMs,
    formatName: data.format?.format_name ?? '',
    sizeBytes: Number(data.format?.size ?? 0) || 0,
    ...(video ? { video } : {}),
    ...(audio ? { audio } : {}),
    streams
  }
}

/** "ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright…" → "8.1.1-full_build-www.gyan.dev" */
export function parseVersion(output: string): string | null {
  const m = /version\s+(\S+)/i.exec(output.split(/\r?\n/)[0] ?? '')
  return m?.[1] ?? null
}

// ---------------------------------------------------------------------------
// Fachada

export interface Ffmpeg {
  readonly paths: FfmpegPaths
  /** Roda o ffmpeg. Rejeita com `FfmpegError` se o código de saída não for 0. */
  run(args: string[], opts?: RunOptions): Promise<{ stderr: string }>
  /** ffprobe em JSON, já interpretado. */
  probe(file: string, opts?: Pick<RunOptions, 'timeoutMs' | 'signal'>): Promise<ProbeResult>
  /** Texto de `-version` interpretado (null se não reconhecer). */
  version(): Promise<string | null>
  ffprobeVersion(): Promise<string | null>
}

export function createFfmpeg(paths: FfmpegPaths): Ffmpeg {
  const hasLevel = (args: string[]): boolean => args.includes('-loglevel') || args.includes('-v')
  return {
    paths,
    async run(args, opts = {}) {
      const full = ['-hide_banner', ...(hasLevel(args) ? [] : ['-loglevel', 'error'])]
      if (opts.onProgress) full.push('-progress', 'pipe:1', '-nostats')
      full.push('-y', ...args)
      const { stderr } = await runBinary(paths.ffmpeg, full, opts)
      return { stderr }
    },
    async probe(file, opts = {}) {
      const { stdout } = await runBinary(
        paths.ffprobe,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file],
        opts
      )
      let json: unknown
      try {
        json = JSON.parse(stdout)
      } catch {
        throw new FfmpegError(`O ffprobe devolveu algo que não é JSON para ${file}.`, 0, lastLines(stdout, TAIL_LINES))
      }
      return parseProbe(json)
    },
    async version() {
      const { stdout } = await runBinary(paths.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 15_000 })
      return parseVersion(stdout)
    },
    async ffprobeVersion() {
      const { stdout } = await runBinary(paths.ffprobe, ['-hide_banner', '-version'], { timeoutMs: 15_000 })
      return parseVersion(stdout)
    }
  }
}
