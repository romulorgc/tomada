// Fila para o que é PESADO e não pode rodar em paralelo nesta máquina (bateria e2e, captura real, pip no
// venv compartilhado, medições na GPU): várias baterias podem ser disparadas ao mesmo tempo a partir de cópias separadas do
// repositório, mas a tela, o mouse e a placa de vídeo são uma só. Uso:
//   node scripts/fila-pesada.mjs npm run test:e2e
// Espera a vez (trava em C:\tmp\tomada-pesado.lock), roda o comando, solta a trava. Também espera enquanto
// houver uma bateria Playwright rodando de quem não usa a fila.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { hasTestRunner } from './fila-processos.mjs'

const LOCK = 'C:\\tmp\\tomada-pesado.lock'
const cmd = process.argv.slice(2)
if (!cmd.length) {
  console.error('uso: node scripts/fila-pesada.mjs <comando...>')
  process.exit(2)
}

const vivo = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Bateria de quem não usa a fila. Wrappers esperando e shells que contêm chamadas
// futuras não são runners; scripts/limpo executando o CLI e npm de e2e são.
let falhasConsulta = 0
let avisouConsulta = false
let primeiraFalha = 0
function outraBateria() {
  const ps = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -in @("node.exe", "electron.exe", "cmd.exe", "npm.exe", "playwright.exe") } | Select-Object Name,CommandLine | ConvertTo-Json -Compress'
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20000,
      windowsHide: true
    })
    const metadata = JSON.parse(out.trim() || '[]')
    falhasConsulta = 0
    avisouConsulta = false
    primeiraFalha = 0
    return hasTestRunner(Array.isArray(metadata) ? metadata : [metadata])
  } catch (err) {
    falhasConsulta++
    if (falhasConsulta === 1) primeiraFalha = Date.now()
    if (!avisouConsulta) {
      console.warn(`[fila-pesada] não consegui consultar os processos: ${err instanceof Error ? err.message : String(err)}`)
      avisouConsulta = true
    }
    if (falhasConsulta >= 8 || Date.now() - primeiraFalha >= 120000) {
      console.warn(`[fila-pesada] a consulta falhou ${falhasConsulta} vezes seguidas; seguindo com a trava compartilhada. Confira se há bateria fora da fila.`)
      return false
    }
    return true
  }
}

const dorme = ms => new Promise(r => setTimeout(r, ms))
fs.mkdirSync(path.dirname(LOCK), { recursive: true })
let avisou = false
for (;;) {
  try {
    fs.mkdirSync(LOCK)
    fs.writeFileSync(path.join(LOCK, 'dono'), `${process.pid}\n${process.cwd()}\n${cmd.join(' ')}\n${new Date().toISOString()}\n`)
    if (outraBateria()) {
      fs.rmSync(LOCK, { recursive: true, force: true })
      throw new Error('ocupado')
    }
    break
  } catch {
    // trava de um processo que morreu sem soltar: libera
    try {
      const [pid] = fs.readFileSync(path.join(LOCK, 'dono'), 'utf8').split('\n')
      if (pid && !vivo(Number(pid))) fs.rmSync(LOCK, { recursive: true, force: true })
    } catch {}
    if (!avisou) {
      console.log('[fila-pesada] esperando a vez (outra bateria está usando a máquina)…')
      avisou = true
    }
    await dorme(15000)
  }
}
console.log(`[fila-pesada] vez minha: ${cmd.join(' ')}`)
const soltar = () => {
  try {
    fs.rmSync(LOCK, { recursive: true, force: true })
  } catch {}
}
process.on('SIGINT', () => {
  soltar()
  process.exit(130)
})
const filho = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: true, windowsHide: true })
filho.on('exit', code => {
  soltar()
  process.exit(code ?? 1)
})
