import { describe, expect, it } from 'vitest'
import { hasTestRunner, isTestRunner, type ProcessMetadata } from '../../scripts/fila-processos.mjs'

const metadata = (Name: string, CommandLine: string): ProcessMetadata => ({ Name, CommandLine })
const queued = metadata('node.exe', '"C:\\Program Files\\nodejs\\node.exe" scripts/fila-pesada.mjs node scripts/limpo.mjs playwright test tests/e2e/camera-recorte-revisao.spec.ts')
const cli = metadata('node.exe', '"C:\\Program Files\\nodejs\\node.exe" C:\\tmp\\tomada\\node_modules\\@playwright\\test\\cli.js test tests/e2e/gravacao.spec.ts')

describe('filtro da fila pesada por processo que realmente executa a bateria', () => {
  it.each([
    ['wrapper esperando, como o PID 25156 observado', queued],
    ['shell pai só contendo o texto da chamada', metadata('bash.exe', 'bash -c "npm run build; node scripts/fila-pesada.mjs node scripts/limpo.mjs playwright test tests/e2e/camera-recorte-revisao.spec.ts"')],
    ['cmd esperando a fila', metadata('cmd.exe', 'cmd.exe /d /s /c "node scripts/fila-pesada.mjs node scripts/limpo.mjs playwright test"')],
    ['PowerShell com chamada no corpo', metadata('powershell.exe', 'powershell -Command "node scripts/fila-pesada.mjs node scripts/limpo.mjs playwright test"')],
    ['consulta de processos', metadata('powershell.exe', 'powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match playwright test }"')],
    ['servidor MCP', metadata('node.exe', 'node node_modules/@playwright/mcp/cli.js')],
    ['CLI sem executar testes', metadata('node.exe', 'node node_modules/@playwright/test/cli.js --help')],
    ['aplicativo Electron comum', metadata('electron.exe', 'electron out/main/index.js')],
    ['arquivo arbitrário com texto Playwright nos argumentos', metadata('node.exe', 'node scripts/relatorio.mjs "playwright test"')]
  ] as const)('não bloqueia por %s', (_label, process) => expect(isTestRunner(process)).toBe(false))

  it.each([
    ['CLI real do @playwright/test', cli],
    ['CLI real com caminhos entre aspas', metadata('node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\tmp\\meu projeto\\node_modules\\playwright\\cli.js" test')],
    ['limpo executando o runner, sem fila', metadata('node.exe', 'node scripts/limpo.mjs playwright test tests/e2e/gravacao.spec.ts')],
    ['cmd executando playwright.cmd', metadata('cmd.exe', 'C:\\Windows\\System32\\cmd.exe /d /s /c "playwright.cmd test tests/e2e/gravacao.spec.ts"')],
    ['cmd executando limpo', metadata('cmd.exe', 'cmd.exe /d /s /c "node scripts/limpo.mjs playwright test"')],
    ['cmd executando npm de e2e', metadata('cmd.exe', 'cmd.exe /d /s /c "npm run test:e2e -- tests/e2e/gravacao.spec.ts"')],
    ['npm CLI de e2e', metadata('node.exe', 'node "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run test:e2e')],
    ['npm CLI de medição real', metadata('node.exe', 'node "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run test:real')],
    ['Electron executando o CLI como Node', metadata('electron.exe', 'electron "C:\\tmp\\tomada\\node_modules\\@playwright\\test\\cli.js" test')]
  ] as const)('continua bloqueando %s', (_label, process) => expect(isTestRunner(process)).toBe(true))

  it('uma fila esperando não oculta outro CLI ativo: impede abrir duas baterias', () => {
    expect(hasTestRunner([queued])).toBe(false)
    expect(hasTestRunner([queued, cli])).toBe(true)
    expect(hasTestRunner([])).toBe(false)
  })
})
