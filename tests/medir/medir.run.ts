/**
 * Mede os dois motores (faster-whisper × whisper.cpp) em três áudios: `voz.wav` (gabarito exato) e as duas
 * gravações REAIS do usuário (`gravacoes/…/camera.mp4`, só nesta máquina; o texto transcrito NUNCA é impresso nem
 * gravado em disco: só contagens e tempos). Reproduz a tabela do README: `npm run medir:transcricao`.
 *
 * Medidas por motor e áudio: velocidade (× tempo real, do início do processo ao fim, e só da transcrição quando o
 * motor informa), VRAM de pico (delta do `nvidia-smi` sobre o repouso), palavras, hesitações, fala sem palavra,
 * probabilidade média; no gabarito, WER e o erro de tempo de cada marca; nas gravações, a divergência entre os dois
 * motores (WER de um contra o outro).
 */
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { computeClean, DEFAULT_CLEAN } from '../../src/shared/clean'
import { transcriptCounts } from '../../src/shared/transcript'
import type { Transcript } from '../../src/shared/types'
import { createFasterWhisper } from '../../src/main/transcription/faster-whisper'
import { createLogger } from '../../src/main/logger'
import { createFfmpeg, locateFfmpeg } from '../../src/main/ffmpeg'
import { ensureToolsDir, toolPaths } from '../../src/main/transcription/tools-dir'
import type { RunStats, Transcriber } from '../../src/main/transcription/types'
import { createWhisperCpp } from '../../src/main/transcription/whisper-cpp'
import { checkAgainstGabarito } from '../helpers/gabarito'
import { FIX } from '../helpers/env'
import { ROOT } from '../helpers/fs'
import { wordErrors } from '../helpers/wer'

const execFileAsync = promisify(execFile)

const REAL = [
  { id: 'real-1 (20 s)', file: join(ROOT, 'gravacoes', '2026-07-26-12-59-14', 'camera.mp4') },
  { id: 'real-2 (28 s)', file: join(ROOT, 'gravacoes', '2026-07-26-13-57-59', 'camera.mp4') }
]

async function vramUsedMiB(): Promise<number> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'])
    return Number(stdout.trim().split(/\r?\n/)[0])
  } catch {
    return 0
  }
}

type Row = {
  engine: string
  audio: string
  audioS: number
  wallS: number
  speedX: number
  transcribeS: number | null
  vramPeakMiB: number
  words: number
  fillers: number
  gapSpeech: number
  avgProb: number
  cleanCuts: number
  suggestedCrutches: number
  wer?: number
  worstErrMs?: number
  fillersFound?: string
  marks?: unknown
  /** Só texto interno para comparar os motores; NUNCA é gravado nem impresso. */
  text?: string
}

async function measure(engine: Transcriber, audio: string, label: string, audioMs: number): Promise<{ row: Row; transcript: Transcript }> {
  let stats: RunStats | null = null
  const baseline = await vramUsedMiB()
  let peak = baseline
  let alive = true
  const sampler = (async () => {
    while (alive) {
      peak = Math.max(peak, await vramUsedMiB())
      await new Promise((r) => setTimeout(r, 150))
    }
  })()
  let transcript: Transcript
  try {
    transcript = await engine.transcribe(audio, { audioMs, onStats: (s) => (stats = s) })
  } finally {
    alive = false
    await sampler
  }
  const s = stats as RunStats | null
  const counts = transcriptCounts(transcript)
  const real = transcript.words.filter((w) => w.kind !== 'gap-speech')
  const clean = computeClean({ words: transcript.words, durationMs: transcript.durationMs, vad: transcript.vad }, DEFAULT_CLEAN)
  const row: Row = {
    engine: engine.id,
    audio: label,
    audioS: audioMs / 1000,
    wallS: (s?.wallMs ?? 0) / 1000,
    speedX: s?.speedX ?? 0,
    transcribeS: s?.transcribeMs !== undefined ? s.transcribeMs / 1000 : null,
    vramPeakMiB: Math.max(0, peak - baseline),
    words: counts.words + counts.fillers,
    fillers: counts.fillers,
    gapSpeech: counts.gapSpeech,
    avgProb: real.length > 0 ? real.reduce((a, w) => a + w.prob, 0) / real.length : 0,
    cleanCuts: clean.items.length,
    suggestedCrutches: clean.suggestedCrutches
  }
  return { row, transcript }
}

it('mede os dois motores', async () => {
  const tools = toolPaths(ensureToolsDir())
  const logger = createLogger(join(tools.base, 'logs'), { echo: true })
  const fw = createFasterWhisper({ tools, scriptPath: join(ROOT, 'resources', 'transcribe.py'), logger })
  const wc = createWhisperCpp({ tools, logger })
  const engines: Transcriber[] = []
  for (const e of [fw, wc]) {
    const c = await e.check()
    if (c.state === 'ready') engines.push(e)
    else console.log(`[medir] ${e.id}: ${c.detail}`)
  }
  expect(engines.length, 'nenhum motor preparado: rode `npm run preparar:transcricao`').toBeGreaterThan(0)

  const ff = createFfmpeg(locateFfmpeg()!)
  mkdirSync(tools.tmp, { recursive: true })
  const audios: { label: string; wav: string; ms: number; gabarito: boolean; cleanup: boolean }[] = [{ label: 'voz.wav (gabarito)', wav: FIX.voz, ms: 22_693, gabarito: true, cleanup: false }]
  for (const r of REAL) {
    const wav = join(tools.tmp, `medicao-${r.id.replace(/\W+/g, '-')}.wav`)
    await ff.run(['-i', r.file, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wav])
    const probe = await ff.probe(wav)
    audios.push({ label: r.id, wav, ms: probe.durationMs, gabarito: false, cleanup: true })
  }

  // (1) a mesma gravação real de 28 s com o volume já normalizado (o `final.mp4` da pasta): se um motor muda de
  // texto só porque o áudio ficou mais alto, ele é frágil. Só contagens saem daqui, nunca o texto.
  const normWav = join(tools.tmp, 'medicao-real-2-normalizada.wav')
  await ff.run(['-i', join(ROOT, 'gravacoes', '2026-07-26-13-57-59', 'final.mp4'), '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', normWav])
  audios.push({ label: 'real-2 normalizada', wav: normWav, ms: (await ff.probe(normWav)).durationMs, gabarito: false, cleanup: true })

  // (2) fala contínua longa: a voz sintética repetida 13 vezes (~4,9 min, quase sem pausa). Mostra a velocidade
  // SUSTENTADA em fala densa, sem o custo fixo de carregar o modelo e sem silêncio que o VAD pule.
  const longWav = join(tools.tmp, 'medicao-fala-longa.wav')
  await ff.run(['-stream_loop', '12', '-i', FIX.voz, '-c:a', 'pcm_s16le', longWav])
  audios.push({ label: 'fala longa (voz × 13)', wav: longWav, ms: (await ff.probe(longWav)).durationMs, gabarito: false, cleanup: true })

  const rows: Row[] = []
  const texts = new Map<string, string>()
  try {
    for (const a of audios) {
      for (const engine of engines) {
        // a primeira execução paga o carregamento do modelo e o aquecimento da placa: roda uma vez só para aquecer
        const { row, transcript } = await measure(engine, a.wav, a.label, a.ms)
        if (a.gabarito) {
          const rep = checkAgainstGabarito(transcript)
          row.wer = rep.wer
          row.worstErrMs = rep.worstErrMs
          row.fillersFound = `${rep.fillersFound}/${rep.fillersTotal}`
          row.marks = rep.marks
        }
        texts.set(`${engine.id}|${a.label}`, transcript.words.filter((w) => w.kind !== 'gap-speech').map((w) => w.text).join(' '))
        rows.push(row)
        console.log(`[medir] ${engine.id} · ${a.label}: ${row.wallS.toFixed(1)} s (${row.speedX.toFixed(1)}× tempo real), VRAM +${row.vramPeakMiB} MiB, ${row.words} palavras, ${row.fillers} hesitações, ${row.gapSpeech} fala sem palavra${row.wer !== undefined ? `, WER ${(row.wer * 100).toFixed(1)}%, pior erro ${row.worstErrMs} ms, muletas ${row.fillersFound}` : ''}`)
      }
    }
  } finally {
    for (const a of audios) if (a.cleanup) rmSync(a.wav, { force: true })
  }

  // divergência (WER de um texto contra o outro; os textos nunca são impressos)
  const divergence: Record<string, number> = {}
  const text = (engine: string, label: string): string => texts.get(`${engine}|${label}`) ?? ''
  if (engines.length === 2) {
    for (const a of audios.filter((x) => !x.gabarito)) divergence[`fw×cpp em ${a.label}`] = wordErrors(text(fw.id, a.label), text(wc.id, a.label)).wer
  }
  for (const engine of engines) {
    divergence[`${engine.id}: real-2 crua × normalizada`] = wordErrors(text(engine.id, 'real-2 (28 s)'), text(engine.id, 'real-2 normalizada')).wer
  }
  mkdirSync(join(ROOT, 'test-results'), { recursive: true })
  writeFileSync(join(ROOT, 'test-results', 'transcricao-medicao.json'), `${JSON.stringify({ rows, divergence }, null, 2)}\n`)
  console.log('[medir] divergências (WER de um contra o outro):', JSON.stringify(divergence))
  console.log('[medir] resultado em test-results/transcricao-medicao.json')
})
