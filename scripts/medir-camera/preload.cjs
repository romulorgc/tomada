// Ponte mínima da medição da câmera: faz o papel de `window.tomada` que o CaptureEngine usa
// (relógio, pedaços, nível, log) e grava os pedaços direto no disco pelo processo principal.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tomada', {
  record: {
    clock: () => ipcRenderer.invoke('bench:clock'),
    chunk: (kind, data) => ipcRenderer.invoke('bench:chunk', kind, data),
    level: () => undefined,
    getPrefs: () => Promise.resolve({ noiseSuppression: false, echoCancellation: false })
  },
  log: (entry) => ipcRenderer.send('bench:log', entry)
})
