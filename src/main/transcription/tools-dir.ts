/**
 * Onde ficam as ferramentas da transcrição (venv do Python, modelos, whisper.cpp): FORA dos projetos, em
 * `%LOCALAPPDATA%\Tomada`, e num caminho SEM ACENTO. O Python, o ctranslate2 e os programas nativos tropeçam em
 * "ô" (esta máquina é `C:\Users\José\…`); então, se o caminho tem acento, usa o nome curto 8.3 do Windows
 * (`C:\Users\JOS~1\AppData\Local\Tomada`) e, se nem ele serve, `%ProgramData%\Tomada`.
 *
 * Sem Electron. O caminho curto vem do Win32 por parâmetro (`shortPathOf`), então a decisão é testável.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import koffi from 'koffi'

/** Variável de teste: aponta as ferramentas para outra pasta (os testes e2e não mexem nas do usuário). */
export const ENV_TOOLS_DIR = 'TOMADA_TOOLS_DIR'

export const isAscii = (path: string): boolean => /^[\u0020-\u007e]*$/.test(path)

export type ToolsDirInput = {
  env: NodeJS.ProcessEnv
  home?: string
  /** Nome curto 8.3 de uma pasta que existe (ou null se o volume não o tem). */
  shortPathOf?: (path: string) => string | null
}

export class ToolsDirError extends Error {
  override readonly name = 'ToolsDirError'
}

/** Escolhe a pasta das ferramentas. Lança `ToolsDirError` (com o motivo) se não achar uma sem acento. */
export function resolveToolsDir(input: ToolsDirInput): string {
  const forced = input.env[ENV_TOOLS_DIR]?.trim()
  if (forced) {
    if (!isAscii(forced)) throw new ToolsDirError(`A pasta das ferramentas (${ENV_TOOLS_DIR}) precisa ter um caminho sem acentos: "${forced}".`)
    return forced
  }
  const local = input.env.LOCALAPPDATA?.trim() || join(input.home ?? homedir(), 'AppData', 'Local')
  const direct = join(local, 'Tomada')
  if (isAscii(direct)) return direct

  const short = input.shortPathOf?.(local) ?? null
  if (short && isAscii(short)) return join(short, 'Tomada')

  const programData = input.env.ProgramData?.trim() || 'C:\\ProgramData'
  const fallback = join(programData, 'Tomada')
  if (isAscii(fallback)) return fallback

  throw new ToolsDirError(
    `Não achei uma pasta sem acentos para as ferramentas de transcrição (tentei ${direct} e ${fallback}). O Python não funciona bem em caminhos com acento.`
  )
}

/** Nome curto 8.3 de uma pasta existente (Win32 `GetShortPathNameW`); null se não houver. */
export function windowsShortPath(path: string): string | null {
  if (process.platform !== 'win32') return null
  try {
    const kernel32 = koffi.load('kernel32.dll')
    const GetShortPathNameW = kernel32.func('uint32 __stdcall GetShortPathNameW(const char16_t *src, _Out_ char16_t *dst, uint32 size)')
    const buf = Buffer.alloc(1040 * 2)
    const n = GetShortPathNameW(path, buf, 1040) as number
    if (!n || n >= 1040) return null
    const out = buf.toString('utf16le', 0, n * 2)
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/** A pasta das ferramentas deste computador (cria se faltar). */
export function ensureToolsDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = resolveToolsDirWithShortPath(env)
  mkdirSync(base, { recursive: true })
  return base
}

function resolveToolsDirWithShortPath(env: NodeJS.ProcessEnv): string {
  const forced = env[ENV_TOOLS_DIR]?.trim()
  if (forced) return resolveToolsDir({ env })
  const local = env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local')
  mkdirSync(local, { recursive: true })
  return resolveToolsDir({ env, shortPathOf: windowsShortPath })
}

/** Subpastas fixas (todas dentro da pasta das ferramentas; nada vem do renderer). */
export function toolPaths(base: string) {
  return {
    base,
    /** venv do Python do app. */
    venv: join(base, 'python'),
    /** modelos (faster-whisper, ggml, VAD). */
    models: join(base, 'models'),
    /** whisper.cpp: binários e DLLs do CUDA. */
    whisperCpp: join(base, 'whisper.cpp'),
    /** cache do pip (as rodas CUDA ficam aqui até a preparação terminar: retomar não rebaixa tudo). */
    pipCache: join(base, 'pip-cache'),
    /** downloads em andamento (`.part`) e arquivos temporários de uma transcrição. */
    downloads: join(base, 'downloads'),
    tmp: join(base, 'tmp'),
    /** marca de "preparação concluída" de cada motor. */
    state: join(base, 'estado')
  }
}

export type ToolPaths = ReturnType<typeof toolPaths>
