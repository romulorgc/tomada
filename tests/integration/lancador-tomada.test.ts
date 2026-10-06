import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { buildLaunchScript, encodeVbs } from '../../scripts/criar-atalhos.mjs'

const execute = promisify(execFile)
// Externo, sem acento no ancestral; cada execução limpa a própria subpasta.
const tempRoot = 'C:\\tmp\\tomada-m5a-launcher-tests'

describe('lançador WSH sem console', () => {
  it('o filho recebe argumento com acento, cwd correto e Electron fora do modo Node', async () => {
    const dir = path.join(tempRoot, `${process.pid}-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    try {
      const result = path.join(dir, 'resultado.json')
      const probe = path.join(dir, 'prova José.cjs')
      await writeFile(probe, [
        'const fs = require("node:fs")',
        'fs.writeFileSync(process.argv[2], JSON.stringify([process.env.ELECTRON_RUN_AS_NODE ?? "", process.cwd(), process.argv[3]]))'
      ].join('\n'), 'utf8')
      const launcher = path.join(dir, 'lancar.vbs')
      const cscript = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cscript.exe')
      await writeFile(launcher, encodeVbs(buildLaunchScript({
        executable: process.execPath,
        args: [probe, result, 'Demonstração com espaço e "aspas"'],
        workingDir: dir,
        requiredFiles: [probe],
        wait: true,
        windowStyle: 0
      })))
      await execute(cscript, ['//nologo', launcher], {
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 15_000
      })
      const values = JSON.parse(await readFile(result, 'utf8')) as string[]
      expect(values).toEqual(['', dir, 'Demonstração com espaço e "aspas"'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
