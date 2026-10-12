/**
 * Grafo de áudio da exportação (passo 1): trechos mantidos com `atrim` → emendas por `acrossfade` de
 * potência igual (`qsin`, 60-80 ms) com ALÇAS REAIS (cada trecho avança metade do cruzamento para dentro do que foi
 * cortado, ver `seams.ts`) → cadeia de voz → mistura com o som do sistema (−9 dB) → `loudnorm` em dois passes → AAC.
 * Só as pontas do vídeo (primeiro começo e último fim) levam fade de 30 ms. O cruzamento não muda o comprimento total:
 * o meio dele cai no corte do vídeo. Construtor PURO (só monta texto): quem executa é `export-service.ts`.
 *
 * Armadilhas do `legado/README.md` que valem aqui:
 *  - o corte vem ANTES do `loudnorm` (modo dinâmico atrasa o sinal em ~3 s e o último trecho some);
 *  - o primeiro passe de uma faixa muda devolve `-inf`: uma medição sem número finito NÃO vai ao
 *    segundo passe (cai no passe único);
 *  - centenas de trechos estouram o limite de 32 mil caracteres da linha de comando do Windows:
 *    o grafo vai num ARQUIVO (`-/filter_complex <arquivo>`, ffmpeg 8).
 */
import type { Range } from '@shared/types'
import { handlesOf, planSeams } from '@shared/seams'
import { assertFfmpegPath } from './ffmpeg-path'

/** Fade das pontas do vídeo (primeiro começo e último fim): sem emenda para cruzar, só evita o estalo. */
export const FADE_MS = 30
/** Emenda sem material para cruzar (trecho cortado menor que ~2 ms): junção direta com um microfade anti-estalo. */
export const HARD_JOIN_FADE_MS = 2
export const TARGET_LUFS = -14
export const TRUE_PEAK_DB = -1
export const SYSTEM_GAIN_DB = -9
export const OUTPUT_SAMPLE_RATE = 48_000
export const OUTPUT_AUDIO_BITRATE = '320k'
/** O mesmo áudio de publicação nos dois formatos (decisão do usuário, 06/10/2026). */
export const VERTICAL_AUDIO_BITRATE = OUTPUT_AUDIO_BITRATE
/** Reserva para a reconstrução AAC: Maria medida a -0,99 dBTP após loudnorm com teto -1. */
export const AAC_HEADROOM_DB = 0.15

/** Medição do primeiro passe do `loudnorm` (`print_format=json`). */
export type LoudnormMeasure = {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

const sec = (ms: number): string => (ms / 1000).toFixed(6)

// ---------------------------------------------------------------------------
// Cadeia de voz: única limpeza no pós, com piso medido na própria gravação.

/**
 * Latência do `afftdn` em amostras a 48 kHz (1200 = 25,0 ms). MEDIDA com o ffmpeg 8.1.1 por correlação
 * cruzada (entrada × saída): o filtro atrasa o som e NÃO compensa o carimbo de tempo, então sem corrigir
 * o áudio chegava ~25 ms depois da imagem. O teste e2e SINCRONIA (flash-bipe) pega a regressão.
 */
export const AFFTDN_LATENCY_SAMPLES = 1200

/**
 * A mesma limpeza da voz, com o atraso do `afftdn` descontado: corta as primeiras amostras logo depois
 * dele e, no fim da faixa, completa com silêncio até a duração exata (`totalMs`), para a voz continuar
 * alinhada com a imagem e com a mesma duração.
 */
export function voiceChainCompensated(totalMs: number, noiseFloorDb?: number | null): string {
  // Sem silêncio confiável, não se usa um piso presumido e não se corta o começo da voz.
  const denoise = typeof noiseFloorDb === 'number' && Number.isFinite(noiseFloorDb) && noiseFloorDb >= -80 && noiseFloorDb <= -20
  return [
    'highpass=f=80',
    ...(denoise ? [
      // Esvazia a janela do FFT: só aparar o atraso substituiria os últimos 25 ms de fala por silêncio.
      `apad=pad_len=${AFFTDN_LATENCY_SAMPLES}`,
      `afftdn=nr=6:nf=${noiseFloorDb.toFixed(2)}:gs=5`,
      `atrim=start_sample=${AFFTDN_LATENCY_SAMPLES}`,
      'asetpts=PTS-STARTPTS'
    ] : []),
    'deesser=i=0.15:m=0.25',
    'acompressor=threshold=-18dB:ratio=1.5:attack=20:release=180',
    `apad=whole_dur=${sec(totalMs)}`,
    `atrim=end=${sec(totalMs)}`,
    'asetpts=PTS-STARTPTS'
  ].join(',')
}

/**
 * `loudnorm`. Sem `measured`, passe único (ou o primeiro passe, com `print`). Com `measured`,
 * o segundo passe, linear: aplica o que o primeiro mediu.
 */
export function loudnormFilter(opts: { measured?: LoudnormMeasure | null; print?: boolean; target?: number; truePeak?: number } = {}): string {
  const target = opts.target ?? TARGET_LUFS
  const tp = opts.truePeak ?? TRUE_PEAK_DB
  const base = `loudnorm=I=${target}:TP=${tp}:LRA=11`
  if (opts.measured) {
    const m = opts.measured
    return `${base}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
  }
  return opts.print ? `${base}:print_format=json` : base
}

/**
 * Lê o JSON impresso pelo primeiro passe do `loudnorm` no stderr. `null` quando não achou ou
 * quando algum número não é finito (faixa muda: `-inf`): então vale o passe único.
 */
export function parseLoudnormMeasure(stderr: string): LoudnormMeasure | null {
  const m = stderr.match(/\{[\s\S]*?"target_offset"[\s\S]*?\}/)
  if (!m) return null
  let json: Record<string, unknown>
  try {
    json = JSON.parse(m[0]) as Record<string, unknown>
  } catch {
    return null
  }
  const fields = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const
  for (const f of fields) {
    if (!Number.isFinite(Number(json[f]))) return null
  }
  return {
    input_i: String(json.input_i),
    input_tp: String(json.input_tp),
    input_lra: String(json.input_lra),
    input_thresh: String(json.input_thresh),
    target_offset: String(json.target_offset)
  }
}

// ---------------------------------------------------------------------------
// Trechos

export type AudioTrackInput = {
  /** Índice da entrada do ffmpeg (`-i`). */
  input: number
  /** Em que instante do relógio da gravação o tempo 0 do arquivo acontece (`project.sync`). */
  offsetMs: number
  channels: 1 | 2
}

export type AudioGraphInput = {
  /** Trechos mantidos (ms, relógio da gravação). */
  kept: readonly Range[]
  voice: AudioTrackInput | null
  system: AudioTrackInput | null
  /** `measure`: só mede (primeiro passe); `final`: normaliza (com `measured` quando válido). */
  mode: 'measure' | 'final'
  measured?: LoudnormMeasure | null
  /** Piso dBFS medido em silêncio da voz original, antes dos cortes; ausente desativa só o redutor. */
  noiseFloorDb?: number | null
  /** Trechos (ms, relógio da gravação) em que a VOZ fica muda (muletas no modo "silenciar"); o resto não muda. */
  voiceMutes?: readonly Range[]
}

export type AudioGraph = {
  /** Texto do `filter_complex`. */
  graph: string
  /** Rótulo da saída (para `-map`). */
  out: string
}

/** Rampa (ms) de cada lado de um silenciamento: sem ela a borda abrupta estala. */
export const MUTE_RAMP_MS = 15
/** Quantos silenciamentos cabem numa única expressão do `volume` (as expressões do ffmpeg são recursivas). */
const MUTES_PER_FILTER = 40

/**
 * Filtros `volume` que calam os trechos `mutes` (tempo do TRECHO, em ms, já relativo ao começo dele). Cada um é uma
 * rampa para zero (e de volta) de `MUTE_RAMP_MS`; fora deles o ganho é 1.
 */
export function muteFilters(mutes: readonly Range[]): string[] {
  const r = MUTE_RAMP_MS / 1000
  const terms = mutes.filter((m) => m.end > m.start).map((m) => `clip(min((t-${sec(m.start)})/${r},(${sec(m.end)}-t)/${r}),0,1)`)
  const out: string[] = []
  for (let i = 0; i < terms.length; i += MUTES_PER_FILTER) {
    const group = terms.slice(i, i + MUTES_PER_FILTER)
    out.push(`volume='1-min(1,${group.join('+')})':eval=frame`)
  }
  return out
}

/**
 * Como as pontas de um trecho se ligam aos vizinhos: `head`/`tail` são as ALÇAS (ms de material cortado que o trecho
 * puxa de cada lado, para o cruzamento) e `fadeInMs`/`fadeOutMs` o fade de ponta (0 = a ponta é cruzada, sem fade).
 */
export type SegmentEdges = { head: number; tail: number; fadeInMs: number; fadeOutMs: number }
const LONE_SEGMENT: SegmentEdges = { head: 0, tail: 0, fadeInMs: FADE_MS, fadeOutMs: FADE_MS }

/**
 * Um trecho de uma faixa: corta (já com as alças), completa com silêncio o que falta e põe fade só nas pontas que não são
 * cruzadas. O tempo dos silenciamentos é relativo ao começo do trecho SEM a alça.
 */
export function segmentChain(range: Range, offsetMs: number, mutes: readonly Range[] = [], edges: SegmentEdges = LONE_SEGMENT): string {
  const ext: Range = { start: range.start - edges.head, end: range.end + edges.tail }
  const len = ext.end - ext.start
  const fileStart = ext.start - offsetMs
  const fileEnd = ext.end - offsetMs
  const lead = fileStart < 0 ? -fileStart : 0
  const trimStart = Math.max(0, fileStart)
  const trimEnd = Math.max(trimStart, fileEnd)
  const steps = [`atrim=start=${sec(trimStart)}:end=${sec(trimEnd)}`, 'asetpts=PTS-STARTPTS']
  if (lead > 0.5) steps.push(`adelay=delays=${Math.round(lead)}:all=1`)
  // garante a duração exata do trecho mesmo se o arquivo for mais curto que o vídeo
  steps.push(`apad=whole_dur=${sec(len)}`, `atrim=end=${sec(len)}`, 'asetpts=PTS-STARTPTS')
  // muletas silenciadas: só os trechos que caem neste pedaço, com o tempo relativo ao começo dele (alça incluída)
  const local = mutes
    .filter((m) => m.end > ext.start && m.start < ext.end)
    .map((m) => ({ start: Math.max(0, m.start - ext.start), end: Math.min(len, m.end - ext.start) }))
  steps.push(...muteFilters(local))
  const fadeIn = Math.min(edges.fadeInMs, len / 2)
  const fadeOut = Math.min(edges.fadeOutMs, len / 2)
  if (fadeIn > 0.5) steps.push(`afade=t=in:st=0:d=${sec(fadeIn)}`)
  if (fadeOut > 0.5) steps.push(`afade=t=out:st=${sec(len - fadeOut)}:d=${sec(fadeOut)}`)
  return steps.join(',')
}

/**
 * `[in:a]asplit` + trechos (com alças) + emendas para uma faixa; devolve as linhas do grafo e o rótulo da saída. Cada emenda é
 * um `acrossfade` de potência igual (`qsin`) de `2 × halfMs`; sem material para cruzar (corte de ~2 ms) é um `concat` simples.
 */
function trackBranch(kept: readonly Range[], track: AudioTrackInput, tag: string, mutes: readonly Range[] = []): { lines: string[]; out: string } {
  const n = kept.length
  const seams = planSeams(kept)
  const lines: string[] = []
  const labels = kept.map((_, i) => `${tag}s${i}`)
  if (n === 1) lines.push(`[${track.input}:a]anull[${labels[0]}]`)
  else lines.push(`[${track.input}:a]asplit=${n}${labels.map((l) => `[${l}]`).join('')}`)
  const outs: string[] = []
  kept.forEach((range, i) => {
    const o = `${tag}c${i}`
    const { head, tail } = handlesOf(seams, i)
    const before = i > 0 ? seams[i - 1]! : null
    const after = i < n - 1 ? seams[i]! : null
    const edges: SegmentEdges = {
      head,
      tail,
      fadeInMs: before === null ? FADE_MS : before.halfMs > 0 ? 0 : HARD_JOIN_FADE_MS,
      fadeOutMs: after === null ? FADE_MS : after.halfMs > 0 ? 0 : HARD_JOIN_FADE_MS
    }
    lines.push(`[${labels[i]}]${segmentChain(range, track.offsetMs, mutes, edges)}[${o}]`)
    outs.push(o)
  })
  const cat = `${tag}cat`
  if (n === 1) {
    lines.push(`[${outs[0]}]anull[${cat}]`)
    return { lines, out: cat }
  }
  let current = outs[0]!
  for (let i = 1; i < n; i++) {
    const seam = seams[i - 1]!
    const joined = i === n - 1 ? cat : `${tag}x${i}`
    lines.push(
      seam.halfMs > 0
        ? `[${current}][${outs[i]}]acrossfade=d=${sec(seam.halfMs * 2)}:c1=qsin:c2=qsin[${joined}]`
        : `[${current}][${outs[i]}]concat=n=2:v=0:a=1[${joined}]`
    )
    current = joined
  }
  return { lines, out: cat }
}

/**
 * Monta o grafo: faixas cortadas e concatenadas, voz limpa (mono → estéreo), som do sistema a −9 dB,
 * mistura e `loudnorm`. Lança se não houver nenhuma faixa ou nenhum trecho (quem chama usa a trilha muda).
 */
export function buildAudioGraph(input: AudioGraphInput): AudioGraph {
  const kept = input.kept.filter((r) => r.end > r.start)
  if (kept.length === 0) throw new RangeError('buildAudioGraph: sem trechos mantidos')
  if (!input.voice && !input.system) throw new RangeError('buildAudioGraph: sem nenhuma faixa de áudio')

  const lines: string[] = []
  const mixInputs: string[] = []

  const totalMs = kept.reduce((acc, r) => acc + (r.end - r.start), 0)
  if (input.voice) {
    const b = trackBranch(kept, input.voice, 'v', input.voiceMutes ?? [])
    lines.push(...b.lines)
    const stereo = input.voice.channels === 1 ? ',pan=stereo|c0=c0|c1=c0' : ''
    lines.push(`[${b.out}]${voiceChainCompensated(totalMs, input.noiseFloorDb)}${stereo}[voz]`)
    mixInputs.push('voz')
  }
  if (input.system) {
    const b = trackBranch(kept, input.system, 'y')
    lines.push(...b.lines)
    const stereo = input.system.channels === 1 ? ',pan=stereo|c0=c0|c1=c0' : ''
    // o som do computador só ganha o corte de grave: comprimir música e interface estraga o material
    lines.push(`[${b.out}]highpass=f=60,volume=${SYSTEM_GAIN_DB}dB${stereo}[sis]`)
    mixInputs.push('sis')
  }

  let mixed = mixInputs[0]!
  if (mixInputs.length === 2) {
    lines.push(`[voz][sis]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[mix]`)
    mixed = 'mix'
  }

  const norm =
    input.mode === 'measure'
      ? loudnormFilter({ print: true })
      : loudnormFilter({ measured: input.measured ?? null })
  const headroom = input.mode === 'final' ? `,volume=-${AAC_HEADROOM_DB}dB` : ''
  lines.push(`[${mixed}]${norm},aresample=${OUTPUT_SAMPLE_RATE}${headroom},aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`)
  return { graph: lines.join(';\n'), out: 'aout' }
}

/** Argumentos do ffmpeg para o primeiro passe (mede; descarta a saída). */
export function buildMeasureArgs(opts: { inputs: string[]; graphFile: string }): string[] {
  const inputs = opts.inputs.map((f) => assertFfmpegPath(f, 'entrada de áudio'))
  const graphFile = assertFfmpegPath(opts.graphFile, 'grafo de filtros')
  // o JSON do loudnorm sai no nível "info" (o ffmpeg do app roda em "error" por padrão)
  return ['-loglevel', 'info', ...inputs.flatMap((f) => ['-i', f]), '-/filter_complex', graphFile, '-map', '[aout]', '-f', 'null', '-']
}

/** Argumentos do ffmpeg para o passe final: AAC 48 kHz, 320 kbps nos dois formatos. */
export function buildAudioArgs(opts: { inputs: string[]; graphFile: string; output: string; bitrate?: string; durationMs?: number }): string[] {
  const inputs = opts.inputs.map((f) => assertFfmpegPath(f, 'entrada de áudio'))
  const graphFile = assertFfmpegPath(opts.graphFile, 'grafo de filtros')
  const output = assertFfmpegPath(opts.output, 'saída de áudio')
  return [
    ...inputs.flatMap((f) => ['-i', f]),
    '-/filter_complex',
    graphFile,
    '-map',
    '[aout]',
    ...(opts.durationMs === undefined ? [] : ['-t', sec(opts.durationMs)]),
    '-c:a',
    'aac',
    '-b:a',
    opts.bitrate ?? OUTPUT_AUDIO_BITRATE,
    '-ar',
    String(OUTPUT_SAMPLE_RATE),
    output
  ]
}

/** Trilha muda (sem microfone nem som do sistema): `anullsrc` pela duração de saída. */
export function buildSilentAudioArgs(opts: { durationMs: number; output: string; bitrate?: string }): string[] {
  const output = assertFfmpegPath(opts.output, 'saída de áudio')
  return [
    '-f',
    'lavfi',
    '-i',
    `anullsrc=r=${OUTPUT_SAMPLE_RATE}:cl=stereo`,
    '-t',
    sec(opts.durationMs),
    '-c:a',
    'aac',
    '-b:a',
    opts.bitrate ?? OUTPUT_AUDIO_BITRATE,
    '-ar',
    String(OUTPUT_SAMPLE_RATE),
    output
  ]
}

/** Mux final: vídeo e áudio já prontos, só copiados, com `moov` no começo. */
export function buildMuxArgs(opts: { video: string; audio: string; output: string }): string[] {
  const video = assertFfmpegPath(opts.video, 'vídeo')
  const audio = assertFfmpegPath(opts.audio, 'áudio')
  const output = assertFfmpegPath(opts.output, 'saída')
  // `-f mp4`: o arquivo parcial tem a extensão `.parcial`, que o ffmpeg não reconhece
  return ['-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output]
}
