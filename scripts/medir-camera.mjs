#!/usr/bin/env node
/**
 * Medidor da câmera REAL (qualidade e taxa de quadros do caminho de gravação do app).
 *
 *   node scripts/fila-pesada.mjs node scripts/medir-camera.mjs <preset> [--seconds 10] [--camera EMEET] [--mic EMEET] [--out <pasta>]
 *
 * Abre o Electron com UMA janela ESCONDIDA (nada pisca, nada rouba o foco), grava pelo `CaptureEngine`
 * de verdade (`src/renderer/recording/capture.ts`) com a câmera física escolhida pelo nome, com e sem a
 * tela gravando ao mesmo tempo, e mede o que saiu: quadros, qps efetivos, resolução, taxa de bits do
 * vídeo e nitidez (variância do Laplaciano do recorte central), tudo comparado com uma captura DIRETA do
 * ffmpeg (dshow, mjpeg, libx264 crf 14) feita em seguida. Também registra `track.getSettings()` e quantos
 * quadros a trilha entregou durante a gravação (separa "a câmera entregou pouco" de "o codificador perdeu").
 *
 * Presets: `aceite` (antes × depois, com e sem tela), `diagnostico` (a investigação inteira), `rapido`.
 * `--scenarios <arquivo.json>` roda uma lista própria. Os arquivos ficam em `C:\tmp\tomada-camera-medicao\`
 * (rosto do usuário: só nesta máquina, nunca no repositório; apague no fim: docs/LIXO.md).
 */
import { spawn, spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeFile, sharpness } from './medir-camera/analise.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const preset = argv.find((a) => !a.startsWith('--')) ?? 'aceite'
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const seconds = Number(opt('seconds', 10))
const cameraName = opt('camera', 'EMEET')
const micName = opt('mic', 'EMEET')
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const out = path.resolve(opt('out', `C:\\tmp\\tomada-camera-medicao\\${stamp}-${preset}`))
fs.mkdirSync(out, { recursive: true })

const ffmpeg = process.env.FFMPEG || 'ffmpeg'
const ffprobe = process.env.FFPROBE || 'ffprobe'

// ---------------------------------------------------------------------------------------------
// Cenários

const base = { seconds, camera: cameraName, mic: micName }
const direct = (id) => ({ id, scenario: 'ffmpeg', seconds, size: '1920x1080', framerate: 30 })
const engine = (id, withScreen, extra = {}) => ({ id, scenario: 'engine', withScreen, fps: 30, ...base, ...extra })
const raw = (id, withScreen, extra = {}) => ({ id, scenario: 'raw', withScreen, fps: 30, ...base, ...extra })
const probe = (id, extra = {}) => ({ id, scenario: 'probe', withScreen: false, ...base, seconds: 5, ...extra })

const sweepItems = []
for (const [width, height] of [[1920, 1080], [1280, 720]]) for (const frameRate of [15, 24, 30, 45, 60]) sweepItems.push({ width, height, frameRate })
sweepItems.push({ width: 1920, height: 1080, frameRate: 30, max: true }, { width: 1920, height: 1080, frameRate: 30, exact: true }, { width: 1920, height: 1080, frameRate: 60, exact: true })

const PRESETS = {
  // O caminho do app (CaptureEngine) em cada qualidade, com e sem a tela, entre capturas diretas do ffmpeg
  final: [
    direct('ffmpeg-1'),
    // ANTES: o que o app pedia (1080p, 30 qps com teto, H.264 de ~8 Mbps), pelo MediaRecorder cru
    raw('antes-camera', false, { videoBps: 8_100_000 }),
    raw('antes-camera-e-tela', true, { videoBps: 8_100_000 }),
    // DEPOIS: o CaptureEngine de verdade

    engine('app-max', false, { quality: 'max' }),
    engine('app-max-e-tela', true, { quality: 'max' }),
    engine('app-max-previas-e-tela', true, { quality: 'max', withPreviews: true }),
    direct('ffmpeg-2'),
    engine('app-alta', false, { quality: 'high' }),
    engine('app-alta-e-tela', true, { quality: 'high' }),
    direct('ffmpeg-3')
  ],
  varredura: [{ id: 'varredura', scenario: 'sweep', withScreen: false, ...base, seconds: 4, sweep: sweepItems }],
  rapido: [probe('trilha-1080p30'), engine('app-camera', false)],
  aceite: [
    direct('ffmpeg-1'),
    engine('app-camera', false),
    direct('ffmpeg-2'),
    engine('app-camera-e-tela', true),
    direct('ffmpeg-3')
  ],
  diagnostico: [
    direct('ffmpeg-1'),
    probe('trilha-1080p30'),
    probe('trilha-1080p60', { frameRate: 60 }),
    probe('trilha-1080p-sem-max', { noFrameRateMax: true }),
    probe('trilha-720p30', { width: 1280, height: 720 }),
    probe('trilha-4k30', { width: 3840, height: 2160 }),
    engine('app-camera', false),
    engine('app-camera-e-tela', true),
    raw('mr-h264-8m', false, { videoBps: 8_000_000 }),
    raw('mr-h264-8m-tela', true, { videoBps: 8_000_000 }),
    raw('mr-vp8-8m', false, { mime: 'video/webm;codecs=vp8,opus', videoBps: 8_000_000 }),
    raw('mr-vp9-8m', false, { mime: 'video/webm;codecs=vp9,opus', videoBps: 8_000_000 }),
    raw('mr-h264-16m', false, { videoBps: 16_000_000 }),
    raw('mr-h264-720p', false, { videoBps: 6_000_000, width: 1280, height: 720 }),
    direct('ffmpeg-2')
  ]
}

const switches = opt('switches', '') ? opt('switches', '').split(';') : []
const scenarios = opt('scenarios', null) ? JSON.parse(fs.readFileSync(opt('scenarios'), 'utf8')) : PRESETS[preset]
if (!scenarios) {
  console.error(`preset desconhecido: ${preset} (use ${Object.keys(PRESETS).join(', ')})`)
  process.exit(2)
}

// ---------------------------------------------------------------------------------------------
// Janela escondida: empacota a página e abre o Electron SEM `ELECTRON_RUN_AS_NODE`

const bundleDir = path.join(out, '_pagina')
fs.mkdirSync(bundleDir, { recursive: true })
await build({
  entryPoints: [path.join(root, 'scripts', 'medir-camera', 'pagina.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome140',
  outfile: path.join(bundleDir, 'pagina.js'),
  alias: { '@shared': path.join(root, 'src', 'shared') },
  logLevel: 'error'
})
const html = path.join(bundleDir, 'pagina.html')
fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><body>medição da câmera<script src="pagina.js"></script></body>')

// nome dshow EXATO da câmera (o ffmpeg precisa dele)
const dshowList = String(spawnSync(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8' }).stderr ?? '')
const cameraDshow = [...dshowList.matchAll(/"([^"]+)" \(video\)/g)].map((m) => m[1]).find((n) => n.toLowerCase().includes(cameraName.toLowerCase()))
if (!cameraDshow && scenarios.some((s) => s.scenario === 'ffmpeg')) {
  console.error(`câmera "${cameraName}" não está na lista do dshow:\n${dshowList}`)
  process.exit(2)
}

const configFile = path.join(out, 'configuracao.json')
fs.writeFileSync(configFile, JSON.stringify({ out, page: html, scenarios, ffmpeg, cameraDshow, switches }, null, 2))

const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const code = await new Promise((resolve) => {
  const child = spawn(electronExe, [path.join(root, 'scripts', 'medir-camera', 'principal.cjs'), configFile], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  child.stdout.on('data', (d) => process.stdout.write(d))
  child.on('close', resolve)
})
if (code !== 0) {
  console.error(`o Electron saiu com código ${code}`)
  process.exit(code ?? 1)
}

// ---------------------------------------------------------------------------------------------
// Análise dos arquivos

const execucao = JSON.parse(fs.readFileSync(path.join(out, 'execucao.json'), 'utf8'))
const fmt = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '-')
const rows = []
for (const r of execucao.results) {
  const dir = path.join(out, r.id)
  const file = ['camera.mp4', 'camera.webm'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f))
  const row = { id: r.id, scenario: r.scenario, error: r.error ?? null, settings: r.settings ?? r.cameraSettings ?? null, trackStats: r.trackStats ?? null, cpuApp: r.cpuApp, gpuUse: r.gpuUse, cpuSystemPct: r.cpuSystemPct, mime: r.mime ?? r.started?.cameraMime ?? null }
  if (file) {
    try {
      row.file = probeFile(ffprobe, file)
      row.sharp = await sharpness(ffmpeg, file)
      delete row.sharp.values
    } catch (e) {
      row.analysisError = String(e)
    }
  }
  const screen = path.join(dir, 'screen.webm')
  if (fs.existsSync(screen)) {
    try {
      row.screenFile = probeFile(ffprobe, screen)
    } catch (e) {
      row.screenError = String(e)
    }
  }
  rows.push(row)
}
fs.writeFileSync(path.join(out, 'resultado.json'), JSON.stringify({ flags: execucao.flags, rows }, null, 2))

const ref = rows.filter((r) => r.scenario === 'ffmpeg' && r.sharp).map((r) => r.sharp.median)
const refSharp = ref.length ? ref.reduce((a, v) => a + v, 0) / ref.length : null
console.log('\n=== RESUMO ===')
console.log(`referência de nitidez (média das capturas diretas do ffmpeg): ${fmt(refSharp, 1)}`)
console.log('| cenário | trilha qps | arquivo qps | quadros | resolução | Mbps vídeo | gap med/p99/máx ms | nitidez | % da ref | luma | CPU sist % | GPU enc % |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) {
  const f = r.file
  console.log(
    `| ${r.id} | ${fmt(r.trackStats?.fps)} | ${fmt(f?.fpsEffective)} | ${f?.frames ?? '-'} | ${f ? `${f.width}x${f.height}` : '-'} | ${fmt(f?.videoMbps)} | ${f ? `${fmt(f.gapMedianMs, 0)}/${fmt(f.gapP99Ms, 0)}/${fmt(f.gapMaxMs, 0)}` : '-'} | ${fmt(r.sharp?.median, 1)} | ${refSharp && r.sharp ? fmt((100 * r.sharp.median) / refSharp, 0) : '-'} | ${fmt(r.sharp?.meanLuma, 0)} | ${fmt(r.cpuSystemPct, 0)} | ${fmt(r.gpuUse?.gpuEncoderAvgPct, 0)} |${r.error ? ` ERRO ${r.error}` : ''}`
  )
}
console.log(`\nResultado completo: ${path.join(out, 'resultado.json')}`)
