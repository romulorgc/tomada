// Alvo sintético em tela REAL: cobre o monitor principal, sem voz/câmera/dados do usuário.
const { app, BrowserWindow, Menu, screen } = require('electron')

if (!process.env.TOMADA_TARGET_DATA) throw new Error('O alvo exige pasta de dados isolada.')
app.setPath('userData', process.env.TOMADA_TARGET_DATA)
Menu.setApplicationMenu(null)
app.whenReady().then(async () => {
  const bounds = screen.getPrimaryDisplay().bounds
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    fullscreen: true,
    title: 'Tomada — prova do atalho',
    backgroundColor: '#10294d',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><style>html,body{height:100%;margin:0;background:#10294d;color:#fff;font-family:Segoe UI,sans-serif}main{height:100%;display:grid;place-content:center;text-align:center}h1{font-size:64px;margin:0 0 12px}p{font-size:28px}#clock{font-size:80px;font-variant-numeric:tabular-nums}#dot{position:absolute;top:72%;left:12%;width:96px;height:96px;border-radius:24px;background:#ff675c;animation:move 3s linear infinite alternate}@keyframes move{to{left:82%;background:#ffd93d}}</style><main><h1>Tomada</h1><p>Prova de gravação pelo atalho</p><div id="clock">0,0 s</div><p>Somente conteúdo sintético nesta tela</p></main><div id="dot"></div><script>const start=performance.now();setInterval(()=>document.getElementById('clock').textContent=((performance.now()-start)/1000).toFixed(1).replace('.',',')+' s',100)</script></html>`)}`)
  win.setBounds(bounds)
  win.show()
  win.focus()
  win.moveTop()
  // Minimizar o app gravador pode restaurar outra janela que já estava à frente.
  // Reafirma a ordem do alvo durante a prova sem tocar nas janelas preexistentes.
  const front = setInterval(() => {
    if (win.isDestroyed()) return
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setBounds(bounds)
    win.moveTop()
  }, 100)
  win.on('closed', () => clearInterval(front))
})
app.on('window-all-closed', () => app.quit())
