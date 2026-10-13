/**
 * Contrato dos motores da análise da câmera (M4c). Quem usa (o serviço, os testes) só conhece esta interface.
 */
import type { CameraEngineId, CameraFeatureState } from '@shared/camera-analysis'
import type { FaceTrack } from '@shared/face'
import type { MatteChunk } from '@shared/matte-parts'
import type { PrepareTracker, StepSpec } from '../transcription/prepare-tracker'

export type CameraCheck = {
  face: CameraFeatureState
  matte: CameraFeatureState
  /** A placa usada ("NVIDIA GeForce RTX 3050 Laptop GPU") ou null se for o processador. */
  device: string | null
}

export type DetectFacesOptions = {
  /** Arquivo da câmera, caminho ABSOLUTO já resolvido por `resolveProjectFile`. */
  video: string
  /** Duração conhecida (ms): dá o tempo limite proporcional. */
  durationMs: number
  signal?: AbortSignal
  /** 0..1 */
  onProgress?: (fraction: number) => void
}

/** O recorte em PEDAÇOS retomável (R1): o motor grava um mp4 por pedaço em `dir` e, no fim, junta todos em `out`. */
export type MatteParts = {
  /** Pasta dos pedaços (absoluta, dentro do projeto, já resolvida pelo serviço). */
  dir: string
  /** Duração de cada pedaço (s). */
  chunkSeconds: number
  /** Os pedaços que já estão prontos, do 0 em diante e sem buracos: o motor começa no seguinte. */
  done: MatteChunk[]
  /** Avisa cada pedaço que ficou pronto (o arquivo já tem o nome final): o serviço guarda o andamento no projeto. */
  onChunk(chunk: MatteChunk): void
  /**
   * Arquivo-sentinela: se ele aparecer, o motor PARA no fim do pedaço em curso (sem perder trabalho) e devolve `stopped: true`.
   * É como o recorte dá lugar a uma exportação.
   */
  stopFile: string
}

export type MakeMatteOptions = {
  /** Arquivo da câmera, caminho ABSOLUTO já resolvido por `resolveProjectFile`. */
  video: string
  /** Onde a máscara é gravada (MP4 em tons de cinza): caminho absoluto, dentro da pasta do projeto, já resolvido. */
  out: string
  durationMs: number
  signal?: AbortSignal
  /** 0..1 */
  onProgress?: (fraction: number) => void
  /** Presente: grava em pedaços (retomável) e junta tudo em `out` no fim. Ausente: um arquivo só, direto em `out`. */
  parts?: MatteParts
  /** Roda com prioridade abaixo do normal (trabalho de fundo: não atrapalha a pessoa nem a prévia). */
  lowPriority?: boolean
}

export type MatteResult = {
  /** O modelo que fez a máscara. */
  engine: string
  /** A placa usada ("cuda") ou "cpu". */
  device: string
  frames: number
  fps: number
  frame: { w: number; h: number }
  /** Quanto durou e quanto custou cada quadro (ms), para o relatório e o log. */
  seconds: number
  msPerFrame: number
  /** Em pedaços: o motor parou a pedido (`stopFile`) no fim de um pedaço; `out` NÃO foi gerado e os pedaços prontos ficam para a retomada. */
  stopped?: boolean
  /** Em pedaços: todos os pedaços prontos depois desta rodada (os de antes e os novos). */
  chunks?: MatteChunk[]
  /**
   * Em pedaços, rodada que RETOMOU de pedaços já prontos: `checkpoint` = continuou do estado do RVM guardado (máscara idêntica à rodada contínua);
   * `warmup` = não havia ponto de retomada e o RVM foi aquecido com 1 s de vídeo (máscara visualmente igual, não idêntica). Ausente = rodada que começou do zero.
   */
  resume?: 'checkpoint' | 'warmup' | null
}

export interface CameraEngine {
  readonly id: CameraEngineId
  /** Os passos da preparação de primeira vez (com peso), para o rastreador. */
  readonly prepareSteps: readonly StepSpec[]
  /** Está tudo no lugar? Rápido: só olha arquivos e a marca de "preparado". */
  check(): Promise<CameraCheck>
  /** Prepara de primeira vez (ou retoma/repara). Lança com o motivo; o rastreador já foi avisado. */
  prepare(tracker: PrepareTracker, signal: AbortSignal): Promise<void>
  /** Acha o rosto ao longo da gravação (uma olhada a cada `sampleMs`). */
  detectFaces(opts: DetectFacesOptions): Promise<FaceTrack>
  /** Recorta o fundo da câmera quadro a quadro (a pessoa em branco) e grava o vídeo da máscara em `out`. Lança com o motivo. */
  makeMatte(opts: MakeMatteOptions): Promise<MatteResult>
}
