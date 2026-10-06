// Instala somente o lançador externo e os atalhos; nunca constrói ou escreve no app-alvo.
import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)

function safePath(value) {
  if (typeof value !== 'string' || /[\u0000-\u001F"]/u.test(value)) throw new Error('Caminho inválido para o lançador.')
  if (value.includes('%')) throw new Error('O caminho não pode conter variável de ambiente embutida.')
  if (!path.win32.isAbsolute(value)) throw new Error('O lançador precisa de um caminho absoluto.')
  return path.win32.normalize(value)
}

export function createLaunchConfig(appDir) {
  const workingDir = safePath(appDir)
  const executable = path.win32.join(workingDir, 'node_modules', 'electron', 'dist', 'electron.exe')
  return {
    executable,
    args: [workingDir],
    workingDir,
    requiredFiles: [executable, path.win32.join(workingDir, 'package.json'), path.win32.join(workingDir, 'out', 'main', 'index.js')]
  }
}

// Regras do CommandLineToArgvW: dobra barras finais e barras que precedem aspas.
export function quoteWindowsArg(value) {
  if (/[\u0000\r\n%]/u.test(value)) throw new Error('Argumento inválido para o lançador.')
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

const vbsLiteral = value => `"${value.replace(/"/g, '""')}"`

export function buildLaunchScript(config) {
  const executable = safePath(config.executable)
  const workingDir = safePath(config.workingDir)
  const files = (config.requiredFiles ?? [executable]).map(safePath)
  const command = [executable, ...config.args].map(quoteWindowsArg).join(' ')
  const wait = config.wait ?? false
  const style = config.windowStyle ?? 1
  if (![0, 1].includes(style)) throw new Error('Estado de janela inválido.')
  return [
    'Option Explicit',
    'Dim shell, env, fs, file, command, result',
    'Set shell = CreateObject("WScript.Shell")',
    'Set fs = CreateObject("Scripting.FileSystemObject")',
    `For Each file In Array(${files.map(vbsLiteral).join(', ')})`,
    '  If Not fs.FileExists(file) Then',
    '    MsgBox "O Tomada precisa ser construído antes de abrir. Arquivo ausente: " & file, 16, "Tomada"',
    '    WScript.Quit 1',
    '  End If',
    'Next',
    'Set env = shell.Environment("Process")',
    'On Error Resume Next',
    'env.Remove "ELECTRON_RUN_AS_NODE"',
    'On Error GoTo 0',
    `shell.CurrentDirectory = ${vbsLiteral(workingDir)}`,
    `command = ${vbsLiteral(command)}`,
    'On Error Resume Next',
    `result = shell.Run(command, ${style}, ${wait ? 'True' : 'False'})`,
    'If Err.Number <> 0 Then',
    '  MsgBox "Não foi possível abrir o Tomada: " & Err.Description, 16, "Tomada"',
    '  WScript.Quit 1',
    'End If',
    'On Error GoTo 0',
    ...(wait ? ['WScript.Quit result'] : []),
    ''
  ].join('\r\n')
}

export function encodeVbs(script) {
  // WSH lê o BOM UTF-16: preserva o ô, mesmo com a página de código do console diferente.
  return Buffer.from(`\uFEFF${script}`, 'utf16le')
}

const psLiteral = value => `'${value.replace(/['\u2018\u2019\u201a\u201b]/gu, quote => quote + quote)}'`

function assertOutsideApp(appDir, launchDir) {
  const relative = path.win32.relative(appDir.toLowerCase(), launchDir.toLowerCase())
  if (!relative || (!relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative))) {
    throw new Error('A pasta do lançador precisa ficar fora do app-alvo; o checkout só pode ser lido.')
  }
}

async function canonicalDestination(value) {
  try { return await realpath(value) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = path.dirname(value)
    if (parent === value) throw error
    return path.join(await canonicalDestination(parent), path.basename(value))
  }
}

async function powershell(script) {
  const result = await execute('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
  ], { windowsHide: true, encoding: 'utf8', timeout: 30_000 })
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim())
}

export async function inspectShortcuts(shortcuts) {
  return powershell([
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$shell = New-Object -ComObject WScript.Shell',
    `$paths = @(${shortcuts.map(psLiteral).join(', ')})`,
    '$items = @($paths | ForEach-Object { $link = $shell.CreateShortcut($_); [PSCustomObject]@{ path=$_; target=$link.TargetPath; arguments=$link.Arguments; workingDir=$link.WorkingDirectory; icon=$link.IconLocation; windowStyle=$link.WindowStyle } })',
    'ConvertTo-Json -InputObject $items -Depth 3 -Compress'
  ].join('\n'))
}

export async function installShortcuts({ appDir, launchDir, icon } = {}) {
  if (process.platform !== 'win32') throw new Error('Os atalhos são próprios do Windows.')
  const appRoot = appDir ?? path.join(process.env.USERPROFILE, 'Downloads', 'Tomada')
  const config = createLaunchConfig(appRoot)
  const externalDir = safePath(launchDir ?? path.join(process.env.LOCALAPPDATA, 'Tomada', 'launch'))
  assertOutsideApp(config.workingDir, externalDir)
  for (const file of config.requiredFiles) await access(file)
  assertOutsideApp(await realpath(config.workingDir), await canonicalDestination(externalDir))
  const appPackage = JSON.parse(await readFile(path.join(config.workingDir, 'package.json'), 'utf8'))
  if (appPackage.main !== './out/main/index.js' && appPackage.main !== 'out/main/index.js') {
    throw new Error('O app-alvo não aponta para o build out/main/index.js.')
  }
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  const sourceIcon = icon ?? path.join(root, 'resources', 'tomada.ico')
  await access(sourceIcon)
  const launcher = path.join(externalDir, 'Tomada.vbs')
  const installedIcon = path.join(externalDir, 'tomada.ico')
  const manifest = path.join(externalDir, 'atalhos.json')
  await mkdir(externalDir, { recursive: true })
  // Preserva uma instalação anterior antes de trocar o lançador/ícone/manifesto.
  const backupDir = path.join(externalDir, 'backups', new Date().toISOString().replace(/[:.]/g, '-'))
  const backups = []
  for (const target of [launcher, installedIcon, manifest]) {
    try { await access(target) } catch { continue }
    await mkdir(backupDir, { recursive: true })
    const saved = path.join(backupDir, path.basename(target))
    await copyFile(target, saved)
    backups.push(saved)
  }
  await writeFile(launcher, encodeVbs(buildLaunchScript(config)))
  if (path.resolve(sourceIcon) !== path.resolve(installedIcon)) await copyFile(sourceIcon, installedIcon)
  const created = await powershell([
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$shell = New-Object -ComObject WScript.Shell',
    '$paths = @((Join-Path $shell.SpecialFolders("Desktop") "Tomada.lnk"), (Join-Path $shell.SpecialFolders("Programs") "Tomada.lnk"))',
    '$backups = @()',
    'foreach ($destination in $paths) {',
    `  if (Test-Path -LiteralPath $destination) { New-Item -ItemType Directory -Path ${psLiteral(backupDir)} -Force | Out-Null; $saved = Join-Path ${psLiteral(backupDir)} ((Split-Path -Leaf (Split-Path -Parent $destination)) + "-Tomada.lnk"); Copy-Item -LiteralPath $destination -Destination $saved; $backups += $saved }`,
    '  $link = $shell.CreateShortcut($destination)',
    '  $link.TargetPath = Join-Path $env:SystemRoot "System32\\wscript.exe"',
    `  $link.Arguments = ${psLiteral(`//nologo ${quoteWindowsArg(launcher)}`)}`,
    `  $link.WorkingDirectory = ${psLiteral(config.workingDir)}`,
    `  $link.IconLocation = ${psLiteral(`${installedIcon},0`)}`,
    '  $link.Description = "Gravar, revisar e publicar com o Tomada"',
    '  $link.WindowStyle = 1',
    '  $link.Save()',
    '}',
    'ConvertTo-Json -InputObject ([PSCustomObject]@{shortcuts=$paths; backups=$backups}) -Depth 3 -Compress'
  ].join('\n'))
  const result = {
    appDir: config.workingDir,
    executable: config.executable,
    appArguments: config.args,
    launcher,
    icon: installedIcon,
    manifest,
    backups: [...backups, ...created.backups],
    shortcuts: await inspectShortcuts(created.shortcuts)
  }
  await writeFile(manifest, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
  installShortcuts({ appDir: option('--app-dir'), launchDir: option('--launch-dir') }).then(result => {
    console.log(JSON.stringify(result, null, 2))
  }).catch(error => {
    console.error(`Não foi possível criar os atalhos: ${error.message}`)
    process.exitCode = 1
  })
}
