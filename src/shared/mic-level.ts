/**
 * Nível do microfone ANTES de gravar: decisão e ajuste do volume de entrada do Windows. TypeScript puro, sem DOM nem Node.
 *
 * Caso real que motivou isto (06/10/2026): fone com microfone no fio, volume de entrada do Windows em 0% (faixa do aparelho de
 * 0 a +23,8 dB, ou seja, nenhum ganho). A voz bruta saiu a -58,3 LUFS com pico em -38 dBFS; a exportação subiu ~44 dB para chegar
 * a -14 LUFS e o chiado subiu junto. O volume de entrada decide o quanto de ganho a voz recebe antes de chegar ao app.
 */

/** Pico da fala abaixo disto = microfone baixo demais (a fala "boa" fica entre -15 e -9 dBFS de pico). */
export const MIC_PEAK_LOW_DBFS = -24
/** Para onde o ajuste leva o pico da fala. */
export const MIC_PEAK_TARGET_DBFS = -12
/** Faixa aceita em torno do alvo: [-15, -9]. */
export const MIC_PEAK_TOLERANCE_DB = 3
/** Pico acima disto é estouro (clipping) ou está perto: o ajuste volta. */
export const MIC_PEAK_CLIP_DBFS = -3
/** Abaixo disto não há fala: é só o silêncio da sala. */
export const MIC_SPEECH_FLOOR_DBFS = -55
/** Volume do Windows até este valor (0..1) conta como "no mínimo". */
export const WINDOWS_VOLUME_MINIMUM = 0.02
/** Janela mínima de escuta antes de julgar a fala. */
export const MIC_OBSERVE_MS = 2000

/** Estado do volume de entrada de um aparelho, como o Windows o informa (WASAPI). */
export type MicVolumeInfo = {
  /** Nome do aparelho como o Windows mostra (ex.: "Microfone (USB PnP Sound Device)"). */
  name: string
  /** 0..1 na escala da barra de volume do Windows. */
  scalar: number
  /** Ganho atual em dB (a escala real do aparelho). */
  db: number
  minDb: number
  maxDb: number
  stepDb: number
  muted: boolean
  isDefault: boolean
}

/** Tira o que o Chromium acrescenta ao rótulo: prefixo "Padrão - ", "Comunicações - " e o sufixo "(vvvv:pppp)" de USB. */
export function microphoneBaseName(label: string): string {
  let name = label.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  name = name.replace(/^(?:padr[aã]o|default|comunica[cç][oõ]es|communications)\s*-\s*/i, '')
  name = name.replace(/\s*\((?:[0-9a-f]{4}:[0-9a-f]{4})\)\s*$/i, '')
  return name.trim().slice(0, 200)
}

/** O rótulo do Chromium aponta para o aparelho PADRÃO do Windows (alias `default`/`communications`)? */
export const isDefaultAlias = (label: string): boolean => /^\s*(?:padr[aã]o|default|comunica[cç][oõ]es|communications)\s*(?:-|$)/i.test(label) || label.trim() === ''

const normalize = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

/** Escolhe, entre os aparelhos de captura do Windows, o que o rótulo nomeia; o alias padrão cai no aparelho padrão. */
export function pickMicrophone(devices: readonly MicVolumeInfo[], label: string): MicVolumeInfo | null {
  const wanted = normalize(microphoneBaseName(label))
  if (wanted) {
    const exact = devices.filter((d) => normalize(d.name) === wanted)
    if (exact.length === 1) return exact[0]!
    if (exact.length > 1) return exact.find((d) => d.isDefault) ?? exact[0]!
    const part = devices.filter((d) => normalize(d.name).includes(wanted) || wanted.includes(normalize(d.name)))
    if (part.length === 1) return part[0]!
  }
  return isDefaultAlias(label) ? (devices.find((d) => d.isDefault) ?? null) : null
}

export const clampDb = (db: number, info: Pick<MicVolumeInfo, 'minDb' | 'maxDb'>): number => Math.min(info.maxDb, Math.max(info.minDb, db))

export type MicLevelStatus = 'listening' | 'ok' | 'too-low' | 'muted' | 'clipping'
export type MicLevelReason = 'windows-minimum' | 'speech-low'
export type MicLevelAssessment = {
  status: MicLevelStatus
  reasons: MicLevelReason[]
  /** Dá para subir o volume de entrada do Windows (há folga acima do ganho atual). */
  canAdjust: boolean
}

export type MicLevelInput = {
  /** Maior pico (dBFS) da fala observada; `null` = nada medido ainda. */
  peakDbfs: number | null
  observedMs: number
  /** `null` = não deu para ler o volume do Windows (outro sistema, aparelho não achado). */
  windows: Pick<MicVolumeInfo, 'scalar' | 'db' | 'minDb' | 'maxDb' | 'stepDb' | 'muted'> | null
}

/** Folga para subir: pelo menos meio passo do aparelho (e nunca menos de 0,1 dB) abaixo do máximo. */
export function hasHeadroom(windows: NonNullable<MicLevelInput['windows']>): boolean {
  return windows.maxDb - windows.db > Math.max(0.1, windows.stepDb / 2)
}

/** A decisão da tela Gravar: o volume no mínimo avisa mesmo antes de a pessoa falar; a fala baixa avisa depois de 2 s de escuta. */
export function assessMicLevel(input: MicLevelInput): MicLevelAssessment {
  const { peakDbfs, observedMs, windows } = input
  if (windows?.muted) return { status: 'muted', reasons: [], canAdjust: false }
  const reasons: MicLevelReason[] = []
  const atMinimum = windows !== null && windows.scalar <= WINDOWS_VOLUME_MINIMUM && windows.maxDb - windows.minDb >= 3
  if (atMinimum) reasons.push('windows-minimum')
  const heard = peakDbfs !== null && peakDbfs > MIC_SPEECH_FLOOR_DBFS
  if (peakDbfs !== null && peakDbfs >= -1) return { status: 'clipping', reasons: [], canAdjust: false }
  if (observedMs >= MIC_OBSERVE_MS && heard && peakDbfs! < MIC_PEAK_LOW_DBFS) reasons.push('speech-low')
  if (reasons.length) return { status: 'too-low', reasons, canAdjust: windows !== null && hasHeadroom(windows) }
  if (observedMs >= MIC_OBSERVE_MS && heard) return { status: 'ok', reasons: [], canAdjust: false }
  return { status: 'listening', reasons: [], canAdjust: false }
}

export type VolumeStep =
  | { action: 'done' }
  | { action: 'no-speech' }
  | { action: 'at-limit'; direction: 'up' | 'down' }
  | { action: 'set'; nextDb: number }

/**
 * Um passo do "Ajustar sozinho": com o ganho atual e o pico medido enquanto a pessoa fala, devolve o próximo ganho para o pico
 * chegar a -12 dBFS. O pico responde 1 dB por dB de ganho; a conta nunca passa da faixa do aparelho e, se o pico já passou de
 * -3 dBFS, o passo é para BAIXO (nunca se termina em estouro).
 */
export function planVolumeStep(input: { currentDb: number; peakDbfs: number | null; minDb: number; maxDb: number; stepDb: number }): VolumeStep {
  const { currentDb, peakDbfs, minDb, maxDb, stepDb } = input
  if (peakDbfs === null || peakDbfs <= MIC_SPEECH_FLOOR_DBFS) return { action: 'no-speech' }
  if (Math.abs(peakDbfs - MIC_PEAK_TARGET_DBFS) <= MIC_PEAK_TOLERANCE_DB) return { action: 'done' }
  const wanted = currentDb + (MIC_PEAK_TARGET_DBFS - peakDbfs)
  const nextDb = Math.min(maxDb, Math.max(minDb, wanted))
  const smallest = Math.max(0.05, stepDb / 2)
  if (Math.abs(nextDb - currentDb) < smallest) return { action: 'at-limit', direction: peakDbfs < MIC_PEAK_TARGET_DBFS ? 'up' : 'down' }
  return { action: 'set', nextDb }
}

/** O volume do Windows em % para mostrar (0..100). */
export const volumePercent = (scalar: number): number => Math.round(Math.min(1, Math.max(0, scalar)) * 100)
