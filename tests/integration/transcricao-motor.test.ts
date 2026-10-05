/**
 * Os motores de transcrição DE VERDADE (faster-whisper e whisper.cpp, na placa de vídeo), com o código do app:
 *  - `voz.wav`, a voz sintética de gabarito exato: texto (WER < 15%) e marcas de tempo (erro máximo por motor);
 *  - uma gravação REAL do usuário (`gravacoes/`, só nesta máquina; nada dela é copiado para `tests/`): só se prova que
 *    devolve palavras em português com tempos coerentes, sem imprimir o conteúdo;
 *  - o cancelamento, o progresso e o dicionário.
 * Exigem o motor preparado (`npm run preparar:transcricao`): sem ele o teste FALHA dizendo isso (nada de pular).
 */
import { existsSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { foldText } from '@shared/text-edit'
import type { Transcript } from '@shared/types'
import { createFfmpeg, locateFfmpeg } from '../../src/main/ffmpeg'
import { createMemoryLogger } from '../../src/main/logger'
import { createFasterWhisper } from '../../src/main/transcription/faster-whisper'
import { ensureToolsDir, toolPaths } from '../../src/main/transcription/tools-dir'
import type { RunStats, Transcriber } from '../../src/main/transcription/types'
import { createWhisperCpp } from '../../src/main/transcription/whisper-cpp'
import { checkAgainstGabarito } from '../helpers/gabarito'
import { FIX } from '../helpers/env'
import { ROOT } from '../helpers/fs'

const tools = toolPaths(ensureToolsDir())
const logger = createMemoryLogger()
const engines: Record<string, Transcriber> = {
  'faster-whisper': createFasterWhisper({ tools, scriptPath: join(ROOT, 'resources', 'transcribe.py'), logger }),
  'whisper-cpp': createWhisperCpp({ tools, logger })
}

async function mustBeReady(engine: Transcriber): Promise<void> {
  const c = await engine.check()
  expect(c.state, `${engine.id} não está preparado (${c.detail ?? 'sem detalhe'}). Rode: npm run preparar:transcricao`).toBe('ready')
}

const REAL = join(ROOT, 'gravacoes', '2026-07-26-13-57-59', 'camera.mp4')
/** Palavras muito comuns do português: se aparecer alguma, o idioma é o certo (nada do conteúdo é impresso). */
const PT_COMMON = new Set(['de', 'a', 'o', 'que', 'e', 'do', 'da', 'em', 'um', 'uma', 'para', 'com', 'nao', 'eu', 'voce', 'os', 'as', 'se', 'na', 'no', 'por', 'mais', 'foi', 'ou', 'como', 'mas', 'ja', 'esse', 'essa', 'isso', 'ai', 'ne', 'ta', 'vou', 'tem', 'aqui', 'entao', 'tipo', 'ele', 'ela', 'ser', 'era', 'meu', 'sua', 'me', 'te', 'la'])

/** Cada motor tem o limite de erro de tempo que a medição da M3 mostrou (README): o escolhido fica em ±150 ms. */
const MAX_TIME_ERR_MS: Record<string, number> = { 'faster-whisper': 150, 'whisper-cpp': 300 }

for (const [id, engine] of Object.entries(engines)) {
  describe(`motor ${id} na voz de gabarito`, () => {
    let transcript!: Transcript
    const progress: number[] = []
    let stats: RunStats | null = null

    beforeAll(async () => {
      await mustBeReady(engine)
      transcript = await engine.transcribe(FIX.voz, { audioMs: 22_693, onProgress: (f) => progress.push(f), onStats: (s) => (stats = s) })
    })

    it('o texto confere com o gabarito: WER abaixo de 15%', () => {
      const report = checkAgainstGabarito(transcript)
      expect(report.wer, `WER ${(report.wer * 100).toFixed(1)}%`).toBeLessThan(0.15)
    })

    it(`as marcas de tempo (começo e fim de cada frase e de cada muleta) erram no máximo ${MAX_TIME_ERR_MS[id]} ms`, () => {
      const report = checkAgainstGabarito(transcript)
      const missing = report.marks.filter((m) => m.found === 'no').map((m) => m.id)
      expect(missing, 'marcas que o motor não achou').toEqual([])
      expect(report.worstErrMs, `pior erro ${report.worstErrMs} ms: ${JSON.stringify(report.marks.map((m) => [m.id, m.startErrMs, m.endErrMs]))}`).toBeLessThanOrEqual(MAX_TIME_ERR_MS[id]!)
    })

    it('as 4 muletas do gabarito estão na transcrição (como palavra ou como fala sem palavra)', () => {
      const report = checkAgainstGabarito(transcript)
      expect(report.fillersFound).toBe(report.fillersTotal)
    })

    it('formato: palavras numeradas, em ms inteiros, em ordem, sem sobreposição, dentro da duração; pt', () => {
      expect(transcript.language).toBe('pt')
      expect(transcript.engine.replace(/\W/g, '')).toBe(id.replace(/\W/g, ''))
      const w = transcript.words
      expect(w.length).toBeGreaterThan(30)
      w.forEach((x, k) => {
        expect(x.i).toBe(k)
        expect(Number.isInteger(x.start) && Number.isInteger(x.end)).toBe(true)
        expect(x.end).toBeGreaterThan(x.start)
        expect(x.prob).toBeGreaterThanOrEqual(0)
        expect(x.prob).toBeLessThanOrEqual(1)
        if (k > 0) expect(x.start).toBeGreaterThanOrEqual(w[k - 1]!.end)
      })
      expect(w[w.length - 1]!.end).toBeLessThanOrEqual(22_693 + 50)
      expect(transcript.vad.length).toBeGreaterThan(2)
      expect(transcript.segments.length).toBeGreaterThan(0)
    })

    it('o progresso sobe de 0 a 1 sem andar para trás, e os números de velocidade vêm do motor', () => {
      expect(progress.length).toBeGreaterThan(0)
      expect([...progress].sort((a, b) => a - b)).toEqual(progress)
      expect(Math.max(...progress)).toBeGreaterThan(0.9)
      const s = stats as RunStats | null
      expect(s?.engine).toBe(id)
      expect(s?.speedX).toBeGreaterThan(1)
    })
  })

  describe(`motor ${id}: outras garantias`, () => {
    it('gravação real do usuário: devolve palavras em português com tempos coerentes (o texto não é impresso)', async () => {
      await mustBeReady(engine)
      expect(existsSync(REAL), 'a gravação real do usuário fica em gravacoes/ (só nesta máquina, fora do git)').toBe(true)
      const ff = createFfmpeg(locateFfmpeg()!)
      mkdirSync(tools.tmp, { recursive: true })
      const wav = join(tools.tmp, `teste-real-${id}.wav`)
      try {
        await ff.run(['-y', '-i', REAL, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wav])
        const ms = (await ff.probe(wav)).durationMs
        let stats: RunStats | null = null
        const t = await engine.transcribe(wav, { audioMs: ms, onStats: (s) => (stats = s) })
        const words = t.words.filter((w) => w.kind !== 'gap-speech')
        expect(words.length, 'palavras na gravação real').toBeGreaterThan(8)
        expect(words.some((w) => PT_COMMON.has(foldText(w.text))), 'nenhuma palavra comum do português: idioma errado?').toBe(true)
        words.forEach((w, k) => {
          expect(w.end).toBeGreaterThan(w.start)
          if (k > 0) expect(w.start).toBeGreaterThanOrEqual(words[k - 1]!.end)
        })
        expect(words[words.length - 1]!.end).toBeLessThanOrEqual(ms + 100)
        // velocidade da transcrição: bem mais rápida que o tempo real (a placa)
        expect((stats as RunStats | null)?.speedX ?? 0).toBeGreaterThan(1.5)
      } finally {
        await rm(wav, { force: true, maxRetries: 10, retryDelay: 200 })
      }
    })

    it('cancelar no meio interrompe o motor logo, com "Cancelado."', async () => {
      await mustBeReady(engine)
      const ff = createFfmpeg(locateFfmpeg()!)
      mkdirSync(tools.tmp, { recursive: true })
      const long = join(tools.tmp, `teste-longo-${id}.wav`)
      try {
        await ff.run(['-y', '-stream_loop', '12', '-i', FIX.voz, '-c:a', 'pcm_s16le', long])
        const ctl = new AbortController()
        const started = Date.now()
        const run = engine.transcribe(long, { audioMs: 295_000, signal: ctl.signal })
        setTimeout(() => ctl.abort(), 2500)
        await expect(run).rejects.toThrow(/Cancelad/)
        expect(Date.now() - started).toBeLessThan(20_000)
      } finally {
        // o programa cancelado ainda segura o arquivo por alguns instantes no Windows: apaga com tentativas
        await rm(long, { force: true, maxRetries: 20, retryDelay: 300 })
      }
    })

    it('o dicionário não atrapalha: com termos, a voz de gabarito segue abaixo de 15% de erro', async () => {
      await mustBeReady(engine)
      const t = await engine.transcribe(FIX.voz, { audioMs: 22_693, vocabulary: ['Tomada', 'Kubernetes'] })
      expect(checkAgainstGabarito(t).wer).toBeLessThan(0.15)
    })

    it('deslocamento da voz: os tempos saem no relógio da gravação (soma o offset)', async () => {
      await mustBeReady(engine)
      const a = await engine.transcribe(FIX.voz, { audioMs: 22_693 })
      const b = await engine.transcribe(FIX.voz, { audioMs: 22_693, offsetMs: 1500 })
      expect(b.words).toHaveLength(a.words.length)
      expect(Math.abs(b.words[0]!.start - a.words[0]!.start - 1500)).toBeLessThanOrEqual(1)
      expect(Math.abs(b.words.at(-1)!.end - a.words.at(-1)!.end - 1500)).toBeLessThanOrEqual(1)
    })
  })
}
