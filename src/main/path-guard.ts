/**
 * Quem pode abrir o quê. O renderer é código nosso, mas o processo principal o trata como MENOS confiável (defesa
 * em profundidade): caminho que vem dele nunca basta.
 *
 *  - `files:open` (tocar o vídeo exportado) só abre arquivo de MÍDIA (lista fechada de extensões) que esteja dentro da
 *    raiz dos projetos OU seja a saída de uma exportação concluída nesta sessão. Nada de `.exe`, `.bat`, `.lnk`.
 *  - `files:reveal` (mostrar na pasta) aceita a mesma lista ampliada a pastas, e nunca executa nada.
 *  - `OutputDirs` guarda as pastas que o usuário escolheu NESTA sessão pelo diálogo nativo; só nelas (ou em
 *    `exports/` do projeto) a exportação grava.
 *
 * Tudo é decidido com `realpath` (o `..`, a junção e o link simbólico não enganam; o Windows ainda expande nomes
 * curtos 8.3, então os dois lados da comparação passam pelo `realpath`). Sem Electron.
 */
import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'
import { isInside } from './project-files'

/** Extensões que `files:open` aceita. */
export const OPENABLE_EXTENSIONS = ['.mp4', '.mov', '.webm', '.m4a', '.wav', '.srt', '.vtt', '.txt', '.png', '.jpg'] as const

const key = (path: string): string => path.toLowerCase()

/** Pastas de destino da exportação aprovadas pelo usuário (diálogo nativo) nesta sessão. */
export interface OutputDirs {
  /** Registra uma pasta devolvida pelo diálogo nativo. */
  approve(dir: string): Promise<void>
  /** A pasta (como o usuário a escreveu, já resolvida) se ela foi aprovada nesta sessão; senão `null`. */
  resolve(dir: string): Promise<string | null>
  /** O caminho (já com `realpath`) é exatamente uma pasta aprovada? */
  has(realDir: string): boolean
}

export function createOutputDirs(): OutputDirs {
  const approved = new Set<string>()
  /** A pasta pode ainda não existir (o diálogo cria): nesse caso vale o caminho resolvido. */
  const canonical = async (dir: string): Promise<string> => key(await realpath(dir).catch(() => resolve(dir)))
  return {
    async approve(dir) {
      if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Error('Pasta inválida: precisa ser um caminho completo.')
      approved.add(await canonical(dir))
    },
    async resolve(dir) {
      if (typeof dir !== 'string' || !isAbsolute(dir)) return null
      return approved.has(await canonical(dir)) ? resolve(dir) : null
    },
    has: (realDir) => approved.has(key(realDir))
  }
}

export type GuardContext = {
  /** Raiz atual dos projetos. */
  root: string
  /** A saída de uma exportação concluída nesta sessão? (recebe o caminho com `realpath`) */
  isExportOutput(realPath: string): boolean
  /** Uma pasta de exportação aprovada? (recebe o caminho com `realpath`) */
  isApprovedDir?(realDir: string): boolean
}

function assertAbsolute(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 2000 || path.includes('\0') || !isAbsolute(path)) {
    throw new Error('Caminho inválido: precisa ser um caminho completo.')
  }
  return path
}

const notFound = (path: string): Error => new Error(`Não encontrei o arquivo: ${path}`)

/** Confere se o arquivo pode ser aberto no programa padrão; devolve o caminho recebido (validado). */
export async function checkOpenable(path: unknown, ctx: GuardContext): Promise<string> {
  const given = assertAbsolute(path)
  const real = await realpath(given).catch(() => {
    throw notFound(given)
  })
  const ext = extname(real).toLowerCase()
  if (!(OPENABLE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new Error(`Só abro arquivos de mídia do Tomada (${OPENABLE_EXTENSIONS.join(', ')}); "${ext || 'sem extensão'}" não está na lista.`)
  }
  const info = await stat(real).catch(() => null)
  if (!info || !info.isFile()) throw notFound(given)
  const realRoot = await realpath(ctx.root).catch(() => resolve(ctx.root))
  if (!isInside(realRoot, real) && !ctx.isExportOutput(real)) {
    throw new Error('Esse arquivo não está na pasta dos projetos nem foi exportado nesta sessão, então não vou abri-lo.')
  }
  return given
}

/** Confere se dá para mostrar o item no Explorer (arquivo ou pasta); nunca executa nada. */
export async function checkRevealable(path: unknown, ctx: GuardContext): Promise<string> {
  const given = assertAbsolute(path)
  const real = await realpath(given).catch(() => {
    throw notFound(given)
  })
  const realRoot = await realpath(ctx.root).catch(() => resolve(ctx.root))
  const allowed = key(real) === key(realRoot) || isInside(realRoot, real) || ctx.isExportOutput(real) || (ctx.isApprovedDir?.(real) ?? false)
  if (!allowed) throw new Error('Esse item não está na pasta dos projetos nem é de uma exportação desta sessão, então não vou mostrá-lo.')
  return given
}
