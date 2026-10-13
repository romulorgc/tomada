/**
 * Tipos da ANÁLISE DA CÂMERA (M4c) que atravessam a ponte: o rosto (enquadramento) e, na etapa do recorte, a máscara de fundo.
 * Mesma forma da transcrição: um motor que precisa ser PREPARADO uma vez (pacotes e modelos), uma fila de trabalhos (a placa é
 * uma só) e o resultado guardado na pasta do projeto, em cache. Código puro: sem DOM, sem Node.
 */
import type { JobState, PrepareSnapshot } from './transcription'

/** O que a análise produz: `face` = onde está o rosto (enquadramento); `matte` = a máscara do fundo (apresentador recortado). */
export type CameraKind = 'face' | 'matte'
export const CAMERA_KINDS: readonly CameraKind[] = ['face', 'matte']

/** Quem faz a análise. `mock` só existe em teste (`TOMADA_CAMERA=mock`). */
export type CameraEngineId = 'python' | 'mock'

export type CameraFeatureState = {
  /** Pronto, falta preparar, preparando agora, ou a última preparação falhou. */
  state: 'ready' | 'missing' | 'preparing' | 'error'
  /** O que falta ou o que deu errado, em português. */
  detail: string | null
}

export type CameraJob = {
  projectId: string
  kind: CameraKind
  state: JobState
  /** 0..1 */
  fraction: number
  /** Motivo, quando falhou ou foi cancelado. */
  error?: string
  /** Terminou: o resultado já existe. `url` é a do arquivo (com a versão), para a interface ler. */
  url?: string
  /** `face`: quantos rostos entraram e quanto da gravação tem rosto (0..1), para a interface dizer. */
  faces?: number
  coverage?: number
  /** `matte`: continua de pedaços que já estavam prontos (o app fechou ou o recorte parou antes). */
  resumed?: boolean
  /** `matte`, na fila: dando lugar a uma exportação, à transcrição ou à prévia (a GPU é uma só). */
  waiting?: 'gpu'
}

export type CameraView = {
  engine: CameraEngineId
  face: CameraFeatureState
  matte: CameraFeatureState
  /** A placa usada ("NVIDIA GeForce RTX 3050") ou null se for o processador. */
  device: string | null
  prepare: PrepareSnapshot | null
  jobs: CameraJob[]
}
