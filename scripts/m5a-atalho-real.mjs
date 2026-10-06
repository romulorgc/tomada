// Prova Windows do .lnk instalado: NÃO reconstrói nem escreve no checkout principal.
// Executar sempre por: node scripts/fila-pesada.mjs node scripts/m5a-atalho-real.mjs
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import koffi from 'koffi'
import { _electron } from '@playwright/test'
import { syntheticMonitorReady } from './m5a-atalho-quadros.mjs'
import { inspectShortcuts } from './criar-atalhos.mjs'

const execute = promisify(execFile)
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const resultDir = path.join(root, 'test-results', 'atalho-real')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const psLiteral = value => `'${value.replace(/'/g, "''")}'`
const enumerateWindowCallback = koffi.proto('int __stdcall TomadaEnumWindow(intptr_t hwnd, intptr_t data)')

async function powershell(code, env = process.env) {
  const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
    windowsHide: true, encoding: 'utf8', timeout: 30_000, env
  })
  return result.stdout.replace(/^\uFEFF/, '').trim()
}

async function physicalScreen() {
  const data = await powershell([
    '$ErrorActionPreference = "Stop"',
    'Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public static class TomadaProofDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }\'',
    '[void][TomadaProofDpi]::SetProcessDPIAware()',
    'Add-Type -AssemblyName System.Drawing,System.Windows.Forms',
    '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$stream = New-Object System.IO.MemoryStream',
    'try { $graphics.CopyFromScreen($bounds.X,$bounds.Y,0,0,$bounds.Size); $bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($stream.ToArray()) } finally { $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose() }'
  ].join('\n'))
  return Buffer.from(data, 'base64')
}

async function processes(executable) {
  return JSON.parse(await powershell([
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    `$rows = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${psLiteral(executable)} } | Select-Object ProcessId,ParentProcessId,CommandLine)`,
    'ConvertTo-Json -InputObject $rows -Depth 3 -Compress'
  ].join('\n')))
}

async function waitFor(read, predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await sleep(150)
  }
  throw new Error(`Tempo esgotado: ${label}.`)
}

function visibleConsoles() {
  const user32 = koffi.load('user32.dll')
  const enumerate = user32.func('int __stdcall EnumWindows(TomadaEnumWindow *callback, intptr_t data)')
  const visible = user32.func('int __stdcall IsWindowVisible(intptr_t hwnd)')
  const className = user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ char16_t *text, int length)')
  const found = []
  const handler = koffi.register(hwnd => {
    if (visible(hwnd)) {
      const buffer = Buffer.alloc(512)
      const length = className(hwnd, buffer, 256)
      const name = buffer.toString('utf16le', 0, length * 2)
      if (/ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS/i.test(name)) found.push(String(hwnd))
    }
    return 1
  }, koffi.pointer(enumerateWindowCallback))
  try { enumerate(handler, 0) } finally { koffi.unregister(handler) }
  return found
}

async function attachInspector(pid) {
  // O Windows notifica o Node do processo já aberto; mantém alvo/argumentos do .lnk intactos.
  process._debugProcess(pid)
  const targets = await waitFor(async () => {
    try { return await (await fetch('http://127.0.0.1:9229/json/list')).json() } catch { return [] }
  }, rows => rows.some(row => row.webSocketDebuggerUrl), 'inspector do app aberto pelo atalho', 15_000)
  const socket = new WebSocket(targets.find(row => row.webSocketDebuggerUrl).webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('Não consegui conectar ao inspector.')), { once: true })
  })
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('O inspector fechou.'))
    pending.clear()
  })
  async function evaluate(expression) {
    const id = ++sequence
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('O inspector não respondeu.')) }, 30_000)
      pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value) }, reject: error => { clearTimeout(timeout); reject(error) } })
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const actualPid = await evaluate('process.pid')
  assert.equal(actualPid, pid, 'o inspector deve pertencer exatamente ao processo criado pelo atalho')
  return { evaluate, close: () => socket.close() }
}

const electronExpr = 'process.mainModule.require("electron")'
function windowExpr(hash = '') {
  const predicate = hash ? `w.webContents.getURL().endsWith(${JSON.stringify(`#${hash}`)})` : '!w.webContents.getURL().includes("#")'
  return `${electronExpr}.BrowserWindow.getAllWindows().find(w => ${predicate})`
}

async function proof() {
  await mkdir(resultDir, { recursive: true })
  await clearProofArtifacts()
  const stamp = `${process.pid}-${Date.now()}`
  const base = path.resolve('C:\\tmp', `tomada-m5a-atalho-real-${stamp}`)
  assert.ok(base.startsWith('C:\\tmp\\tomada-m5a-atalho-real-'))
  const projects = path.join(base, 'projetos')
  const userData = path.join(base, 'userdata')
  const targetData = path.join(base, 'alvo-data')
  const launcherManifest = path.join(process.env.LOCALAPPDATA, 'Tomada', 'launch', 'atalhos.json')
  const installed = JSON.parse(await readFile(launcherManifest, 'utf8'))
  const link = installed.shortcuts.find(item => /Área de Trabalho|Desktop/u.test(item.path))?.path ?? installed.shortcuts[0].path
  const mainFile = path.join(installed.appDir, 'out', 'main', 'index.js')
  const originalBuild = await readFile(mainFile)
  const originalSha = createHash('sha256').update(originalBuild).digest('hex')
  const originalStat = await stat(mainFile)
  const baseline = new Set((await processes(installed.executable)).map(item => item.ProcessId))
  const consolesBefore = visibleConsoles()
  const report = { startedAt: new Date().toISOString(), shortcut: link, externalBase: base, appDir: installed.appDir, executable: installed.executable,
    buildBefore: { bytes: originalBuild.length, modifiedAt: originalStat.mtime.toISOString(), sha256: originalSha }, cleanup: false }
  let target
  let inspector
  let pid
  try {
    await mkdir(projects, { recursive: true })
    await mkdir(userData, { recursive: true })
    await mkdir(targetData, { recursive: true })
    await writeFile(path.join(userData, 'settings.json'), JSON.stringify({
      autopilot: { mode: 'nothing' }, transcription: { auto: false, autoClean: false },
      record: { mode: 'screen', setupDone: true, cameraId: null, micId: null, fps: 30, systemAudio: false, showBubble: false, hideCursor: false }
    }))
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', TOMADA_PROJECTS_DIR: projects, TOMADA_USER_DATA_DIR: userData,
      TOMADA_TEST_SILENT: '1', TOMADA_TRANSCRIBER: 'mock-unprepared', TOMADA_LLM: 'off', TOMADA_TOOLS_DIR: path.join(base, 'ferramentas'), TOMADA_DEVTOOLS: '0' }
    await powershell(`$ErrorActionPreference = "Stop"\nInvoke-Item -LiteralPath ${psLiteral(link)}`, env)
    const main = await waitFor(() => processes(installed.executable), rows => rows.some(item => !baseline.has(item.ProcessId) && !/--type=/.test(item.CommandLine ?? '')), 'processo principal do atalho')
    pid = main.find(item => !baseline.has(item.ProcessId) && !/--type=/.test(item.CommandLine ?? '')).ProcessId
    report.pid = pid
    report.commandLine = main.find(item => item.ProcessId === pid).CommandLine
    await sleep(1500)
    inspector = await attachInspector(pid)
    report.environment = await inspector.evaluate(`({ runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, cwd: process.cwd(), projects: process.env.TOMADA_PROJECTS_DIR, userData: ${electronExpr}.app.getPath('userData') })`)
    assert.equal(report.environment.runAsNode, null)
    assert.equal(report.environment.projects, projects)
    assert.equal(report.environment.userData, userData)
    assert.equal(report.environment.cwd, installed.appDir)
    const renderer = (code, hash = '') => inspector.evaluate(`${windowExpr(hash)}?.webContents.executeJavaScript(${JSON.stringify(code)}, true)`)
    const has = (id, hash = '') => renderer(`Boolean(document.querySelector('[data-testid="${id}"]'))`, hash)
    const click = (id, hash = '') => renderer(`(() => { const el = document.querySelector('[data-testid="${id}"]'); if (!el || el.disabled) throw new Error('Botão indisponível: ${id}'); el.click(); return true })()`, hash)
    const shot = async (name, hash = '') => {
      const image = await inspector.evaluate(`${windowExpr(hash)}.capturePage().then(image => image.toPNG().toString('base64'))`)
      await writeFile(path.join(resultDir, name), Buffer.from(image, 'base64'))
    }
    await waitFor(() => has('nav-record'), Boolean, 'biblioteca do app')
    report.visible = await inspector.evaluate(`${windowExpr()}.isVisible()`)
    assert.equal(report.visible, true)
    await shot('01-aberto-pelo-atalho.png')
    const targetEnv = { ...process.env, TOMADA_TARGET_DATA: targetData }
    delete targetEnv.ELECTRON_RUN_AS_NODE
    target = await _electron.launch({ executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [path.join(root, 'scripts', 'm5a-atalho-real-alvo.cjs')], cwd: root, env: targetEnv })
    const targetPage = await target.firstWindow()
    await targetPage.waitForLoadState('domcontentloaded')
    await target.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setAlwaysOnTop(true, 'screen-saver')
      win.show(); win.focus(); win.moveTop()
    })
    // A captura do conteúdo da janela não prova sua posição na tela real.
    // Só aceita o monitor quando o título branco do alvo também aparece nele.
    const physical = await waitFor(physicalScreen, syntheticMonitorReady, 'alvo sintético cobrindo o monitor real', 10_000)
    report.syntheticMonitorReady = true
    report.monitorProof = 'GDI CopyFromScreen, DPI físico'
    await writeFile(path.join(resultDir, '02-monitor-real-sintetico.png'), physical)
    await targetPage.screenshot({ path: path.join(resultDir, '02-tela-real-sintetica.png') })
    await click('nav-record')
    await waitFor(() => has('source-card'), Boolean, 'fontes reais de tela')
    await click('mode-screen')
    const source = await renderer(`window.tomada.record.sources().then(sources => sources.find(source => source.kind === 'screen' && source.primary) ?? sources.find(source => source.kind === 'screen'))`)
    assert.ok(source, 'uma tela real deve existir')
    await renderer(`document.querySelector('[data-testid="source-card"][data-source-id="${source.id}"]').click()`)
    await click('record-start')
    await waitFor(() => has('bar-time', 'bar'), Boolean, 'barra de gravação', 35_000)
    await waitFor(() => renderer('Number(document.querySelector("[data-testid=bar-time]")?.dataset.ms ?? 0)', 'bar'), value => value >= 5000, 'cinco segundos de captura real', 15_000)
    report.recordedBarMs = await renderer('Number(document.querySelector("[data-testid=bar-time]").dataset.ms)', 'bar')
    report.noVisibleConsole = visibleConsoles().every(hwnd => consolesBefore.includes(hwnd))
    assert.equal(report.noVisibleConsole, true, 'o lançador não deve criar janela de console visível')
    await click('bar-stop', 'bar')
    await target.close()
    target = undefined
    await waitFor(() => has('project-view'), Boolean, 'projeto gravado aberto no editor', 90_000)
    await waitFor(() => renderer('document.querySelector("[data-testid=preview-canvas]")?.dataset.ready === "true"'), Boolean, 'primeiro quadro da prévia', 30_000)
    const folders = await readdir(projects)
    assert.equal(folders.length, 1)
    const projectDir = path.join(projects, folders[0])
    const project = JSON.parse(await readFile(path.join(projectDir, 'project.json'), 'utf8'))
    const manifest = JSON.parse(await readFile(path.join(projectDir, 'raw', 'recording.json'), 'utf8'))
    report.capture = { kind: project.capture.kind, w: project.sources.screen.w, h: project.sources.screen.h, recordedMs: manifest.recordedMs, cursorHidden: project.capture.cursorHidden }
    assert.equal(report.capture.kind, 'screen')
    assert.equal(report.capture.cursorHidden, false, 'sem flags falsas: o cursor real é informado pela captura')
    assert.ok(manifest.recordedMs >= 4900 && manifest.recordedMs < 7000)
    await click('export-open')
    await waitFor(() => has('export-start'), Boolean, 'formulário de exportação')
    await click('export-preset-1080p')
    await click('export-fps-30')
    await click('export-start')
    await waitFor(() => has('export-done'), Boolean, 'exportação concluída', 120_000)
    const output = await renderer('document.querySelector("[data-testid=export-done-path]").title')
    const probeResult = await execute('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', '-i', output], { windowsHide: true, encoding: 'utf8' })
    const probed = JSON.parse(probeResult.stdout)
    const video = probed.streams.find(stream => stream.codec_type === 'video')
    const audio = probed.streams.find(stream => stream.codec_type === 'audio')
    assert.deepEqual([video.width, video.height, video.codec_name, video.avg_frame_rate], [1920, 1080, 'h264', '30/1'])
    assert.equal(audio.codec_name, 'aac')
    assert.ok(Math.abs(Number(probed.format.duration) * 1000 - manifest.recordedMs) < 150)
    report.probe = { durationS: Number(probed.format.duration), width: video.width, height: video.height, codec: video.codec_name, fps: video.avg_frame_rate, audio: audio.codec_name }
    const decoded = await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', output, '-vf', 'scale=320:180', '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true, encoding: 'buffer', maxBuffer: 40 * 1024 * 1024 })
    const frameSize = 320 * 180 * 3
    const frameCount = Math.floor(decoded.stdout.length / frameSize)
    let minimumWhite = Infinity
    let maximumDark = 0
    for (let frame = 0; frame < frameCount; frame++) {
      let white = 0
      for (let y = 50; y < 72; y++) for (let x = 110; x < 210; x++) {
        const pixel = frame * frameSize + (y * 320 + x) * 3
        if (decoded.stdout[pixel] > 215 && decoded.stdout[pixel + 1] > 215 && decoded.stdout[pixel + 2] > 215) white++
      }
      minimumWhite = Math.min(minimumWhite, white)
      let dark = 0
      for (let y = 28; y < 156; y++) for (let x = 44; x < 276; x++) {
        const pixel = frame * frameSize + (y * 320 + x) * 3
        if (decoded.stdout[pixel] < 10 && decoded.stdout[pixel + 1] < 10 && decoded.stdout[pixel + 2] < 15) dark++
      }
      maximumDark = Math.max(maximumDark, dark)
    }
    assert.ok(frameCount >= 145 && minimumWhite > 25 && maximumDark < 150, 'todos os quadros devem mostrar somente o alvo sintético; não conservar captura de outra janela')
    report.syntheticFrames = { frameCount, minimumWhite, maximumDark }
    await shot('04-exportado-1080p30.png')
    await renderer('Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "Fechar").click()')
    await sleep(250)
    await shot('03-projeto-real-gravado.png')
    const proofVideo = path.join(resultDir, 'youtube.mp4')
    await copyFile(output, proofVideo)
    const every = report.probe.durationS / 6
    await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(.2, every / 2)), '-i', proofVideo,
      '-vf', `fps=1/${every.toFixed(4)},scale=480:-2,tile=3x2:padding=4:margin=4:color=0x222222`, '-frames:v', '1', path.join(resultDir, 'folha-de-contato.png')], { windowsHide: true })
    report.video = proofVideo
    report.shortcuts = await inspectShortcuts(installed.shortcuts.map(item => item.path))
    report.ok = true
  } catch (error) {
    report.ok = false
    report.error = error.stack ?? error.message
    throw error
  } finally {
    await target?.close().catch(() => undefined)
    await inspector?.evaluate(`${electronExpr}.app.quit()`).catch(() => undefined)
    inspector?.close()
    if (pid) {
      await sleep(1000)
      try { process.kill(pid, 0); await execute('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }) } catch { /* já encerrou */ }
    }
    const currentBuild = await readFile(mainFile)
    const currentStat = await stat(mainFile)
    report.buildAfter = { bytes: currentBuild.length, modifiedAt: currentStat.mtime.toISOString(), sha256: createHash('sha256').update(currentBuild).digest('hex') }
    report.buildUnchanged = originalSha === report.buildAfter.sha256 && currentStat.mtimeMs === originalStat.mtimeMs
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    report.cleanup = true
    report.finishedAt = new Date().toISOString()
    await writeFile(path.join(resultDir, 'relatorio.json'), `${JSON.stringify(report, null, 2)}\n`)
    assert.equal(report.buildUnchanged, true, 'o build principal deve permanecer exatamente como antes')
  }
  return report
}

async function clearProofArtifacts() {
  // Só nomes conhecidos desta prova, sem glob/recursão/diretório externo.
  for (const name of ['01-aberto-pelo-atalho.png', '02-tela-real-sintetica.png', '02-monitor-real-sintetico.png', '03-projeto-real-gravado.png', '04-exportado-1080p30.png', 'folha-de-contato.png', 'youtube.mp4', 'relatorio.json']) {
    const file = path.resolve(resultDir, name)
    assert.equal(path.dirname(file), resultDir)
    await rm(file, { force: true })
  }
}

if (process.argv.includes('--limpar')) {
  clearProofArtifacts().then(() => console.log('Artefatos conhecidos da prova removidos.')).catch(error => { console.error(error.message); process.exitCode = 1 })
} else if (process.argv.includes('--help')) {
  console.log('Uso: node scripts/fila-pesada.mjs node scripts/m5a-atalho-real.mjs\nAbre o .lnk instalado, grava tela real por 5 s e exporta 1080p30; nunca constrói/escreve no app-alvo.')
} else {
  proof().then(report => console.log(JSON.stringify({ ok: report.ok, capture: report.capture, probe: report.probe, cleanup: report.cleanup, evidence: resultDir }))).catch(error => {
    console.error(`A prova do atalho falhou: ${error.message}`)
    process.exitCode = 1
  })
}
