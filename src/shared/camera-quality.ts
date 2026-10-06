/**
 * Qualidade da câmera (PURO): qual resolução pedir, como pedir, quanto de taxa de bits e como julgar os
 * quadros por segundo que a câmera REALMENTE entregou.
 *
 * Por que isto existe (medido na EMEET SmartCam C60E 4K, 06/10/2026): o app gravava a 15 qps com a imagem
 * mole. O codificador NÃO era o gargalo: a própria trilha do `getUserMedia` já chegava a 15 qps (contagem de
 * quadros na trilha, antes de qualquer codificador). A câmera, no modo de exposição automática que o Windows/
 * Chromium usa, REDUZ SOZINHA a taxa em pouca luz (15 a 24 qps pedindo 30; 30 pedindo 60). A captura direta do
 * ffmpeg (dshow) não sofre isso: 30 qps cheios no mesmo quarto, na mesma hora. Em exposição manual os 30 qps
 * voltam, mas a imagem fica quase preta (a câmera não sobe o ganho sozinha), então não é saída.
 *
 * O que dá para fazer dentro do Chromium: pedir o modo de 60 qps do 1080p (que cai para ~30 em pouca luz e sobe
 * a 60 com luz boa) e ABRIR NO MÁXIMO (4K, só 30 qps) apenas quando a câmera prova que sustenta 30 qps com a luz
 * de agora. A prova é medida na abertura (quadros reais da trilha), nunca presumida.
 */
import { z } from 'zod'
import type { Size } from './types'

export type CameraQuality = 'max' | 'high'
export const CAMERA_QUALITIES: readonly CameraQuality[] = ['max', 'high']
/** Padrão do usuário (06/10/2026): "a câmera melhor de todas". */
export const DEFAULT_CAMERA_QUALITY: CameraQuality = 'max'

/** A taxa que a câmera precisa entregar para o vídeo parecer fluido. */
export const CAMERA_TARGET_FPS = 30
/** Na abertura (sondagem de ~1,4 s): abaixo disto o degrau é recusado e o seguinte é tentado. */
export const CAMERA_PROBE_MIN_FPS = 28
/** Na gravação pronta: abaixo disto o app AVISA (com o motivo e o que fazer). */
export const CAMERA_WARN_FPS = 24

export type CameraProfileId = 'uhd' | 'fhd'

export type CameraProfile = {
  id: CameraProfileId
  label: string
  width: number
  height: number
  /** `frameRate.ideal` pedido ao Chromium (o 1080p pede 60: ver o comentário do módulo). */
  requestFps: number
  /** Teto da taxa; ausente = sem teto. */
  maxFps?: number
}

export const CAMERA_PROFILES: Record<CameraProfileId, CameraProfile> = {
  uhd: { id: 'uhd', label: '4K', width: 3840, height: 2160, requestFps: 30, maxFps: 30 },
  fhd: { id: 'fhd', label: '1080p', width: 1920, height: 1080, requestFps: 60 }
}

/** Os degraus, do melhor ao seguro. */
export function cameraLadder(quality: CameraQuality): CameraProfile[] {
  return quality === 'max' ? [CAMERA_PROFILES.uhd, CAMERA_PROFILES.fhd] : [CAMERA_PROFILES.fhd]
}

/** Restrições de vídeo do `getUserMedia` para um degrau (sem `deviceId`, que quem chama acrescenta). */
export function cameraVideoConstraints(profile: CameraProfile): {
  width: { ideal: number }
  height: { ideal: number }
  frameRate: { ideal: number; max?: number }
} {
  return {
    width: { ideal: profile.width },
    height: { ideal: profile.height },
    frameRate: { ideal: profile.requestFps, ...(profile.maxFps ? { max: profile.maxFps } : {}) }
  }
}

/**
 * Taxa de bits da câmera (H.264 do MediaRecorder): 4K a 30 qps ≈ 45 Mbps, 1080p ≈ 16 Mbps (até 60 qps sem
 * apertar). Entre 4 e 50 Mbps. O rosto é ampliado nos layouts Apresentador e lado a lado: o bitrate generoso
 * é o que mantém cabelo e barba nítidos depois do recorte.
 */
export function cameraRecordBitrate(size: Size, fps: number): number {
  const pixels = size.w * size.h
  const basis = pixels * CAMERA_TARGET_FPS * (pixels > 2_600_000 ? 0.18 : 0.26)
  return Math.round(Math.min(50_000_000, Math.max(4_000_000, fps > CAMERA_TARGET_FPS ? basis * 1.25 : basis)))
}

/** Quadros por segundo de uma contagem (`count` quadros em `spanMs`, do primeiro ao último). */
export function framesPerSecond(count: number, spanMs: number): number {
  if (!(count > 1) || !(spanMs > 0)) return 0
  return ((count - 1) * 1000) / spanMs
}

/** A sondagem aceita este degrau? */
export const probeAccepts = (fps: number): boolean => fps >= CAMERA_PROBE_MIN_FPS

export type CameraAttempt = {
  profile: CameraProfileId
  /** Tamanho que a trilha informou (`getSettings`). */
  width: number
  height: number
  /** Quadros por segundo medidos na trilha. */
  fps: number
  accepted: boolean
}

/** O que a abertura da câmera decidiu (vai para o manifesto, para o aviso saber do que falar). */
export type CameraCaptureInfo = {
  quality: CameraQuality
  profile: CameraProfileId
  width: number
  height: number
  /** Taxa medida na sondagem do degrau escolhido (0 = não mediu). */
  probeFps: number
  /** Maior largura que o aparelho oferece (`getCapabilities`): distingue câmera sem 4K de câmera ocupada por outro programa. */
  maxWidth?: number
  attempts: CameraAttempt[]
}

/**
 * A nota que explica por que a câmera NÃO saiu no tamanho pedido (null se saiu como pedido). Duas causas que se medem:
 * a luz (o 4K a 30 qps não se sustentou na sondagem) e o aparelho ocupado por outra janela ou programa (a trilha veio menor que
 * o degrau, apesar de o aparelho oferecer o tamanho).
 */
export function cameraFallbackNote(info: CameraCaptureInfo): string | null {
  const profile = CAMERA_PROFILES[info.profile]
  const notes: string[] = []
  if (info.quality === 'max' && info.profile !== 'uhd') {
    const uhd = info.attempts.find((a) => a.profile === 'uhd')
    if (uhd) notes.push(`Gravei a câmera em 1080p em vez de 4K: com a luz de agora a câmera entregou só ${Math.round(uhd.fps)} qps em 4K (o mínimo para ficar fluido é ${CAMERA_PROBE_MIN_FPS}). Com mais luz de frente para o rosto o 4K volta a valer. Em Ajustes, "Qualidade da câmera: Alta (1080p)" evita essa tentativa.`)
  }
  if (info.width > 0 && info.width < profile.width * 0.9 && (info.maxWidth ?? 0) >= profile.width) {
    notes.push(`A câmera abriu em ${info.width}×${info.height} e não em ${profile.width}×${profile.height}, que o aparelho oferece: outro programa ou janela estava usando a câmera. Feche o que usa a câmera e grave de novo.`)
  }
  return notes.length > 0 ? notes.join(' ') : null
}

export type CameraFpsReport = {
  fps: number
  width: number
  height: number
}

/**
 * O aviso da gravação PRONTA com poucos quadros por segundo (medidos no arquivo gravado). null = tudo certo.
 * `info` vem do manifesto (o que a abertura decidiu); pode faltar em gravação antiga ou recuperada.
 */
export function lowCameraFpsNote(report: CameraFpsReport, info: CameraCaptureInfo | null): string | null {
  if (!(report.fps > 0) || report.fps >= CAMERA_WARN_FPS) return null
  const got = `${report.fps.toFixed(1).replace('.', ',')} qps`
  const where = `${report.width}×${report.height}`
  const dim = info && info.probeFps >= CAMERA_PROBE_MIN_FPS
    ? 'A abertura mediu a taxa certa, então a queda veio durante a gravação: a luz do quarto mudou ou o computador ficou sobrecarregado.'
    : 'Com pouca luz, a câmera reduz sozinha os quadros por segundo.'
  return `A câmera gravou a ${got} em ${where} (o esperado é ${CAMERA_TARGET_FPS}). ${dim} O que fazer: acenda uma luz de frente para o rosto, feche programas pesados e, se continuar, em Ajustes escolha "Qualidade da câmera: Alta (1080p)".`
}

/**
 * Percorre os degraus do melhor ao seguro: `tryProfile` abre a câmera naquele degrau e devolve o tamanho e os
 * qps medidos (`fps: null` = não sei medir: o degrau vale). O primeiro que sustenta a taxa ganha; o último sempre
 * ganha (melhor gravar do que não gravar: o aviso do fim diz o que houve). Um degrau que NÃO ABRE (lança) vira
 * tentativa registrada com 0 qps e o seguinte é tentado; se o último também não abre, o erro dele sobe.
 */
export async function walkCameraLadder(
  quality: CameraQuality,
  tryProfile: (profile: CameraProfile) => Promise<{ width: number; height: number; fps: number | null; maxWidth?: number }>
): Promise<{ profile: CameraProfile; info: CameraCaptureInfo }> {
  const ladder = cameraLadder(quality)
  const attempts: CameraAttempt[] = []
  for (let i = 0; i < ladder.length; i++) {
    const profile = ladder[i]!
    const last = i === ladder.length - 1
    let measured: { width: number; height: number; fps: number | null; maxWidth?: number }
    try {
      measured = await tryProfile(profile)
    } catch (err) {
      if (last) throw err
      attempts.push({ profile: profile.id, width: 0, height: 0, fps: 0, accepted: false })
      continue
    }
    const accepted = measured.fps === null || probeAccepts(measured.fps)
    attempts.push({ profile: profile.id, width: measured.width, height: measured.height, fps: measured.fps ?? 0, accepted })
    if (accepted || last) {
      return { profile, info: { quality, profile: profile.id, width: measured.width, height: measured.height, probeFps: measured.fps ?? 0, ...(measured.maxWidth ? { maxWidth: measured.maxWidth } : {}), attempts } }
    }
  }
  throw new Error('Nenhum degrau de qualidade da câmera.')
}

/** O manifesto é lido do disco: o que não bate com o formato vira "sem informação" (o aviso fala do que sabe). */
export const cameraCaptureInfoSchema = z.object({
  quality: z.enum(['max', 'high']),
  profile: z.enum(['uhd', 'fhd']),
  width: z.number().int().min(0).max(20_000),
  height: z.number().int().min(0).max(20_000),
  probeFps: z.number().min(0).max(1000),
  maxWidth: z.number().int().min(0).max(20_000).optional(),
  attempts: z
    .array(z.object({ profile: z.enum(['uhd', 'fhd']), width: z.number().int().min(0).max(20_000), height: z.number().int().min(0).max(20_000), fps: z.number().min(0).max(1000), accepted: z.boolean() }))
    .max(8)
})

/** O que a gravação da câmera entregou, medido no ARQUIVO bruto: vai para o `project.json` e a Revisão mostra o aviso. */
export const cameraCaptureReportSchema = z.object({
  quality: z.enum(['max', 'high']),
  profile: z.enum(['uhd', 'fhd']),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  /** Quadros por segundo efetivos no arquivo bruto. */
  fps: z.number().min(0),
  /** Taxa medida na sondagem da abertura (0 = não mediu). */
  probeFps: z.number().min(0),
  /** Só quando a câmera entregou poucos qps: o motivo e o que fazer. */
  warning: z.string().optional()
})
export type CameraCaptureReport = z.infer<typeof cameraCaptureReportSchema>

/** Monta o relatório a partir da medição no arquivo e do que a abertura decidiu (gravação antiga não tem `info`). */
export function cameraCaptureReport(measured: { fps: number; width: number; height: number }, info: CameraCaptureInfo | null): CameraCaptureReport {
  const warning = [info ? cameraFallbackNote(info) : null, lowCameraFpsNote(measured, info)].filter(Boolean).join(' ') || undefined
  return {
    quality: info?.quality ?? DEFAULT_CAMERA_QUALITY,
    profile: info?.profile ?? 'fhd',
    width: measured.width,
    height: measured.height,
    fps: Math.round(measured.fps * 100) / 100,
    probeFps: info?.probeFps ?? 0,
    ...(warning ? { warning } : {})
  }
}
