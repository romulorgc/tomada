// Fila para o que é PESADO e não pode rodar em paralelo nesta máquina (bateria e2e, captura real, pip no
// venv compartilhado, medições na GPU): vários cópias de trabalho trabalham ao mesmo tempo em cópias separadas do
// repositório, mas a tela, o mouse e a placa de vídeo são uma só. Uso:
//   node scripts/fila-pesada.mjs npm run test:e2e
// Espera a vez (trava em C:\tmp\tomada-pesado.lock), roda o comando, solta a trava. Também espera enquanto
// houver uma bateria Playwright rodando de quem não usa a fila.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

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

// Bateria Playwright de quem não usa a fila. ⚠️ A consulta NÃO pode se contar: o próprio processo do
// PowerShell tem 'playwright' e ' test' na linha de comando (05/10: com isso a fila nunca liberava ninguém).
// Conta só cópias de trabalho de teste de verdade e ignora o servidor MCP do Playwright das outras sessões.
function outraBateria() {
  const ps = [
    '$n = @(Get-CimInstance Win32_Process | Where-Object {',
    '$_.ProcessId -ne $PID -and $_.CommandLine -and',
    "$_.CommandLine -notmatch 'Get-CimInstance' -and",
    "$_.CommandLine -notmatch 'playwright-mcp|@playwright[\\\\/]mcp' -and",
    "$_.CommandLine -match '@playwright[\\\\/]test[\\\\/]cli|playwright(\\.cmd)?.? test'",
    '}).Count; $n'
  ].join(' ')
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20000
    })
    return Number(out.trim()) > 0
  } catch {
    return false
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
      console.log('[fila-pesada] esperando a vez (outro cópia de trabalho está com a máquina)…')
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
const filho = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: true })
filho.on('exit', code => {
  soltar()
  process.exit(code ?? 1)
})
