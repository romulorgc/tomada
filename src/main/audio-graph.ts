/**
 * Grafo de áudio da exportação (passo 1): trechos mantidos com `atrim` + fade de
 * 30 ms em cada borda → `concat` → cadeia de voz → mistura com o som do sistema (−9 dB) →
 * `loudnorm` em dois passes → AAC. Construtor PURO (só monta texto): quem executa é `export-service.ts`.
 *
 * Armadilhas do `legado/README.md` que valem aqui:
 *  - o corte vem ANTES do `loudnorm` (modo dinâmico atrasa o sinal em ~3 s e o último trecho some);
 *  - o primeiro passe de uma faixa muda devolve `-inf`: uma medição sem número finito NÃO vai ao
 *    segundo passe (cai no passe único);
 *  - centenas de trechos estouram o limite de 32 mil caracteres da linha de comando do Windows:
 *    o grafo vai num ARQUIVO (`-/filter_complex <arquivo>`, ffmpeg 8).
 */
import type { Range } from '@shared/types'

export const FADE_MS = 30
export const TARGET_LUFS = -14
export const TRUE_PEAK_DB = -1
export const SYSTEM_GAIN_DB = -9
export const OUTPUT_SAMPLE_RATE = 48_000
export const OUTPUT_AUDIO_BITRATE = '384k'

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
// Cadeia de voz (portada de `cadeiaDeVoz`, legado/lib/composicao.mjs)

/**
 * Latência do `afftdn` em amostras a 48 kHz (1200 = 25,0 ms). MEDIDA com o ffmpeg 8.1.1 por correlação
 * cruzada (entrada × saída): o filtro atrasa o som e NÃO compensa o carimbo de tempo, então sem corrigir
 * o áudio chegava ~25 ms depois da imagem. O teste e2e SINCRONIA (flash-bipe) pega a regressão.
 */
export const AFFTDN_LATENCY_SAMPLES = 1200

/** Limpeza e compressão da voz, ANTES de normalizar: ronco, chiado, sibilância, dinâmica (igual à do legado). */
export const VOICE_CLEAN_CHAIN = [
  'highpass=f=80', // ronco de mesa e ar-condicionado
  'afftdn=nr=12:nf=-45', // chiado de fundo
  'deesser=i=0.4', // sibilância do microfone perto da boca
  'acompressor=threshold=-18dB:ratio=3:attack=15:release=180'
].join(',')

/**
 * A mesma limpeza da voz, com o atraso do `afftdn` descontado: corta as primeiras amostras logo depois
 * dele e, no fim da faixa, completa com silêncio até a duração exata (`totalMs`), para a voz continuar
 * alinhada com a imagem e com a mesma duração.
 */
export function voiceChainCompensated(totalMs: number): string {
  return [
    'highpass=f=80',
    'afftdn=nr=12:nf=-45',
    `atrim=start_sample=${AFFTDN_LATENCY_SAMPLES}`,
    'asetpts=PTS-STARTPTS',
    'deesser=i=0.4',
    'acompressor=threshold=-18dB:ratio=3:attack=15:release=180',
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

/** Mesma cadeia do legado (`cadeiaDeVoz`): limpeza + `loudnorm` + 48 kHz. Mantida igual para comparação. */
export function cadeiaDeVoz(opts: { ganhoDb?: number; medido?: LoudnormMeasure | null; alvoLufs?: number; truePeak?: number } = {}): string {
  const etapas: string[] = []
  if (opts.ganhoDb) etapas.push(`volume=${opts.ganhoDb}dB`)
  etapas.push(VOICE_CLEAN_CHAIN)
  etapas.push(loudnormFilter({ measured: opts.medido ?? null, target: opts.alvoLufs ?? TARGET_LUFS, truePeak: opts.truePeak ?? -1.5 }))
  etapas.push('aresample=48000')
  return etapas.join(',')
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
}

export type AudioGraph = {
  /** Texto do `filter_complex`. */
  graph: string
  /** Rótulo da saída (para `-map`). */
  out: string
}

/** Um trecho de uma faixa: corta, completa com silêncio o que falta e põe fade nas duas bordas. */
export function segmentChain(range: Range, offsetMs: number): string {
  const len = range.end - range.start
  const fileStart = range.start - offsetMs
  const fileEnd = range.end - offsetMs
  const lead = fileStart < 0 ? -fileStart : 0
  const trimStart = Math.max(0, fileStart)
  const trimEnd = Math.max(trimStart, fileEnd)
  const fade = Math.min(FADE_MS, len / 2)
  const steps = [`atrim=start=${sec(trimStart)}:end=${sec(trimEnd)}`, 'asetpts=PTS-STARTPTS']
  if (lead > 0.5) steps.push(`adelay=delays=${Math.round(lead)}:all=1`)
  // garante a duração exata do trecho mesmo se o arquivo for mais curto que o vídeo
  steps.push(`apad=whole_dur=${sec(len)}`, `atrim=end=${sec(len)}`, 'asetpts=PTS-STARTPTS')
  if (fade > 0.5) {
    steps.push(`afade=t=in:st=0:d=${sec(fade)}`, `afade=t=out:st=${sec(len - fade)}:d=${sec(fade)}`)
  }
  return steps.join(',')
}

/** `[in:a]asplit` + trechos + `concat` para uma faixa; devolve as linhas do grafo e o rótulo da saída. */
function trackBranch(kept: readonly Range[], track: AudioTrackInput, tag: string): { lines: string[]; out: string } {
  const n = kept.length
  const lines: string[] = []
  const labels = kept.map((_, i) => `${tag}s${i}`)
  if (n === 1) lines.push(`[${track.input}:a]anull[${labels[0]}]`)
  else lines.push(`[${track.input}:a]asplit=${n}${labels.map((l) => `[${l}]`).join('')}`)
  const outs: string[] = []
  kept.forEach((range, i) => {
    const o = `${tag}c${i}`
    lines.push(`[${labels[i]}]${segmentChain(range, track.offsetMs)}[${o}]`)
    outs.push(o)
  })
  const cat = `${tag}cat`
  lines.push(n === 1 ? `[${outs[0]}]anull[${cat}]` : `${outs.map((o) => `[${o}]`).join('')}concat=n=${n}:v=0:a=1[${cat}]`)
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
    const b = trackBranch(kept, input.voice, 'v')
    lines.push(...b.lines)
    const stereo = input.voice.channels === 1 ? ',pan=stereo|c0=c0|c1=c0' : ''
    lines.push(`[${b.out}]${voiceChainCompensated(totalMs)}${stereo}[voz]`)
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
  lines.push(`[${mixed}]${norm},aresample=${OUTPUT_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`)
  return { graph: lines.join(';\n'), out: 'aout' }
}

/** Argumentos do ffmpeg para o primeiro passe (mede; descarta a saída). */
export function buildMeasureArgs(opts: { inputs: string[]; graphFile: string }): string[] {
  // o JSON do loudnorm sai no nível "info" (o ffmpeg do app roda em "error" por padrão)
  return ['-loglevel', 'info', ...opts.inputs.flatMap((f) => ['-i', f]), '-/filter_complex', opts.graphFile, '-map', '[aout]', '-f', 'null', '-']
}

/** Argumentos do ffmpeg para o passe final: AAC 48 kHz 384 kbps. */
export function buildAudioArgs(opts: { inputs: string[]; graphFile: string; output: string }): string[] {
  return [
    ...opts.inputs.flatMap((f) => ['-i', f]),
    '-/filter_complex',
    opts.graphFile,
    '-map',
    '[aout]',
    '-c:a',
    'aac',
    '-b:a',
    OUTPUT_AUDIO_BITRATE,
    '-ar',
    String(OUTPUT_SAMPLE_RATE),
    opts.output
  ]
}

/** Trilha muda (sem microfone nem som do sistema): `anullsrc` pela duração de saída. */
export function buildSilentAudioArgs(opts: { durationMs: number; output: string }): string[] {
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
    OUTPUT_AUDIO_BITRATE,
    '-ar',
    String(OUTPUT_SAMPLE_RATE),
    opts.output
  ]
}

/** Mux final: vídeo e áudio já prontos, só copiados, com `moov` no começo. */
export function buildMuxArgs(opts: { video: string; audio: string; output: string }): string[] {
  // `-f mp4`: o arquivo parcial tem a extensão `.parcial`, que o ffmpeg não reconhece
  return ['-i', opts.video, '-i', opts.audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', opts.output]
}
