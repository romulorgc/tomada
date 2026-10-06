/**
 * Construtores PUROS de argumentos do ffmpeg (sem executar nada): testáveis por
 * unidade. Quem executa é `ffmpeg.ts`; quem orquestra é `normalize.ts`.
 *
 * Armadilhas de legado/README.md que estes argumentos respeitam:
 *  - o container de saída sai do CODEC (H.264 → MP4), nunca da extensão de entrada;
 *  - o Chrome grava H.264 dentro de .webm e o ffmpeg recusa escrever H.264 em WebM.
 */

import { assertFfmpegPath } from './ffmpeg-path'

export type VideoEncoder = 'libx264' | 'h264_nvenc'

export type NormalizeVideoArgs = {
  input: string
  output: string
  /** Taxa de quadros CONSTANTE de saída. */
  fps: number
  encoder: VideoEncoder
  /** Tamanho do GOP em segundos (padrão 1 s: busca rápida no editor). */
  gopSeconds?: number
  /** Mantém a trilha de áudio (AAC 192 kbps). Padrão: não. */
  keepAudio?: boolean
  /**
   * Duração (ms) que o vídeo precisa ter: se a gravação termina antes (captura de tela só entrega
   * quadro quando algo muda, então o RABO ESTÁTICO some), repete o último quadro até lá; o que
   * passar disso é cortado. Sem isto o vídeo sai com a duração do último quadro recebido.
   */
  padToMs?: number
  /**
   * Trava o tamanho do quadro no da ENTRADA (o primeiro): o quadro que muda de tamanho no meio (uma janela redimensionada) é
   * esticado ao tamanho travado, SEM refazer o grafo de filtros. Sem isto o ffmpeg refaz o grafo na troca de tamanho e perde a
   * duração do quadro que estava parado (medido: uma janela redimensionada aos 8,5 s fazia o vídeo perder 4,4 s e tudo o que vem
   * depois ficava adiantado em relação aos eventos). Só vale para quem grava a tela/janela.
   */
  lockSize?: { w: number; h: number }
}

/** Quanto de rabo estático se aceita repetir (s). Acima disso o passo avisa em vez de esconder. */
export const MAX_TAIL_PAD_SECONDS = 30

function gopFrames(fps: number, gopSeconds: number): number {
  return Math.max(1, Math.round(fps * gopSeconds))
}

/** Argumentos de codificação H.264 de acordo com o encoder (qualidade alta para texto nítido). */
export function encoderArgs(encoder: VideoEncoder, gop: number): string[] {
  if (encoder === 'h264_nvenc') {
    return [
      '-c:v', 'h264_nvenc',
      '-preset', 'p5',
      '-tune', 'hq',
      '-rc', 'vbr',
      '-cq', '19',
      '-b:v', '0',
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      '-g', String(gop),
      '-no-scenecut', '1',
      '-forced-idr', '1'
    ]
  }
  return [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0'
  ]
}

/**
 * Normaliza uma gravação (VFR, WebM) para MP4 H.264 com fps CONSTANTE e GOP = 1 s.
 * `setpts=PTS-STARTPTS` zera o começo (o MediaRecorder pode começar com PTS ≠ 0) e
 * `fps=` duplica/descarta quadros para a taxa fixa preservando a duração. As
 * dimensões saem PARES (exigência do yuv420p).
 */
export function buildNormalizeVideoArgs(o: NormalizeVideoArgs): string[] {
  if (!(o.fps > 0)) throw new RangeError(`fps inválido: ${o.fps}`)
  const input = assertFfmpegPath(o.input, 'entrada')
  const output = assertFfmpegPath(o.output, 'saída')
  const gop = gopFrames(o.fps, o.gopSeconds ?? 1)
  const pad = o.padToMs !== undefined && Number.isFinite(o.padToMs) && o.padToMs > 0
  const lock = o.lockSize && o.lockSize.w > 0 && o.lockSize.h > 0 ? { w: Math.round(o.lockSize.w), h: Math.round(o.lockSize.h) } : null
  const vf = [
    ...(lock ? [`scale=${lock.w}:${lock.h}`] : []),
    'setpts=PTS-STARTPTS',
    `fps=${o.fps}`,
    ...(pad ? [`tpad=stop_mode=clone:stop_duration=${MAX_TAIL_PAD_SECONDS}`] : []),
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    'setsar=1'
  ].join(',')
  const audio = o.keepAudio
    ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k', '-af', 'aresample=async=1:first_pts=0']
    : ['-an']
  return [
    ...(lock ? ['-reinit_filter', '0'] : []),
    '-i', input,
    '-map', '0:v:0',
    ...audio,
    '-vf', vf,
    '-fps_mode', 'cfr',
    ...(pad ? ['-t', (o.padToMs! / 1000).toFixed(3)] : []),
    ...encoderArgs(o.encoder, gop),
    '-movflags', '+faststart',
    '-f', 'mp4',
    output
  ]
}

export type ExtractAudioArgs = {
  input: string
  output: string
  channels: 1 | 2
  /** Padrão 48000. */
  sampleRate?: number
  /** Índice da trilha de áudio dentro da entrada (padrão 0). */
  track?: number
}

/** Extrai áudio como WAV PCM 16 bits (voice.wav: 48 kHz mono; system.wav: 48 kHz estéreo). */
export function buildExtractAudioArgs(o: ExtractAudioArgs): string[] {
  const input = assertFfmpegPath(o.input, 'entrada')
  const output = assertFfmpegPath(o.output, 'saída')
  return [
    '-i', input,
    '-map', `0:a:${o.track ?? 0}`,
    '-vn',
    '-ac', String(o.channels),
    '-ar', String(o.sampleRate ?? 48_000),
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    output
  ]
}

export type ThumbnailArgs = {
  input: string
  output: string
  atMs: number
  /** Largura da miniatura (altura proporcional e par). Padrão 640. */
  width?: number
}

export function buildThumbnailArgs(o: ThumbnailArgs): string[] {
  const input = assertFfmpegPath(o.input, 'entrada')
  const output = assertFfmpegPath(o.output, 'saída')
  const seconds = Math.max(0, o.atMs) / 1000
  return [
    '-ss', seconds.toFixed(3),
    '-i', input,
    '-frames:v', '1',
    '-vf', `scale=${o.width ?? 640}:-2`,
    '-q:v', '4',
    '-update', '1',
    '-f', 'image2',
    output
  ]
}

/** Voz mono em PCM de 16 bits cru (para calcular os picos da forma de onda). */
export function buildPeaksPcmArgs(o: { input: string; output: string; sampleRate: number }): string[] {
  const input = assertFfmpegPath(o.input, 'entrada')
  const output = assertFfmpegPath(o.output, 'saída')
  return ['-i', input, '-vn', '-ac', '1', '-ar', String(Math.trunc(o.sampleRate)), '-f', 's16le', output]
}

/**
 * `count` quadros da tela, espaçados por igual, em CINZA e crus (um byte por pixel, `width` de largura): a análise do recorte
 * sugerido (C1). A altura segue a proporção (par).
 */
export function buildGrayFramesArgs(o: { input: string; output: string; count: number; durationMs: number; width: number; height: number }): string[] {
  const input = assertFfmpegPath(o.input, 'entrada')
  const output = assertFfmpegPath(o.output, 'saída')
  const count = Math.max(1, Math.trunc(o.count))
  const seconds = Math.max(0.5, o.durationMs / 1000)
  // um quadro a cada (duração / count) s, começando um pouco depois do início (o primeiro quadro costuma ser de abertura)
  return [
    '-ss',
    String(Math.min(1, seconds / 4)),
    '-i',
    input,
    '-an',
    '-vf',
    `fps=${(count / seconds).toFixed(4)},scale=${Math.trunc(o.width)}:${Math.trunc(o.height)}:flags=area,format=gray`,
    '-frames:v',
    String(count),
    '-f',
    'rawvideo',
    output
  ]
}

/** Miniaturas da tela: um JPEG a cada `intervalMs`, numerados a partir de 0 (`outputPattern` leva `%04d`). */
export function buildThumbStripArgs(o: { input: string; outputPattern: string; intervalMs: number; height: number }): string[] {
  const input = assertFfmpegPath(o.input, 'entrada')
  const output = assertFfmpegPath(o.outputPattern, 'saída')
  return [
    '-i',
    input,
    '-an',
    '-vf',
    `fps=1000/${Math.trunc(o.intervalMs)},scale=-2:${Math.trunc(o.height)}:flags=lanczos`,
    '-q:v',
    '5',
    '-start_number',
    '0',
    output
  ]
}

/** Codificação mínima (um quadro, sem arquivo) para saber se o encoder realmente funciona aqui. */
export function buildEncoderProbeArgs(encoder: VideoEncoder): string[] {
  return [
    '-f', 'lavfi',
    '-i', 'color=c=black:s=640x360:r=30:d=0.5',
    ...encoderArgs(encoder, 30),
    '-frames:v', '5',
    '-f', 'null',
    '-'
  ]
}
