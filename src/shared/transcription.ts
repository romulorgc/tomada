/**
 * Tipos da transcrição que atravessam a ponte (estado do motor, preparação de primeira vez, fila de trabalhos).
 * Código puro: sem DOM, sem Node.
 */

/** Qual motor transcreve. `mock` só existe em teste (`TOMADA_TRANSCRIBER=mock`). */
export type EngineId = 'faster-whisper' | 'whisper-cpp' | 'mock'

/** Pronto, falta preparar, preparando agora, ou a última preparação falhou. */
export type EngineState = 'ready' | 'missing' | 'preparing' | 'error'

export type PrepareStepStatus = 'pending' | 'running' | 'done' | 'error'

/** Passos da preparação (cada motor usa o seu conjunto). */
export type PrepareStepId = 'python' | 'packages' | 'binary' | 'model' | 'check'

export type PrepareStep = {
  id: PrepareStepId
  status: PrepareStepStatus
  /** 0..1 */
  fraction: number
  /** Linha curta do que está acontecendo ("Baixando model.bin · 412 MB de 1,5 GB"). */
  detail?: string
}

export type PrepareSnapshot = {
  /** O motor que está sendo preparado (a análise da câmera, M4c, também usa este retrato, com `camera`). */
  engine: EngineId | 'camera'
  status: 'running' | 'done' | 'error' | 'cancelled'
  /** 0..1 do trabalho todo (cada passo pesa pelo tamanho do que baixa). */
  fraction: number
  steps: PrepareStep[]
  error?: { step: PrepareStepId; message: string }
  /** Avisos de bastidor (ex.: "a rede caiu, tentando de novo em 2 s"). */
  notes: string[]
  startedAt: number
}

export type JobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

/** A transcrição de um projeto (uma por vez; as demais esperam na fila). */
export type TranscriptionJob = {
  projectId: string
  state: JobState
  /** 0..1 */
  fraction: number
  /** Motivo, quando falhou ou foi cancelada. */
  error?: string
  /** Palavras entregues (quando terminou). */
  words?: number
}

export type TranscriptionView = {
  engine: EngineId
  state: EngineState
  /** O que falta ou o que deu errado, em português. */
  detail: string | null
  /** A GPU que vai ser usada ("NVIDIA GeForce RTX 3050") ou null se for o processador. */
  device: string | null
  prepare: PrepareSnapshot | null
  jobs: TranscriptionJob[]
}

/** Modo de uso da IA (`llm:status`). A interface nunca diz o nome do fornecedor: é "IA". */
export type LlmProviderId = 'cli' | 'api' | 'mock'

export type LlmStatus = {
  /** O que vai ser usado agora, ou null se não há nada configurado. */
  provider: LlmProviderId | null
  /** Pode pedir algo à IA agora? */
  available: boolean
  /** O usuário guardou uma chave (nunca devolvemos a chave). */
  hasKey: boolean
  /** O programa de linha de comando foi achado neste computador. */
  cliFound: boolean
  /** Preferência do usuário: automático, só o programa local, ou só a chave. */
  preference: 'auto' | 'cli' | 'api'
  detail: string | null
}

/** Um recomeço que a IA apontou: cortar as palavras de `from` a `to` (índices `Word.i`, inclusive). */
export type RetakeSpan = { from: number; to: number; reason: string }

export type RetakesResult = {
  retakes: RetakeSpan[]
  /** Quantas sugestões inválidas (índice fora da faixa, invertida) foram descartadas. */
  dropped: number
}

/** Preferências da transcrição guardadas nos ajustes. */
export type TranscriptionPrefs = {
  /** Transcrever sozinho depois de cada gravação (padrão: sim). */
  auto: boolean
  /** Ao abrir um projeto recém-transcrito, aplicar a limpeza padrão (silêncio Rápido + hesitações puras) UMA vez, desfazível. */
  autoClean: boolean
}

export const DEFAULT_TRANSCRIPTION_PREFS: TranscriptionPrefs = { auto: true, autoClean: true }
