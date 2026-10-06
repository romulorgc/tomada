// Lê somente argv de executáveis conhecidos. Corpos de bash/PowerShell podem conter
// o texto de uma chamada futura; procurar Playwright no texto inteiro gera deadlock.
const words = (line) => Array.from(line.matchAll(/"([^"]*)"|([^\s"]+)/g), (m) => m[1] ?? m[2]).filter(Boolean)
const normalized = (word = '') => word.replaceAll('\\', '/').toLowerCase()
const name = (word) => normalized(word).split('/').at(-1)
const isNpmTest = (args) => args[0] === 'run' && ['test:e2e', 'test:real'].includes(args[1])

function nodeRunner(args) {
  let i = 0
  while (args[i]?.startsWith('-')) {
    // Código inline não é o CLI: seu texto não pode contar como uma bateria.
    if (['-e', '--eval', '-p', '--print'].includes(args[i])) return false
    const hasValue = ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions'].includes(args[i])
    i += hasValue ? 2 : 1
  }
  const script = normalized(args[i]), rest = args.slice(i + 1)
  if (name(script) === 'fila-pesada.mjs') return false // o wrapper ainda espera a vez
  if (name(script) === 'limpo.mjs') return commandRunner(rest) // já executa, sem fila
  if (/\/(?:@playwright\/test|playwright|playwright-core)\/cli\.(?:js|mjs|cjs)$/.test(`/${script}`)) return rest[0] === 'test'
  if (name(script) === 'npm-cli.js') return isNpmTest(rest)
  return false
}

function commandRunner(args) {
  const executable = name(args[0]), rest = args.slice(1)
  if (['node', 'node.exe', 'electron', 'electron.exe'].includes(executable)) return nodeRunner(rest)
  if (['playwright', 'playwright.cmd', 'playwright.exe'].includes(executable)) return rest[0] === 'test'
  if (['npm', 'npm.cmd', 'npm.exe'].includes(executable)) return isNpmTest(rest)
  if (executable === 'call') return commandRunner(rest)
  return false
}

/** Metadados locais, sem executar ou imprimir a linha de comando. */
export function isTestRunner(process) {
  const line = process.CommandLine ?? '', executable = name(process.Name)
  if (['node.exe', 'electron.exe', 'npm.exe', 'playwright.exe'].includes(executable)) return commandRunner(words(line))
  if (executable !== 'cmd.exe') return false
  const command = line.match(/\s\/c\s+([\s\S]+)$/i)?.[1]?.trim()
  if (!command) return false
  // cmd /s /c envolve o comando em mais um par de aspas, além das dos caminhos.
  const payload = command.startsWith('"') && command.endsWith('"') ? command.slice(1, -1) : command
  return commandRunner(words(payload))
}

export const hasTestRunner = (processes) => processes.some(isTestRunner)
