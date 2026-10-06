/**
 * Motor B: whisper.cpp com CUDA (`whisper-cli.exe`), sem Python. Mesmo modelo (large-v3-turbo, ggml), `-ojf` para
 * os tokens com tempo, `--dtw large.v3.turbo` para o tempo por palavra e `--prompt` para o dicionário.
 *
 * Origens fixas: o zip do GitHub (`ggml-org/whisper.cpp`, build `b5130`, SHA-256 conferido) e o modelo ggml do
 * Hugging Face (revisão fixa, tamanho e SHA-256 conferidos). O zip é aberto pelo `tar.exe` do Windows e o conteúdo
 * é conferido (nada pode cair fora da pasta). O processo principal só executa o `whisper-cli.exe` que ele mesmo
 * extraiu para `%LOCALAPPDATA%\Tomada\whisper.cpp`.
 */
import { mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fromWhisperCpp, parseWhisperCppVad } from '@shared/transcript-engines'
import { buildTranscript } from '@shared/transcript'
import type { Range, Transcript } from '@shared/types'
import { writeFileAtomic } from '../fs-utils'
import type { Logger } from '../logger'
import { ProcessError, runProcess, tail } from '../process-runner'
import { createTmpDirIn, removeTmpDir } from '../safe-output'
import { downloadFile, DownloadError } from './download'
import { explain, detectNvidiaGpu, type GpuInfo } from './faster-whisper'
import { bytesLine, type PrepareTracker } from './prepare-tracker'
import type { ToolPaths } from './tools-dir'
import { buildPrompt, type EngineCheck, type RunStats, type Transcriber, type TranscribeOptions } from './types'

export const WCPP_ENGINE_ID = 'whisper-cpp' as const
export const WCPP_BUILD = 'b5130'
export const WCPP_ZIP = {
  name: 'whisper-cublas-12.4.0-bin-x64.zip',
  url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WCPP_BUILD}/whisper-cublas-12.4.0-bin-x64.zip`,
  size: 674539285,
  sha256: 'af520ddd034d985b55dfeea3e465ed93653ba2aee1a55e865033edc548c272a7'
} as const
export const WCPP_MODEL = {
  name: 'ggml-large-v3-turbo.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo.bin',
  size: 1624555275,
  sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69'
} as const
/** Modelo do Silero VAD em ggml (o `whisper-vad-speech-segments` diz onde há voz; o whisper-cli não informa isso). */
export const WCPP_VAD_MODEL = {
  name: 'ggml-silero-v5.1.2.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v5.1.2.bin',
  size: 885098,
  sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf'
} as const
/** O zip vem do GitHub (e dos CDNs dele); o modelo, do Hugging Face. */
export const WCPP_ZIP_HOSTS = ['github.com', 'githubusercontent.com'] as const
export const WCPP_MODEL_HOSTS = ['huggingface.co', 'hf.co'] as const
const MARKER_VERSION = 1

type Marker = { version: number; build: string; cli: string; gpu: string | null; completedAt: string }

export type WhisperCppDeps = {
  tools: ToolPaths
  logger: Logger
  fetchImpl?: typeof fetch
  detectGpu?: () => Promise<GpuInfo | null>
  now?: () => Date
  env?: NodeJS.ProcessEnv
}

const markerFile = (t: ToolPaths): string => join(t.state, 'whisper-cpp.json')
const binDir = (t: ToolPaths): string => join(t.whisperCpp, `bin-${WCPP_BUILD}`)
const modelFile = (t: ToolPaths): string => join(t.models, 'whisper.cpp', WCPP_MODEL.name)
const vadModelFile = (t: ToolPaths): string => join(t.models, 'whisper.cpp', WCPP_VAD_MODEL.name)

async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

/** Acha o `whisper-cli.exe` (o zip traz uma subpasta `Release`). */
async function findCli(dir: string): Promise<string | null> {
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isFile() && entry.name.toLowerCase() === 'whisper-cli.exe') return full
      if (entry.isDirectory()) {
        const hit = await findCli(full)
        if (hit) return hit
      }
    }
  } catch {
    // pasta que não existe
  }
  return null
}

/** Todo arquivo extraído está dentro da pasta de destino (sem fuga por `..` ou atalho)? */
async function assertContained(root: string, dir: string): Promise<void> {
  const realRoot = await realpath(root)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const real = await realpath(full)
    const rel = relative(realRoot, real)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
      throw new Error(`O zip do whisper.cpp trouxe um arquivo fora da pasta (${entry.name}). Apaguei tudo.`)
    }
    if (entry.isDirectory()) await assertContained(root, full)
  }
}

export function createWhisperCpp(deps: WhisperCppDeps): Transcriber {
  const { tools, logger } = deps
  const env = deps.env ?? process.env
  const detectGpu = deps.detectGpu ?? ((): Promise<GpuInfo | null> => detectNvidiaGpu(env))
  const now = deps.now ?? ((): Date => new Date())

  async function readMarker(): Promise<Marker | null> {
    try {
      const m = JSON.parse(await readFile(markerFile(tools), 'utf8')) as Marker
      return m && m.version === MARKER_VERSION && m.build === WCPP_BUILD ? m : null
    } catch {
      return null
    }
  }

  async function check(): Promise<EngineCheck> {
    const marker = await readMarker()
    if (!marker) return { state: 'missing', detail: 'O whisper.cpp ainda não foi preparado neste computador.', device: null }
    if ((await fileSize(marker.cli)) === null) return { state: 'missing', detail: 'O programa do whisper.cpp sumiu. Prepare de novo.', device: null }
    if ((await fileSize(modelFile(tools))) !== WCPP_MODEL.size || (await fileSize(vadModelFile(tools))) !== WCPP_VAD_MODEL.size) {
      return { state: 'missing', detail: 'O modelo do whisper.cpp está incompleto. Prepare de novo.', device: null }
    }
    return { state: 'ready', detail: null, device: marker.gpu }
  }

  async function prepare(tracker: PrepareTracker, signal: AbortSignal): Promise<void> {
    let current: 'binary' | 'model' | 'check' = 'binary'
    try {
      await mkdir(tools.whisperCpp, { recursive: true })
      await mkdir(tools.state, { recursive: true })

      // --- 1. programa (zip do GitHub) -------------------------------------------------------------------
      tracker.begin('binary', 'Baixando o whisper.cpp…')
      let cli = await findCli(binDir(tools))
      if (!cli) {
        const zip = join(tools.downloads, WCPP_ZIP.name)
        await downloadFile(
          { url: WCPP_ZIP.url, dest: zip, allowedHosts: WCPP_ZIP_HOSTS, size: WCPP_ZIP.size, sha256: WCPP_ZIP.sha256 },
          {
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
            signal,
            onProgress: (p) => tracker.progress('binary', (p.received / WCPP_ZIP.size) * 0.9, `Baixando o whisper.cpp · ${bytesLine(p.received, WCPP_ZIP.size)}`),
            onNote: (m) => tracker.note(m)
          }
        )
        tracker.progress('binary', 0.92, 'Abrindo o pacote…')
        const staging = join(tools.whisperCpp, `.extraindo-${process.pid}`)
        await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
        await mkdir(staging, { recursive: true })
        const tar = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
        try {
          await runProcess(tar, ['-xf', zip, '-C', staging], { signal, timeoutMs: 10 * 60_000 })
          await assertContained(staging, staging)
          if (!(await findCli(staging))) throw new Error('O zip do whisper.cpp não trouxe o whisper-cli.exe.')
          await rm(binDir(tools), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
          await rename(staging, binDir(tools))
        } catch (err) {
          await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined)
          throw err
        }
        await rm(zip, { force: true }).catch(() => undefined)
        cli = await findCli(binDir(tools))
      }
      if (!cli) throw new Error('Não achei o whisper-cli.exe depois de abrir o pacote.')
      tracker.done('binary', `whisper.cpp ${WCPP_BUILD}`)

      // --- 2. modelo ggml -----------------------------------------------------------------------------------
      current = 'model'
      tracker.begin('model', 'Baixando o modelo…')
      const downloads = [
        { spec: WCPP_VAD_MODEL, dest: vadModelFile(tools) },
        { spec: WCPP_MODEL, dest: modelFile(tools) }
      ]
      const totalBytes = downloads.reduce((a, d) => a + d.spec.size, 0)
      let doneBytes = 0
      for (const d of downloads) {
        const base = doneBytes
        await downloadFile(
          { url: d.spec.url, dest: d.dest, allowedHosts: WCPP_MODEL_HOSTS, size: d.spec.size, sha256: d.spec.sha256 },
          {
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
            signal,
            onProgress: (p) => tracker.progress('model', (base + p.received) / totalBytes, `Baixando ${d.spec.name} · ${bytesLine(base + p.received, totalBytes)}`),
            onNote: (m) => tracker.note(m)
          }
        )
        doneBytes += d.spec.size
      }
      tracker.done('model', 'large-v3-turbo (ggml) e VAD conferidos')

      // --- 3. conferência: o programa abre? ----------------------------------------------------------------
      current = 'check'
      tracker.begin('check', 'Conferindo o whisper.cpp…')
      const help = await runProcess(cli, ['--help'], { signal, timeoutMs: 60_000, cwd: join(cli, '..') }).catch((e: unknown) => {
        // o `--help` do whisper-cli sai com código 0 em umas versões e 1 em outras: o que importa é ele ter aberto e imprimido
        if (e instanceof ProcessError && e.reason === 'exit' && /usage:/i.test(`${e.stderr}${e.stdout}`)) return { stdout: e.stdout, stderr: e.stderr, exitCode: 0 as const }
        throw e
      })
      if (!/usage:/i.test(`${help.stdout}${help.stderr}`)) throw new Error('O whisper-cli.exe abriu, mas não respondeu como esperado.')
      const gpu = await detectGpu()
      const marker: Marker = { version: MARKER_VERSION, build: WCPP_BUILD, cli, gpu: gpu?.name ?? null, completedAt: now().toISOString() }
      await writeFileAtomic(markerFile(tools), `${JSON.stringify(marker, null, 2)}\n`)
      tracker.done('check', gpu ? `Placa ${gpu.name}` : 'Processador')
      logger.info(`whisper.cpp ${WCPP_BUILD} preparado (${gpu?.name ?? 'processador'}).`)
    } catch (err) {
      if (signal.aborted) {
        tracker.cancelled()
        throw err
      }
      const message = err instanceof DownloadError ? err.message : explain(err)
      logger.error(`Preparação do whisper.cpp falhou no passo "${current}".`, err)
      tracker.fail(current, message)
      throw new Error(message)
    }
  }

  async function transcribe(wav: string, opts: TranscribeOptions = {}): Promise<Transcript> {
    if (!isAbsolute(wav) || wav.startsWith('-')) throw new Error('Caminho do áudio inválido para a transcrição.')
    const marker = await readMarker()
    const state = await check()
    if (!marker || state.state !== 'ready') throw new Error(state.detail ?? 'O whisper.cpp não está preparado.')
    // O whisper.cpp escreve `<base>.json`: numa pasta EXCLUSIVA (nome sorteado, vazia), nunca num nome que dê para adivinhar (pid + hora)
    const work = await createTmpDirIn(tools.tmp, 'wcpp-')
    const base = await work.file('resultado')
    const started = performance.now()
    const args = [
      '-m',
      modelFile(tools),
      '-f',
      wav,
      '-l',
      opts.language ?? 'pt',
      '-ojf',
      '-of',
      base,
      // o tempo por palavra (DTW) só funciona com a atenção "flash" desligada
      '-nfa',
      '--dtw',
      'large.v3.turbo',
      '--prompt',
      buildPrompt(opts.vocabulary),
      // sem contexto da frase anterior (equivale a `condition_on_previous_text=False`)
      '-mc',
      '0',
      '-pp'
    ]
    let buffer = ''
    const onStderr = (text: string): void => {
      buffer += text
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const m = /progress\s*=\s*(\d+)\s*%/.exec(line)
        if (m) opts.onProgress?.(Math.min(1, Number(m[1]) / 100))
      }
    }
    const timeoutMs = Math.max(15 * 60_000, (opts.audioMs ?? 0) * 3 + 10 * 60_000)
    try {
      // onde há voz (Silero): corrige o começo/fim das palavras e acha a fala que o Whisper engoliu
      let vad: Range[] = []
      try {
        const vadTool = join(marker.cli, '..', 'whisper-vad-speech-segments.exe')
        const res = await runProcess(vadTool, ['-f', wav, '-vm', vadModelFile(tools), '-vspd', '80', '-vsd', '100', '-vp', '30', '-np'], {
          signal: opts.signal,
          timeoutMs: 10 * 60_000,
          cwd: join(marker.cli, '..')
        })
        vad = parseWhisperCppVad(res.stdout)
      } catch (err) {
        if (opts.signal?.aborted) throw err
        // sem VAD a transcrição ainda sai (só perde a correção de borda e a fala sem palavra): fica no log
        logger.warn('O VAD do whisper.cpp falhou; a transcrição segue sem ele.', err)
      }
      try {
        await runProcess(marker.cli, args, { signal: opts.signal, timeoutMs, cwd: join(marker.cli, '..'), onStderr })
      } catch (err) {
        if (err instanceof ProcessError && err.reason === 'exit') throw new Error(`A transcrição falhou: ${tail(err.stderr, 4) || err.message}`)
        throw err
      }
      const wallMs = performance.now() - started
      let json: unknown
      try {
        json = JSON.parse(await readFile(`${base}.json`, 'utf8'))
      } catch {
        throw new Error('O whisper.cpp terminou, mas não gerou o resultado.')
      }
      const raw = fromWhisperCpp(json)
      const durationMs = opts.audioMs ?? raw.durationMs
      const transcript = buildTranscript({
        engine: WCPP_ENGINE_ID,
        model: raw.model || 'large-v3-turbo (ggml)',
        language: raw.language,
        durationMs,
        words: raw.words,
        segments: raw.segments,
        vad,
        offsetMs: opts.offsetMs ?? 0,
        createdAt: now().toISOString()
      })
      const stats: RunStats = { engine: WCPP_ENGINE_ID, wallMs, audioMs: durationMs, speedX: durationMs / Math.max(1, wallMs) }
      opts.onStats?.(stats)
      opts.onProgress?.(1)
      return transcript
    } finally {
      await removeTmpDir(work.dir, logger)
    }
  }

  return { id: WCPP_ENGINE_ID, check, prepare, transcribe }
}
