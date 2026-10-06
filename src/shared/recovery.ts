/** Identidade pública de uma gravação interrompida. Nunca inclui caminhos absolutos. */
export type InterruptedRecording = {
  id: string
  sessionId: string
  title: string
  createdAt: string
  recordedMs: number | null
  bytes: number
  error?: string
  warning?: string
}
