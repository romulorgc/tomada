// Fila para o que é PESADO e não pode rodar em paralelo nesta máquina (bateria e2e, captura real, pip no
// venv compartilhado, medições na GPU): vários cópias de trabalho trabalham ao mesmo tempo em cópias separadas do
// repositório, mas a tela, o mouse e a placa de vídeo são uma só. Uso:
//   node scripts/fila-pesada.mjs npm run test:e2e
// Espera a vez (trava em C:\tmp\tomada-pesado.lock), roda o comando, solta a trava. Também espera enquanto
// houver uma bateria Playwright rodando de quem não usa a fila.
import { spawn, execSync } from 'node:child_process'
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

// Playwright de outra cópia rodando sem a fila (conta processos de teste que não são filhos deste).
function outraBateria() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'node.exe\' -and $_.CommandLine -notmatch \'fila-pesada[.]mjs\' -and $_.CommandLine -match \'playwri[g]ht\' -and $_.CommandLine -match \'\\btest\\b\' }).Count"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }
    )
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
