/**
 * O que uma janela do Tomada pode abrir e de quem o processo principal aceita IPC. Sem Electron: testável em Node.
 *
 * As páginas são SÓ as do próprio app: o `index.html` empacotado (as janelas auxiliares e a de exportação usam o
 * mesmo arquivo, com `#hash`) ou, no `npm run dev`, o servidor de desenvolvimento. Qualquer outro `file://`,
 * `http(s)://`, `data:` ou `about:` é barrado: navegação, `window.open` e requisições de rede para fora.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type AppUrlContext = {
  /** `ELECTRON_RENDERER_URL` (só existe no `npm run dev`). */
  rendererUrl: string | undefined
  /** Caminho do `index.html` empacotado. */
  rendererFile: string
}

const fold = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))

function devHost(ctx: AppUrlContext): string | null {
  if (!ctx.rendererUrl) return null
  try {
    return new URL(ctx.rendererUrl).host
  } catch {
    return null
  }
}

/** A URL é uma página do próprio app? (comparação exata do arquivo ou da origem; `#hash` e `?query` não contam) */
export function isAppUrl(url: unknown, ctx: AppUrlContext): boolean {
  if (typeof url !== 'string') return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const dev = devHost(ctx)
  if (dev && (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === dev) return true
  if (parsed.protocol !== 'file:' || parsed.host !== '') return false
  try {
    return fold(fileURLToPath(parsed)) === fold(ctx.rendererFile)
  } catch {
    return false
  }
}

/** Origem de uma página nossa, como o Chromium a informa nas checagens de permissão (`file:///` para arquivo). */
export function isAppOrigin(origin: unknown, ctx: AppUrlContext): boolean {
  if (typeof origin !== 'string') return false
  return origin === 'file:///' || origin === 'file://' || isAppUrl(origin, ctx)
}

const NETWORK_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:'])

/**
 * Requisição que sairia da máquina? Nada do app precisa de rede (tudo é local), então todas são barradas na camada
 * de rede, além da CSP; a exceção é o servidor de desenvolvimento (e o WebSocket dele) no `npm run dev`.
 */
export function isExternalRequest(url: string, ctx: AppUrlContext): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // não deu para ler: se ao menos PARECE de rede, barra; do contrário o protocolo dela decide
    return /^(https?|wss?|ftp):/i.test(url)
  }
  if (!NETWORK_PROTOCOLS.has(parsed.protocol)) return false
  const dev = devHost(ctx)
  return !(dev && parsed.host === dev)
}
