#!/usr/bin/env node
/**
 * Roda um comando de node_modules/.bin SEM `ELECTRON_RUN_AS_NODE` no ambiente.
 *
 * Esta máquina tem essa variável ligada; com ela o executável do Electron vira
 * um Node comum e `require('electron').app` vem `undefined`. Todo script que abre
 * o Electron (dev, start, Playwright) passa por aqui.
 *
 *   node scripts/limpo.mjs electron-vite dev
 *   node scripts/limpo.mjs playwright test
 */
import { spawn } from 'node:child_process'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [cmd, ...args] = process.argv.slice(2)
if (!cmd) {
  console.error('uso: node scripts/limpo.mjs <comando> [argumentos…]')
  process.exit(2)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.PATH = `${join(root, 'node_modules', '.bin')}${delimiter}${env.PATH ?? ''}`
if (env.Path !== undefined) {
  env.Path = env.PATH
}

// Um comando só (e não argumentos soltos) com shell: o Windows precisa do shell para os .cmd de
// node_modules/.bin, e passar argumentos junto com `shell: true` é depreciado (DEP0190).
const quote = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)
const child = spawn([cmd, ...args.map(quote)].join(' '), { cwd: root, env, stdio: 'inherit', shell: true, windowsHide: true })
child.on('error', (err) => {
  console.error(`falha ao iniciar "${cmd}": ${err.message}`)
  process.exit(1)
})
child.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
