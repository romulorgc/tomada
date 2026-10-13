/**
 * O motor da análise da câmera (M4c): o `camera_tools.py` do app, rodando no MESMO venv do Python da transcrição
 * (`%LOCALAPPDATA%\Tomada\python`, caminho sem acento; ver `tools-dir.ts`). O processo principal só executa o `python.exe` do venv e o
 * script do app; o caminho do vídeo chega ao script pelo stdin, montado aqui a partir de uma pasta resolvida por `resolveProjectFile`.
 *
 * Origens fixas (nada vem do renderer): PyPI (os pacotes, pelo pip, que confere o hash de cada roda) e o GitHub do OpenCV Zoo (o
 * modelo do detector de rosto, em revisão fixa, com tamanho e SHA-256 conferidos aqui).
 *
 * Detector de rosto: YuNet (OpenCV Zoo, licença MIT), 232 KB, roda no processador a dezenas de vezes o tempo real.
 * Recorte do fundo: RobustVideoMatting (licença GPL-3.0: aceitável para uso pessoal, registrado no README) em ONNX, na placa de vídeo
 * pelo `onnxruntime-gpu` (o ffmpeg do app grava o vídeo da máscara).
 */
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { FACE_TRACK_VERSION, parseFaceTrack, type FaceTrack } from '@shared/face'
import { contiguousChunks, MATTE_WARMUP_SECONDS, type MatteChunk } from '@shared/matte-parts'
import { writeFileAtomic } from '../fs-utils'
import type { Logger } from '../logger'
import type { PrepareStepId } from '@shared/transcription'
import { ProcessError, runProcess, tail } from '../process-runner'
import { downloadFile, DownloadError } from '../transcription/download'
import { detectNvidiaGpu, explain, FW_CUDA_PACKAGES, FW_PIP_INDEX, parsePipDownloadLine, parsePipProgressLine, pipHasRawProgress, venvPython } from '../transcription/faster-whisper'
import { bytesLine, type PrepareTracker, type StepSpec } from '../transcription/prepare-tracker'
import { joinMatteParts, MatteJoinError } from './matte-join'
import { locatePython, type PythonFound } from '../transcription/python-locator'
import type { ToolPaths } from '../transcription/tools-dir'
import type { CameraCheck, CameraEngine, DetectFacesOptions, MakeMatteOptions, MatteResult } from './types'

export const CAMERA_ENGINE_ID = 'python' as const
/** Pasta dos modelos da câmera, dentro de `models/` das ferramentas. */
export const CAMERA_MODEL_DIR = 'camera'
/** O detector de rosto: OpenCV Zoo, YuNet 2023mar (MIT). Revisão FIXA do repositório; o conteúdo é conferido por SHA-256 de qualquer jeito. */
export const YUNET_FILE = {
  name: 'face_detection_yunet_2023mar.onnx',
  size: 232_589,
  sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
  url: 'https://github.com/opencv/opencv_zoo/raw/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx'
} as const
/**
 * O modelo do recorte do fundo: RobustVideoMatting ResNet50 em ONNX (fp32), versão FIXA (tag v1.0.0), com tamanho e SHA-256 conferidos
 * aqui. Medido numa gravação real na RTX 3050. Licença GPL-3.0: o modelo é baixado na primeira preparação e não faz parte do repositório.
 */
export const MATTE_MODEL = {
  id: 'rvm-resnet50',
  name: 'rvm_resnet50_fp32.onnx',
  size: 107_479_165,
  sha256: '25db300fcb6ee27f941a1b52c97856e8d1f13c7f35817f81a612f89af0e8a85c',
  url: 'https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_resnet50_fp32.onnx'
} as const
/** O GitHub serve os arquivos grandes (LFS) por `media.githubusercontent.com`. */
export const CAMERA_DOWNLOAD_HOSTS = ['github.com', 'githubusercontent.com'] as const
export const CAMERA_PACKAGES = ['opencv-python-headless>=4.9,<5', 'av>=12'] as const
/** O recorte do fundo roda no onnxruntime: o da placa NVIDIA (com as rodas CUDA da transcrição, que já costumam estar lá) ou o do processador. */
export const MATTE_PACKAGES_GPU = ['onnxruntime-gpu>=1.20,<2', ...FW_CUDA_PACKAGES] as const
export const MATTE_PACKAGES_CPU = ['onnxruntime>=1.20,<2'] as const
/** Estimativa do que o pip baixa, para a barra de progresso: o rosto (opencv ~39 MB, av ~30 MB) e o recorte (onnxruntime-gpu ~280 MB). */
const FACE_PIP_ESTIMATE_BYTES = 70_000_000
const MATTE_PIP_ESTIMATE_BYTES = 290_000_000
/** De quanto em quanto tempo o detector olha a imagem (ms): 5 por segundo bastam para um rosto que fala. */
export const FACE_SAMPLE_MS = 200
const MARKER_VERSION = 1
/**
 * A máscara é calculada e gravada numa imagem de no máximo isto (px, lado maior): a de 1080p custa o dobro e a borda sai igual. Uma câmera
 * de 4K chega ao RVM em 1280×720; nada passa de 1080p (o `camera_tools.py` tem o mesmo teto, `MATTE_HARD_MAX_SIDE`).
 */
export const MATTE_MAX_SIDE = 1280
/** Qualidade do vídeo da máscara (x264 crf; baixo = mais fiel). */
export const MATTE_CRF = 14

/** Dois blocos independentes depois do Python: o ROSTO (packages, model, check) e o RECORTE DO FUNDO (matte-*). */
export const CAMERA_STEPS: readonly StepSpec[] = [
  { id: 'python', weight: 2 },
  { id: 'packages', weight: 12 },
  { id: 'model', weight: 1 },
  { id: 'check', weight: 2 },
  { id: 'matte-packages', weight: 38 },
  { id: 'matte-model', weight: 8 },
  { id: 'matte-check', weight: 3 }
]

type Marker = {
  version: number
  python: string
  opencv: string
  av: string
  completedAt: string
  /** O recorte do fundo (M4c): versão do onnxruntime, provedores e a placa; ausente = preparado só com o rosto. */
  onnxruntime?: string
  providers?: string[]
  gpu?: string | null
}

export type PythonCameraDeps = {
  tools: ToolPaths
  /** `resources/camera_tools.py` do app. */
  scriptPath: string
  logger: Logger
  fetchImpl?: typeof fetch
  /** Para os testes. */
  locate?: () => Promise<PythonFound>
  /** Executa os programas (o Python do venv, o pip, o teste final). Os testes trocam por um falso. */
  run?: typeof runProcess
  /** Baixa os modelos. Os testes trocam por um falso. */
  download?: typeof downloadFile
  now?: () => Date
  /** O ffmpeg do app (grava o vídeo da máscara). `null` = não achei. */
  ffmpeg?: () => string | null
  /** A placa NVIDIA (para os testes). */
  detectGpu?: () => Promise<{ name: string } | null>
}

const markerFile = (t: ToolPaths): string => join(t.state, 'camera.json')
export const cameraModelDir = (t: ToolPaths): string => join(t.models, CAMERA_MODEL_DIR)
export const yunetPath = (t: ToolPaths): string => join(cameraModelDir(t), YUNET_FILE.name)
export const mattePath = (t: ToolPaths): string => join(cameraModelDir(t), MATTE_MODEL.name)

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

export function createPythonCamera(deps: PythonCameraDeps): CameraEngine {
  const { tools, logger } = deps
  const locate = deps.locate ?? ((): Promise<PythonFound> => locatePython())
  const run = deps.run ?? runProcess
  const download = deps.download ?? downloadFile
  const now = deps.now ?? ((): Date => new Date())

  const MISSING = 'A análise da câmera ainda não foi preparada neste computador.'

  async function check(): Promise<CameraCheck> {
    const off = { state: 'missing', detail: null } as const
    const missing = (detail: string): CameraCheck => ({ face: { ...off, detail }, matte: { ...off, detail }, device: null })
    const marker = await readMarker(tools)
    if (!marker) return missing(MISSING)
    if (!(await exists(venvPython(tools)))) return missing('O ambiente do Python da análise sumiu. Prepare de novo.')
    const face = (await exists(yunetPath(tools), YUNET_FILE.size))
      ? ({ state: 'ready', detail: null } as const)
      : ({ state: 'missing', detail: 'Falta o modelo que acha o rosto. Prepare de novo para baixar.' } as const)
    const matteMissing = 'O recorte do fundo ainda não está preparado. Prepare para instalar o modelo e a execução na placa de vídeo.'
    const matte: CameraCheck['matte'] =
      marker.onnxruntime && (await exists(mattePath(tools), MATTE_MODEL.size))
        ? { state: 'ready', detail: marker.providers?.includes('CUDAExecutionProvider') ? null : 'Sem placa de vídeo compatível: o recorte do fundo vai rodar no processador (bem mais devagar).' }
        : { state: 'missing', detail: matteMissing }
    return { face, matte, device: marker.providers?.includes('CUDAExecutionProvider') ? (marker.gpu ?? 'Placa NVIDIA') : null }
  }

  /** Roda `pip install` lendo o progresso (`--progress-bar raw`, que só existe do pip 25.1 em diante: `raw = false` para o pip antigo). */
  async function pip(args: string[], tracker: PrepareTracker, signal: AbortSignal, o: { step: PrepareStepId; label: string; estimate: number; raw?: boolean }): Promise<void> {
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
        tracker.progress(o.step, Math.min(0.98, (finished + current) / o.estimate), `${o.label}: ${currentName}`)
        return
      }
      const pr = parsePipProgressLine(line)
      if (pr) {
        current = pr.current
        currentTotal = pr.total
        tracker.progress(o.step, Math.min(0.98, (finished + current) / o.estimate), `Baixando ${currentName} · ${bytesLine(pr.current, pr.total)}`)
      }
    }
    await run(
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
        ...(o.raw === false ? [] : ['--progress-bar', 'raw']),
        '--retries',
        '8',
        '--timeout',
        '30',
        ...args
      ],
      {
        signal,
        timeoutMs: 2 * 60 * 60 * 1000,
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

  /** O pip do venv conhece `--progress-bar raw`? (Um venv novo vem com o pip que o Python trouxe, em geral mais velho que o 25.1.) */
  async function ensureRawProgressPip(tracker: PrepareTracker, signal: AbortSignal): Promise<void> {
    const { stdout } = await run(venvPython(tools), ['-m', 'pip', '--version'], { timeoutMs: 60_000, signal })
    if (pipHasRawProgress(stdout)) return
    // o pip antigo não conhece a barra: esta atualização (2 MB) roda sem ela
    await pip(['--upgrade', 'pip'], tracker, signal, { step: 'packages', label: 'Atualizando o pip', estimate: 4_000_000, raw: false })
  }

  const cancelledError = (): DownloadError => new DownloadError('Cancelado.', false)

  /** Baixa um modelo (origem fixa, tamanho e SHA-256 conferidos) com o progresso no passo `step`. */
  async function fetchModel(file: { url: string; size: number; sha256: string; name: string }, dest: string, tracker: PrepareTracker, signal: AbortSignal, step: PrepareStepId): Promise<void> {
    await download(
      { url: file.url, dest, allowedHosts: CAMERA_DOWNLOAD_HOSTS, size: file.size, sha256: file.sha256 },
      {
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        signal,
        onProgress: (p) => tracker.progress(step, p.received / file.size, `Baixando ${file.name} · ${bytesLine(p.received, file.size)}`),
        onNote: (m) => tracker.note(m)
      }
    )
  }

  type CheckInfo = { python?: string; opencv?: string; av?: string; yunet?: boolean; onnxruntime?: string | null; providers?: string[]; onnxruntimeError?: string }

  async function runCheck(signal: AbortSignal): Promise<CheckInfo> {
    const { stdout } = await run(venvPython(tools), [deps.scriptPath, '--check'], { signal, timeoutMs: 180_000, env: { PYTHONUTF8: '1' } })
    return JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? '{}') as CheckInfo
  }

  /**
   * Duas TRILHAS independentes sobre o mesmo ambiente do Python: o ROSTO (OpenCV, PyAV, detector YuNet) e o RECORTE DO FUNDO
   * (onnxruntime, modelo RVM de 107 MB). Cada uma grava a marca de preparo dela assim que passa na conferência: se o download do RVM
   * cai, o enquadramento do rosto já está pronto e segue disponível (as duas trilhas são independentes); "Tentar de novo" refaz o que falta.
   */
  async function prepare(tracker: PrepareTracker, signal: AbortSignal): Promise<void> {
    let current: PrepareStepId = 'python'
    try {
      await mkdir(tools.base, { recursive: true })
      await mkdir(tools.state, { recursive: true })

      // --- 1. Python e venv (o mesmo da transcrição: se ele já existe e funciona, nada a fazer) -----------------------
      tracker.begin('python', 'Procurando o Python…')
      let pythonVersion = ''
      let venvWorks = false
      if (await exists(venvPython(tools))) {
        try {
          const { stdout } = await run(venvPython(tools), ['-c', 'import sys; print(sys.version.split()[0])'], { timeoutMs: 30_000, signal })
          pythonVersion = stdout.trim()
          venvWorks = pythonVersion.length > 0
        } catch (err) {
          // O venv é COMPARTILHADO com a transcrição: só se refaz com CERTEZA de que está quebrado (o Python dele abriu e falhou, ou nem
          // abre). Cancelar, estourar o tempo ou qualquer outra dúvida sobem como erro, SEM apagar nada.
          if (signal.aborted || !(err instanceof ProcessError) || (err.reason !== 'exit' && err.reason !== 'spawn')) throw err
          venvWorks = false
        }
        if (signal.aborted) throw cancelledError()
      }
      if (!venvWorks) {
        const base = await locate()
        tracker.progress('python', 0.2, `Criando o ambiente do Python ${base.version.join('.')}…`)
        await rm(tools.venv, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
        await run(base.exe, [...base.prefix, '-m', 'venv', tools.venv], { signal, timeoutMs: 10 * 60_000 })
        pythonVersion = base.version.join('.')
      }
      tracker.done('python', `Python ${pythonVersion}`)
      if (signal.aborted) throw cancelledError()

      // --- TRILHA DO ROSTO ------------------------------------------------------------------------------------------
      // 2. pacotes (pip, só do PyPI)
      current = 'packages'
      tracker.begin('packages', 'Preparando o instalador de pacotes…')
      await ensureRawProgressPip(tracker, signal)
      tracker.progress('packages', 0.02, 'Instalando OpenCV e a leitura de vídeo…')
      await pip([...CAMERA_PACKAGES], tracker, signal, { step: 'packages', label: 'Instalando', estimate: FACE_PIP_ESTIMATE_BYTES })
      tracker.done('packages', 'OpenCV e leitura de vídeo')
      if (signal.aborted) throw cancelledError()

      // 3. modelo do detector de rosto
      current = 'model'
      tracker.begin('model', 'Baixando o detector de rosto…')
      await fetchModel(YUNET_FILE, yunetPath(tools), tracker, signal, 'model')
      tracker.done('model', 'YuNet conferido')

      // 4. conferência: o ambiente enxerga o OpenCV e o detector? Passou: o rosto está pronto (a marca é gravada já)
      current = 'check'
      tracker.begin('check', 'Conferindo o detector de rosto…')
      const faceInfo = await runCheck(signal)
      if (!faceInfo.yunet) throw new Error('O OpenCV deste computador não tem o detector de rosto (FaceDetectorYN). Tente de novo.')
      const faceMarker: Marker = {
        version: MARKER_VERSION,
        python: faceInfo.python ?? pythonVersion,
        opencv: faceInfo.opencv ?? '?',
        av: faceInfo.av ?? '?',
        completedAt: now().toISOString()
      }
      await writeFileAtomic(markerFile(tools), `${JSON.stringify(faceMarker, null, 2)}\n`)
      tracker.done('check', `OpenCV ${faceMarker.opencv}`)
      logger.info(`Análise do rosto preparada (OpenCV ${faceMarker.opencv}, PyAV ${faceMarker.av}).`)
      if (signal.aborted) throw cancelledError()

      // --- TRILHA DO RECORTE DO FUNDO ---------------------------------------------------------------------------------
      // 5. onnxruntime (o da placa NVIDIA, com as rodas CUDA da transcrição, ou o do processador)
      current = 'matte-packages'
      tracker.begin('matte-packages', 'Instalando a execução do recorte do fundo…')
      const gpu = await (deps.detectGpu ?? ((): Promise<{ name: string } | null> => detectNvidiaGpu()))()
      await pip([...(gpu ? MATTE_PACKAGES_GPU : MATTE_PACKAGES_CPU)], tracker, signal, { step: 'matte-packages', label: 'Instalando', estimate: MATTE_PIP_ESTIMATE_BYTES })
      tracker.done('matte-packages', gpu ? `onnxruntime na placa ${gpu.name}` : 'onnxruntime (processador)')
      if (signal.aborted) throw cancelledError()

      // 6. modelo do recorte (107 MB)
      current = 'matte-model'
      tracker.begin('matte-model', 'Baixando o modelo do recorte do fundo…')
      await fetchModel(MATTE_MODEL, mattePath(tools), tracker, signal, 'matte-model')
      tracker.done('matte-model', 'RVM conferido')

      // 7. conferência do onnxruntime
      current = 'matte-check'
      tracker.begin('matte-check', 'Conferindo o recorte do fundo…')
      const matteInfo = await runCheck(signal)
      if (!matteInfo.onnxruntime) throw new Error(`O onnxruntime não abriu neste computador (${matteInfo.onnxruntimeError ?? 'motivo desconhecido'}). Tente de novo.`)
      const marker: Marker = { ...faceMarker, onnxruntime: matteInfo.onnxruntime, providers: matteInfo.providers ?? [], gpu: gpu?.name ?? null, completedAt: now().toISOString() }
      await writeFileAtomic(markerFile(tools), `${JSON.stringify(marker, null, 2)}\n`)
      tracker.done('matte-check', matteInfo.providers?.includes('CUDAExecutionProvider') ? 'onnxruntime na placa de vídeo' : 'onnxruntime no processador')
      logger.info(`Recorte do fundo preparado (onnxruntime ${marker.onnxruntime}, ${marker.providers?.join(', ') || 'sem provedores'}).`)
    } catch (err) {
      if (signal.aborted) {
        tracker.cancelled()
        throw err
      }
      const message = explain(err)
      logger.error(`Preparação da análise da câmera falhou no passo "${current}".`, err)
      tracker.fail(current, message)
      throw new Error(message)
    }
  }

  async function detectFaces(o: DetectFacesOptions): Promise<FaceTrack> {
    if (!isAbsolute(o.video) || o.video.startsWith('-')) throw new Error('Caminho do vídeo inválido para a análise da câmera.')
    const state = await check()
    if (state.face.state !== 'ready') throw new Error(state.face.detail ?? 'A análise da câmera não está preparada.')
    const request = JSON.stringify({ mode: 'face', video: o.video, model: yunetPath(tools), sampleMs: FACE_SAMPLE_MS })
    let buffer = ''
    const onStderr = (text: string): void => {
      buffer += text
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const m = /^PROGRESS\s+([\d.]+)/.exec(line)
        if (m) o.onProgress?.(Math.min(1, Math.max(0, Number(m[1]))))
      }
    }
    let stdout: string
    try {
      ;({ stdout } = await runProcess(venvPython(tools), [deps.scriptPath], {
        stdin: request,
        ...(o.signal ? { signal: o.signal } : {}),
        timeoutMs: Math.max(10 * 60_000, o.durationMs * 2 + 5 * 60_000),
        env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        onStderr
      }))
    } catch (err) {
      if (err instanceof ProcessError && err.reason === 'exit') {
        const why = /ERRO: .*/.exec(err.stderr)?.[0] ?? tail(err.stderr, 4)
        throw new Error(`A análise do rosto falhou: ${why || err.message}`)
      }
      throw err
    }
    let json: Record<string, unknown>
    try {
      json = JSON.parse(stdout) as Record<string, unknown>
    } catch {
      throw new Error('A análise do rosto devolveu algo que não é JSON.')
    }
    o.onProgress?.(1)
    return parseFaceTrack(JSON.stringify({ ...json, version: FACE_TRACK_VERSION, createdAt: now().toISOString() }))
  }

  async function makeMatte(o: MakeMatteOptions): Promise<MatteResult> {
    if (!isAbsolute(o.video) || o.video.startsWith('-') || !isAbsolute(o.out) || o.out.startsWith('-')) throw new Error('Caminho inválido para o recorte do fundo.')
    if (o.parts && (!isAbsolute(o.parts.dir) || o.parts.dir.startsWith('-') || !isAbsolute(o.parts.stopFile) || o.parts.stopFile.startsWith('-'))) throw new Error('Caminho inválido para o recorte do fundo.')
    const state = await check()
    if (state.matte.state !== 'ready') throw new Error(state.matte.detail ?? 'O recorte do fundo não está preparado.')
    const ffmpeg = deps.ffmpeg?.() ?? null
    if (!ffmpeg) throw new Error('Não achei o ffmpeg, que grava o vídeo do recorte do fundo. Aponte o ffmpeg nos Ajustes.')
    const parts = o.parts
    const done = parts ? contiguousChunks(parts.done) : []
    const request = JSON.stringify({
      mode: 'matte',
      video: o.video,
      ...(parts
        ? { parts: { dir: parts.dir, chunkSeconds: parts.chunkSeconds, startChunk: done.length, warmupSeconds: MATTE_WARMUP_SECONDS, stopFile: parts.stopFile } }
        : { out: o.out }),
      model: mattePath(tools),
      ffmpeg,
      maxSide: MATTE_MAX_SIDE,
      crf: MATTE_CRF,
      lowPriority: o.lowPriority === true,
      parentPid: process.pid
    })
    let buffer = ''
    const onLine = (line: string): void => {
      const p = /^PROGRESS\s+([\d.]+)/.exec(line)
      if (p) {
        o.onProgress?.(Math.min(1, Math.max(0, Number(p[1]))))
        return
      }
      const c = /^CHUNK\s+(\d+)\s+(\d+)\s+(\d+)/.exec(line)
      if (c && parts) parts.onChunk({ index: Number(c[1]), frames: Number(c[2]), bytes: Number(c[3]) })
    }
    const onStderr = (text: string): void => {
      buffer += text
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    }
    let stdout: string
    try {
      ;({ stdout } = await runProcess(venvPython(tools), [deps.scriptPath], {
        stdin: request,
        ...(o.signal ? { signal: o.signal } : {}),
        // folga larga: na placa roda perto do tempo real; no processador pode levar muitas vezes a duração da gravação
        timeoutMs: Math.max(30 * 60_000, o.durationMs * 12 + 10 * 60_000),
        env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        onStderr
      }))
    } catch (err) {
      if (err instanceof ProcessError && err.reason === 'exit') {
        const why = /ERRO: .*/.exec(err.stderr)?.[0] ?? tail(err.stderr, 4)
        throw new Error(`O recorte do fundo falhou: ${why || err.message}`)
      }
      throw err
    }
    if (buffer) onLine(buffer)
    type Json = {
      engine?: string
      device?: string
      frames?: number
      fps?: number
      frame?: { w?: number; h?: number }
      stats?: { seconds?: number; msPerFrame?: number }
      chunks?: { index?: number; frames?: number }[]
      lastChunk?: number
      stopped?: boolean
      resume?: 'checkpoint' | 'warmup' | null
    }
    let json: Json
    try {
      json = JSON.parse(stdout) as Json
    } catch {
      throw new Error('O recorte do fundo devolveu algo que não é JSON.')
    }
    if (!json.fps || !json.frame?.w || !json.frame.h) throw new Error('O recorte do fundo terminou sem quadros.')
    const result = (frames: number, extra: Partial<MatteResult>): MatteResult => ({
      engine: MATTE_MODEL.id,
      device: json.device ?? 'cpu',
      frames,
      fps: json.fps!,
      frame: { w: json.frame!.w!, h: json.frame!.h! },
      seconds: json.stats?.seconds ?? 0,
      msPerFrame: json.stats?.msPerFrame ?? 0,
      ...extra
    })
    if (!parts) {
      if (!json.frames || json.frames <= 0) throw new Error('O recorte do fundo terminou sem quadros.')
      o.onProgress?.(1)
      return result(json.frames, {})
    }
    // --- em pedaços: os de antes (o serviço guardou) + os desta rodada (o script contou) -------------------------------------
    const fresh: MatteChunk[] = (json.chunks ?? []).filter((c): c is { index: number; frames: number } => Number.isInteger(c.index) && typeof c.frames === 'number' && c.frames > 0).map((c) => ({ index: c.index, frames: c.frames, bytes: 0 }))
    const all = contiguousChunks([...done, ...fresh.filter((c) => !done.some((d) => d.index === c.index))])
    const resume = json.resume === 'checkpoint' || json.resume === 'warmup' ? json.resume : null
    if (json.stopped) return result(all.reduce((sum, c) => sum + c.frames, 0), { stopped: true, chunks: all, resume })
    if (all.length === 0) throw new Error('O recorte do fundo terminou sem quadros.')
    const last = typeof json.lastChunk === 'number' ? json.lastChunk : all.length - 1
    if (all.length !== last + 1) throw new MatteJoinError(`Faltam pedaços do recorte (prontos: ${all.length}, esperados: ${last + 1}).`)
    const frames = all.reduce((sum, c) => sum + c.frames, 0)
    await joinMatteParts({ ffmpeg, dir: parts.dir, indices: all.map((c) => c.index), out: o.out, frames, fps: json.fps, ...(o.signal ? { signal: o.signal } : {}) })
    o.onProgress?.(1)
    return result(frames, { chunks: all, resume })
  }

  return { id: CAMERA_ENGINE_ID, prepareSteps: CAMERA_STEPS, check, prepare, detectFaces, makeMatte }
}
