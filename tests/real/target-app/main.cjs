// Janela-alvo da captura real: botões grandes em posições conhecidas. Clicar muda a cor de
// fundo (sequência fixa) e incrementa um contador grande. Roda como app Electron à parte,
// aberto pelo teste (`npm run test:real`). Não faz nada fora da própria janela.
//   TARGET_DISPLAY=primary|secondary  em qual monitor abrir (padrão: principal)
const { app, BrowserWindow, Menu, screen } = require('electron')
const path = require('node:path')

Menu.setApplicationMenu(null)

app.whenReady().then(() => {
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const others = displays.filter((d) => d.id !== primary.id)
  const display = process.env.TARGET_DISPLAY === 'secondary' && others[0] ? others[0] : primary
  const area = display.workArea
  const win = new BrowserWindow({
    x: area.x + 120,
    y: area.y + 100,
    width: 920,
    height: 640,
    title: 'Tomada-Alvo',
    backgroundColor: '#222222',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
  })
  // Fica por cima de tudo (sem pedir foco ao Windows), para o teste poder clicar nela com segurança.
  win.setAlwaysOnTop(true, 'floating')
  win.loadFile(path.join(__dirname, 'index.html'))
  // Em monitor de DPI diferente da principal o Electron encolhe/estica o tamanho inicial (conta o DPI
  // duas vezes). Depois que a janela está no monitor certo, fixa o tamanho DE NOVO: a área de
  // conteúdo precisa ser 904×600 px CSS para os botões ficarem onde o layout diz.
  win.webContents.once('did-finish-load', () => {
    win.setPosition(area.x + 120, area.y + 100)
    win.setContentSize(904, 600)
  })
})

app.on('window-all-closed', () => app.quit())
