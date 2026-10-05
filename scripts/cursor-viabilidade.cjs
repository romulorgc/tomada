/**
 * Teste de viabilidade do cursor sintético: dá para capturar uma JANELA (de outro processo)
 * SEM o cursor do sistema? Grava a janela do app-alvo (`tests/real/target-app`) com várias
 * restrições de `getDisplayMedia` e, para cada uma, olha um quadro REAL com o cursor parado em
 * dois pontos: se há pixels claros no formato do cursor, ele está no vídeo.
 *
 *   node scripts/limpo.mjs electron scripts/cursor-viabilidade.cjs
 *
 * Resultado medido no Electron 40.9.3 (ver README): `cursor: 'never'`, `{ exact: 'never' }` e
 * `'motion'` são ACEITOS e IGNORADOS: `getSettings().cursor` continua "always" e o cursor aparece no
 * quadro do mesmo jeito que sem restrição nenhuma. Por isso `project.capture.cursorHidden` vem do que
 * a trilha informa (aqui, false) e o teste real de captura prova por quadro.
 *
 * Move o cursor com SetCursorPos (sem clicar). O app-alvo é aberto e fechado pelo script.
 */
const { app, BrowserWindow, desktopCapturer, session } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const koffi = require('koffi')

const user32 = koffi.load('user32.dll')
const dwmapi = koffi.load('dwmapi.dll')
koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
koffi.struct('POINT', { x: 'long', y: 'long' })
const SetCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)')
const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT *p)')
const GetClientRect = user32.func('int __stdcall GetClientRect(intptr_t h, _Out_ RECT *r)')
const ClientToScreen = user32.func('int __stdcall ClientToScreen(intptr_t h, _Inout_ POINT *p)')
const DwmGetWindowAttribute = dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, _Out_ RECT *out, uint32 size)')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

setTimeout(() => {
  console.log('TEMPO ESGOTADO')
  app.exit(3)
}, 3 * 60 * 1000)

app.whenReady().then(async () => {
  const before = { x: 0, y: 0 }
  GetCursorPos(before)

  let currentId = null
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_req, cb) => {
      const list = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
      cb({ video: list.find((s) => s.id === currentId) })
    },
    { useSystemPicker: false }
  )
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(true))

  const blank = path.join(os.tmpdir(), 'tomada-cursor-branco.html')
  fs.writeFileSync(blank, '<body style="margin:0;background:#fff"></body>')
  const host = new BrowserWindow({ x: 50, y: 50, width: 300, height: 200, webPreferences: { backgroundThrottling: false } })
  await host.loadFile(blank)

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'tests', 'real', 'target-app', 'main.cjs')], { env, stdio: 'ignore' })
  await sleep(4000)
  const all = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
  const src = all.find((s) => s.name === 'Tomada-Alvo')
  if (!src) {
    console.log('Não achei a janela do app-alvo (Tomada-Alvo).')
    child.kill()
    app.exit(1)
    return
  }
  currentId = src.id
  const hwnd = Number(src.id.split(':')[1])
  const frame = { left: 0, top: 0, right: 0, bottom: 0 }
  DwmGetWindowAttribute(hwnd, 9, frame, 16) // DWMWA_EXTENDED_FRAME_BOUNDS
  const client = { left: 0, top: 0, right: 0, bottom: 0 }
  const origin = { x: 0, y: 0 }
  GetClientRect(hwnd, client)
  ClientToScreen(hwnd, origin)
  console.log('moldura DWM', frame, '| origem da área de cliente', origin, '| tamanho do cliente', client.right, client.bottom)

  // Dois pontos sobre o fundo liso (nenhum botão): onde o cursor para e onde ele NÃO está.
  const P = { x: origin.x + 300, y: origin.y + 150 }
  const AWAY = { x: origin.x + 40, y: origin.y + 40 }

  const variants = {
    'sem restrição': '{ video: true }',
    "cursor 'never'": "{ video: { cursor: 'never' } }",
    "cursor { exact: 'never' }": "{ video: { cursor: { exact: 'never' } } }",
    "cursor 'motion'": "{ video: { cursor: 'motion' } }"
  }
  const snap = `(async () => {
    const v = document.querySelector('video'); await new Promise((r) => setTimeout(r, 450))
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(v, 0, 0)
    window.__cur = g.getImageData(0, 0, c.width, c.height); return { w: c.width, h: c.height } })()`
  // Pixels bem claros num retângulo de 24×32 a partir do ponto (o cursor padrão é branco com borda preta).
  const bright = (fx, fy) => `(() => { const b = window.__cur; let n = 0
    for (let y = ${fy} - 4; y < ${fy} + 28; y++) for (let x = ${fx} - 4; x < ${fx} + 20; x++) {
      if (x < 0 || y < 0 || x >= b.width || y >= b.height) continue
      const i = (y * b.width + x) * 4
      if (b.data[i] > 170 && b.data[i + 1] > 170 && b.data[i + 2] > 170) n++ } return n })()`

  for (const [name, constraints] of Object.entries(variants)) {
    try {
      const info = await host.webContents.executeJavaScript(
        `(async () => {
          const stream = await navigator.mediaDevices.getDisplayMedia(${constraints})
          const v = document.createElement('video'); v.muted = true
          v.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0'; document.body.appendChild(v); v.srcObject = stream
          await new Promise((r) => (v.onloadedmetadata = r)); await v.play(); window.__stream = stream
          return { cursor: stream.getVideoTracks()[0].getSettings().cursor, w: v.videoWidth, h: v.videoHeight } })()`,
        true
      )
      SetCursorPos(AWAY.x, AWAY.y)
      await sleep(1200)
      await host.webContents.executeJavaScript(snap, true)
      const awayWithCursor = await host.webContents.executeJavaScript(bright(AWAY.x - frame.left, AWAY.y - frame.top), true)
      const pWithoutCursor = await host.webContents.executeJavaScript(bright(P.x - frame.left, P.y - frame.top), true)
      SetCursorPos(P.x, P.y)
      await sleep(700)
      await host.webContents.executeJavaScript(snap, true)
      const pWithCursor = await host.webContents.executeJavaScript(bright(P.x - frame.left, P.y - frame.top), true)
      const present = awayWithCursor > 8 || pWithCursor > 8
      console.log(
        `${name}: settings.cursor=${info.cursor} quadro ${info.w}x${info.h}; pixels claros onde o cursor ESTÁ: ${awayWithCursor}/${pWithCursor}; onde NÃO está: ${pWithoutCursor} => ${present ? 'CURSOR PRESENTE no vídeo' : 'cursor ausente'}`
      )
      await host.webContents.executeJavaScript(`document.querySelectorAll('video').forEach((v) => v.remove()); window.__stream.getTracks().forEach((t) => t.stop())`)
    } catch (e) {
      console.log(`${name}: ERRO ${String(e).slice(0, 150)}`)
    }
  }

  child.kill()
  SetCursorPos(before.x, before.y) // devolve o cursor de onde estava
  app.exit(0)
})
