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
import { writeFileAtomic } from '../fs-utils'
import type { Logger } from '../logger'
import { ProcessError, runProcess, tail } from '../process-runner'
import { downloadFile, DownloadError } from '../transcription/download'
import { detectNvidiaGpu, explain, FW_CUDA_PACKAGES, FW_PIP_INDEX, parsePipDownloadLine, parsePipProgressLine, venvPython } from '../transcription/faster-whisper'
import { bytesLine, type PrepareTracker, type StepSpec } from '../transcription/prepare-tracker'
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
 * aqui. Medido na gravação real do usuário na RTX 3050 (ver README, "Recorte do fundo"). Licença GPL-3.0 (uso pessoal: registrado).
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
/** Estimativa do que o pip baixa (opencv ~39 MB, av ~30 MB, onnxruntime-gpu ~280 MB), para a barra de progresso. */
const PIP_ESTIMATE_BYTES = 360_000_000
/** De quanto em quanto tempo o detector olha a imagem (ms): 5 por segundo bastam para um rosto que fala. */
export const FACE_SAMPLE_MS = 200
const MARKER_VERSION = 1
/** A máscara é calculada e gravada numa imagem de no máximo isto (px, lado maior): a de 1080p custa o dobro e a borda sai igual. */
export const MATTE_MAX_SIDE = 1280
/** Qualidade do vídeo da máscara (x264 crf; baixo = mais fiel). */
export const MATTE_CRF = 14

export const CAMERA_STEPS: readonly StepSpec[] = [
  { id: 'python', weight: 2 },
  { id: 'packages', weight: 50 },
  { id: 'model', weight: 8 },
  { id: 'check', weight: 5 }
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

  /** Roda `pip install` lendo o progresso (`--progress-bar raw`). */
  async function pip(args: string[], tracker: PrepareTracker, signal: AbortSignal, label: string): Promise<void> {
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
        tracker.progress('packages', Math.min(0.98, (finished + current) / PIP_ESTIMATE_BYTES), `${label}: ${currentName}`)
        return
      }
      const pr = parsePipProgressLine(line)
      if (pr) {
        current = pr.current
        currentTotal = pr.total
        tracker.progress('packages', Math.min(0.98, (finished + current) / PIP_ESTIMATE_BYTES), `Baixando ${currentName} · ${bytesLine(pr.current, pr.total)}`)
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
        'raw',
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

  async function prepare(tracker: PrepareTracker, signal: AbortSignal): Promise<void> {
    let current: 'python' | 'packages' | 'model' | 'check' = 'python'
    try {
      await mkdir(tools.base, { recursive: true })
      await mkdir(tools.state, { recursive: true })

      // --- 1. Python e venv (o mesmo da transcrição: se ele já existe, nada a fazer) ---------------------------------
      tracker.begin('python', 'Procurando o Python…')
      let pythonVersion = ''
      let venvWorks = false
      if (await exists(venvPython(tools))) {
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
        await runProcess(base.exe, [...base.prefix, '-m', 'venv', tools.venv], { signal, timeoutMs: 10 * 60_000 })
        pythonVersion = base.version.join('.')
      }
      tracker.done('python', `Python ${pythonVersion}`)
      if (signal.aborted) throw new DownloadError('Cancelado.', false)

      // --- 2. pacotes (pip, só do PyPI) ----------------------------------------------------------------------------
      current = 'packages'
      tracker.begin('packages', 'Instalando os pacotes da análise da câmera…')
      const gpu = await (deps.detectGpu ?? ((): Promise<{ name: string } | null> => detectNvidiaGpu()))()
      await pip([...CAMERA_PACKAGES, ...(gpu ? MATTE_PACKAGES_GPU : MATTE_PACKAGES_CPU)], tracker, signal, 'Instalando')
      tracker.done('packages', gpu ? `OpenCV, leitura de vídeo e onnxruntime na placa ${gpu.name}` : 'OpenCV, leitura de vídeo e onnxruntime (processador)')
      if (signal.aborted) throw new DownloadError('Cancelado.', false)

      // --- 3. modelo do detector de rosto (revisão fixa, com tamanho e SHA-256) -------------------------------------
      current = 'model'
      tracker.begin('model', 'Baixando o detector de rosto…')
      await downloadFile(
        { url: YUNET_FILE.url, dest: yunetPath(tools), allowedHosts: CAMERA_DOWNLOAD_HOSTS, size: YUNET_FILE.size, sha256: YUNET_FILE.sha256 },
        {
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          signal,
          onProgress: (p) => tracker.progress('model', p.received / YUNET_FILE.size, `Baixando ${YUNET_FILE.name} · ${bytesLine(p.received, YUNET_FILE.size)}`),
          onNote: (m) => tracker.note(m)
        }
      )
      tracker.progress('model', 0.5, 'Baixando o modelo do recorte do fundo…')
      await downloadFile(
        { url: MATTE_MODEL.url, dest: mattePath(tools), allowedHosts: CAMERA_DOWNLOAD_HOSTS, size: MATTE_MODEL.size, sha256: MATTE_MODEL.sha256 },
        {
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          signal,
          onProgress: (p) => tracker.progress('model', 0.5 + (0.5 * p.received) / MATTE_MODEL.size, `Baixando ${MATTE_MODEL.name} · ${bytesLine(p.received, MATTE_MODEL.size)}`),
          onNote: (m) => tracker.note(m)
        }
      )
      tracker.done('model', 'YuNet e RVM conferidos')

      // --- 4. conferência: o ambiente enxerga o OpenCV e o detector? ---------------------------------------------------
      current = 'check'
      tracker.begin('check', 'Conferindo a análise da câmera…')
      const { stdout } = await runProcess(venvPython(tools), [deps.scriptPath, '--check'], { signal, timeoutMs: 180_000, env: { PYTHONUTF8: '1' } })
      const info = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? '{}') as {
        python?: string
        opencv?: string
        av?: string
        yunet?: boolean
        onnxruntime?: string | null
        providers?: string[]
        onnxruntimeError?: string
      }
      if (!info.yunet) throw new Error('O OpenCV deste computador não tem o detector de rosto (FaceDetectorYN). Tente de novo.')
      if (!info.onnxruntime) throw new Error(`O onnxruntime não abriu neste computador (${info.onnxruntimeError ?? 'motivo desconhecido'}). Tente de novo.`)
      const marker: Marker = {
        version: MARKER_VERSION,
        python: info.python ?? pythonVersion,
        opencv: info.opencv ?? '?',
        av: info.av ?? '?',
        completedAt: now().toISOString(),
        onnxruntime: info.onnxruntime,
        providers: info.providers ?? [],
        gpu: gpu?.name ?? null
      }
      await writeFileAtomic(markerFile(tools), `${JSON.stringify(marker, null, 2)}\n`)
      tracker.done('check', `OpenCV ${marker.opencv}`)
      logger.info(`Análise da câmera preparada (OpenCV ${marker.opencv}, PyAV ${marker.av}).`)
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
    const state = await check()
    if (state.matte.state !== 'ready') throw new Error(state.matte.detail ?? 'O recorte do fundo não está preparado.')
    const ffmpeg = deps.ffmpeg?.() ?? null
    if (!ffmpeg) throw new Error('Não achei o ffmpeg, que grava o vídeo do recorte do fundo. Aponte o ffmpeg nos Ajustes.')
    const request = JSON.stringify({ mode: 'matte', video: o.video, out: o.out, model: mattePath(tools), ffmpeg, maxSide: MATTE_MAX_SIDE, crf: MATTE_CRF })
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
    let json: { engine?: string; device?: string; frames?: number; fps?: number; frame?: { w?: number; h?: number }; stats?: { seconds?: number; msPerFrame?: number } }
    try {
      json = JSON.parse(stdout) as typeof json
    } catch {
      throw new Error('O recorte do fundo devolveu algo que não é JSON.')
    }
    if (!json.frames || json.frames <= 0 || !json.fps || !json.frame?.w || !json.frame.h) throw new Error('O recorte do fundo terminou sem quadros.')
    o.onProgress?.(1)
    return {
      engine: MATTE_MODEL.id,
      device: json.device ?? 'cpu',
      frames: json.frames,
      fps: json.fps,
      frame: { w: json.frame.w, h: json.frame.h },
      seconds: json.stats?.seconds ?? 0,
      msPerFrame: json.stats?.msPerFrame ?? 0
    }
  }

  return { id: CAMERA_ENGINE_ID, prepareSteps: CAMERA_STEPS, check, prepare, detectFaces, makeMatte }
}
