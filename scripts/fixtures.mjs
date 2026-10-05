#!/usr/bin/env node
/**
 * Gera os fixtures de teste em `tests/fixtures/` (fora do git, sob demanda).
 *
 *   node scripts/fixtures.mjs            gera se faltar
 *   node scripts/fixtures.mjs --force    refaz tudo
 *
 * Produz:
 *   voz.wav + voz.json   voz pt-BR (Microsoft Maria, System.Speech) com pausas, muletas e gabarito
 *   tela-vfr.webm        tela sintética, VP9, taxa de quadros VARIÁVEL
 *   camera.webm          vídeo sintético + voz (Opus)
 *   flash-bipe.mp4       clarão branco + bipe 1 kHz a cada 2 s (medir sincronia)
 *   fake-camera.y4m      640×360, 5 s, para --use-file-for-fake-video-capture
 *   projeto-exemplo/     projeto completo (project.json válido) para biblioteca e M2
 *
 * ── Sobre o gabarito da voz ─────────────────────────────────────────────────
 * O plano previa `<mark/>` + `BookmarkReached.AudioPosition`. Medido nesta máquina,
 * esse tempo NÃO acompanha o arquivo (numa frase de 2,15 s com a fala acabando em
 * 1,14 s, a marca final saiu em 2,75 s; numa de 17,5 s saiu 23,9 s). Então a voz é
 * sintetizada FRASE POR FRASE (cada uma em SSML), o silêncio é gerado por nós e a
 * linha do tempo é montada por contagem de amostras: o gabarito é exato por
 * construção, e vai para `voz.json` (inclusive como `marks`, nome → ms).
 *
 * O caminho desta máquina tem "ô" (José): tudo que o ffmpeg e o PowerShell tocam
 * fica numa pasta temporária SEM acento; só o resultado final é copiado para cá.
 */
import { execFile, spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..')
export const FIXTURES_DIR = join(ROOT, 'tests', 'fixtures')
/** Muda quando o conteúdo gerado muda: força regerar nas máquinas que já têm fixtures. */
export const FIXTURES_VERSION = 2
const MARKER = join(FIXTURES_DIR, '.fixtures-ok')

const EXAMPLE_FOLDER = 'projeto-exemplo'

// ---------------------------------------------------------------------------
// Roteiro da voz (kind: speech | filler | pause). Tudo em pt-BR.

const SCRIPT = [
  { id: 'frase1', kind: 'speech', text: 'Olá, pessoal. Hoje eu vou mostrar como gravar a tela.' },
  { id: 'pausa1', kind: 'pause', ms: 1500 },
  { id: 'muleta1', kind: 'filler', text: 'é', filler: 'é' },
  { id: 'frase2', kind: 'speech', text: 'Então, vamos clicar aqui no botão de gravar.' },
  { id: 'pausa2', kind: 'pause', ms: 700 },
  { id: 'muleta2', kind: 'filler', text: 'hã', filler: 'hã' },
  { id: 'muleta3', kind: 'filler', text: 'tipo', filler: 'tipo' },
  { id: 'frase3', kind: 'speech', text: 'O resultado aparece direto na biblioteca' },
  { id: 'muleta4', kind: 'filler', text: 'né', filler: 'né' },
  { id: 'pausa3', kind: 'pause', ms: 1500 },
  { id: 'frase4', kind: 'speech', text: 'Pronto. Era isso por hoje, até a próxima.' }
]
const LEAD_MS = 400 // silêncio antes da primeira fala
const TAIL_MS = 400 // e depois da última
const JOIN_MS = 120 // respiro entre falas coladas (não conta como pausa)
const SILENCE_THRESHOLD = 400 // |amostra| (de 32768) abaixo disso é silêncio, ao aparar
const TRIM_MARGIN_MS = 12

/**
 * Copia uma pasta inteira. Não usa fs.cpSync: com caminho acentuado ("José") ele
 * falha com EIO no Windows.
 */
export function copyTree(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dst)
    else copyFileSync(src, dst)
  }
}

// ---------------------------------------------------------------------------
// Execução de processos

function runProc(cmd, args, { cwd } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) =>
      rej(new Error(e.code === 'ENOENT' ? `Não achei "${cmd}" no PATH. Instale o ffmpeg.` : e.message))
    )
    child.on('close', (code) => {
      if (code === 0) res({ stdout: out, stderr: err })
      else rej(new Error(`${cmd} saiu com código ${code}:\n${err.trim().split(/\r?\n/).slice(-10).join('\n')}`))
    })
  })
}

const ffmpeg = (args) => runProc('ffmpeg', ['-hide_banner', '-nostats', '-loglevel', 'error', '-y', ...args])

async function probeDurationMs(file) {
  const { stdout } = await new Promise((res, rej) =>
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { windowsHide: true },
      (e, so, se) => (e ? rej(new Error(`ffprobe: ${se || e.message}`)) : res({ stdout: so }))
    )
  )
  return Math.round(parseFloat(stdout) * 1000)
}

// ---------------------------------------------------------------------------
// Voz: System.Speech (Windows PowerShell 5) frase a frase

const PS_SCRIPT = `
param([string]$configFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$cfg = Get-Content -Raw -Encoding UTF8 -LiteralPath $configFile | ConvertFrom-Json
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'pt-BR' -and $_.VoiceInfo.Name -like '*Maria*' } | Select-Object -First 1
if (-not $voice) { throw 'Voz Microsoft Maria (pt-BR) nao encontrada neste Windows.' }
$s.SelectVoice($voice.VoiceInfo.Name)
foreach ($item in $cfg.items) {
  $s.SetOutputToWaveFile($item.file)
  $text = [System.Security.SecurityElement]::Escape($item.text)
  $s.SpeakSsml("<speak version='1.0' xml:lang='pt-BR' xmlns='http://www.w3.org/2001/10/synthesis'>$text</speak>")
  $s.SetOutputToNull()
}
$s.Dispose()
Write-Output $voice.VoiceInfo.Name
`

function parseWavPcm16(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('WAV inválido da síntese de voz.')
  }
  let pos = 12
  let fmt = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    let size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14)
      }
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV sem chunk fmt.')
      if (fmt.audioFormat !== 1 || fmt.bits !== 16 || fmt.channels !== 1) {
        throw new Error(`Formato de WAV inesperado: ${JSON.stringify(fmt)}`)
      }
      if (body + size > buf.length) size = buf.length - body // cabeçalho com tamanho curinga
      const samples = new Int16Array(size >> 1)
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(body + i * 2)
      return { sampleRate: fmt.sampleRate, samples }
    }
    pos = body + size + (size & 1)
  }
  throw new Error('WAV sem chunk data.')
}

function trimSilence(samples, sampleRate) {
  let a = 0
  let b = samples.length - 1
  while (a <= b && Math.abs(samples[a]) < SILENCE_THRESHOLD) a++
  while (b >= a && Math.abs(samples[b]) < SILENCE_THRESHOLD) b--
  if (a > b) throw new Error('Segmento de voz saiu mudo.')
  const margin = Math.round((TRIM_MARGIN_MS / 1000) * sampleRate)
  return samples.subarray(Math.max(0, a - margin), Math.min(samples.length, b + 1 + margin))
}

function writeWavPcm16(file, samples, sampleRate) {
  const dataBytes = samples.length * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2)
  writeFileSync(file, buf)
}

/** Sintetiza o roteiro, monta a linha do tempo e escreve `voz.wav` (48 kHz mono) em `tmp`. */
async function synthVoice(tmp) {
  const segDir = join(tmp, 'seg')
  mkdirSync(segDir)
  const items = SCRIPT.filter((s) => s.kind !== 'pause').map((s, i) => ({
    id: s.id,
    text: s.text,
    file: join(segDir, `seg-${String(i).padStart(2, '0')}.wav`)
  }))
  const cfgFile = join(tmp, 'voz-config.json')
  writeFileSync(cfgFile, JSON.stringify({ items }), 'utf8')
  // .ps1 com BOM UTF-8: o PowerShell 5 lê sem BOM como ANSI e estraga acentos.
  const psFile = join(tmp, 'voz.ps1')
  writeFileSync(psFile, `\uFEFF${PS_SCRIPT}`, 'utf8')
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await runProc(powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    psFile,
    cfgFile
  ])
  const voiceName = stdout.trim().split(/\r?\n/).pop()

  const wavs = new Map()
  let sampleRate = 0
  for (const it of items) {
    const w = parseWavPcm16(readFileSync(it.file))
    sampleRate ||= w.sampleRate
    if (w.sampleRate !== sampleRate) throw new Error('Taxas de amostragem diferentes entre segmentos.')
    wavs.set(it.id, trimSilence(w.samples, w.sampleRate))
  }

  const ms = (n) => Math.round((n / 1000) * sampleRate)
  const chunks = []
  let total = 0
  const push = (arr) => {
    chunks.push(arr)
    total += arr.length
  }
  const toMs = (n) => Math.round((n / sampleRate) * 1000)

  const segments = []
  push(new Int16Array(ms(LEAD_MS)))
  let prevWasSound = false
  for (const s of SCRIPT) {
    if (s.kind === 'pause') {
      const start = total
      push(new Int16Array(ms(s.ms)))
      segments.push({ id: s.id, kind: 'pause', startMs: toMs(start), endMs: toMs(total) })
      prevWasSound = false
      continue
    }
    if (prevWasSound) push(new Int16Array(ms(JOIN_MS)))
    const start = total
    push(wavs.get(s.id))
    segments.push({
      id: s.id,
      kind: s.kind,
      text: s.text,
      ...(s.filler ? { filler: s.filler } : {}),
      startMs: toMs(start),
      endMs: toMs(total)
    })
    prevWasSound = true
  }
  push(new Int16Array(ms(TAIL_MS)))

  const all = new Int16Array(total)
  let off = 0
  for (const c of chunks) {
    all.set(c, off)
    off += c.length
  }
  const raw = join(tmp, 'voz-22k.wav')
  writeWavPcm16(raw, all, sampleRate)
  const out = join(tmp, 'voz.wav')
  await ffmpeg(['-i', raw, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', out])
  const durationMs = await probeDurationMs(out)

  const marks = {}
  for (const s of segments) {
    marks[`${s.id}_inicio`] = s.startMs
    marks[`${s.id}_fim`] = s.endMs
  }
  const gabarito = {
    voice: voiceName,
    sampleRate: 48_000,
    durationMs,
    note: 'Tempos em ms desde o início de voz.wav, exatos por construção (ver scripts/fixtures.mjs).',
    segments,
    pauses: segments.filter((s) => s.kind === 'pause'),
    fillers: segments.filter((s) => s.kind === 'filler'),
    phrases: segments.filter((s) => s.kind === 'speech'),
    marks
  }
  return { wav: out, gabarito }
}

// ---------------------------------------------------------------------------
// Vídeos sintéticos

const FONT = "fontfile='C\\:/Windows/Fonts/segoeui.ttf'"

/** Expressão ffmpeg linear por partes em t (segundos): pontos [{t, v}]. */
function piecewise(points) {
  let expr = String(points[points.length - 1].v)
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i]
    const b = points[i + 1]
    expr = `if(lt(t,${b.t}),${a.v}+(${b.v}-${a.v})*(t-${a.t})/(${b.t}-${a.t}),${expr})`
  }
  return expr
}

/** Trajetória do cursor (fração da duração, x, y normalizados) e cliques (mesma base). */
function cursorPlan(durS) {
  const wp = [
    [0, 0.12, 0.2],
    [0.08, 0.5, 0.5],
    [0.12, 0.5, 0.5], // clique 1
    [0.3, 0.25, 0.7],
    [0.34, 0.25, 0.7], // clique 2
    [0.55, 0.78, 0.4],
    [0.6, 0.78, 0.4], // clique 3
    [0.85, 0.4, 0.8],
    [1, 0.5, 0.5]
  ].map(([f, x, y]) => ({ t: +(f * durS).toFixed(3), x, y }))
  const clicks = [
    { t: wp[2].t - 0.02, x: 0.5, y: 0.5 },
    { t: wp[4].t - 0.02, x: 0.25, y: 0.7 },
    { t: wp[6].t - 0.02, x: 0.78, y: 0.4 }
  ].map((c) => ({ ...c, t: +c.t.toFixed(3) }))
  return { wp, clicks }
}

async function makeScreenVfr(tmp, durS) {
  const W = 1920
  const H = 1080
  const fps = 60
  const { wp, clicks } = cursorPlan(durS)
  const cx = piecewise(wp.map((p) => ({ t: p.t, v: Math.round(p.x * W) })))
  const cy = piecewise(wp.map((p) => ({ t: p.t, v: Math.round(p.y * H) })))
  const last = durS * fps - 1

  const bg = [
    `color=c=0x1b1f27:s=${W}x${H}:r=${fps}:d=${durS}`,
    'drawbox=x=0:y=0:w=iw:h=72:color=0x2a303c:t=fill',
    'drawbox=x=0:y=72:w=340:h=ih-72:color=0x20252f:t=fill',
    'drawbox=x=400:y=130:w=1440:h=90:color=0x2a303c:t=fill',
    'drawbox=x=400:y=260:w=700:h=420:color=0x252b36:t=fill',
    'drawbox=x=1140:y=260:w=700:h=420:color=0x252b36:t=fill',
    'drawbox=x=400:y=720:w=1440:h=280:color=0x20252f:t=fill',
    // alvos dos cliques
    ...clicks.map(
      (c) =>
        `drawbox=x=${Math.round(c.x * W) - 90}:y=${Math.round(c.y * H) - 36}:w=180:h=72:color=0x3a6df0:t=fill`
    ),
    `drawtext=${FONT}:text='Tomada - tela sintetica':fontsize=34:fontcolor=white:x=28:y=18`,
    `drawtext=${FONT}:text='%{pts\\:hms}':fontsize=88:fontcolor=0xffd93d:x=1200:y=860`
  ].join(',')

  const filters = [
    `${bg}[bg]`,
    `color=c=black:s=26x26:r=${fps}:d=${durS}[curb]`,
    `color=c=white:s=22x22:r=${fps}:d=${durS}[curw]`,
    '[curb][curw]overlay=2:2[cur]',
    `[bg][cur]overlay=x='${cx}':y='${cy}':eval=frame[a0]`
  ]
  clicks.forEach((c, i) => {
    filters.push(`color=c=0xff3b30:s=70x70:r=${fps}:d=${durS}[r${i}]`)
    filters.push(
      `[a${i}][r${i}]overlay=x=${Math.round(c.x * W) - 35}:y=${Math.round(c.y * H) - 35}:enable='between(t,${c.t},${(c.t + 0.4).toFixed(3)})'[a${i + 1}]`
    )
  })
  // Taxa variável: rajadas a 60 qps e buracos (como a captura real de tela parada).
  filters.push(`[a${clicks.length}]select='lt(mod(n,16),5)+gte(mod(n,100),90)+gte(n,${last})'`)

  const out = join(tmp, 'tela-vfr.webm')
  await ffmpeg([
    '-filter_complex',
    filters.join(';'),
    '-fps_mode',
    'vfr',
    '-t',
    String(durS),
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    '0',
    '-crf',
    '34',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-row-mt',
    '1',
    '-pix_fmt',
    'yuv420p',
    out
  ])
  return { file: out, width: W, height: H, wp, clicks }
}

async function makeCameraWebm(tmp, voiceWav, voiceMs) {
  const out = join(tmp, 'camera.webm')
  const d = (voiceMs / 1000).toFixed(3)
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=640x360:r=30:d=${d}`,
    '-i',
    voiceWav,
    '-t',
    d,
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    '0',
    '-crf',
    '36',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'libopus',
    '-b:a',
    '96k',
    out
  ])
  return out
}

async function makeFlashBipe(tmp) {
  const out = join(tmp, 'flash-bipe.mp4')
  // Clarão branco de 100 ms e bipe de 1 kHz no mesmo instante, a cada 2 s, por 10 s.
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    "color=c=black:s=640x360:r=30:d=10,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t,2),0.1)'",
    '-f',
    'lavfi',
    '-i',
    "sine=f=1000:r=48000:d=10,volume='if(lt(mod(t,2),0.1),1,0)':eval=frame",
    '-t',
    '10',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    out
  ])
  return out
}

async function makeFakeCamera(tmp) {
  const out = join(tmp, 'fake-camera.y4m')
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=5', '-pix_fmt', 'yuv420p', out])
  return out
}

// ---------------------------------------------------------------------------
// Projeto de exemplo

/**
 * `transcript.json` do exemplo no formato do app (ver `Transcript` em src/shared/types.ts): as palavras do gabarito com
 * o tempo repartido pelo tamanho de cada uma, os trechos de fala como VAD e `createdAt` vazio (é uma transcrição de
 * teste: a limpeza automática só vale para transcrição feita DEPOIS da criação do projeto). O Node não resolve os
 * imports sem extensão de src/shared, então o formato é escrito aqui; tests/unit/transcript.test.ts confere que o
 * código do app lê este arquivo.
 */
function transcriptFrom(gabarito) {
  const HESITATION = /^(h[ãa]+n?|hu+m+|hm+|ahn+|[ãa]h+n*|eh+n?|uh+n?)$/iu
  const words = []
  const segments = []
  const vad = []
  for (const seg of gabarito.segments) {
    if (seg.kind === 'pause') continue
    const tokens = seg.text.split(/\s+/).filter(Boolean)
    const weights = tokens.map((t) => t.length + 1)
    const sum = weights.reduce((x, y) => x + y, 0)
    let cursor = seg.startMs
    const first = words.length
    tokens.forEach((text, k) => {
      const end = k === tokens.length - 1 ? seg.endMs : cursor + Math.round(((seg.endMs - seg.startMs) * weights[k]) / sum)
      const bare = text.replace(/[.,!?…]/g, '')
      words.push({ i: words.length, text, start: cursor, end, prob: 0.95, kind: HESITATION.test(bare) ? 'filler' : 'word' })
      cursor = end
    })
    segments.push({ start: seg.startMs, end: seg.endMs, text: seg.text, first, last: words.length - 1 })
    vad.push({ start: seg.startMs, end: seg.endMs })
  }
  return `${JSON.stringify({ engine: 'teste', model: 'gabarito', language: 'pt', durationMs: gabarito.durationMs, words, segments, vad, createdAt: '' })}
`
}

function smooth(a, b, u) {
  const k = u * u * (3 - 2 * u)
  return a + (b - a) * k
}

function cursorAt(wp, tS) {
  if (tS <= wp[0].t) return wp[0]
  for (let i = 0; i < wp.length - 1; i++) {
    const a = wp[i]
    const b = wp[i + 1]
    if (tS < b.t) {
      const u = (tS - a.t) / (b.t - a.t)
      return { x: smooth(a.x, b.x, u), y: smooth(a.y, b.y, u) }
    }
  }
  return wp[wp.length - 1]
}

async function makeExampleProject(tmp, ctx) {
  const dir = join(tmp, EXAMPLE_FOLDER)
  mkdirSync(join(dir, 'media'), { recursive: true })
  mkdirSync(join(dir, 'events'))

  const { screen, cameraWebm, voiceWav, gabarito } = ctx
  const fps = 30

  // Tela normalizada: H.264, fps constante, GOP = 1 s (mesma receita da normalização do app).
  await ffmpeg([
    '-i',
    screen.file,
    '-map',
    '0:v:0',
    '-an',
    '-vf',
    `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(fps),
    '-keyint_min',
    String(fps),
    '-sc_threshold',
    '0',
    '-movflags',
    '+faststart',
    join(dir, 'media', 'screen.mp4')
  ])
  await ffmpeg([
    '-i',
    cameraWebm,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-vf',
    `fps=${fps}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '30',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(fps),
    '-keyint_min',
    String(fps),
    '-sc_threshold',
    '0',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    join(dir, 'media', 'camera.mp4')
  ])
  copyFileSync(voiceWav, join(dir, 'media', 'voice.wav'))
  await ffmpeg([
    '-ss',
    '3',
    '-i',
    join(dir, 'media', 'screen.mp4'),
    '-frames:v',
    '1',
    '-vf',
    'scale=640:-2',
    '-q:v',
    '4',
    join(dir, 'media', 'thumb.jpg')
  ])

  const screenMs = await probeDurationMs(join(dir, 'media', 'screen.mp4'))
  const cameraMs = await probeDurationMs(join(dir, 'media', 'camera.mp4'))

  // Eventos a 120 Hz, no formato do projeto.
  const durS = screenMs / 1000
  const lines = []
  for (let t = 0; t <= screenMs; t += 1000 / 120) {
    const p = cursorAt(screen.wp, t / 1000)
    lines.push(JSON.stringify({ t: Math.round(t), x: +p.x.toFixed(5), y: +p.y.toFixed(5) }))
  }
  writeFileSync(join(dir, 'events', 'cursor.jsonl'), `${lines.join('\n')}\n`)
  writeFileSync(
    join(dir, 'events', 'clicks.jsonl'),
    `${screen.clicks
      .map((c) => JSON.stringify({ t: Math.round(c.t * 1000), x: c.x, y: c.y, button: 'left', upT: Math.round(c.t * 1000) + 90 }))
      .join('\n')}\n`
  )
  const typingStart = Math.round(durS * 0.7 * 1000)
  writeFileSync(
    join(dir, 'events', 'keys.jsonl'),
    `${Array.from({ length: 8 }, (_, i) => JSON.stringify({ t: typingStart + i * 140 })).join('\n')}\n`
  )
  writeFileSync(join(dir, 'transcript.json'), transcriptFrom(gabarito))

  // project.json pelo MESMO código do app (src/shared/project.ts): o Node 24 lê TypeScript direto.
  const { createProject, serializeProject, parseProject } = await import(
    pathToFileURL(join(ROOT, 'src', 'shared', 'project.ts')).href
  )
  const project = createProject({
    id: 'exemplo-0001',
    title: 'Projeto de exemplo',
    createdAt: '2026-10-04T15:00:00.000Z',
    sources: {
      screen: { path: 'media/screen.mp4', w: screen.width, h: screen.height, fps, durationMs: screenMs },
      camera: { path: 'media/camera.mp4', w: 640, h: 360, fps, durationMs: cameraMs },
      voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs: gabarito.durationMs }
    },
    sync: { screenOffsetMs: 0, cameraOffsetMs: 0 },
    capture: { kind: 'screen', boundsPx: { x: 0, y: 0, w: screen.width, h: screen.height }, scale: 1 }
  })
  const text = serializeProject(project)
  parseProject(text) // se o gerador escreveu algo inválido, falha aqui, não nos testes
  writeFileSync(join(dir, 'project.json'), text)
  return dir
}

// ---------------------------------------------------------------------------
// Orquestração

export function fixturesUpToDate() {
  try {
    return (
      readFileSync(MARKER, 'utf8').trim() === String(FIXTURES_VERSION) &&
      existsSync(join(FIXTURES_DIR, EXAMPLE_FOLDER, 'project.json')) &&
      existsSync(join(FIXTURES_DIR, 'voz.wav'))
    )
  } catch {
    return false
  }
}

export async function ensureFixtures({ force = false, quiet = false } = {}) {
  if (!force && fixturesUpToDate()) return
  const say = (m) => {
    if (!quiet) console.log(`[fixtures] ${m}`)
  }
  const tmp = mkdtempSync(join(tmpdir(), 'tomada-fx-'))
  try {
    say(`gerando em ${tmp}`)
    say('voz pt-BR (Microsoft Maria)…')
    const { wav: voiceWav, gabarito } = await synthVoice(tmp)
    const durS = Math.ceil(gabarito.durationMs / 1000)
    say(`voz pronta: ${gabarito.durationMs} ms`)
    say('tela sintética (VP9, taxa variável)…')
    const screen = await makeScreenVfr(tmp, durS)
    say('câmera sintética…')
    const cameraWebm = await makeCameraWebm(tmp, voiceWav, gabarito.durationMs)
    say('flash + bipe e câmera falsa…')
    const flash = await makeFlashBipe(tmp)
    const fakeCam = await makeFakeCamera(tmp)
    say('projeto de exemplo…')
    const exampleDir = await makeExampleProject(tmp, { screen, cameraWebm, voiceWav, gabarito })

    rmSync(FIXTURES_DIR, { recursive: true, force: true })
    mkdirSync(FIXTURES_DIR, { recursive: true })
    copyFileSync(voiceWav, join(FIXTURES_DIR, 'voz.wav'))
    writeFileSync(join(FIXTURES_DIR, 'voz.json'), `${JSON.stringify(gabarito, null, 2)}\n`)
    copyFileSync(screen.file, join(FIXTURES_DIR, 'tela-vfr.webm'))
    copyFileSync(cameraWebm, join(FIXTURES_DIR, 'camera.webm'))
    copyFileSync(flash, join(FIXTURES_DIR, 'flash-bipe.mp4'))
    copyFileSync(fakeCam, join(FIXTURES_DIR, 'fake-camera.y4m'))
    copyTree(exampleDir, join(FIXTURES_DIR, EXAMPLE_FOLDER))
    writeFileSync(MARKER, `${FIXTURES_VERSION}\n`)
    say(`pronto em ${FIXTURES_DIR}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// Execução direta: `node scripts/fixtures.mjs [--force]`
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  ensureFixtures({ force: process.argv.includes('--force') }).catch((err) => {
    console.error(`[fixtures] FALHOU: ${err.message}`)
    process.exit(1)
  })
}
