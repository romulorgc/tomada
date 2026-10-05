/**
 * Contrato dos motores de transcrição. Quem usa (o serviço, os testes, a medição) só conhece esta interface.
 */
import type { EngineId } from '@shared/transcription'
import type { Transcript } from '@shared/types'
import type { PrepareTracker } from './prepare-tracker'

/** Medidas de uma execução (para a tabela do README e para o log). */
export type RunStats = {
  engine: EngineId
  /** Tempo total do pedido, do início ao fim (ms). */
  wallMs: number
  /** Duração do áudio (ms). */
  audioMs: number
  /** Quantas vezes mais rápido que o tempo real (audioMs / wallMs). */
  speedX: number
  /** Só o carregamento do modelo, se o motor informou (ms). */
  loadMs?: number
  /** Só a transcrição, sem carregar o modelo, se o motor informou (ms). */
  transcribeMs?: number
}

export type TranscribeOptions = {
  /** Idioma (padrão "pt"). */
  language?: string
  /** Dicionário: nomes próprios e termos que o Whisper deve acertar (vira prompt e hotwords). */
  vocabulary?: readonly string[]
  /** 0..1 enquanto transcreve. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  /** Soma aos tempos do arquivo para chegar ao tempo de origem (`sync.cameraOffsetMs`). */
  offsetMs?: number
  onStats?: (stats: RunStats) => void
  /** Duração do áudio, se já se sabe (dá o tempo limite proporcional). */
  audioMs?: number
}

export type EngineCheck = {
  state: 'ready' | 'missing'
  /** O que falta, em português. */
  detail: string | null
  /** A placa usada ("NVIDIA GeForce RTX 3050 Laptop GPU") ou null se for o processador. */
  device: string | null
}

export interface Transcriber {
  readonly id: EngineId
  /** Está tudo no lugar? Rápido: só olha arquivos e a marca de "preparado". */
  check(): Promise<EngineCheck>
  /** Prepara de primeira vez (ou retoma/repara). Lança com o motivo; o rastreador já foi avisado. */
  prepare(tracker: PrepareTracker, signal: AbortSignal): Promise<void>
  transcribe(wav: string, opts?: TranscribeOptions): Promise<Transcript>
}

/** Frase do prompt inicial do Whisper: semeia as hesitações para ele não as engolir. */
export const BASE_PROMPT = 'Hum... é, tipo, né? Ãh, então...'

/** Prompt inicial + o dicionário do usuário (nomes próprios). */
export function buildPrompt(vocabulary: readonly string[] = []): string {
  const words = vocabulary.map((v) => v.trim()).filter(Boolean)
  return words.length > 0 ? `${BASE_PROMPT} ${words.join(', ')}.` : BASE_PROMPT
}

/** Termos do dicionário para o `hotwords` do faster-whisper (separados por espaço). */
export function buildHotwords(vocabulary: readonly string[] = []): string {
  return vocabulary
    .map((v) => v.trim())
    .filter(Boolean)
    .join(' ')
}
