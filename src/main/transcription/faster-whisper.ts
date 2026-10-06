/**
 * Motor A: faster-whisper `large-v3-turbo` (int8_float16, CUDA) num venv Python do PRÓPRIO app.
 *
 * Tudo que o motor usa mora FORA dos projetos, em `%LOCALAPPDATA%\Tomada` (caminho sem acento, ver `tools-dir.ts`):
 * o venv, as rodas CUDA e o modelo. O processo principal só executa o `python.exe` do venv e o `transcribe.py` do
 * app; o caminho do áudio chega ao script pelo stdin, montado aqui a partir de uma pasta fixa.
 *
 * Origens fixas (nada vem do renderer): PyPI (rodas, pelo pip, que confere o hash de cada uma) e Hugging Face (o
 * modelo, em revisão fixa, com tamanho e SHA-256 de cada arquivo conferidos aqui). Preparação retomável: o pip
 * guarda o que já baixou no cache e o modelo baixa por `.part` com `Range`.
 */
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fromFasterWhisper } from '@shared/transcript-engines'
import { buildTranscript } from '@shared/transcript'
import type { Transcript } from '@shared/types'
import { writeFileAtomic } from '../fs-utils'
import type { Logger } from '../logger'
import { ProcessError, runProcess, tail } from '../process-runner'
import { downloadFile, DownloadError } from './download'
import { bytesLine, type PrepareTracker } from './prepare-tracker'
import type { ToolPaths } from './tools-dir'
import { buildHotwords, buildPrompt, type EngineCheck, type RunStats, type Transcriber, type TranscribeOptions } from './types'
import { locatePython, type PythonFound } from './python-locator'

export const FW_ENGINE_ID = 'faster-whisper' as const
export const FW_MODEL_DIR = 'faster-whisper-large-v3-turbo'
/** Revisão FIXA do modelo no Hugging Face (o conteúdo é conferido por SHA-256 de qualquer jeito). */
export const FW_MODEL_REPO = 'dropbox-dash/faster-whisper-large-v3-turbo'
export const FW_MODEL_REVISION = '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf'
export const FW_MODEL_FILES: readonly { name: string; size: number; sha256: string }[] = [
  { name: 'config.json', size: 2263, sha256: 'b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e' },
  { name: 'preprocessor_config.json', size: 340, sha256: '7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711' },
  { name: 'tokenizer.json', size: 2710337, sha256: '297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd' },
  { name: 'vocabulary.json', size: 1068114, sha256: 'c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1' },
  { name: 'model.bin', size: 1617884929, sha256: 'e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da' }
]
/** O Hugging Face serve os arquivos grandes por CDNs dentro destes domínios. */
export const FW_DOWNLOAD_HOSTS = ['huggingface.co', 'hf.co'] as const
export const FW_PIP_INDEX = 'https://pypi.org/simple'
/** Pacotes (versões fixadas onde importa). As rodas CUDA só entram se houver placa NVIDIA. */
export const FW_PACKAGES = ['faster-whisper==1.2.1'] as const
export const FW_CUDA_PACKAGES = ['nvidia-cublas-cu12>=12.4,<13', 'nvidia-cudnn-cu12>=9,<10'] as const
/** Estimativa do que o pip baixa com CUDA (cuDNN 743 MB + cuBLAS 553 MB + o resto), para a barra de progresso. */
export const FW_PIP_ESTIMATE_BYTES = 1_450_000_000
const MARKER_VERSION = 1

export type GpuInfo = { name: string; memoryMiB: number }

/** A placa NVIDIA, pelo `nvidia-smi` (null = não há, ou o driver não está instalado). */
export async function detectNvidiaGpu(env: NodeJS.ProcessEnv = process.env): Promise<GpuInfo | null> {
  const candidates = [join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe'), 'nvidia-smi']
  for (const exe of candidates) {
    try {
      const { stdout } = await runProcess(exe, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeoutMs: 15_000 })
      const line = stdout.trim().split(/\r?\n/)[0] ?? ''
      const at = line.lastIndexOf(',')
      if (at < 0) continue
      const name = line.slice(0, at).trim()
      const memoryMiB = Number(line.slice(at + 1).trim())
      if (name) return { name, memoryMiB: Number.isFinite(memoryMiB) ? memoryMiB : 0 }
    } catch {
      // sem este: o próximo
    }
  }
  return null
}

type Marker = {
  version: number
  device: 'cuda' | 'cpu'
  computeType: string
  gpu: string | null
  python: string
  fasterWhisper: string
  ctranslate2: string
  completedAt: string
}

export type FasterWhisperDeps = {
  tools: ToolPaths
  /** `resources/transcribe.py` do app. */
  scriptPath: string
  logger: Logger
  fetchImpl?: typeof fetch
  /** Para os testes. */
  locate?: () => Promise<PythonFound>
  detectGpu?: () => Promise<GpuInfo | null>
  now?: () => Date
}

const markerFile = (t: ToolPaths): string => join(t.state, 'faster-whisper.json')
export const venvPython = (t: ToolPaths): string => join(t.venv, 'Scripts', 'python.exe')
export const modelDir = (t: ToolPaths): string => join(t.models, FW_MODEL_DIR)

async function exists(path: string, size?: number): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && (size === undefined || info.size === size)
  } catch {
    return false
  }
}

async function readMarker(t: ToolPaths): Promise<Marker | null> {
  try {
    const m = JSON.parse(await readFile(markerFile(t), 'utf8')) as Marker
    return m && m.version === MARKER_VERSION ? m : null
  } catch {
    return null
  }
}

/** `pip --version` ("pip 25.1.1 from ..."): o pip conhece `--progress-bar raw`? Só do 25.1 em diante; o de um venv novo costuma ser mais velho. */
export function pipHasRawProgress(versionOutput: string): boolean {
  const m = /pip\s+(\d+)\.(\d+)/.exec(versionOutput)
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > 25 || (major === 25 && minor >= 1)
}

/** `Downloading nvidia_cudnn_cu12-9.27.0.42-py3-none-win_amd64.whl (743.1 MB)` → { name, bytes }. */
export function parsePipDownloadLine(line: string): { name: string; bytes: number } | null {
  const m = /^(?:Downloading|Using cached)\s+(\S+)\s+\(([\d.,]+)\s*(kB|MB|GB|B)\)/.exec(line.trim())
  if (!m || m[1]!.endsWith('.metadata')) return null
  const n = Number(m[2]!.replace(',', '.'))
  const unit = { B: 1, kB: 1000, MB: 1000 ** 2, GB: 1000 ** 3 }[m[3] as 'B' | 'kB' | 'MB' | 'GB']
  return Number.isFinite(n) ? { name: m[1]!, bytes: Math.round(n * unit) } : null
}

/** `Progress 262144 of 27595679` → { current, total }. */
export function parsePipProgressLine(line: string): { current: number; total: number } | null {
  const m = /^Progress\s+(\d+)\s+of\s+(\d+)/.exec(line.trim())
  return m ? { current: Number(m[1]), total: Number(m[2]) } : null
}

export function createFasterWhisper(deps: FasterWhisperDeps): Transcriber {
  const { tools, logger } = deps
  const locate = deps.locate ?? ((): Promise<PythonFound> => locatePython())
  const detectGpu = deps.detectGpu ?? ((): Promise<GpuInfo | null> => detectNvidiaGpu())
  const now = deps.now ?? ((): Date => new Date())

  async function modelComplete(): Promise<boolean> {
    for (const f of FW_MODEL_FILES) if (!(await exists(join(modelDir(tools), f.name), f.size))) return false
    return true
  }

  async function check(): Promise<EngineCheck> {
    const marker = await readMarker(tools)
    if (!marker) return { state: 'missing', detail: 'A transcrição ainda não foi preparada neste computador.', device: null }
    if (!(await exists(venvPython(tools)))) return { state: 'missing', detail: 'O ambiente do Python da transcrição sumiu. Prepare de novo.', device: null }
    if (!(await modelComplete())) return { state: 'missing', detail: 'Faltam arquivos do modelo de transcrição. Prepare de novo para baixar o que falta.', device: null }
    return { state: 'ready', detail: null, device: marker.device === 'cuda' ? marker.gpu : null }
  }

  async function pipHasRaw(): Promise<boolean> {
    const { stdout } = await runProcess(venvPython(tools), ['-m', 'pip', '--version'], { timeoutMs: 60_000 })
    return pipHasRawProgress(stdout)
  }

  /** Roda `pip install` lendo o progresso (`--progress-bar raw`). */
  async function pip(args: string[], tracker: PrepareTracker, signal: AbortSignal, label: string, raw = true): Promise<void> {
    let buffer = ''
    let finished = 0
    let current = 0
    let currentTotal = 0
    let currentName = ''
    const onLine = (line: string): void => {
      const dl = parsePipDownloadLine(line)
      if (dl) {
        finished += currentTotal
        currentTotal = dl.bytes
        current = line.trim().startsWith('Using cached') ? dl.bytes : 0
        currentName = dl.name
        tracker.progress('packages', Math.min(0.98, (finished + current) / FW_PIP_ESTIMATE_BYTES), `${label}: ${currentName}`)
        return
      }
      const pr = parsePipProgressLine(line)
      if (pr) {
        current = pr.current
        currentTotal = pr.total
        tracker.progress('packages', Math.min(0.98, (finished + current) / FW_PIP_ESTIMATE_BYTES), `Baixando ${currentName} · ${bytesLine(pr.current, pr.total)}`)
      }
    }
    await runProcess(
      venvPython(tools),
      [
        '-m',
        'pip',
        'install',
        '--isolated',
        '--disable-pip-version-check',
        '--no-input',
        '--only-binary=:all:',
        '--index-url',
        FW_PIP_INDEX,
        '--cache-dir',
        tools.pipCache,
        '--progress-bar',
        raw ? 'raw' : 'off',
        '--retries',
        '8',
        '--timeout',
        '30',
        ...args
      ],
      {
        signal,
        timeoutMs: 6 * 60 * 60 * 1000,
        env: { PYTHONUTF8: '1' },
        onStdout: (text) => {
          buffer += text
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''
          for (const l of lines) onLine(l)
        }
      }
    )
  }

  async function prepare(tracker: PrepareTracker, signal: AbortSignal): Promise<void> {
    let current: 'python' | 'packages' | 'model' | 'check' = 'python'
    try {
      await mkdir(tools.base, { recursive: true })
      await mkdir(tools.state, { recursive: true })

      // --- 1. Python e venv -------------------------------------------------------------------------------
      tracker.begin('python', 'Procurando o Python…')
      let pythonVersion = ''
      const venvOk = await exists(venvPython(tools))
      let venvWorks = false
      if (venvOk) {
        try {
          const { stdout } = await runProcess(venvPython(tools), ['-c', 'import sys; print(sys.version.split()[0])'], { timeoutMs: 30_000, signal })
          pythonVersion = stdout.trim()
          venvWorks = pythonVersion.length > 0
        } catch {
          venvWorks = false
        }
      }
      if (!venvWorks) {
        const base = await locate()
        tracker.progress('python', 0.2, `Criando o ambiente do Python ${base.version.join('.')}…`)
        await rm(tools.venv, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
        // o venv fica num caminho SEM acento (`tools-dir.ts`): é o que faz o ensurepip e o pip funcionarem
        await runProcess(base.exe, [...base.prefix, '-m', 'venv', tools.venv], { signal, timeoutMs: 10 * 60_000 })
        pythonVersion = base.version.join('.')
      }
      tracker.done('python', `Python ${pythonVersion}`)
      if (signal.aborted) throw new DownloadError('Cancelado.', false)

      // --- 2. pacotes (pip, só do PyPI) ---------------------------------------------------------------------
      current = 'packages'
      tracker.begin('packages', 'Preparando o instalador de pacotes…')
      const gpu = await detectGpu()
      if (!(await pipHasRaw())) {
        // o pip antigo do venv não conhece `--progress-bar raw`: esta atualização (2 MB) roda sem barra
        await pip(['--upgrade', 'pip'], tracker, signal, 'Atualizando o pip', false)
      }
      const wanted = [...FW_PACKAGES, ...(gpu ? FW_CUDA_PACKAGES : [])]
      tracker.progress('packages', 0.02, gpu ? `Instalando a transcrição na placa ${gpu.name}…` : 'Instalando a transcrição (sem placa NVIDIA: usará o processador)…')
      await pip(wanted, tracker, signal, 'Instalando')
      tracker.done('packages', gpu ? `faster-whisper + CUDA 12 (${gpu.name})` : 'faster-whisper (processador)')
      if (signal.aborted) throw new DownloadError('Cancelado.', false)

      // --- 3. modelo (Hugging Face, revisão fixa, com tamanho e SHA-256) -----------------------------------------
      current = 'model'
      tracker.begin('model', 'Baixando o modelo de transcrição…')
      const totalBytes = FW_MODEL_FILES.reduce((a, f) => a + f.size, 0)
      let done = 0
      for (const f of FW_MODEL_FILES) {
        const base = done
        await downloadFile(
          {
            url: `https://huggingface.co/${FW_MODEL_REPO}/resolve/${FW_MODEL_REVISION}/${f.name}`,
            dest: join(modelDir(tools), f.name),
            allowedHosts: FW_DOWNLOAD_HOSTS,
            size: f.size,
            sha256: f.sha256
          },
          {
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
            signal,
            onProgress: (p) => tracker.progress('model', (base + p.received) / totalBytes, `Baixando ${f.name} · ${bytesLine(base + p.received, totalBytes)}`),
            onNote: (m) => tracker.note(m)
          }
        )
        done += f.size
      }
      tracker.done('model', 'large-v3-turbo conferido')

      // --- 4. conferência: o ambiente enxerga a placa? ---------------------------------------------------------
      current = 'check'
      tracker.begin('check', 'Conferindo a transcrição…')
      const { stdout } = await runProcess(venvPython(tools), [deps.scriptPath, '--check'], { signal, timeoutMs: 180_000, env: { PYTHONUTF8: '1' } })
      const info = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? '{}') as { python?: string; fasterWhisper?: string; ctranslate2?: string; cudaDevices?: number; computeTypes?: string[] }
      const cuda = (info.cudaDevices ?? 0) > 0
      if (gpu && !cuda) tracker.note('As bibliotecas da placa NVIDIA não funcionaram neste computador: a transcrição vai usar o processador (mais lenta).')
      const computeType = cuda ? ((info.computeTypes ?? []).includes('int8_float16') ? 'int8_float16' : 'float16') : 'int8'
      const marker: Marker = {
        version: MARKER_VERSION,
        device: cuda ? 'cuda' : 'cpu',
        computeType,
        gpu: cuda ? (gpu?.name ?? null) : null,
        python: info.python ?? pythonVersion,
        fasterWhisper: info.fasterWhisper ?? '?',
        ctranslate2: info.ctranslate2 ?? '?',
        completedAt: now().toISOString()
      }
      await writeFileAtomic(markerFile(tools), `${JSON.stringify(marker, null, 2)}\n`)
      // as rodas ficam instaladas no venv: o cache do pip (mais de 1 GB) já não serve para nada
      await rm(tools.pipCache, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined)
      tracker.done('check', cuda ? `Placa ${gpu?.name ?? 'NVIDIA'} pronta (${computeType})` : 'Processador')
      logger.info(`Transcrição preparada (${marker.device}, ${computeType}, faster-whisper ${marker.fasterWhisper}, ctranslate2 ${marker.ctranslate2}).`)
    } catch (err) {
      if (signal.aborted) {
        tracker.cancelled()
        throw err
      }
      const message = explain(err)
      logger.error(`Preparação da transcrição falhou no passo "${current}".`, err)
      tracker.fail(current, message)
      throw new Error(message)
    }
  }

  async function transcribe(wav: string, opts: TranscribeOptions = {}): Promise<Transcript> {
    if (!isAbsolute(wav) || wav.startsWith('-')) throw new Error('Caminho do áudio inválido para a transcrição.')
    const marker = await readMarker(tools)
    const state = await check()
    if (!marker || state.state !== 'ready') throw new Error(state.detail ?? 'A transcrição não está preparada.')
    const started = performance.now()
    const language = opts.language ?? 'pt'
    const request = JSON.stringify({
      audio: wav,
      modelDir: modelDir(tools),
      language,
      prompt: buildPrompt(opts.vocabulary),
      hotwords: buildHotwords(opts.vocabulary),
      device: marker.device,
      computeType: marker.computeType
    })
    let buffer = ''
    const onStderr = (text: string): void => {
      buffer += text
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const m = /^PROGRESS\s+([\d.]+)/.exec(line)
        if (m) opts.onProgress?.(Math.min(1, Math.max(0, Number(m[1]))))
      }
    }
    const timeoutMs = Math.max(15 * 60_000, (opts.audioMs ?? 0) * 3 + 10 * 60_000)
    let stdout: string
    try {
      ;({ stdout } = await runProcess(venvPython(tools), [deps.scriptPath], {
        stdin: request,
        signal: opts.signal,
        timeoutMs,
        env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1' },
        onStderr
      }))
    } catch (err) {
      if (err instanceof ProcessError && err.reason === 'exit') {
        const why = /ERRO: .*/.exec(err.stderr)?.[0] ?? tail(err.stderr, 4)
        throw new Error(`A transcrição falhou: ${why || err.message}`)
      }
      throw err
    }
    const wallMs = performance.now() - started
    let json: unknown
    try {
      json = JSON.parse(stdout)
    } catch {
      throw new Error('O motor de transcrição devolveu algo que não é JSON.')
    }
    const raw = fromFasterWhisper(json)
    const transcript = buildTranscript({
      engine: FW_ENGINE_ID,
      model: raw.model,
      language: raw.language,
      durationMs: raw.durationMs,
      words: raw.words,
      segments: raw.segments,
      vad: raw.vad,
      offsetMs: opts.offsetMs ?? 0,
      createdAt: now().toISOString()
    })
    const stats: RunStats = {
      engine: FW_ENGINE_ID,
      wallMs,
      audioMs: raw.durationMs,
      speedX: raw.durationMs / Math.max(1, wallMs),
      ...(raw.stats.loadSeconds !== undefined ? { loadMs: raw.stats.loadSeconds * 1000 } : {}),
      ...(raw.stats.transcribeSeconds !== undefined ? { transcribeMs: raw.stats.transcribeSeconds * 1000 } : {})
    }
    opts.onStats?.(stats)
    opts.onProgress?.(1)
    return transcript
  }

  return { id: FW_ENGINE_ID, check, prepare, transcribe }
}

/** Mensagem para a pessoa (sem jargão do pip) a partir do erro de qualquer passo da preparação. */
export function explain(err: unknown): string {
  if (err instanceof ProcessError) {
    if (err.reason === 'spawn') return err.message
    if (err.reason === 'timeout') return 'A preparação passou do tempo limite. Confira a internet e tente de novo: o que já foi baixado não se perde.'
    const text = `${err.stderr}\n${err.stdout}`
    if (/No matching distribution|Could not find a version|Could not fetch URL|Connection (?:aborted|reset|broken)|Temporary failure|getaddrinfo|ReadTimeout|ConnectTimeout|NewConnectionError|MaxRetryError/i.test(text)) {
      return 'Não consegui baixar os pacotes (a internet caiu ou o servidor não respondeu). Tente de novo: o que já foi baixado não se perde.'
    }
    if (/No space left|Errno 28|espaço insuficiente/i.test(text)) return 'O disco ficou sem espaço durante a preparação. Libere uns 4 GB e tente de novo.'
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}
