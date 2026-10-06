/**
 * `scripts/resolve-ts.mjs`: o gancho que deixa os scripts .mjs importarem TypeScript de `src/` com imports sem extensão. Sem ele,
 * `node scripts/fixtures.mjs` falhava num checkout novo ("Cannot find module …\src\shared\script imported from …\project.ts"), porque o
 * Node 24 tira os tipos mas não completa `./script` para `./script.ts`.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../helpers/fs'

const hook = pathToFileURL(join(ROOT, 'scripts', 'resolve-ts.mjs')).href
const project = pathToFileURL(join(ROOT, 'src', 'shared', 'project.ts')).href

function run(code: string): { ok: boolean; out: string } {
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    return { ok: true, out: execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }
  } catch (err) {
    return { ok: false, out: String((err as { stderr?: string }).stderr ?? err) }
  }
}

describe('resolve-ts', () => {
  it('sem o gancho, importar o project.ts (que importa ./script sem extensão) falha', () => {
    const r = run(`await import(${JSON.stringify(project)})`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/)
  })

  it('com o gancho, o mesmo import funciona e o código do app roda', () => {
    const r = run(`
      import { register } from 'node:module'
      register(${JSON.stringify(hook)})
      const m = await import(${JSON.stringify(project)})
      const p = m.createProject({ id: 'x', title: 'Teste', createdAt: '2026-10-06T00:00:00.000Z', sources: {}, sync: { screenOffsetMs: 0, cameraOffsetMs: 0 }, capture: { kind: 'screen', boundsPx: { x: 0, y: 0, w: 10, h: 10 }, scale: 1 } })
      m.parseProject(m.serializeProject(p))
      console.log('ok', p.version)
    `)
    expect(r.out).toMatch(/^ok 2/)
    expect(r.ok).toBe(true)
  })
})
