#!/usr/bin/env node
/**
 * Prova de emenda de um vídeo JÁ exportado (F1 · R6).
 *
 *   node scripts/medir-emendas.mjs <video.mp4> <project.json> [--formato horizontal|vertical] [--json saida.json]
 *
 * Lê os cortes do `project.json` (os que valem para o vídeo: o documento do YouTube ou do vídeo inteiro vertical), calcula onde
 * cada emenda cai no vídeo final e mede o PRÓPRIO arquivo: emendas por minuto, menor trecho, queda de nível em cada emenda e emendas
 * dentro de fala (`src/shared/seam-proof.ts`, o mesmo medidor que a exportação roda sozinha). Não precisa do Electron nem da GPU.
 *
 * Saída: 0 passou; 2 reprovou (a lista diz por quê); 1 erro. Para medir um corte vertical, use o `project.json` com os cortes DELE.
 */
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))
const [video, projectFile] = positional
if (!video || !projectFile) {
  console.error('Uso: node scripts/medir-emendas.mjs <video.mp4> <project.json> [--formato horizontal|vertical] [--json saida.json]')
  process.exit(1)
}
for (const f of [video, projectFile]) {
  if (!fs.existsSync(f)) {
    console.error(`Não encontrei ${f}`)
    process.exit(1)
  }
}

const ffmpeg = process.env.FFMPEG || 'ffmpeg'
const ffprobe = process.env.FFPROBE || 'ffprobe'
const SAMPLE_RATE = 8000

// o medidor é TypeScript do app: empacota na hora (esbuild já vem com o Vite) numa pasta temporária sem acento
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomada-medir-emendas-'))
try {
  const entry = `export { measureSeams, seamSummary } from '@shared/seam-proof'\nexport { planSeams } from '@shared/seams'\nexport { keptRanges } from '@shared/timeline'\n`
  const outfile = path.join(outDir, 'lib.mjs')
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'entrada.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    alias: { '@shared': path.join(root, 'src', 'shared') },
    logLevel: 'error'
  })
  const lib = await import(pathToFileURL(outfile).href)

  const probe = spawnSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', video], { encoding: 'utf8', windowsHide: true })
  if (probe.status !== 0) throw new Error(`ffprobe falhou: ${probe.stderr?.split(/\r?\n/).slice(-4).join(' ')}`)
  const info = JSON.parse(probe.stdout)
  const v = info.streams.find((s) => s.codec_type === 'video')
  const durationMs = Number(info.format.duration) * 1000
  const format = flag('formato') ?? (v && v.height > v.width ? 'vertical' : 'horizontal')

  const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'))
  const src = project.sources ?? {}
  const sourceMs = Math.max(0, ...['screen', 'camera', 'voice', 'system'].map((k) => src[k]?.durationMs ?? 0))
  const kept = lib.keptRanges(sourceMs, (project.cuts ?? []).map((c) => ({ start: c.start, end: c.end, enabled: c.enabled !== false })))
  const seams = lib.planSeams(kept)

  const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', video, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'], { maxBuffer: 1024 * 1024 * 1024, windowsHide: true })
  if (decoded.status !== 0) throw new Error(`ffmpeg falhou ao ler o áudio: ${decoded.stderr?.toString().split(/\r?\n/).slice(-4).join(' ')}`)
  const pcm = new Int16Array(decoded.stdout.buffer, decoded.stdout.byteOffset, Math.floor(decoded.stdout.byteLength / 2))
  const samples = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768

  const report = lib.measureSeams(samples, SAMPLE_RATE, seams.map((s) => s.outMs), durationMs, { format })
  const f = (n, d = 1) => (n === null || n === undefined ? '—' : n.toFixed(d))
  console.log(`${path.basename(video)} · ${format} · ${(durationMs / 1000).toFixed(2)} s · ${(sourceMs / 1000).toFixed(2)} s de origem`)
  console.log(`emendas: ${report.seams} (${f(report.seamsPerMin)}/min) · menor trecho (pontas incluídas) ${report.shortestMs === null ? '—' : `${Math.round(report.shortestMs)} ms`} · menor entre emendas ${report.shortestBetweenMs === null ? '—' : `${Math.round(report.shortestBetweenMs)} ms`} · trechos < 1,5 s: ${report.under1500} · emendas em fala: ${report.inSpeech}`)
  console.log(`voz ${f(report.voiceDb)} dBFS · chão ${f(report.floorDb)} dBFS · maior queda ${f(report.maxDropDb)} dB${report.worstDropAtMs === null ? '' : ` aos ${(report.worstDropAtMs / 1000).toFixed(2)} s`}`)
  console.log('  emenda   saída(s)  lateral(dB)  buraco(dB)  queda(dB)  na emenda(dB)  fala')
  for (const m of report.measures) {
    console.log(`  ${String(m.index + 1).padStart(6)}  ${(m.outMs / 1000).toFixed(2).padStart(8)}  ${f(m.aroundDb).padStart(11)}  ${f(m.dipDb).padStart(10)}  ${f(m.dropDb).padStart(9)}  ${f(m.atDb).padStart(13)}  ${m.inSpeech ? 'SIM' : 'não'}`)
  }
  console.log(lib.seamSummary(report))
  const json = flag('json')
  if (json) fs.writeFileSync(json, JSON.stringify({ video, format, durationMs, sourceMs, ...report }, null, 2))
  process.exitCode = report.ok ? 0 : 2
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
} finally {
  fs.rmSync(outDir, { recursive: true, force: true })
}
