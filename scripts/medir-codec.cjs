/**
 * Medição de codec do MediaRecorder: grava 10 s de uma tela MOVIMENTADA (texto rolando, formas
 * coloridas e um contador) em 1080p e conta, por candidato, quadros entregues × esperados,
 * tamanho, taxa de bits real, intervalos entre quadros e uso de CPU. Foi o que decidiu a
 * preferência H.264 > VP9 > VP8 (ver README, "Codec medido").
 *
 *   node scripts/limpo.mjs electron scripts/medir-codec.cjs
 *
 * Variáveis opcionais:
 *   EXP_FPS=60            quadros por segundo pedidos
 *   EXP_SECONDS=10        duração de cada gravação
 *   EXP_CANDIDATES="video/webm;codecs=h264@12000000,video/webm;codecs=vp9@25000000"
 *                         lista "mime@bits-por-segundo[@fps]" separada por vírgulas
 *
 * Abre uma janela em tela cheia no monitor principal (a captura é da tela de verdade) e não
 * mexe no mouse nem no teclado. Os arquivos ficam em %TEMP%\tomada-codec.
 */
const { app, BrowserWindow, screen, desktopCapturer, session } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const FPS = Number(process.env.EXP_FPS || 60)
const SECONDS = Number(process.env.EXP_SECONDS || 10)
const CANDIDATES = (
  process.env.EXP_CANDIDATES ||
  [
    'video/webm;codecs=h264@12000000',
    'video/webm;codecs=h264@25000000',
    'video/webm;codecs=vp9@12000000',
    'video/webm;codecs=vp9@25000000',
    'video/webm;codecs=vp8@12000000'
  ].join(',')
).split(',')
const OUT = path.join(os.tmpdir(), 'tomada-codec')
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Trava de segurança: nunca fica preso.
setTimeout(() => {
  console.log('TEMPO ESGOTADO')
  app.exit(3)
}, 20 * 60 * 1000)

function cpuTimes() {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k]
    idle += c.times.idle
  }
  return { idle, total }
}

function probe(file) {
  const j = JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height,codec_name:format=duration,size', '-of', 'json', file],
      { encoding: 'utf8' }
    )
  )
  const pts = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
  const gaps = pts.slice(1).map((v, i) => (v - pts[i]) * 1000).sort((a, b) => a - b)
  return {
    frames: Number(j.streams[0].nb_read_frames),
    w: j.streams[0].width,
    h: j.streams[0].height,
    codec: j.streams[0].codec_name,
    sizeMB: Number(j.format.size) / 1e6,
    gapMedian: gaps[gaps.length >> 1],
    gapP99: gaps[Math.floor(gaps.length * 0.99)],
    gapMax: gaps[gaps.length - 1],
    over50ms: gaps.filter((g) => g > 50).length
  }
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

  // Tela movimentada: canvas com texto rolando, formas e contador, em tela cheia no monitor principal.
  const anim = new BrowserWindow({ x: primary.bounds.x, y: primary.bounds.y, width: primary.bounds.width, height: primary.bounds.height, frame: false, fullscreen: true, backgroundColor: '#101820', webPreferences: { backgroundThrottling: false } })
  const animHtml = path.join(OUT, 'anim.html')
  fs.writeFileSync(
    animHtml,
    `<body style="margin:0;background:#101820;overflow:hidden"><canvas id=c></canvas><script>
    const c = document.getElementById('c'); c.width = innerWidth; c.height = innerHeight; const g = c.getContext('2d')
    const lines = Array.from({length: 60}, (_, i) => 'const resultado = calcular(' + i + ', "texto de exemplo para nitidez", ' + (i*37%101) + ') // linha ' + i)
    const t0 = performance.now()
    function draw(now) {
      const t = (now - t0) / 1000
      g.fillStyle = '#101820'; g.fillRect(0, 0, c.width, c.height)
      g.font = '22px Consolas, monospace'
      const off = (t * 240) % 40
      for (let i = 0; i < 60; i++) { g.fillStyle = i % 3 ? '#9ad1ff' : '#ffd479'; g.fillText(lines[(i + Math.floor(t * 6)) % 60], 40, 40 * i - off + 40) }
      for (let k = 0; k < 6; k++) { g.fillStyle = 'hsl(' + (k * 60 + t * 90) + ',80%,55%)'; g.fillRect(900 + 400 * Math.sin(t * (1 + k * .4) + k), 100 + k * 140 + 60 * Math.cos(t * 2 + k), 220, 90) }
      g.fillStyle = '#fff'; g.font = 'bold 120px Segoe UI'; g.fillText(String(Math.floor(t * 1000)).padStart(6, '0'), 1000, 1000)
      requestAnimationFrame(draw)
    }
    requestAnimationFrame(draw)
  </script></body>`
  )
  await anim.loadFile(animHtml)

  // Janela que grava (com Node para escrever os pedaços direto no disco).
  const host = new BrowserWindow({ x: 20, y: 20, width: 320, height: 160, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } })
  const hostHtml = path.join(OUT, 'host.html')
  fs.writeFileSync(hostHtml, '<body>host</body>')
  await host.loadFile(hostHtml)
  await sleep(1500)

  const results = []
  {
    const c0 = cpuTimes()
    await sleep(10_000)
    const c1 = cpuTimes()
    console.log(`BASE sem gravar: CPU do sistema ${(100 * (1 - (c1.idle - c0.idle) / (c1.total - c0.total))).toFixed(1)}%`)
  }

  for (const cand of CANDIDATES) {
    const [mime, bps, fpsPart] = cand.split('@')
    const fps = Number(fpsPart || FPS)
    const supported = await host.webContents.executeJavaScript(`MediaRecorder.isTypeSupported(${JSON.stringify(mime)})`)
    if (!supported) {
      console.log(`CANDIDATO ${cand}: não suportado`)
      continue
    }
    const file = path.join(OUT, `${mime.replace(/[^a-z0-9]/gi, '_')}_${bps}_${fps}_${Date.now()}.webm`)
    const js = `
    (async () => {
      const fs = require('fs')
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: ${fps}, max: ${fps} } } })
      const settings = stream.getVideoTracks()[0].getSettings()
      const rec = new MediaRecorder(stream, { mimeType: ${JSON.stringify(mime)}, videoBitsPerSecond: ${Number(bps)} })
      const fd = fs.openSync(${JSON.stringify(file)}, 'w')
      let writes = Promise.resolve()
      rec.ondataavailable = (e) => { writes = writes.then(async () => { fs.writeSync(fd, Buffer.from(await e.data.arrayBuffer())) }) }
      const stopped = new Promise((r) => (rec.onstop = r))
      rec.start(1000)
      await new Promise((r) => setTimeout(r, ${SECONDS * 1000}))
      rec.stop(); await stopped; await writes; fs.closeSync(fd)
      stream.getTracks().forEach((t) => t.stop())
      return { fps: settings.frameRate }
    })()`

    // CPU do app: amostra a cada 500 ms durante a gravação (pula o arranque).
    const samples = []
    let sampling = true
    const sampler = (async () => {
      await sleep(1500)
      while (sampling) {
        samples.push(app.getAppMetrics().reduce((a, p) => a + p.cpu.percentCPUUsage, 0))
        await sleep(500)
      }
    })()
    app.getAppMetrics()
    const c0 = cpuTimes()
    let info
    try {
      info = await host.webContents.executeJavaScript(js, true)
    } catch (e) {
      console.log(`CANDIDATO ${cand}: ERRO ${e}`)
      sampling = false
      await sampler
      continue
    }
    sampling = false
    await sampler
    const c1 = cpuTimes()
    const p = probe(file)
    const expected = fps * SECONDS
    const row = {
      candidato: cand,
      fpsDaTrilha: info.fps,
      quadro: `${p.w}x${p.h}`,
      codec: p.codec,
      quadros: p.frames,
      esperados: expected,
      perdidosPct: +((100 * (expected - p.frames)) / expected).toFixed(1),
      tamanhoMB: +p.sizeMB.toFixed(1),
      mbpsReal: +((p.sizeMB * 8) / SECONDS).toFixed(1),
      intervaloMedianoMs: +p.gapMedian.toFixed(1),
      intervaloP99Ms: +p.gapP99.toFixed(1),
      intervaloMaxMs: +p.gapMax.toFixed(1),
      intervalosAcimaDe50ms: p.over50ms,
      cpuDoAppPct: +(samples.reduce((a, s) => a + s, 0) / Math.max(1, samples.length)).toFixed(0),
      cpuDoSistemaPct: +(100 * (1 - (c1.idle - c0.idle) / (c1.total - c0.total))).toFixed(1)
    }
    console.log('RESULTADO ' + JSON.stringify(row))
    results.push(row)
    await sleep(1200)
  }

  fs.writeFileSync(path.join(OUT, 'resultados.json'), JSON.stringify(results, null, 2))
  console.log(`Resultados em ${path.join(OUT, 'resultados.json')}`)
  app.exit(0)
})
