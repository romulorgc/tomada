/**
 * Processo principal da medição da câmera (ver `scripts/medir-camera.mjs`, que o abre).
 *
 * Abre UMA janela ESCONDIDA (`show: false`: nada pisca, nada rouba o foco), roda os cenários da
 * lista em sequência e grava os pedaços que a página manda em `<saida>/<cenário>/<tipo>.webm`.
 * O cenário `ffmpeg` captura a MESMA câmera direto pelo dshow (a referência de qualidade).
 *
 * Uso (pelo driver): electron principal.cjs <arquivo-de-configuração.json>
 * Configuração: { out, page, scenarios: [{ id, scenario, ... }], ffmpeg, cameraDshow }
 */
const { app, BrowserWindow, ipcMain, session, desktopCapturer, screen } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const config = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'))
// A mesma escolha de placa do app (src/main/index.ts): sem ela o Chromium usa a Intel integrada.
if (process.env.TOMADA_GPU !== 'auto') app.commandLine.appendSwitch('force_high_performance_gpu')
// Chaves do Chromium para os experimentos: "nome=valor" (ex.: "disable-features=MediaFoundationVideoCapture")
for (const sw of config.switches || []) {
  const [name, ...rest] = sw.split('=')
  app.commandLine.appendSwitch(name, rest.join('=') || undefined)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let currentDir = config.out
ipcMain.handle('bench:clock', () => performance.timeOrigin + performance.now())
ipcMain.handle('bench:chunk', (_e, kind, data) => {
  fs.appendFileSync(path.join(currentDir, `${kind}.webm`), Buffer.from(data))
})
ipcMain.on('bench:log', (_e, entry) => console.log(`[página] ${JSON.stringify(entry)}`))

// Trava de segurança: nunca fica preso.
setTimeout(() => {
  console.log('TEMPO ESGOTADO')
  app.exit(3)
}, 25 * 60 * 1000)

function cpuTimes() {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k]
    idle += c.times.idle
  }
  return { idle, total }
}

/** Uso da placa NVIDIA (codificador e geral) amostrado a 1 Hz pelo nvidia-smi enquanto `fn` roda. */
function startGpuSampler() {
  const samples = []
  let child = null
  try {
    child = spawn('nvidia-smi', ['--query-gpu=utilization.encoder,utilization.gpu', '--format=csv,noheader,nounits', '-l', '1'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      const lines = buf.split(/\r?\n/)
      buf = lines.pop()
      for (const l of lines) {
        const [enc, gpu] = l.split(',').map((x) => Number(x.trim()))
        if (Number.isFinite(enc)) samples.push({ enc, gpu })
      }
    })
    child.on('error', () => undefined)
  } catch {}
  return {
    stop() {
      try { child && child.kill() } catch {}
      const enc = samples.map((s) => s.enc)
      const gpu = samples.map((s) => s.gpu)
      const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(0) : null)
      return { gpuEncoderAvgPct: avg(enc), gpuEncoderMaxPct: enc.length ? Math.max(...enc) : null, gpuAvgPct: avg(gpu) }
    }
  }
}

/** Amostra o uso de CPU do app (por tipo de processo) e do sistema durante `fn`. */
async function withCpu(fn) {
  const gpuSampler = startGpuSampler()
  const samples = []
  let sampling = true
  app.getAppMetrics()
  const c0 = cpuTimes()
  const sampler = (async () => {
    await sleep(1000)
    while (sampling) {
      const by = {}
      for (const p of app.getAppMetrics()) by[p.type] = (by[p.type] || 0) + p.cpu.percentCPUUsage
      samples.push(by)
      await sleep(500)
    }
  })()
  let result
  try {
    result = await fn()
  } finally {
    sampling = false
    await sampler
  }
  const gpuUse = gpuSampler.stop()
  const c1 = cpuTimes()
  const types = new Set(samples.flatMap((s) => Object.keys(s)))
  const cpuApp = {}
  for (const t of types) cpuApp[t] = +(samples.reduce((a, s) => a + (s[t] || 0), 0) / Math.max(1, samples.length)).toFixed(1)
  return { result, cpuApp, gpuUse, cpuSystemPct: +(100 * (1 - (c1.idle - c0.idle) / (c1.total - c0.total))).toFixed(1) }
}

/** Captura direta pelo ffmpeg (dshow, mjpeg), libx264 de alta qualidade: o teto do que a câmera entrega. */
function ffmpegDirect(s) {
  const file = path.join(currentDir, 'camera.mp4')
  const args = [
    '-hide_banner', '-y',
    '-f', 'dshow', '-video_size', s.size || '1920x1080', '-framerate', String(s.framerate || 30), '-vcodec', 'mjpeg',
    '-i', `video=${config.cameraDshow}`,
    '-t', String(s.seconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p',
    file
  ]
  return new Promise((resolve) => {
    const child = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code, file, tail: err.split(/\r?\n/).slice(-6).join('\n') }))
  })
}

app.whenReady().then(async () => {
  const primary = screen.getPrimaryDisplay()
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_req, cb) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      cb({ video: sources.find((x) => x.display_id === String(primary.id)) || sources[0] })
    },
    { useSystemPicker: false }
  )
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(true))
  session.defaultSession.setPermissionCheckHandler(() => true)

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }
  })
  await win.loadFile(config.page)
  await sleep(1500)
  const flags = { gpu: app.getGPUFeatureStatus() }
  try {
    const info = await app.getGPUInfo('complete')
    flags.devices = (info.gpuDevice || []).map((d) => d.deviceString)
    flags.videoEncode = info.videoEncodeAcceleratorSupportedProfile || null
  } catch (e) {
    flags.gpuInfoError = String(e)
  }
  console.log('GPU ' + JSON.stringify(flags))


  const results = []
  for (const s of config.scenarios) {
    currentDir = path.join(config.out, s.id)
    fs.rmSync(currentDir, { recursive: true, force: true })
    fs.mkdirSync(currentDir, { recursive: true })
    console.log(`CENÁRIO ${s.id} (${s.scenario}${s.withScreen ? ' + tela' : ''})`)
    let row
    if (s.scenario === 'both') {
      // a câmera aberta pelo Chromium (probe) e, ao mesmo tempo, o ffmpeg direto: dá para dividir o aparelho?
      const page = win.webContents.executeJavaScript(`window.__bench.run(${JSON.stringify({ ...s.page, scenario: 'probe' })})`, true)
      await sleep(s.delayMs ?? 2500)
      const direct = await ffmpegDirect({ ...s, seconds: s.ffSeconds ?? 5 })
      row = { id: s.id, scenario: s.scenario, ffmpeg: direct, page: await page }
    } else if (s.scenario === 'ffmpeg') {
      const { result, cpuApp, gpuUse, cpuSystemPct } = await withCpu(() => ffmpegDirect(s))
      row = { id: s.id, scenario: s.scenario, ...result, cpuSystemPct, cpuApp, gpuUse }
    } else {
      const { result, cpuApp, gpuUse, cpuSystemPct } = await withCpu(() => win.webContents.executeJavaScript(`window.__bench.run(${JSON.stringify(s)})`, true))
      row = { id: s.id, scenario: s.scenario, ...result, cpuSystemPct, cpuApp, gpuUse }
    }
    console.log('RESULTADO ' + JSON.stringify(row))
    results.push(row)
    fs.writeFileSync(path.join(config.out, 'execucao.json'), JSON.stringify({ flags, results }, null, 2))
    await sleep(s.cooldownMs ?? 2500) // a câmera solta o driver
  }
  win.destroy()
  app.exit(0)
})
