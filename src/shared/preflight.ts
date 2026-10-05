export type PreflightResult = { freeBytes: number | null; disk: 'ok' | 'low' | 'unknown'; dnd: 'reminder'; face: 'pending-m4c' }
export type FaceCheck = { status:'ok'|'no-face'|'off-center'|'dark'|'unknown' }
/** TODO M4c: adaptar o detector daquela etapa à prévia; o provedor mantém os quadros locais. */
export interface FacePreflightProvider { check(): Promise<FaceCheck> }
export type MicCheck = { rms: number; peak: number; sampledMs: number; status: 'listening' | 'low' | 'clipping' | 'ok' }
/** Dois segundos de amostras; RMS abaixo de −40 dBFS ou pico próximo de 0 dBFS pede atenção. */
export function micCheck(sample: Omit<MicCheck, 'status'>): MicCheck {
  return { ...sample, status: sample.sampledMs < 2000 ? 'listening' : sample.peak >= 0.98 ? 'clipping' : sample.rms < 0.01 ? 'low' : 'ok' }
}
