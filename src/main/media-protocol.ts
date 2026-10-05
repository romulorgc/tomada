/**
 * Protocolo `tomada-media://project/<pasta>/<arquivo>`: serve arquivos de projeto
 * ao renderer (`<video>`, `<img>`) COM suporte a Range (sem isso o `<video>` não
 * busca) e restrito à raiz dos projetos.
 *
 * Este módulo não depende do Electron: `handleMediaRequest` recebe um `Request`
 * padrão e devolve um `Response` padrão, então os testes o exercitam direto. O
 * registro no Electron (`protocol.handle`) fica em `index.ts`.
 */
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { MEDIA_HOST, MEDIA_SCHEME } from '@shared/media-url'

export { MEDIA_SCHEME }

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.opus': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

const text = (status: number, body: string, extra: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extra } })

export type ByteRange = { start: number; end: number }

/**
 * Interpreta o cabeçalho Range para um arquivo de `size` bytes.
 *  - `null`      → sem cabeçalho (ou unidade que não conhecemos): responder 200 inteiro;
 *  - `'invalid'` → impossível de atender: responder 416;
 *  - `{start,end}` (inclusivo) → responder 206.
 * Só um intervalo é atendido; vários (`bytes=0-1,5-9`) respondem 416 (os players não usam).
 */
export function parseRange(header: string | null, size: number): ByteRange | 'invalid' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!m) return header.trim().toLowerCase().startsWith('bytes=') ? 'invalid' : null
  const [, a = '', b = ''] = m
  if (a === '' && b === '') return 'invalid'
  if (size === 0) return 'invalid'
  if (a === '') {
    // sufixo: os últimos N bytes
    const n = Number(b)
    if (!(n > 0)) return 'invalid'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(a)
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  if (start >= size || end < start) return 'invalid'
  return { start, end }
}

/** Dentro da raiz? (comparação por caminho relativo, que resolve `..` e maiúsculas do Windows). */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** URL → caminho absoluto dentro da raiz, ou `null` se for suspeita. */
export function resolveMediaPath(url: URL, root: string): string | null {
  if (url.protocol !== `${MEDIA_SCHEME}:` || url.hostname !== MEDIA_HOST) return null
  const segments: string[] = []
  for (const raw of url.pathname.split('/')) {
    if (raw === '') continue
    let seg: string
    try {
      seg = decodeURIComponent(raw)
    } catch {
      return null
    }
    // `..`, separadores escondidos em %2f/%5c, fluxos alternativos do NTFS (":") e NUL
    if (seg === '.' || seg === '..' || /[\\/:\0]/.test(seg)) return null
    segments.push(seg)
  }
  if (segments.length < 2) return null // pelo menos <pasta>/<arquivo>
  const target = resolve(root, ...segments)
  return isInside(resolve(root), target) ? target : null
}

/**
 * CORS aberto de propósito: só este app consome o protocolo, e a M2 vai ler quadros
 * em um worker (OffscreenCanvas + mediabunny), que exige `Access-Control-Allow-Origin`.
 */
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
}

export async function handleMediaRequest(request: Request, root: string): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Range' }
    })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text(405, 'Método não permitido.', { Allow: 'GET, HEAD, OPTIONS' })
  }

  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return text(400, 'URL inválida.')
  }

  const target = resolveMediaPath(url, root)
  if (!target) return text(403, 'Caminho não permitido.')

  // Links simbólicos e junções não podem levar para fora da raiz.
  let real: string
  let size: number
  try {
    real = await realpath(target)
    const realRoot = await realpath(root)
    if (!isInside(realRoot, real)) return text(403, 'Caminho não permitido.')
    const info = await stat(real)
    if (!info.isFile()) return text(404, 'Arquivo não encontrado.')
    size = info.size
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? text(404, 'Arquivo não encontrado.') : text(500, 'Falha ao ler o arquivo.')
  }

  const type = MIME[extname(real).toLowerCase()] ?? 'application/octet-stream'
  const baseHeaders: Record<string, string> = {
    ...CORS,
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  }

  const range = parseRange(request.headers.get('range'), size)
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` } })
  }

  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  const length = size === 0 ? 0 : end - start + 1
  const headers: Record<string, string> = { ...baseHeaders, 'Content-Length': String(length) }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  const status = range ? 206 : 200

  if (request.method === 'HEAD' || length === 0) return new Response(null, { status, headers })

  const stream = Readable.toWeb(createReadStream(real, { start, end })) as unknown as ReadableStream<Uint8Array>
  return new Response(stream, { status, headers })
}

/** Caminho do `join` já resolvido, útil para testes. */
export const mediaPathFor = (root: string, ...segments: string[]): string => join(root, ...segments)
