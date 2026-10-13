/**
 * Acha um Python utilizável para criar o venv do app: 3.9 a 3.14, preferindo 3.11 (o que o projeto fixou).
 *
 * Os caminhos NÃO são lidos da saída de texto do `py -0p` (que sai na página de código do console e estraga acentos
 * como o de `C:\Users\José`): só as etiquetas (`-V:Astral/CPython3.11.15`, ASCII) são lidas dali, e o caminho vem do
 * próprio Python, em JSON com escapes (`json.dumps`), que não depende de página de código nenhuma.
 *
 * Sem Electron.
 */
import { runProcess } from '../process-runner'

export type PythonFound = {
  /** Executável (caminho exato, pode ter acento). */
  exe: string
  /** Argumentos que vão ANTES dos demais (`-V:<etiqueta>` quando a escolha veio do `py`). */
  prefix: string[]
  version: [number, number, number]
}

export class PythonNotFoundError extends Error {
  override readonly name = 'PythonNotFoundError'
}

export const PYTHON_NOT_FOUND_MESSAGE =
  'Não encontrei o Python (versões 3.9 a 3.14) neste computador. Instale o Python 3.11 (python.org ou "winget install Python.Python.3.11") e clique em "Tentar de novo".'

/** Menor número = preferido. 3.11 é o do projeto; 3.14 por último (as rodas do ctranslate2 chegaram há pouco). */
export function pythonPreference(minor: number): number {
  const order = [11, 12, 10, 13, 9, 14]
  const at = order.indexOf(minor)
  return at < 0 ? 99 : at
}

/** Etiquetas (`3.11`, `Astral/CPython3.11.15`) da saída de `py -0p`, na ordem em que aparecem. */
export function parsePyListing(text: string): string[] {
  const tags: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*-V:(\S+)/.exec(line)
    if (!m) continue
    const tag = m[1]!.replace(/\[.*?\]/g, '')
    if (tag && !tags.includes(tag)) tags.push(tag)
  }
  return tags
}

function versionOfTag(tag: string): { major: number; minor: number } | null {
  const m = /(\d+)\.(\d+)/.exec(tag)
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null
}

const PROBE = 'import sys, json; print(json.dumps([sys.executable, list(sys.version_info[:3])]))'

async function probe(exe: string, prefix: string[], run: typeof runProcess): Promise<PythonFound | null> {
  try {
    const { stdout } = await run(exe, [...prefix, '-c', PROBE], { timeoutMs: 20_000 })
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? '') as [string, [number, number, number]]
    const [path, version] = parsed
    if (typeof path !== 'string' || !Array.isArray(version) || version[0] !== 3) return null
    if (version[1]! < 9 || version[1]! > 14) return null
    return { exe: path, prefix: [], version }
  } catch {
    return null
  }
}

/** O melhor Python encontrado, ou lança `PythonNotFoundError`. `run` entra por parâmetro para os testes. */
export async function locatePython(run: typeof runProcess = runProcess, env: NodeJS.ProcessEnv = process.env): Promise<PythonFound> {
  const found: PythonFound[] = []

  // 1) o `py` do Windows (lista os instalados, inclusive os do uv/Astral)
  const windir = env.SystemRoot ?? 'C:\\Windows'
  const launchers = [`${windir}\\py.exe`, 'py']
  for (const launcher of launchers) {
    try {
      const { stdout } = await run(launcher, ['-0p'], { timeoutMs: 20_000 })
      for (const tag of parsePyListing(stdout)) {
        const v = versionOfTag(tag)
        if (!v || v.major !== 3) continue
        const hit = await probe(launcher, [`-V:${tag}`], run)
        if (hit) found.push(hit)
      }
      if (found.length > 0) break
    } catch {
      // sem este lançador: o próximo
    }
  }

  // 2) `python` no PATH (fora do atalho da Microsoft Store, que abre a loja em vez de rodar)
  if (found.length === 0) {
    for (const name of ['python', 'python3']) {
      const hit = await probe(name, [], run)
      if (hit && !/WindowsApps/i.test(hit.exe)) found.push(hit)
    }
  }

  if (found.length === 0) throw new PythonNotFoundError(PYTHON_NOT_FOUND_MESSAGE)
  found.sort((a, b) => pythonPreference(a.version[1]) - pythonPreference(b.version[1]) || b.version[2] - a.version[2])
  return found[0]!
}
